import { ChannelAdapter, ParsedInbound } from '../providers/channels/channelTypes.js';
import { inboundRepository } from '../repositories/inboundRepository.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { auditRepository } from '../repositories/auditRepository.js';
import { phoneRateLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';

export interface IngestResult {
  persisted: number;
  duplicates: number;
  rateLimited: number;
  ignored: number;
  statuses: number;
}

/**
 * Ingesta genérica del sobre normalizado.
 *
 * Es agnóstica al canal: el adaptador ya verificó/parseó y solo aporta la clave
 * de rate limit. Persiste mensajes y reconcilia statuses antes del ACK.
 */
export async function ingestParsedInbound(
  adapter: ChannelAdapter,
  parsed: ParsedInbound
): Promise<IngestResult> {
  const result: IngestResult = {
    persisted: 0,
    duplicates: 0,
    rateLimited: 0,
    ignored: 0,
    statuses: 0,
  };

  for (const statusEvent of parsed.statuses) {
    const timestamp = new Date(statusEvent.occurredAt);
    const firstError = Array.isArray(statusEvent.errors) ? statusEvent.errors[0] : undefined;
    const errorDetails = firstError
      ? {
          code: (firstError as { code?: string | number }).code,
          message:
            (firstError as { title?: string; message?: string }).title ||
            (firstError as { message?: string }).message,
        }
      : undefined;

    await messageRepository.updateDeliveryStatus(
      statusEvent.externalMessageId,
      statusEvent.status,
      Number.isNaN(timestamp.getTime()) ? new Date(0) : timestamp,
      errorDetails
    );
    result.statuses++;
  }

  for (const message of parsed.messages) {
    const accountId = typeof message.externalAccountId === 'string' ? message.externalAccountId.trim() : '';

    // C5: metadata inválida → auditar y descartar sin fallback global.
    if (!accountId || accountId === 'UNKNOWN') {
      const auditMetadata = (message.raw as { metadata?: unknown })?.metadata ?? {
        channel: message.channel,
        externalAccountId: message.externalAccountId,
        externalMessageId: message.externalMessageId,
      };
      logger.warn(
        { alert: 'MALFORMED_WEBHOOK_PAYLOAD', metadata: auditMetadata },
        '⚠️ Webhook sin phone_number_id válido en metadata: descartando mensaje para evitar contaminación multi-tenant'
      );
      try {
        await auditRepository.logEvent(null, 'MALFORMED_WEBHOOK_PAYLOAD', 'SYSTEM', {
          metadata: auditMetadata,
          messagesCount: 1,
        });
      } catch (auditErr) {
        logger.error({ auditErr }, 'Error registrando auditoría de webhook malformado');
      }
      result.ignored++;
      continue;
    }

    const rateLimitKey = adapter.rateLimitKey?.(message.senderId) ?? message.senderId;
    if (phoneRateLimiter.isRateLimited(rateLimitKey)) {
      logger.warn(
        { phoneNumber: message.senderId, wamid: message.externalMessageId },
        'Usuario superó el límite de tasa (Rate Limited)'
      );
      try {
        await auditRepository.logEvent(null, 'RATE_LIMIT_EXCEEDED', 'SYSTEM', {
          phoneNumber: message.senderId,
          wamid: message.externalMessageId,
        });
      } catch (auditErr) {
        logger.error({ auditErr }, 'Error registrando auditoría de rate limit');
      }
      result.rateLimited++;
      continue;
    }

    const persisted = await inboundRepository.persistInboundEvent({
      wamid: message.externalMessageId,
      phoneNumberId: accountId,
      senderPhone: message.senderId,
      recipientId: message.recipientId,
      payload: message,
      channel: message.channel,
    });

    if (persisted) {
      result.persisted++;
      logger.info(
        { wamid: message.externalMessageId, senderPhone: message.senderId, channel: message.channel },
        '📥 Evento inbound persistido duraderamente en PostgreSQL'
      );
    } else {
      result.duplicates++;
      logger.info(
        { wamid: message.externalMessageId, senderPhone: message.senderId, channel: message.channel },
        'Evento inbound duplicado interceptado (ON CONFLICT DO NOTHING)'
      );
    }
  }

  return result;
}
