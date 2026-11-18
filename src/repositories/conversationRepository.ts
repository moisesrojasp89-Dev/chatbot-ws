import pg from 'pg';
import { db } from '../providers/database/dbClient.js';
import { ConversationRecord, FSMState, isValidFSMTransition } from '../types/states.js';
import { logger } from '../utils/logger.js';

export class ConversationRepository {
  /**
   * F2-C2: Obtiene la sesión activa o crea una nueva.
   * Cierra explícitamente cualquier sesión previa inactiva (> 30 min) antes de proceder.
   */
  public async getOrCreateActiveSession(contactId: string): Promise<ConversationRecord> {
    // 1. Cerrar explícitamente sesiones expiradas por inactividad (> 30 minutos)
    const closeExpiredQuery = `
      UPDATE public.conversations
      SET current_state = 'CLOSED', closed_at = NOW()
      WHERE contact_id = $1
        AND current_state != 'CLOSED'
        AND last_interaction_at < NOW() - INTERVAL '30 minutes';
    `;
    await db.query(closeExpiredQuery, [contactId]);

    // 2. Buscar si existe una sesión activa no expirada
    const findActiveQuery = `
      SELECT * FROM public.conversations
      WHERE contact_id = $1 AND current_state != 'CLOSED'
      ORDER BY last_interaction_at DESC
      LIMIT 1;
    `;
    const activeRes = await db.query(findActiveQuery, [contactId]);
    if (activeRes.rows.length > 0) {
      return activeRes.rows[0] as ConversationRecord;
    }

    // 3. Si no existe sesión activa, crear una nueva en estado IDLE
    const createQuery = `
      INSERT INTO public.conversations (contact_id, current_state, last_interaction_at)
      VALUES ($1, 'IDLE', NOW())
      RETURNING *;
    `;
    const createRes = await db.query(createQuery, [contactId]);
    logger.info({ contactId, conversationId: createRes.rows[0].id }, 'Nueva sesión conversacional iniciada');
    return createRes.rows[0] as ConversationRecord;
  }

  /**
   * Busca una conversación por su ID.
   */
  public async findById(id: string): Promise<ConversationRecord | null> {
    const query = `SELECT * FROM public.conversations WHERE id = $1 LIMIT 1;`;
    const result = await db.query(query, [id]);
    return (result.rows[0] as ConversationRecord) || null;
  }

  /**
   * Ejecuta una transición de estado de la FSM y actualiza opcionalmente el context_summary.
   * I13: Valida preventivamente la legalidad de la transición según la FSM si currentState es provisto.
   */
  public async transitionState(
    id: string,
    newState: FSMState,
    summaryUpdate?: string,
    currentState?: FSMState,
    client?: pg.PoolClient
  ): Promise<ConversationRecord | null> {
    if (currentState && !isValidFSMTransition(currentState, newState)) {
      logger.warn(
        { conversationId: id, from: currentState, to: newState },
        '⚠️ Transición FSM fuera de la matriz estándar detectada'
      );
    }

    const query = `
      UPDATE public.conversations
      SET current_state = $1,
          context_summary = COALESCE($2, context_summary),
          last_interaction_at = NOW()
      WHERE id = $3
      RETURNING *;
    `;
    const executor = client || db;
    const result = await executor.query(query, [newState, summaryUpdate || null, id]);
    logger.info({ conversationId: id, newState }, 'Transición de estado FSM completada');
    return (result.rows[0] as ConversationRecord) || null;
  }

  /**
   * Incrementa el contador de mensajes y actualiza la última interacción.
   */
  public async touch(id: string): Promise<void> {
    const query = `
      UPDATE public.conversations
      SET total_messages_count = total_messages_count + 1,
          last_interaction_at = NOW()
      WHERE id = $1;
    `;
    await db.query(query, [id]);
  }

  /**
   * Actualiza el context_summary acumulativo de la conversación (F3-C4).
   */
  public async updateContextSummary(id: string, summary: string): Promise<void> {
    const query = `
      UPDATE public.conversations
      SET context_summary = $1,
          last_interaction_at = NOW()
      WHERE id = $2;
    `;
    await db.query(query, [summary, id]);
  }

  /**
   * Cierra manualmente una sesión (ej: compra concluida o handoff resuelto).
   */
  public async closeSession(id: string): Promise<ConversationRecord | null> {
    const query = `
      UPDATE public.conversations
      SET current_state = 'CLOSED', closed_at = NOW()
      WHERE id = $1
      RETURNING *;
    `;
    const result = await db.query(query, [id]);
    return (result.rows[0] as ConversationRecord) || null;
  }
}

export const conversationRepository = new ConversationRepository();
