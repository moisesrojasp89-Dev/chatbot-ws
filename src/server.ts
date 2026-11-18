import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { db } from './providers/database/dbClient.js';
import { outboxDispatcher } from './services/outboxDispatcher.js';
import { inboundDispatcher } from './services/inboundDispatcher.js';
import { retentionService } from './services/retentionService.js';
import { setShuttingDown } from './app.js';

async function start(): Promise<void> {
  try {
    const app = await buildApp();

    await app.listen({
      port: env.PORT,
      host: '0.0.0.0',
    });

    logger.info(`🚀 Servidor Chatbot WS escuchando en http://0.0.0.0:${env.PORT}`);
    logger.info(`📡 Webhook listo en http://localhost:${env.PORT}/webhook`);
    logger.info(`🩺 Health check en http://localhost:${env.PORT}/health`);
    logger.info(`🚦 Readiness probe en http://localhost:${env.PORT}/ready`);

    // Iniciar Daemons en segundo plano
    inboundDispatcher.start();
    outboxDispatcher.start();
    retentionService.start();

    // B6: Graceful Shutdown con guarda de reentrada y timeout duro (28s)
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`Señal ${signal} recibida. Cerrando servidor de forma elegante...`);
      setShuttingDown(true); // /ready pasa a 503 inmediatamente
      const hard = setTimeout(() => {
        logger.error('Timeout duro de apagado excedido (28s). Forzando salida.');
        process.exit(1);
      }, 28_000);
      hard.unref?.();

      try {
        await Promise.allSettled([
          inboundDispatcher.stop(24_000),
          outboxDispatcher.stop(24_000),
          retentionService.stop(),
        ]);
        await app.close();
        await db.close();
        logger.info('Servidor y conexiones cerradas correctamente.');
      } catch (err) {
        logger.error({ err }, 'Error durante el apagado elegante');
      } finally {
        clearTimeout(hard);
        process.exit(0);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    logger.error({ error }, 'Error fatal durante el arranque del servidor');
    process.exit(1);
  }
}

start();
