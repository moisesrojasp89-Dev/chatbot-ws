import { FastifyReply, FastifyRequest } from 'fastify';
import { handleChannelWebhook } from './channelWebhookController.js';

/**
 * POST /webhook/telegram
 * Envoltorio fino del controller genérico para el canal Telegram.
 */
export async function handleTelegramWebhook(
  request: FastifyRequest<{ Body: unknown }>,
  reply: FastifyReply
): Promise<void> {
  return handleChannelWebhook('telegram', request, reply);
}
