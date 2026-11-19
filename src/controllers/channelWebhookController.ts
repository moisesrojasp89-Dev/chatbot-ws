import { FastifyReply, FastifyRequest } from 'fastify';
import { channelRegistry } from '../providers/channels/channelRegistry.js';
import { ingestParsedInbound } from '../services/inboundIngestor.js';
import { logger } from '../utils/logger.js';

/**
 * Controller genérico de webhooks.
 *
 * El adaptador del canal verifica autenticidad y traduce el payload; este
 * controller solo aplica el ACK y delega la persistencia al ingestor común.
 * Agregar un canal no requiere tocar este archivo.
 */
export async function handleChannelWebhook(
  channel: string,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const adapter = channelRegistry.getAdapter(channel);
  const signature = request.headers['x-hub-signature-256'] as string | undefined;
  const rawBody = (request as unknown as { rawBody?: string | Buffer }).rawBody;

  let verified: boolean;
  try {
    verified = await adapter.verifyInbound({
      headers: request.headers,
      rawBody,
      signature,
    });
  } catch (error) {
    logger.error({ channel, error }, `Canal ${channel} no configurado para recibir webhooks`);
    reply.status(503).send({ error: `${channel} channel not configured` });
    return;
  }

  if (!verified) {
    logger.warn({ channel, ip: request.ip }, `🚨 Webhook de ${channel} rechazado: autenticidad inválida`);
    reply.status(401).send({ error: 'Unauthorized. Invalid webhook authentication.' });
    return;
  }

  let parsed;
  try {
    parsed = adapter.parseInbound(request.body);
  } catch (error) {
    logger.warn({ channel, error }, `Webhook ${channel} malformado: se ignora con ACK 200`);
    reply.status(200).send({ status: 'ignored' });
    return;
  }

  if (parsed.messages.length === 0 && parsed.statuses.length === 0) {
    reply.status(200).send({ status: 'ok' });
    return;
  }

  try {
    const result = await ingestParsedInbound(adapter, parsed);
    logger.info({ channel, ...result }, `✅ Ingesta ${channel} completada`);
    reply.status(200).send({ status: 'ok' });
  } catch (error) {
    logger.error({ channel, error }, `🚨 Error al persistir evento ${channel}; respondiendo 500 para reintento`);
    reply.status(500).send({ error: 'Database persistence error' });
  }
}
