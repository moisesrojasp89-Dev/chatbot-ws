import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getTelegramConfig } from '../providers/channels/telegram/telegramConfig.js';
import { inboundRepository } from '../repositories/inboundRepository.js';
import { phoneRateLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';

const telegramUpdateSchema = z
  .object({
    update_id: z.number().int(),
    message: z
      .object({
        message_id: z.number().optional(),
        date: z.number().optional(),
        text: z.string().optional(),
        chat: z.object({ id: z.union([z.number(), z.string()]) }).optional(),
        from: z
          .object({
            first_name: z.string().optional(),
            last_name: z.string().optional(),
            username: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftHash = crypto.createHash('sha256').update(left).digest();
  const rightHash = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

/**
 * POST /webhook/telegram
 *
 * Ingress mínimo del adaptador Telegram: valida el secret token, traduce el
 * update al sobre interno de inbound_events y responde 200 tras persistir.
 * Los mensajes no-texto se aceptan con 200 pero no se procesan todavía.
 */
export async function handleTelegramWebhook(
  request: FastifyRequest<{ Body: unknown }>,
  reply: FastifyReply
): Promise<void> {
  let webhookSecret: string;
  try {
    webhookSecret = getTelegramConfig().webhookSecret;
  } catch (error) {
    logger.error({ error }, 'Telegram no está configurado para recibir webhooks');
    reply.status(503).send({ error: 'Telegram channel not configured' });
    return;
  }

  const header = request.headers['x-telegram-bot-api-secret-token'];
  const providedSecret = Array.isArray(header) ? header[0] : header;
  if (!providedSecret || !timingSafeStringEqual(providedSecret, webhookSecret)) {
    logger.warn({ ip: request.ip }, '🚨 Webhook de Telegram rechazado: secret token inválido o ausente');
    reply.status(401).send({ error: 'Unauthorized. Invalid Telegram secret token.' });
    return;
  }

  const parsedUpdate = telegramUpdateSchema.safeParse(request.body);
  if (!parsedUpdate.success) {
    logger.warn({ issues: parsedUpdate.error.issues.length }, 'Telegram: update malformado, ignorado');
    reply.status(200).send({ status: 'ignored' });
    return;
  }

  const update = parsedUpdate.data;
  const message = update.message;
  const chatId = message?.chat?.id;
  const text = message?.text;

  if (chatId === undefined || typeof text !== 'string') {
    // Mensajes no-texto o updates sin mensaje: ACK para que Telegram no reintente.
    reply.status(200).send({ status: 'ignored' });
    return;
  }

  const senderId = String(chatId);
  if (phoneRateLimiter.isRateLimited(`telegram:${senderId}`)) {
    logger.warn({ chatId: senderId, updateId: update.update_id }, 'Telegram: usuario superó el límite de tasa');
    reply.status(200).send({ status: 'rate_limited' });
    return;
  }

  const externalMessageId = `tg:in:${update.update_id}`;
  const displayName =
    [message?.from?.first_name, message?.from?.last_name].filter(Boolean).join(' ').trim() ||
    message?.from?.username ||
    'desconocido';

  try {
    const persisted = await inboundRepository.persistInboundEvent({
      wamid: externalMessageId,
      phoneNumberId: 'telegram',
      senderPhone: senderId,
      channel: 'telegram',
      payload: {
        message: {
          id: externalMessageId,
          from: senderId,
          type: 'text',
          text: { body: text },
          timestamp: message?.date ? String(message.date) : undefined,
        },
        contact: { profile: { name: displayName } },
        metadata: { phone_number_id: 'telegram' },
      },
    });

    if (persisted) {
      logger.info({ channel: 'telegram', updateId: update.update_id }, '📥 Evento Telegram persistido duraderamente');
    } else {
      logger.info({ channel: 'telegram', updateId: update.update_id }, 'Evento Telegram duplicado interceptado');
    }

    reply.status(200).send({ status: 'ok' });
  } catch (error) {
    logger.error({ error }, '🚨 Error al persistir evento Telegram; respondiendo 500 para reintento');
    reply.status(500).send({ error: 'Database persistence error' });
  }
}
