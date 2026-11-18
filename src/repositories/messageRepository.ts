import pg from 'pg';
import { db } from '../providers/database/dbClient.js';
import { MessageRecord } from '../types/states.js';
import { logger } from '../utils/logger.js';

export interface UpdateProcessedMessageParams {
  conversationId?: string;
  content: string;
  messageType?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
  rawPayload?: Record<string, unknown>;
}

export class MessageRepository {
  /**
   * Auditor 5B: Persiste o actualiza un mensaje entrante (INBOUND) con soporte de transacción.
   */
  public async saveInboundMessage(
    params: {
      wamid: string;
      conversationId: string;
      content: string;
      rawPayload?: Record<string, unknown>;
    },
    client?: pg.PoolClient
  ): Promise<MessageRecord> {
    const query = `
      INSERT INTO public.messages (
        wamid, conversation_id, direction, message_type, content, raw_payload
      )
      VALUES ($1, $2, 'INBOUND', 'text', $3, $4::jsonb)
      ON CONFLICT (wamid) DO UPDATE
      SET conversation_id = EXCLUDED.conversation_id,
          content = EXCLUDED.content,
          raw_payload = EXCLUDED.raw_payload
      RETURNING *;
    `;
    const executor = client || db;
    const result = await executor.query(query, [
      params.wamid,
      params.conversationId,
      params.content,
      params.rawPayload ? JSON.stringify(params.rawPayload) : null,
    ]);
    return result.rows[0] as MessageRecord;
  }
  /**
   * F2-C5 (Patrón A): Actualiza el mensaje previamente insertado por el IdempotencyGate.
   * Evita duplicación de INSERTs y vincula la conversación y métricas de procesamiento.
   */
  public async updateProcessedMessage(
    wamid: string,
    data: UpdateProcessedMessageParams
  ): Promise<MessageRecord | null> {
    const query = `
      UPDATE public.messages
      SET conversation_id = COALESCE($1, conversation_id),
          content = $2,
          message_type = COALESCE($3, message_type),
          prompt_tokens = COALESCE($4, prompt_tokens),
          completion_tokens = COALESCE($5, completion_tokens),
          latency_ms = COALESCE($6, latency_ms),
          raw_payload = COALESCE($7::jsonb, raw_payload)
      WHERE wamid = $8
      RETURNING *;
    `;
    const result = await db.query(query, [
      data.conversationId || null,
      data.content,
      data.messageType || 'text',
      data.promptTokens || 0,
      data.completionTokens || 0,
      data.latencyMs || 0,
      data.rawPayload ? JSON.stringify(data.rawPayload) : null,
      wamid,
    ]);

    return (result.rows[0] as MessageRecord) || null;
  }

  /**
   * Guarda un mensaje saliente (OUTBOUND) generado por el bot o por un asesor.
   * Auditor 5A (I16): Piso inicial 'sent' (Meta ya aceptó el mensaje). Tras el INSERT,
   * ejecuta un UPDATE de reconciliación contra message_status_events para absorber carreras
   * inversas donde el webhook delivered/read llegó antes o durante la inserción.
   */
  public async saveOutboundMessage(params: {
    wamid: string;
    conversationId: string;
    content: string;
    promptTokens?: number;
    completionTokens?: number;
    latencyMs?: number;
  }): Promise<MessageRecord> {
    // 1. Inserción con piso inicial 'sent' (Meta ya confirmó recepción)
    const insertQuery = `
      INSERT INTO public.messages (
        wamid, conversation_id, direction, message_type, content,
        prompt_tokens, completion_tokens, latency_ms, delivery_status
      )
      VALUES ($1, $2, 'OUTBOUND', 'text', $3, $4, $5, $6, 'sent')
      RETURNING *;
    `;
    const insertResult = await db.query(insertQuery, [
      params.wamid,
      params.conversationId,
      params.content,
      params.promptTokens || 0,
      params.completionTokens || 0,
      params.latencyMs || 0,
    ]);

    const inserted = insertResult.rows[0] as MessageRecord;

    // 2. Reconciliación post-insert con cualquier evento ya comprometido en message_status_events
    // Auditor 5A: Aplica el mismo guard de rango monótono que updateDeliveryStatus para evitar degradaciones
    const reconcileQuery = `
      WITH events_summary AS (
        SELECT 
          wamid,
          CASE 
            WHEN BOOL_OR(status = 'read') THEN 'read'
            WHEN BOOL_OR(status = 'delivered') THEN 'delivered'
            WHEN BOOL_OR(status = 'failed') THEN 'failed'
            WHEN BOOL_OR(status = 'sent') THEN 'sent'
            ELSE NULL
          END AS target_status,
          MIN(event_timestamp) FILTER (WHERE status IN ('delivered', 'read')) AS delivered_at,
          MIN(event_timestamp) FILTER (WHERE status = 'read') AS read_at,
          (ARRAY_AGG(jsonb_build_object('code', error_code, 'message', error_message)) FILTER (WHERE status = 'failed' AND error_code IS NOT NULL))[1] AS error_details
        FROM public.message_status_events
        WHERE wamid = $1
        GROUP BY wamid
      )
      UPDATE public.messages m
      SET delivery_status = e.target_status,
          delivered_at = COALESCE(e.delivered_at, m.delivered_at),
          read_at = COALESCE(e.read_at, m.read_at),
          error_details = CASE WHEN e.target_status = 'failed' THEN COALESCE(e.error_details, m.error_details) ELSE m.error_details END
      FROM events_summary e
      WHERE m.wamid = e.wamid
        AND e.target_status IS NOT NULL
        AND (
          (
            e.target_status != 'failed'
            AND CASE m.delivery_status
              WHEN 'queued' THEN 0
              WHEN 'sent' THEN 1
              WHEN 'delivered' THEN 2
              WHEN 'read' THEN 3
              ELSE 0
            END < CASE e.target_status
              WHEN 'queued' THEN 0
              WHEN 'sent' THEN 1
              WHEN 'delivered' THEN 2
              WHEN 'read' THEN 3
              ELSE 0
            END
          )
          OR (
            e.target_status = 'failed'
            AND m.delivery_status IN ('queued', 'sent')
          )
        )
      RETURNING m.*;
    `;

    const reconcileResult = await db.query(reconcileQuery, [params.wamid]);
    const finalRecord = (reconcileResult.rows[0] as MessageRecord) || inserted;

    logger.debug(
      { wamid: params.wamid, deliveryStatus: finalRecord.delivery_status },
      'Mensaje saliente registrado y reconciliado en base de datos'
    );
    return finalRecord;
  }

  /**
   * Recupera la ventana móvil de contexto (últimos N mensajes) para la inferencia de IA.
   * Se devuelven en orden cronológico ascendente (más antiguo primero).
   */
  public async getSlidingContextWindow(conversationId: string, limit: number = 6): Promise<MessageRecord[]> {
    const query = `
      SELECT * FROM (
        SELECT * FROM public.messages
        WHERE conversation_id = $1
          AND content != 'PENDING_PROCESSING'
        ORDER BY created_at DESC
        LIMIT $2
      ) AS recent_msgs
      ORDER BY created_at ASC;
    `;
    const result = await db.query(query, [conversationId, limit]);
    return result.rows as MessageRecord[];
  }

  /**
   * Busca un mensaje por su wamid.
   */
  public async findByWamid(wamid: string): Promise<MessageRecord | null> {
    const query = `SELECT * FROM public.messages WHERE wamid = $1 LIMIT 1;`;
    const result = await db.query(query, [wamid]);
    return (result.rows[0] as MessageRecord) || null;
  }

  /**
   * Auditor 5A & I16: Actualiza el estado de entrega con:
   * 1. Inserción append-only en message_status_events con ON CONFLICT DO NOTHING para idempotencia.
   * 2. Lista blanca estricta de estados.
   * 3. Avance monótono de rangos: queued (0) < sent (1) < delivered (2) < read (3).
   * 4. Estado 'failed' únicamente admisible desde 'queued' o 'sent' (no puede fallar tras delivered/read).
   * 5. Almacenamiento estructurado de errores de Meta.
   */
  public async updateDeliveryStatus(
    wamid: string,
    status: 'sent' | 'delivered' | 'read' | 'failed',
    timestamp?: Date,
    errorDetails?: { code?: string | number; message?: string }
  ): Promise<MessageRecord | null> {
    const ts = timestamp || new Date();
    const validStatuses = ['queued', 'sent', 'delivered', 'read', 'failed'];
    if (!validStatuses.includes(status)) {
      logger.warn({ wamid, status }, 'Intento de actualizar estado con valor no reconocido en whitelist');
      return null;
    }

    // 1. Registro append-only del evento con ON CONFLICT DO NOTHING
    try {
      await db.query(
        `INSERT INTO public.message_status_events (wamid, status, error_code, error_message, raw_payload, event_timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (wamid, status, event_timestamp) DO NOTHING;`,
        [
          wamid,
          status,
          errorDetails?.code ? String(errorDetails.code) : null,
          errorDetails?.message ? String(errorDetails.message) : null,
          errorDetails ? JSON.stringify(errorDetails) : null,
          ts,
        ]
      );
    } catch (eventErr) {
      logger.error({ wamid, status, eventErr }, 'Error al insertar evento en message_status_events');
    }

    // 2. Actualización monótona de la tabla messages
    const errJson = errorDetails ? JSON.stringify(errorDetails) : null;
    const query = `
      UPDATE public.messages
      SET delivery_status = $1,
          delivered_at = CASE WHEN $1 IN ('delivered', 'read') THEN COALESCE(delivered_at, $2) ELSE delivered_at END,
          read_at = CASE WHEN $1 = 'read' THEN COALESCE(read_at, $2) ELSE read_at END,
          error_details = CASE WHEN $1 = 'failed' THEN $4::jsonb ELSE error_details END
      WHERE wamid = $3
        AND (
          (
            $1 != 'failed'
            AND CASE delivery_status
              WHEN 'queued' THEN 0
              WHEN 'sent' THEN 1
              WHEN 'delivered' THEN 2
              WHEN 'read' THEN 3
              ELSE 0
            END < CASE $1
              WHEN 'queued' THEN 0
              WHEN 'sent' THEN 1
              WHEN 'delivered' THEN 2
              WHEN 'read' THEN 3
              ELSE 0
            END
          )
          OR (
            $1 = 'failed'
            AND delivery_status IN ('queued', 'sent')
          )
        )
      RETURNING *;
    `;

    const result = await db.query(query, [status, ts, wamid, errJson]);
    const updated = (result.rows[0] as MessageRecord) || null;

    if (updated) {
      logger.debug({ wamid, status, deliveryStatus: updated.delivery_status }, 'Estado de entrega actualizado en DB');
    } else {
      logger.debug(
        { wamid, status },
        'Aviso: updateDeliveryStatus no modificó fila (carrera inversa o status de menor rango ignorado)'
      );
    }

    return updated;
  }
}

export const messageRepository = new MessageRepository();
