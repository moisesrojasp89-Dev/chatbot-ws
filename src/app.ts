import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rawBodyPlugin from 'fastify-raw-body';
import { handleVerifyWebhook, handleIncomingWebhook } from './controllers/webhookController.js';
import { handleTelegramWebhook } from './controllers/telegramWebhookController.js';
import { logger } from './utils/logger.js';
import { db } from './providers/database/dbClient.js';
import { inboundDispatcher } from './services/inboundDispatcher.js';
import { channelRegistry } from './providers/channels/channelRegistry.js';

let isShuttingDown = false;

export function setShuttingDown(val: boolean = true): void {
  isShuttingDown = val;
}

export function isServerShuttingDown(): boolean {
  return isShuttingDown;
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // Usamos nuestra instancia personalizada de Pino
  });

  // Valida canales habilitados y su configuración antes de exponer rutas.
  channelRegistry.validateEnabledChannels();

  // 1. Registro de CORS
  await app.register(cors, {
    origin: true,
  });

  // 2. Registro Crítico de fastify-raw-body (P2 para validación HMAC de Meta)
  await app.register(rawBodyPlugin, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });

  // 3. Health Check
  app.get('/health', async () => {
    const isDbHealthy = await db.isHealthy();
    return {
      status: 'ok',
      database: isDbHealthy ? 'connected' : 'fallback_memory',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  });

  // 4. Auditor 5B (Punto 4): Readiness Probe (pasa a 503 apenas inicia el apagado)
  app.get('/ready', async (_request, reply) => {
    if (isShuttingDown) {
      reply.status(503).send({ status: 'shutting_down' });
      return;
    }
    if (inboundDispatcher.isPaused()) {
      reply.status(503).send({ status: 'paused', reason: 'INBOUND_WORKER_PAUSED' });
      return;
    }
    const isDbHealthy = await db.isHealthy();
    if (!isDbHealthy) {
      reply.status(503).send({ status: 'unready', database: 'disconnected' });
      return;
    }
    reply.status(200).send({ status: 'ready', database: 'connected' });
  });

  // 5. Métricas de Salud y Telemetría (M4)
  app.get('/metrics', async () => {
    return {
      uptime_seconds: Math.floor(process.uptime()),
      memory_rss_bytes: process.memoryUsage().rss,
      memory_heap_used_bytes: process.memoryUsage().heapUsed,
      node_version: process.version,
    };
  });

  // 5. Rutas del adaptador Meta/WhatsApp (solo si el canal está habilitado)
  if (channelRegistry.isEnabled('whatsapp')) {
    app.get('/webhook', handleVerifyWebhook);

    app.post(
      '/webhook',
      {
        config: {
          rawBody: true, // Habilita la captura del rawBody para validación HMAC SHA-256
        },
      },
      handleIncomingWebhook
    );
  } else {
    logger.info('Canal WhatsApp deshabilitado: rutas /webhook no registradas');
  }

  if (channelRegistry.isEnabled('telegram')) {
    app.post('/webhook/telegram', handleTelegramWebhook);
  }

  return app;
}
