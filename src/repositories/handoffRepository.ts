import { db } from '../providers/database/dbClient.js';
import { HandoffRecord } from '../types/states.js';
import { logger } from '../utils/logger.js';

export class HandoffRepository {
  /**
   * Crea un nuevo ticket de escalamiento a asesor humano.
   */
  public async createHandoffSession(
    conversationId: string,
    triggerReason: 'USER_REQUEST' | 'FRUSTRATION' | 'TOOL_FAILURE' | 'OUT_OF_SCOPE',
    briefing: string
  ): Promise<HandoffRecord> {
    const query = `
      INSERT INTO public.handoff_sessions (
        conversation_id, trigger_reason, ai_briefing_for_agent, status, triggered_at
      )
      VALUES ($1, $2, $3, 'PENDING', NOW())
      RETURNING *;
    `;
    const result = await db.query(query, [conversationId, triggerReason, briefing]);
    logger.warn(
      { handoffId: result.rows[0].id, conversationId, triggerReason },
      '🚨 Sesión de Human Handoff registrada en base de datos'
    );
    return result.rows[0] as HandoffRecord;
  }

  /**
   * C6: Consulta sesiones pendientes que superen X minutos de inactividad (para HandoffTimeoutChecker).
   */
  public async getPendingHandoffsOlderThan(minutes: number = 15): Promise<HandoffRecord[]> {
    // I6: Multiplicación directa de intervalos para prevenir errores de casteo y SQL injection
    const query = `
      SELECT * FROM public.handoff_sessions
      WHERE status = 'PENDING'
        AND triggered_at < NOW() - ($1::int * INTERVAL '1 minute');
    `;
    const result = await db.query(query, [minutes]);
    return result.rows as HandoffRecord[];
  }

  /**
   * Marca una sesión como atendida y resuelta por un asesor.
   */
  public async resolveHandoff(id: string, agentEmail?: string): Promise<HandoffRecord | null> {
    const query = `
      UPDATE public.handoff_sessions
      SET status = 'RESOLVED',
          assigned_agent_email = COALESCE($1, assigned_agent_email),
          resolved_at = NOW()
      WHERE id = $2
      RETURNING *;
    `;
    const result = await db.query(query, [agentEmail || null, id]);
    return (result.rows[0] as HandoffRecord) || null;
  }

  /**
   * C6: Marca una sesión como expirada por falta de atención humana.
   */
  public async markTimeout(id: string): Promise<void> {
    const query = `
      UPDATE public.handoff_sessions
      SET status = 'TIMEOUT', resolved_at = NOW()
      WHERE id = $1;
    `;
    await db.query(query, [id]);
    logger.warn({ handoffId: id }, 'Sesión de handoff marcada como TIMEOUT por inactividad');
  }
}

export const handoffRepository = new HandoffRepository();
