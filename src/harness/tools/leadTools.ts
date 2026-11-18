import { PoolClient } from 'pg';
import { leadRepository } from '../../repositories/leadRepository.js';
import { conversationRepository } from '../../repositories/conversationRepository.js';
import { auditRepository } from '../../repositories/auditRepository.js';
import { logger } from '../../utils/logger.js';

export interface CreateQualifiedLeadArgs {
  contactId: string;
  conversationId: string;
  productInterest: string;
  estimatedBudget?: number;
  customerEmail?: string;
  customerCity?: string;
  notes?: string;
}

export interface QualifiedLeadResult {
  success: boolean;
  leadId?: string;
  message: string;
}

export interface LeadToolOptions {
  defer?: boolean;
  client?: PoolClient;
}

/**
 * Registra y califica formalmente una oportunidad de venta en la base de datos (C1).
 * Si options.defer es true, difiere la persistencia para ser ejecutada dentro de la transacción atómica final.
 */
export async function createQualifiedLead(
  args: CreateQualifiedLeadArgs,
  options?: LeadToolOptions
): Promise<QualifiedLeadResult> {
  if (options?.defer) {
    logger.info(
      { contactId: args.contactId, productInterest: args.productInterest },
      '🎯 Tool createQualifiedLead: acción diferida para transacción atómica única'
    );
    return {
      success: true,
      leadId: 'staged-lead',
      message: `Lead calificado con éxito para ${args.productInterest}. Se ha notificado al equipo comercial.`,
    };
  }

  return executeLeadInTransaction(args, options?.client);
}

/**
 * Ejecuta la creación del lead, transición de estado y auditoría atómicamente con un cliente transaccional opcional.
 */
export async function executeLeadInTransaction(
  args: CreateQualifiedLeadArgs,
  client?: PoolClient
): Promise<QualifiedLeadResult> {
  try {
    logger.info(
      { contactId: args.contactId, productInterest: args.productInterest },
      '🎯 Ejecutando Tool: createQualifiedLead'
    );

    const lead = await leadRepository.createLead(
      {
        contactId: args.contactId,
        conversationId: args.conversationId,
        productInterest: args.productInterest,
        estimatedBudget: args.estimatedBudget,
        qualificationStage: args.customerEmail ? 'WARM' : 'COLD',
        extractedData: {
          email: args.customerEmail,
          city: args.customerCity,
          notes: args.notes,
        },
      },
      client
    );

    // Transición de la FSM a CLOSING si estaba en QUALIFYING o IDLE
    if (client) {
      await conversationRepository.transitionState(
        args.conversationId,
        'CLOSING',
        `Lead calificado: ${args.productInterest}`,
        undefined,
        client
      );
    } else {
      await conversationRepository.transitionState(
        args.conversationId,
        'CLOSING',
        `Lead calificado: ${args.productInterest}`
      );
    }

    // Registro de auditoría
    await auditRepository.logEvent(
      args.conversationId,
      'TOOL_CALL',
      'BOT',
      { tool: 'createQualifiedLead', leadId: lead.id, product: args.productInterest },
      client
    );

    return {
      success: true,
      leadId: lead.id,
      message: `Lead calificado con éxito para ${args.productInterest}. Se ha notificado al equipo comercial.`,
    };
  } catch (error) {
    logger.error({ error, args }, 'Error al ejecutar createQualifiedLead');
    return {
      success: false,
      message: 'No fue posible registrar el lead en este momento.',
    };
  }
}

