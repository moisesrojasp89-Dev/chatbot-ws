import { PoolClient } from 'pg';
import { db } from '../../providers/database/dbClient.js';
import { logger } from '../../utils/logger.js';

export interface RequestHumanHandoffArgs {
  contactId: string;
  conversationId: string;
  reason?: 'USER_REQUEST' | 'FRUSTRATION' | 'TOOL_FAILURE' | 'OUT_OF_SCOPE' | 'SYSTEM_DELAY';
  briefing: string;
}

export interface HumanHandoffResult {
  success: boolean;
  handoffId?: string;
  alreadyInHandoff?: boolean;
  message: string;
}

export interface HandoffToolOptions {
  defer?: boolean;
  client?: PoolClient;
}

/**
 * F3-C5: Ejecuta el escalamiento a asesor humano verificando estado previo y
 * ejecutando las operaciones de forma atómica.
 * Si options.defer es true, difiere la persistencia para ser ejecutada dentro de la transacción atómica final.
 */
export async function requestHumanHandoff(
  args: RequestHumanHandoffArgs,
  options?: HandoffToolOptions
): Promise<HumanHandoffResult> {
  if (options?.defer) {
    logger.info(
      { contactId: args.contactId, conversationId: args.conversationId },
      '🚨 Tool requestHumanHandoff: acción diferida para transacción atómica única'
    );
    return {
      success: true,
      handoffId: 'staged-handoff',
      message:
        'He transferido tu caso a un asesor humano de nuestro equipo. En un momento continuará contigo por este mismo chat.',
    };
  }

  if (options?.client) {
    return executeHandoffInTransaction(args, options.client);
  }

  return db.withTransaction(async (client) => {
    return executeHandoffInTransaction(args, client);
  });
}

/**
 * Ejecuta el escalamiento a asesor humano dentro de la transacción provista.
 */
export async function executeHandoffInTransaction(
  args: RequestHumanHandoffArgs,
  client: PoolClient
): Promise<HumanHandoffResult> {
  const triggerReason = args.reason || 'USER_REQUEST';

  logger.warn(
    { contactId: args.contactId, conversationId: args.conversationId, reason: triggerReason },
    '🚨 Ejecutando Tool atómica: requestHumanHandoff (F3-C5)'
  );

  // 1. Verificar estado actual del contacto con lock para evitar doble handoff
  const checkContactQuery = `
    SELECT id, status, phone_number, profile_name
    FROM public.contacts
    WHERE id = $1
    FOR UPDATE;
  `;
  const contactRes = await client.query(checkContactQuery, [args.contactId]);
  if (contactRes.rows.length === 0) {
    throw new Error(`Contacto ${args.contactId} no encontrado`);
  }

  // La deduplicación es por conversación/chat, no por contacto global: el mismo
  // usuario puede tener handoff en un grupo y seguir con bot en otro.
  const existingHandoff = await client.query(
    `SELECT id FROM public.handoff_sessions
     WHERE conversation_id = $1
       AND status IN ('PENDING', 'ASSIGNED')
     LIMIT 1;`,
    [args.conversationId]
  );
  if (existingHandoff.rows.length > 0) {
    logger.info(
      { contactId: args.contactId, conversationId: args.conversationId },
      'La conversación ya tiene un handoff activo. Omitiendo duplicación.'
    );
    return {
      success: false,
      alreadyInHandoff: true,
      message: 'Tu conversación ya se encuentra asignada a un asesor humano que te atenderá en breve.',
    };
  }

  // 2. Cambiar estado del contacto a HUMAN_HANDOFF
  const updateContactQuery = `
    UPDATE public.contacts
    SET status = 'HUMAN_HANDOFF', updated_at = NOW()
    WHERE id = $1;
  `;
  await client.query(updateContactQuery, [args.contactId]);

  // 3. Crear sesión en handoff_sessions
  const createHandoffQuery = `
    INSERT INTO public.handoff_sessions (
      conversation_id, trigger_reason, ai_briefing_for_agent, status, triggered_at
    )
    VALUES ($1, $2, $3, 'PENDING', NOW())
    RETURNING id;
  `;
  const handoffRes = await client.query(createHandoffQuery, [
    args.conversationId,
    triggerReason,
    args.briefing,
  ]);
  const handoffId = handoffRes.rows[0].id;

  // 4. Transicionar la conversación a HUMAN_ESCALATION
  const updateConvQuery = `
    UPDATE public.conversations
    SET current_state = 'HUMAN_ESCALATION',
        last_interaction_at = NOW()
    WHERE id = $1;
  `;
  await client.query(updateConvQuery, [args.conversationId]);

  // 5. Auditoría de evento (I10: contactId registrado dentro del payload JSONB)
  const auditQuery = `
    INSERT INTO public.audit_log (event_type, actor, conversation_id, payload, created_at)
    VALUES ($1, 'BOT', $2, $3, NOW());
  `;
  await client.query(auditQuery, [
    'HUMAN_HANDOFF_TRIGGERED',
    args.conversationId,
    JSON.stringify({
      contactId: args.contactId,
      handoffId,
      triggerReason,
      briefing: args.briefing,
    }),
  ]);

  logger.info(
    { contactId: args.contactId, conversationId: args.conversationId, handoffId },
    '✅ Escalamiento a asesor humano completado atómicamente en 4 pasos'
  );

  return {
    success: true,
    handoffId,
    message:
      'He transferido tu caso a un asesor humano de nuestro equipo. En un momento continuará contigo por este mismo chat.',
  };
}

