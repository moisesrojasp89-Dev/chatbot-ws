import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { messageRepository } from '../repositories/messageRepository.js';

export interface ConversationUsage {
  messages: number;
  tokens: number;
}

export interface QuotaLimits {
  maxTurns: number;
  maxTokens: number;
}

export type QuotaReason = 'TURNS' | 'TOKENS';

export interface QuotaDecision {
  allowed: boolean;
  reason?: QuotaReason;
  usage: ConversationUsage;
  limits: QuotaLimits;
}

/**
 * Evalúa la cuota acumulada. Es pura para poder testearla sin DB.
 */
export function evaluateConversationQuota(
  usage: ConversationUsage,
  limits: QuotaLimits
): QuotaDecision {
  if (usage.messages >= limits.maxTurns) {
    return { allowed: false, reason: 'TURNS', usage, limits };
  }
  if (usage.tokens >= limits.maxTokens) {
    return { allowed: false, reason: 'TOKENS', usage, limits };
  }
  return { allowed: true, usage, limits };
}

export class ConversationQuotaService {
  public async check(conversationId: string): Promise<QuotaDecision> {
    const limits: QuotaLimits = {
      maxTurns: env.MAX_CONVERSATION_TURNS,
      maxTokens: env.MAX_CONVERSATION_TOKENS,
    };

    try {
      const usage = await messageRepository.getConversationUsage(conversationId);
      const decision = evaluateConversationQuota(usage, limits);

      if (!decision.allowed) {
        logger.warn(
          { conversationId, reason: decision.reason, usage, limits },
          '🛑 Cuota de conversación alcanzada: se corta el bucle y se escala'
        );
      }

      return decision;
    } catch (error) {
      // La cuota es una protección, no un punto único de fallo: si la lectura falla,
      // se permite el turno y se registra para no bloquear ventas.
      logger.error({ error, conversationId }, 'No se pudo evaluar la cuota de conversación');
      return { allowed: true, usage: { messages: 0, tokens: 0 }, limits };
    }
  }
}

export const conversationQuota = new ConversationQuotaService();
