import pg from 'pg';
import { db } from '../providers/database/dbClient.js';
import { OutboxRecord } from '../types/states.js';
import { CONSTANTS } from '../config/constants.js';
import { normalizeChannelName } from '../providers/channels/channelTypes.js';
import { logger } from '../utils/logger.js';

export interface EnqueueMessageParams {
  conversationId?: string | null;
  /** Canal de salida; por defecto whatsapp (compatibilidad con registros previos). */
  channel?: string;
  phoneNumberId: string;
  recipientPhone: string;
  messageType?: string;
  content: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
  maxRetries?: number;
}

export class OutboxRepository {
  /**
   * Encola un mensaje saliente de forma transaccional antes de tocar la red externa.
   * F4-C5: Consume CONSTANTS.OUTBOX.MAX_RETRIES como única fuente de verdad.
   */
  public async enqueueMessage(
    params: EnqueueMessageParams,
    client?: pg.PoolClient
  ): Promise<OutboxRecord> {
    const maxRetries = params.maxRetries ?? CONSTANTS.OUTBOX.MAX_RETRIES;
    const query = `
      INSERT INTO public.outbox_messages (
        conversation_id, phone_number_id, recipient_phone, message_type,
        content, status, prompt_tokens, completion_tokens, latency_ms, max_retries, channel
      )
      VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, $9, $10)
      RETURNING *;
    `;
    const values = [
      params.conversationId || null,
      params.phoneNumberId,
      params.recipientPhone,
      params.messageType || 'text',
      params.content,
      params.promptTokens || 0,
      params.completionTokens || 0,
      params.latencyMs || 0,
      maxRetries,
      normalizeChannelName(params.channel),
    ];

    const result = client
      ? await client.query(query, values)
      : await db.query(query, values);

    const record = result.rows[0] as OutboxRecord;
    logger.debug(
      { outboxId: record.id, recipient: params.recipientPhone },
      'Mensaje encolado en outbox_messages'
    );
    return record;
  }

  /**
   * B2 & Fencing: Reclama un lote de mensajes pendientes de forma atómica en una sola sentencia SQL (CTE)
   * con FOR UPDATE SKIP LOCKED, registrando locked_at = NOW() y generando un lock_token UUID criptográfico.
   * Elimina cualquier ambigüedad de tolerancia temporal entre Node.js y PostgreSQL.
   */
  public async claimPendingBatch(
    limit: number = CONSTANTS.OUTBOX.BATCH_SIZE,
    client?: pg.PoolClient,
    allowedChannels?: string[]
  ): Promise<OutboxRecord[]> {
    // Si el llamador no permite ningún canal, no hay nada que reclamar.
    if (allowedChannels && allowedChannels.length === 0) {
      return [];
    }

    const channelFilter = allowedChannels ? 'AND o.channel = ANY($2::varchar[])' : '';
    const params = allowedChannels ? [limit, allowedChannels] : [limit];
    // Auditor 5A (Bloqueante cerrado): El lock FOR UPDATE OF o SKIP LOCKED se aplica directamente
    // sobre la tabla en el SELECT de picked. En Postgres, los locks no aplican a referencias a CTEs.
    const query = `
      WITH picked AS (
        SELECT o.id
        FROM public.outbox_messages o
        WHERE o.status = 'PENDING'
          AND o.next_retry_at <= clock_timestamp()
          ${channelFilter}
          AND NOT EXISTS (
            SELECT 1 FROM public.outbox_messages older
            WHERE older.phone_number_id = o.phone_number_id
              AND older.recipient_phone = o.recipient_phone
              AND older.id <> o.id
              AND (
                older.status = 'PROCESSING'
                OR (older.status = 'PENDING' AND (
                  older.created_at < o.created_at
                  OR (older.created_at = o.created_at AND older.id < o.id)
                ))
              )
          )
        ORDER BY o.created_at ASC
        LIMIT $1
        FOR UPDATE OF o SKIP LOCKED
      )
      UPDATE public.outbox_messages o
      SET status = 'PROCESSING',
          locked_at = NOW(),
          lock_token = gen_random_uuid()
      FROM picked
      WHERE o.id = picked.id
        AND o.status = 'PENDING'
      RETURNING o.*;
    `;

    const result = client
      ? await client.query(query, params)
      : await db.query(query, params);

    return result.rows as OutboxRecord[];
  }

  /** Backlog PENDING agrupado por canal (para alertas operativas). */
  public async countPendingByChannel(): Promise<Array<{ channel: string; pending: number }>> {
    const result = await db.query(
      `SELECT channel, count(*)::int AS pending
       FROM public.outbox_messages
       WHERE status = 'PENDING'
       GROUP BY channel
       ORDER BY channel ASC;`
    );

    return (result.rows as Array<{ channel: string; pending: number }>).map((row) => ({
      channel: row.channel,
      pending: row.pending,
    }));
  }

  /**
   * Auditor Checkpoint 1 & 2: Valida si el lease de procesamiento sigue activo
   * y pertenece a este worker antes de ejecutar el efecto irreversible (llamada a Meta).
   */
  public async isLeaseValid(
    id: string,
    lockToken: string,
    client?: pg.PoolClient
  ): Promise<boolean> {
    const query = `
      SELECT 1 FROM public.outbox_messages
      WHERE id = $1 AND status = 'PROCESSING' AND lock_token = $2
      LIMIT 1;
    `;
    const result = client
      ? await client.query(query, [id, lockToken])
      : await db.query(query, [id, lockToken]);

    return (result.rowCount ?? result.rows.length) > 0;
  }

  /**
   * B1 & Auditor Fix (R3): Libera un mensaje reclamado regresándolo a PENDING sin consumir
   * presupuesto de reintentos. Exige lockToken obligatorio con cláusula estricta AND lock_token = $2
   * para garantizar que un worker zombie con lease expirado no toque la fila reasignada a otro worker.
   */
  public async release(
    id: string,
    lockToken: string,
    delaySeconds: number,
    client?: pg.PoolClient
  ): Promise<boolean> {
    const query = `
      UPDATE public.outbox_messages
      SET status = 'PENDING',
          locked_at = NULL,
          lock_token = NULL,
          next_retry_at = NOW() + ($3 || ' seconds')::INTERVAL
      WHERE id = $1 AND status = 'PROCESSING' AND lock_token = $2
      RETURNING id;
    `;
    const result = client
      ? await client.query(query, [id, lockToken, delaySeconds])
      : await db.query(query, [id, lockToken, delaySeconds]);

    const affected = (result.rowCount ?? result.rows.length) > 0;
    if (!affected) {
      logger.warn({ id }, 'release afectó 0 filas (lease expirado o lock_token no coincide)');
    }
    return affected;
  }

  /**
   * B2 & Poison Pill Protection:
   * Restaura filas huérfanas en PROCESSING por reinicios o cuelgues de workers.
   * Incrementa retry_count para evitar bucles infinitos por mensajes poison pill.
   */
  public async reapStaleProcessing(
    timeoutMinutes: number = CONSTANTS.OUTBOX.REAPER_TIMEOUT_MINUTES,
    client?: pg.PoolClient
  ): Promise<number> {
    const query = `
      WITH stalled AS (
        SELECT id
        FROM public.outbox_messages
        WHERE status = 'PROCESSING'
          AND locked_at < NOW() - ($1 || ' minutes')::INTERVAL
        ORDER BY locked_at ASC
        LIMIT 500
        FOR UPDATE SKIP LOCKED
      )
      UPDATE public.outbox_messages o
      SET status = CASE
            WHEN o.retry_count + 1 >= o.max_retries THEN 'FAILED'
            ELSE 'PENDING'
          END,
          locked_at = NULL,
          lock_token = NULL,
          last_error = 'Processing timeout: lease expired (crashed worker or stalled execution)',
          retry_count = o.retry_count + 1
      FROM stalled
      WHERE o.id = stalled.id
        AND o.status = 'PROCESSING'
      RETURNING o.id;
    `;
    const result = client
      ? await client.query(query, [timeoutMinutes])
      : await db.query(query, [timeoutMinutes]);

    const count = result.rowCount ?? result.rows.length;
    if (count > 0) {
      logger.warn({ reapedCount: count }, '♻️ Reaper: Filas huérfanas en PROCESSING restauradas o enviadas a FAILED');
    }
    return count;
  }

  /**
   * I14 & Auditor Fix (R3): Marca un mensaje directamente como FAILED sin reintentar.
   * Exige lockToken obligatorio con cláusula estricta AND lock_token = $2 sin ramas alternativas.
   */
  public async terminalFailed(
    id: string,
    lockToken: string,
    error: string,
    client?: pg.PoolClient
  ): Promise<OutboxRecord | null> {
    const query = `
      UPDATE public.outbox_messages
      SET status = 'FAILED',
          last_error = $3,
          locked_at = NULL,
          lock_token = NULL
      WHERE id = $1 AND status = 'PROCESSING' AND lock_token = $2
      RETURNING *;
    `;
    const result = client
      ? await client.query(query, [id, lockToken, error])
      : await db.query(query, [id, lockToken, error]);

    return (result.rows[0] as OutboxRecord) || null;
  }

  /**
   * B3 & Fencing Estricto (R3): Marca el mensaje como 'SENT'.
   * Compara de forma exacta lock_token = $3 (UUID) sin puertas traseras ni ramas alternativas.
   * Si el lease expiró o fue reasignado, el UPDATE afecta 0 filas protegiendo la integridad.
   */
  public async markSent(
    id: string,
    wamid: string,
    lockToken: string,
    client?: pg.PoolClient
  ): Promise<OutboxRecord | null> {
    const query = `
      UPDATE public.outbox_messages
      SET status = 'SENT',
          wamid = $2,
          sent_at = NOW(),
          last_error = NULL,
          locked_at = NULL,
          lock_token = NULL
      WHERE id = $1
        AND status = 'PROCESSING'
        AND lock_token = $3
      RETURNING *;
    `;

    const values = [id, wamid, lockToken];
    const result = client
      ? await client.query(query, values)
      : await db.query(query, values);

    return (result.rows[0] as OutboxRecord) || null;
  }

  /**
   * B3 & Fencing Estricto (R3): Registra fallo con backoff comparando exactamente lock_token (UUID).
   * Sin ramas alternativas cuando lockToken es falsy.
   */
  public async markFailed(
    id: string,
    lockToken: string,
    error: string,
    backoffSeconds: number,
    client?: pg.PoolClient
  ): Promise<OutboxRecord | null> {
    const query = `
      UPDATE public.outbox_messages
      SET retry_count = retry_count + 1,
          last_error = $3,
          locked_at = NULL,
          lock_token = NULL,
          status = CASE
            WHEN retry_count + 1 >= max_retries THEN 'FAILED'
            ELSE 'PENDING'
          END,
          next_retry_at = NOW() + ($4 || ' seconds')::INTERVAL
      WHERE id = $1
        AND status = 'PROCESSING'
        AND lock_token = $2
      RETURNING *;
    `;

    const values = [id, lockToken, error, backoffSeconds];
    const result = client
      ? await client.query(query, values)
      : await db.query(query, values);

    const record = (result.rows[0] as OutboxRecord) || null;
    if (!record) {
      logger.warn({ id }, 'markFailed afectó 0 filas (lease expirado o lock_token no coincide)');
    }
    return record;
  }

  /**
   * Busca un registro de outbox por ID.
   */
  public async findById(id: string): Promise<OutboxRecord | null> {
    const query = `SELECT * FROM public.outbox_messages WHERE id = $1 LIMIT 1;`;
    const result = await db.query(query, [id]);
    return (result.rows[0] as OutboxRecord) || null;
  }
}

export const outboxRepository = new OutboxRepository();
