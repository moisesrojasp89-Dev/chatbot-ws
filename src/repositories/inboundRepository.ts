import pg from 'pg';
import { db } from '../providers/database/dbClient.js';
import { CONSTANTS } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { normalizeChannelName } from '../providers/channels/channelTypes.js';

export interface InboundEventRecord {
  id: string;
  /** Canal de origen (whatsapp, telegram, instagram, ...). */
  channel?: string;
  wamid: string;
  phone_number_id: string;
  sender_phone: string;
  payload: any;
  status: 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';
  locked_at: Date | null;
  lock_token: string | null;
  retry_count: number;
  next_retry_at: Date;
  last_error: string | null;
  created_at: Date;
  processed_at: Date | null;
}

export interface CoalescedEventBatch {
  primaryEvent: InboundEventRecord;
  secondaryEvents: InboundEventRecord[];
  lockToken: string;
}

export class InboundRepository {
  /**
   * Auditor 5B (I18): Persiste el evento entrante en inbound_events antes de emitir el ACK 200 a Meta.
   * ON CONFLICT (channel, wamid) DO NOTHING asegura idempotencia estricta por canal e identificador externo de mensaje.
   */
  public async persistInboundEvent(
    params: {
      wamid: string;
      phoneNumberId: string;
      senderPhone: string;
      payload: unknown;
      channel?: string;
    },
    client?: pg.PoolClient
  ): Promise<InboundEventRecord | null> {
    const query = `
      INSERT INTO public.inbound_events (
        wamid, phone_number_id, sender_phone, payload, channel
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (channel, wamid) DO NOTHING
      RETURNING *;
    `;

    const executor = client || db;
    const result = await executor.query(query, [
      params.wamid,
      params.phoneNumberId,
      params.senderPhone,
      JSON.stringify(params.payload),
      normalizeChannelName(params.channel),
    ]);

    return (result.rows[0] as InboundEventRecord) || null;
  }

  /**
   * Auditor 5B: Reclamo atómico con exclusión mutua mediante FOR UPDATE OF i SKIP LOCKED
   * y política de cabeza por remitente (Head-of-Line por usuario).
   * Garantiza orden FIFO estricto dentro de un mismo remitente y concurrencia entre usuarios.
   */
  public async claimPendingBatch(
    limit: number = 10,
    client?: pg.PoolClient
  ): Promise<InboundEventRecord[]> {
    const query = `
      WITH picked AS (
        SELECT i.id
        FROM public.inbound_events i
        WHERE i.status = 'PENDING'
          AND i.next_retry_at <= clock_timestamp()
          AND NOT EXISTS (
            SELECT 1 FROM public.inbound_events older
            WHERE older.channel = i.channel
              AND older.phone_number_id = i.phone_number_id
              AND older.sender_phone = i.sender_phone
              AND older.id <> i.id
              AND (
                older.status = 'PROCESSING'
                OR (older.status = 'PENDING' AND (
                  older.created_at < i.created_at
                  OR (older.created_at = i.created_at AND older.id < i.id)
                ))
              )
          )
        ORDER BY i.created_at ASC
        LIMIT $1
        FOR UPDATE OF i SKIP LOCKED
      )
      UPDATE public.inbound_events i
      SET status = 'PROCESSING',
          locked_at = NOW(),
          lock_token = gen_random_uuid()
      FROM picked
      WHERE i.id = picked.id
        AND i.status = 'PENDING'
      RETURNING i.*;
    `;

    const executor = client || db;
    const result = await executor.query(query, [limit]);
    return result.rows as InboundEventRecord[];
  }

  /**
   * Fase 5C (C1 & C2 & C10): Reclamo unificado con garantía estricta de 1 worker por remitente
   * y Coalescencia Inteligente estrictamente contigua.
   *
   * 1. C1 (Fix EvalPlanQual): CTE con candidate_senders excluyendo remitentes en PROCESSING,
   *    DISTINCT ON (sender_phone) para tomar la cabeza y 'AND u.status = PENDING' en el UPDATE final.
   * 2. C10: Agrupa eventos posteriores en PENDING del mismo remitente deteniéndose ESTRICTAMENTE
   *    ante el primer evento que NO sea de tipo texto.
   * 3. Bloquea atómicamente los eventos secundarios con el mismo lockToken.
   */
  public async claimNextBatchWithCoalescing(
    limit: number = 10,
    client?: pg.PoolClient
  ): Promise<CoalescedEventBatch[]> {
    const executor = client || db;

    // 1. Reclamo de hasta N eventos cabecera (1 por remitente distinto) con C1 EvalPlanQual fix
    const headQuery = `
      WITH picked_heads AS (
        SELECT i.id
        FROM public.inbound_events i
        WHERE i.status = 'PENDING'
          AND i.next_retry_at <= clock_timestamp()
          AND NOT EXISTS (
            SELECT 1 FROM public.inbound_events older
            WHERE older.channel = i.channel
              AND older.phone_number_id = i.phone_number_id
              AND older.sender_phone = i.sender_phone
              AND older.id <> i.id
              AND (
                older.status = 'PROCESSING'
                OR (
                  older.status = 'PENDING'
                  AND (
                    older.created_at < i.created_at
                    OR (older.created_at = i.created_at AND older.id < i.id)
                  )
                )
              )
          )
        ORDER BY i.created_at ASC, i.id ASC
        LIMIT $1
        FOR UPDATE OF i SKIP LOCKED
      )
      UPDATE public.inbound_events u
      SET status = 'PROCESSING',
          locked_at = NOW(),
          lock_token = gen_random_uuid()
      FROM picked_heads
      WHERE u.id = picked_heads.id
        AND u.status = 'PENDING'
      RETURNING u.*;
    `;

    const headResult = await executor.query(headQuery, [limit]);
    const primaryEvents = headResult.rows as InboundEventRecord[];
    if (primaryEvents.length === 0) {
      return [];
    }

    const batches: CoalescedEventBatch[] = [];

    // 2. Para cada evento primario, buscar mensajes contiguos en PENDING del mismo remitente (C10)
    for (const primary of primaryEvents) {
      const lockToken = primary.lock_token!;

      // Consultar mensajes posteriores en PENDING del mismo remitente
      const secondariesQuery = `
        SELECT id, payload, created_at
        FROM public.inbound_events
        WHERE channel = $1
          AND sender_phone = $2
          AND phone_number_id = $3
          AND status = 'PENDING'
          AND next_retry_at <= clock_timestamp()
          AND (created_at > $4 OR (created_at = $4 AND id > $5))
        ORDER BY created_at ASC, id ASC;
      `;

      const secondariesRes = await executor.query(secondariesQuery, [
        primary.channel,
        primary.sender_phone,
        primary.phone_number_id,
        primary.created_at,
        primary.id,
      ]);

      const primaryMsgType = primary.payload?.message?.type;
      const contiguousIds: string[] = [];
      const maxSecondaries = (CONSTANTS.INBOUND.COALESCE_MAX_MESSAGES ?? 5) - 1;

      // C10: La coalescencia aplica únicamente si el mensaje primario es de texto
      if (primaryMsgType === 'text' && maxSecondaries > 0) {
        for (const row of secondariesRes.rows) {
          if (contiguousIds.length >= maxSecondaries) break;
          const msgType = row.payload?.message?.type;
          if (msgType === 'text') {
            contiguousIds.push(row.id);
          } else {
            // C10: Detenerse ante el primer evento no-texto (estrictamente contiguo)
            break;
          }
        }
      }

      let secondaryEvents: InboundEventRecord[] = [];
      if (contiguousIds.length > 0) {
        const lockSecondariesQuery = `
          UPDATE public.inbound_events
          SET status = 'PROCESSING',
              locked_at = NOW(),
              lock_token = $1
          WHERE id = ANY($2::uuid[])
            AND status = 'PENDING'
          RETURNING *;
        `;
        const lockRes = await executor.query(lockSecondariesQuery, [
          lockToken,
          contiguousIds,
        ]);
        secondaryEvents = lockRes.rows as InboundEventRecord[];
      }

      batches.push({
        primaryEvent: primary,
        secondaryEvents,
        lockToken,
      });
    }

    return batches;
  }

  /**
   * C9: Marca como DONE un lote coalescido en la misma transacción atómica con Fencing Token.
   * El primario se marca con processed_at, y los secundarios se marcan con nota coalesced_into.
   */
  public async markCoalescedBatchDone(
    primaryId: string,
    secondaryIds: string[],
    lockToken: string,
    client?: pg.PoolClient
  ): Promise<boolean> {
    const primaryOk = await this.markDone(primaryId, lockToken, client);
    if (!primaryOk) return false;

    if (secondaryIds.length > 0) {
      const executor = client || db;
      const query = `
        UPDATE public.inbound_events
        SET status = 'DONE',
            processed_at = NOW(),
            locked_at = NULL,
            lock_token = NULL,
            last_error = 'coalesced_into:' || $1
        WHERE id = ANY($2::uuid[])
          AND status = 'PROCESSING'
          AND lock_token = $3;
      `;
      await executor.query(query, [primaryId, secondaryIds, lockToken]);
    }

    return true;
  }

  /**
   * Extiende el lease de un conjunto de eventos (primario y secundarios coalescidos).
   */
  public async extendBatchLease(
    ids: string[],
    lockToken: string,
    client?: pg.PoolClient
  ): Promise<boolean> {
    if (ids.length === 0) return true;
    const query = `
      UPDATE public.inbound_events
      SET locked_at = NOW()
      WHERE id = ANY($1::uuid[]) AND status = 'PROCESSING' AND lock_token = $2
      RETURNING id;
    `;
    const executor = client || db;
    const result = await executor.query(query, [ids, lockToken]);
    return (result.rowCount ?? result.rows.length) === ids.length;
  }

  /**
   * Libera el lease de un conjunto de eventos devolviéndolos a PENDING sin quemar reintentos.
   */
  public async releaseBatch(
    ids: string[],
    lockToken: string,
    delaySeconds: number = 0,
    client?: pg.PoolClient
  ): Promise<boolean> {
    if (ids.length === 0) return true;
    const query = `
      UPDATE public.inbound_events
      SET status = 'PENDING',
          locked_at = NULL,
          lock_token = NULL,
          next_retry_at = NOW() + make_interval(secs => $3)
      WHERE id = ANY($1::uuid[]) AND status = 'PROCESSING' AND lock_token = $2
      RETURNING id;
    `;
    const executor = client || db;
    const result = await executor.query(query, [ids, lockToken, delaySeconds]);
    return (result.rowCount ?? result.rows.length) > 0;
  }

  /**
   * Reintenta un conjunto de eventos coalescidos incrementando retry_count y programando backoff.
   */
  public async retryFailedBatch(
    ids: string[],
    lockToken: string,
    error: string,
    delaySeconds: number,
    client?: pg.PoolClient
  ): Promise<boolean> {
    if (ids.length === 0) return true;
    const query = `
      UPDATE public.inbound_events
      SET status = 'PENDING',
          locked_at = NULL,
          lock_token = NULL,
          retry_count = retry_count + 1,
          last_error = $3,
          next_retry_at = NOW() + make_interval(secs => $4)
      WHERE id = ANY($1::uuid[]) AND status = 'PROCESSING' AND lock_token = $2
      RETURNING id;
    `;
    const executor = client || db;
    const result = await executor.query(query, [ids, lockToken, error, delaySeconds]);
    return (result.rowCount ?? result.rows.length) > 0;
  }

  /**
   * Marca como FAILED terminalmente un conjunto de eventos coalescidos.
   */
  public async terminalFailedBatch(
    ids: string[],
    lockToken: string,
    error: string,
    client?: pg.PoolClient
  ): Promise<boolean> {
    if (ids.length === 0) return true;
    const query = `
      UPDATE public.inbound_events
      SET status = 'FAILED',
          last_error = $3,
          locked_at = NULL,
          lock_token = NULL
      WHERE id = ANY($1::uuid[]) AND status = 'PROCESSING' AND lock_token = $2
      RETURNING id;
    `;
    const executor = client || db;
    const result = await executor.query(query, [ids, lockToken, error]);
    return (result.rowCount ?? result.rows.length) > 0;
  }

  /**
   * Valida si el lease de procesamiento sigue activo y no fue revocado o reasignado.
   */
  public async isLeaseValid(
    id: string,
    lockToken: string,
    client?: pg.PoolClient
  ): Promise<boolean> {
    const query = `
      SELECT 1 FROM public.inbound_events
      WHERE id = $1 AND status = 'PROCESSING' AND lock_token = $2;
    `;
    const executor = client || db;
    const result = await executor.query(query, [id, lockToken]);
    return result.rows.length > 0;
  }

  /**
   * Auditor 5B (Fence Atómico): Marca el evento como DONE exigiendo lock_token exacto.
   * Diseñado para ejecutarse dentro de la transacción atómica del resultado.
   * Si retorna false, significa que el lease se perdió y la transacción debe hacer ROLLBACK.
   */
  public async markDone(
    id: string,
    lockToken: string,
    client?: pg.PoolClient
  ): Promise<boolean> {
    const query = `
      UPDATE public.inbound_events
      SET status = 'DONE',
          processed_at = NOW(),
          locked_at = NULL,
          lock_token = NULL
      WHERE id = $1 AND status = 'PROCESSING' AND lock_token = $2
      RETURNING id;
    `;
    const executor = client || db;
    const result = await executor.query(query, [id, lockToken]);
    const affected = (result.rowCount ?? result.rows.length) > 0;
    if (!affected) {
      logger.warn({ id }, 'markDone afectó 0 filas (fencing token no coincide o lease expirado)');
    }
    return affected;
  }

  /**
   * Auditor 5B (B1): Libera el lease de un evento devolviéndolo a PENDING
   * SIN quemar reintentos (usado únicamente para diferir por circuit breaker, pausa o shutdown).
   */
  public async release(
    id: string,
    lockToken: string,
    delaySeconds: number = 0,
    client?: pg.PoolClient
  ): Promise<boolean> {
    const query = `
      UPDATE public.inbound_events
      SET status = 'PENDING',
          locked_at = NULL,
          lock_token = NULL,
          next_retry_at = NOW() + make_interval(secs => $3)
      WHERE id = $1 AND status = 'PROCESSING' AND lock_token = $2
      RETURNING id;
    `;
    const executor = client || db;
    const result = await executor.query(query, [id, lockToken, delaySeconds]);
    return (result.rowCount ?? result.rows.length) > 0;
  }

  /**
   * Auditor 5B (B1): Reintenta un evento fallido incrementando retry_count,
   * guardando last_error y programando next_retry_at con backoff exponencial.
   */
  public async retryFailed(
    id: string,
    lockToken: string,
    error: string,
    delaySeconds: number,
    client?: pg.PoolClient
  ): Promise<boolean> {
    const query = `
      UPDATE public.inbound_events
      SET status = 'PENDING',
          locked_at = NULL,
          lock_token = NULL,
          retry_count = retry_count + 1,
          last_error = $3,
          next_retry_at = NOW() + make_interval(secs => $4)
      WHERE id = $1 AND status = 'PROCESSING' AND lock_token = $2
      RETURNING id;
    `;
    const executor = client || db;
    const result = await executor.query(query, [id, lockToken, error, delaySeconds]);
    return (result.rowCount ?? result.rows.length) > 0;
  }

  /**
   * Marca el evento como terminalmente fallido (FAILED).
   */
  public async terminalFailed(
    id: string,
    lockToken: string,
    error: string,
    client?: pg.PoolClient
  ): Promise<InboundEventRecord | null> {
    const query = `
      UPDATE public.inbound_events
      SET status = 'FAILED',
          last_error = $3,
          locked_at = NULL,
          lock_token = NULL
      WHERE id = $1 AND status = 'PROCESSING' AND lock_token = $2
      RETURNING *;
    `;
    const executor = client || db;
    const result = await executor.query(query, [id, lockToken, error]);
    return (result.rows[0] as InboundEventRecord) || null;
  }

  /**
   * Auditor 5B (I4): Valida y extiende el lease de procesamiento activo
   * antes de contactar al proveedor LLM, renovando locked_at a NOW().
   */
  public async extendLease(
    id: string,
    lockToken: string,
    extendSeconds: number = CONSTANTS.INBOUND.LEASE_TIMEOUT_SECONDS,
    client?: pg.PoolClient
  ): Promise<boolean> {
    const query = `
      UPDATE public.inbound_events
      SET locked_at = NOW()
      WHERE id = $1 AND status = 'PROCESSING' AND lock_token = $2
      RETURNING id;
    `;
    const executor = client || db;
    const result = await executor.query(query, [id, lockToken]);
    return (result.rowCount ?? result.rows.length) > 0;
  }

  /**
   * Auditor 5B Reaper (I2, T7): Rescata eventos huérfanos en PROCESSING cuyo lease expiró.
   * Aplica protección Poison Pill: si retry_count + 1 >= MAX_RETRIES (3), transiciona a FAILED
   * y retorna poison pills para alerta individual y encolado de mensaje fallback.
   */
  public async reapOrphaned(
    leaseTimeoutSeconds: number = CONSTANTS.INBOUND.LEASE_TIMEOUT_SECONDS
  ): Promise<{ reapedCount: number; poisonPills: InboundEventRecord[] }> {
    const query = `
      UPDATE public.inbound_events
      SET status = CASE
            WHEN retry_count + 1 >= ${CONSTANTS.INBOUND.MAX_RETRIES} THEN 'FAILED'
            ELSE 'PENDING'
          END,
          last_error = CASE
            WHEN retry_count + 1 >= ${CONSTANTS.INBOUND.MAX_RETRIES} THEN 'Poison pill: lease expired MAX_RETRIES times'
            ELSE last_error
          END,
          locked_at = NULL,
          lock_token = NULL,
          retry_count = retry_count + 1,
          next_retry_at = NOW()
      WHERE status = 'PROCESSING'
        AND locked_at < NOW() - make_interval(secs => $1)
      RETURNING *;
    `;
    const result = await db.query(query, [leaseTimeoutSeconds]);
    const poisonPills = result.rows.filter((r: any) => r.status === 'FAILED') as InboundEventRecord[];
    const reapedCount = result.rowCount ?? result.rows.length;
    if (reapedCount > 0) {
      logger.warn(
        { count: reapedCount, poisonPillsFailed: poisonPills.length },
        '🚨 Reaper de Inbound: Rescatados eventos huérfanos con protección poison pill'
      );
    }
    return { reapedCount, poisonPills };
  }

  /**
   * Auditor 5B (Punto 4): Purga unificada de PII (inbound, outbox, messages, status_events)
   * ejecutada por lotes con LIMIT 500 para no retener locks largos de PostgreSQL.
   */
  public async purgeProcessedEvents(
    retentionDays: number = CONSTANTS.INBOUND.RETENTION_DAYS,
    batchLimit: number = 500
  ): Promise<{ inbound: number; outbox: number; messages: number; statusEvents: number }> {
    // 1. Inbound events DONE y FAILED con payload crudo PII (C3)
    const inboundRes = await db.query(
      `
      WITH targets AS (
        SELECT id FROM public.inbound_events
        WHERE status IN ('DONE', 'FAILED')
          AND COALESCE(processed_at, created_at) < NOW() - ($1 || ' days')::INTERVAL
        LIMIT $2
      )
      DELETE FROM public.inbound_events WHERE id IN (SELECT id FROM targets) RETURNING id;
      `,
      [retentionDays, batchLimit]
    );

    // 2. Outbox messages SENT y FAILED con teléfono y contenido PII (C3)
    const outboxRes = await db.query(
      `
      WITH targets AS (
        SELECT id FROM public.outbox_messages
        WHERE status IN ('SENT', 'FAILED')
          AND created_at < NOW() - ($1 || ' days')::INTERVAL
        LIMIT $2
      )
      DELETE FROM public.outbox_messages WHERE id IN (SELECT id FROM targets) RETURNING id;
      `,
      [retentionDays, batchLimit]
    );

    // 3. Message status events
    const statusRes = await db.query(
      `
      WITH targets AS (
        SELECT id FROM public.message_status_events
        WHERE created_at < NOW() - ($1 || ' days')::INTERVAL
        LIMIT $2
      )
      DELETE FROM public.message_status_events WHERE id IN (SELECT id FROM targets) RETURNING id;
      `,
      [retentionDays, batchLimit]
    );

    // 4. C3: public.messages (datos de producto) excluidos de la purga automática hasta decidir política de retención
    const totals = {
      inbound: inboundRes.rowCount ?? inboundRes.rows.length,
      outbox: outboxRes.rowCount ?? outboxRes.rows.length,
      messages: 0,
      statusEvents: statusRes.rowCount ?? statusRes.rows.length,
    };

    if (totals.inbound + totals.outbox + totals.messages + totals.statusEvents > 0) {
      logger.info(totals, '🧹 Purga LGPD unificada completada en lotes LIMIT');
    }
    return totals;
  }
}

export const inboundRepository = new InboundRepository();

