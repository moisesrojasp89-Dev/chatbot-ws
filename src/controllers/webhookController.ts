import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { getMetaConfig } from '../providers/channels/meta/metaConfig.js';
import { metaChannelSender } from '../providers/channels/meta/metaChannelSender.js';
import { logger } from '../utils/logger.js';
import { phoneRateLimiter } from '../middleware/rateLimiter.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { inboundRepository } from '../repositories/inboundRepository.js';
import { auditRepository } from '../repositories/auditRepository.js';

/**
 * GET /webhook
 * Endpoint de verificación del Challenge de Meta WhatsApp Cloud API.
 */
export async function handleVerifyWebhook(
  request: FastifyRequest<{
    Querystring: {
      'hub.mode'?: string;
      'hub.verify_token'?: string;
      'hub.challenge'?: string;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const mode = request.query['hub.mode'];
  const token = request.query['hub.verify_token'];
  const challenge = request.query['hub.challenge'];

  const isValidToken =
    typeof token === 'string' &&
    crypto.timingSafeEqual(
      crypto.createHash('sha256').update(token).digest(),
      crypto.createHash('sha256').update(getMetaConfig().verifyToken).digest()
    );

  if (mode === 'subscribe' && isValidToken) {
    logger.info('✅ Webhook verificado exitosamente por Meta');
    reply.status(200).send(challenge);
    return;
  }

  logger.warn({ mode, hasToken: Boolean(token) }, '❌ Intento fallido de verificación de webhook no autorizado');
  reply.status(403).send({ error: 'Forbidden. Invalid verification token.' });
}

/**
 * POST /webhook
 * Controller fino de Meta: el adaptador valida la firma y traduce el payload
 * al sobre normalizado. El controller aplica rate limit/auditoría y persiste
 * durablemente antes del ACK 200.
 */
export async function handleIncomingWebhook(
  request: FastifyRequest<{ Body: unknown }>,
  reply: FastifyReply
): Promise<void> {
  const signature = request.headers['x-hub-signature-256'] as string | undefined;
  const rawBody = (request as unknown as { rawBody?: string | Buffer }).rawBody;

  // 1. Validación criptográfica HMAC SHA-256 delegada al adaptador Meta
  if (!metaChannelSender.verifyInbound({ rawBody, signature })) {
    logger.warn({ ip: request.ip }, '🚨 Petición de webhook rechazada: Firma HMAC SHA-256 inválida o ausente');
    reply.status(401).send({ error: 'Unauthorized. Invalid HMAC signature.' });
    return;
  }

  let parsed: ReturnType<typeof metaChannelSender.parseInbound>;
  try {
    parsed = metaChannelSender.parseInbound(request.body);
  } catch (error) {
    // Un payload autenticado pero malformado no debe provocar reintentos infinitos.
    logger.warn({ error }, 'Webhook Meta malformado: se ignora con ACK 200');
    reply.status(200).send({ status: 'ignored' });
    return;
  }

  const { messages, statuses } = parsed;
  if (messages.length === 0 && statuses.length === 0) {
    reply.status(200).send({ status: 'ok' });
    return;
  }

  try {
    // A. Status Updates normalizados por el adaptador
    for (const statusEvent of statuses) {
      const timestamp = new Date(statusEvent.occurredAt);
      const firstError = Array.isArray(statusEvent.errors) ? statusEvent.errors[0] : undefined;
      const errorDetails = firstError
        ? {
            code: (firstError as { code?: number }).code,
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
    }

    // B. Mensajes entrantes normalizados
    for (const message of messages) {
      const phoneNumberId = typeof message.externalAccountId === 'string' ? message.externalAccountId.trim() : '';

      // C5: metadata inválida → auditar y descartar sin fallback global.
      if (!phoneNumberId || phoneNumberId === 'UNKNOWN') {
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
        continue;
      }

      const from = message.senderId;
      if (phoneRateLimiter.isRateLimited(from)) {
        logger.warn(
          { phoneNumber: from, wamid: message.externalMessageId },
          'Usuario superó el límite de tasa (Rate Limited)'
        );
        try {
          await auditRepository.logEvent(null, 'RATE_LIMIT_EXCEEDED', 'SYSTEM', {
            phoneNumber: from,
            wamid: message.externalMessageId,
          });
        } catch (auditErr) {
          logger.error({ auditErr }, 'Error registrando auditoría de rate limit');
        }
        continue;
      }

      // Auditor 5B (I18 & Punto 4): Única compuerta duradera en inbound_events (ON CONFLICT DO NOTHING)
      const persisted = await inboundRepository.persistInboundEvent({
        wamid: message.externalMessageId,
        phoneNumberId,
        senderPhone: from,
        payload: message,
        channel: message.channel,
      });

      if (persisted) {
        logger.info(
          { wamid: message.externalMessageId, senderPhone: from },
          '📥 Evento inbound persistido duraderamente en PostgreSQL'
        );
      } else {
        logger.info(
          { wamid: message.externalMessageId, senderPhone: from },
          'Evento inbound duplicado interceptado (ON CONFLICT DO NOTHING)'
        );
      }
    }

    // 3. Acuse de recibo exitoso a Meta tras persistir en DB (< 500ms)
    reply.status(200).send({ status: 'ok' });
  } catch (error) {
    logger.error({ error }, '🚨 Error al persistir evento inbound en base de datos. Respondiendo 500 para reintento de Meta');
    reply.status(500).send({ error: 'Database persistence error' });
  }
}
