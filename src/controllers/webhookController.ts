import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { getMetaConfig } from '../providers/channels/meta/metaConfig.js';
import { validateMetaSignature } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { phoneRateLimiter } from '../middleware/rateLimiter.js';
import { MetaWebhookPayload } from '../types/meta.js';
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
 * Endpoint de ingesta de eventos de Meta WhatsApp Cloud API.
 * SLA: Responde HTTP 200 OK de inmediato (< 500ms).
 * Auditor 5B (I18):
 * - Persistencia síncrona en inbound_events antes de emitir el ACK 200.
 * - Si la base de datos falla, retorna 500 para forzar reintento de Meta.
 * - Idempotencia absoluta por UNIQUE(wamid) en base de datos (ON CONFLICT DO NOTHING).
 * - Cero llamadas a LLM ni a AgentEngine en la ruta de ACK.
 */
export async function handleIncomingWebhook(
  request: FastifyRequest<{
    Body: MetaWebhookPayload;
  }>,
  reply: FastifyReply
): Promise<void> {
  const signature = request.headers['x-hub-signature-256'] as string | undefined;
  const rawBody = (request as unknown as { rawBody?: string | Buffer }).rawBody;

  // 1. Validación Criptográfica HMAC SHA-256
  const isValidSignature = validateMetaSignature(rawBody, signature);
  if (!isValidSignature) {
    logger.warn({ ip: request.ip }, '🚨 Petición de webhook rechazada: Firma HMAC SHA-256 inválida o ausente');
    reply.status(401).send({ error: 'Unauthorized. Invalid HMAC signature.' });
    return;
  }

  const payload = request.body;
  if (payload?.object !== 'whatsapp_business_account' || !payload.entry) {
    reply.status(200).send({ status: 'ok' });
    return;
  }

  try {
    // 2. Auditor 5B (I18): Persistencia síncrona en inbound_events antes de emitir el ACK 200
    for (const entry of payload.entry) {
      if (!entry.changes) continue;
      for (const change of entry.changes) {
        const value = change.value;
        if (!value || value.messaging_product !== 'whatsapp') continue;

        // A. Status Updates de Meta
        if (value.statuses && Array.isArray(value.statuses)) {
          for (const statusObj of value.statuses) {
            const wamid = statusObj.id;
            const status = statusObj.status;
            const parsedSeconds = statusObj.timestamp ? Number.parseInt(statusObj.timestamp, 10) : Number.NaN;
            const timestamp = Number.isFinite(parsedSeconds)
              ? new Date(parsedSeconds * 1000)
              : new Date(0); // Epoch determinista de respaldo para no romper la idempotencia de UNIQUE(wamid, status, event_timestamp)
            const errorObj =
              statusObj.errors && Array.isArray(statusObj.errors) && statusObj.errors.length > 0
                ? statusObj.errors[0]
                : undefined;
            const errorDetails = errorObj
              ? { code: errorObj.code, message: errorObj.title || (errorObj as { message?: string }).message }
              : undefined;

            await messageRepository.updateDeliveryStatus(wamid, status, timestamp, errorDetails);
          }
        }

        // B. Mensajes entrantes de clientes
        if (value.messages && Array.isArray(value.messages)) {
          const rawPhoneNumberId = value.metadata?.phone_number_id;
          if (
            !rawPhoneNumberId ||
            typeof rawPhoneNumberId !== 'string' ||
            rawPhoneNumberId.trim() === '' ||
            rawPhoneNumberId === 'UNKNOWN'
          ) {
            // C5: Log MALFORMED_WEBHOOK_PAYLOAD, registrar auditoría y descartar sin procesar ni usar fallback global
            logger.warn(
              { alert: 'MALFORMED_WEBHOOK_PAYLOAD', metadata: value.metadata },
              '⚠️ Webhook recibido sin phone_number_id válido en metadata: descartando mensaje para evitar contaminación multi-tenant'
            );
            try {
              await auditRepository.logEvent(null, 'MALFORMED_WEBHOOK_PAYLOAD', 'SYSTEM', {
                metadata: value.metadata,
                messagesCount: value.messages.length,
              });
            } catch (auditErr) {
              logger.error({ auditErr }, 'Error registrando auditoría de webhook malformado');
            }
            continue;
          }

          const phoneNumberId = rawPhoneNumberId.trim();
          for (const msg of value.messages) {
            const from = msg.from;
            const wamid = msg.id;

            if (phoneRateLimiter.isRateLimited(from)) {
              logger.warn({ phoneNumber: from, wamid }, 'Usuario superó el límite de tasa (Rate Limited)');
              try {
                await auditRepository.logEvent(null, 'RATE_LIMIT_EXCEEDED', 'SYSTEM', {
                  phoneNumber: from,
                  wamid,
                });
              } catch (auditErr) {
                logger.error({ auditErr }, 'Error registrando auditoría de rate limit');
              }
              continue;
            }

            // Auditor 5B (I18 & Punto 4): Única compuerta duradera en inbound_events (ON CONFLICT DO NOTHING)
            const persisted = await inboundRepository.persistInboundEvent({
              wamid,
              phoneNumberId,
              senderPhone: from,
              payload: {
                message: msg,
                contact: value.contacts?.[0],
                metadata: value.metadata,
              },
              channel: 'whatsapp',
            });

            if (persisted) {
              logger.info({ wamid, senderPhone: from }, '📥 Evento inbound persistido duraderamente en PostgreSQL');
            } else {
              logger.info({ wamid, senderPhone: from }, 'Evento inbound duplicado interceptado (ON CONFLICT DO NOTHING)');
            }
          }
        }
      }
    }

    // 3. Acuse de recibo exitoso a Meta tras persistir en DB (< 500ms)
    // CRÍTICO: El camino del ACK NO llama al LLM ni a AgentEngine
    reply.status(200).send({ status: 'ok' });
  } catch (error) {
    logger.error({ error }, '🚨 Error al persistir evento inbound en base de datos. Respondiendo 500 para reintento de Meta');
    reply.status(500).send({ error: 'Database persistence error' });
  }
}
