import { FastifyRequest, FastifyReply } from 'fastify';
import { telegramChannelSender } from '../providers/channels/telegram/telegramChannelSender.js';
import { inboundRepository } from '../repositories/inboundRepository.js';
import { phoneRateLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';

/**
 * POST /webhook/telegram
 *
 * Controller fino: el adaptador Telegram verifica el secret token y traduce el
 * update al sobre normalizado. El controller solo aplica rate limit y persiste
 * durablemente antes del ACK.
 */
export async function handleTelegramWebhook(
  request: FastifyRequest<{ Body: unknown }>,
  reply: FastifyReply
): Promise<void> {
  let verified: boolean;
  try {
    verified = telegramChannelSender.verifyInbound({ headers: request.headers });
  } catch (error) {
    logger.error({ error }, 'Telegram no está configurado para recibir webhooks');
    reply.status(503).send({ error: 'Telegram channel not configured' });
    return;
  }

  if (!verified) {
    logger.warn({ ip: request.ip }, '🚨 Webhook de Telegram rechazado: secret token inválido o ausente');
    reply.status(401).send({ error: 'Unauthorized. Invalid Telegram secret token.' });
    return;
  }

  const { messages } = telegramChannelSender.parseInbound(request.body);
  if (messages.length === 0) {
    // Mensajes no-texto o updates sin mensaje: ACK para que Telegram no reintente.
    reply.status(200).send({ status: 'ignored' });
    return;
  }

  try {
    for (const message of messages) {
      if (phoneRateLimiter.isRateLimited(`telegram:${message.senderId}`)) {
        logger.warn(
          { chatId: message.senderId, updateId: message.externalMessageId },
          'Telegram: usuario superó el límite de tasa'
        );
        continue;
      }

      const persisted = await inboundRepository.persistInboundEvent({
        wamid: message.externalMessageId,
        phoneNumberId: message.externalAccountId,
        senderPhone: message.senderId,
        channel: message.channel,
        payload: message,
      });

      if (persisted) {
        logger.info(
          { channel: message.channel, updateId: message.externalMessageId },
          '📥 Evento Telegram persistido duraderamente'
        );
      } else {
        logger.info(
          { channel: message.channel, updateId: message.externalMessageId },
          'Evento Telegram duplicado interceptado'
        );
      }
    }

    reply.status(200).send({ status: 'ok' });
  } catch (error) {
    logger.error({ error }, '🚨 Error al persistir evento Telegram; respondiendo 500 para reintento');
    reply.status(500).send({ error: 'Database persistence error' });
  }
}
