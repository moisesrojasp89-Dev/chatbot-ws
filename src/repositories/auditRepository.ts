import { db } from '../providers/database/dbClient.js';
import { AuditRecord } from '../types/states.js';
import { logger } from '../utils/logger.js';

import { PoolClient } from 'pg';

export class AuditRepository {
  /**
   * M1: Inserta un evento append-only de auditoría forense.
   */
  public async logEvent(
    conversationId: string | null,
    eventType: string,
    actor: 'USER' | 'BOT' | 'AGENT' | 'SYSTEM',
    payload: Record<string, unknown> = {},
    client?: PoolClient
  ): Promise<AuditRecord> {
    const query = `
      INSERT INTO public.audit_log (conversation_id, event_type, actor, payload)
      VALUES ($1, $2, $3, $4::jsonb)
      RETURNING *;
    `;
    const values = [
      conversationId,
      eventType,
      actor,
      JSON.stringify(payload),
    ];
    const result = client ? await client.query(query, values) : await db.query(query, values);

    logger.debug({ eventType, actor, conversationId }, 'Evento de auditoría registrado');
    return result.rows[0] as AuditRecord;
  }

  /**
   * Obtiene todos los eventos de auditoría de una conversación.
   */
  public async getEventsByConversation(conversationId: string): Promise<AuditRecord[]> {
    const query = `
      SELECT * FROM public.audit_log
      WHERE conversation_id = $1
      ORDER BY created_at ASC;
    `;
    const result = await db.query(query, [conversationId]);
    return result.rows as AuditRecord[];
  }
}

export const auditRepository = new AuditRepository();
