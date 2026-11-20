import { db } from '../providers/database/dbClient.js';
import { CONSTANTS } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { purgeMediaFiles } from './mediaStorage.js';

export interface RetentionStats {
  inboundDone: number;
  inboundFailed: number;
  outboxSent: number;
  outboxFailed: number;
  statusEvents: number;
  mediaFiles: number;
}

/**
 * Servicio autónomo de retención y purga periódica LGPD / GDPR.
 * 
 * Cumple con:
 * - I6 & C3: Purgas diferenciadas (DONE/SENT a 7 días, FAILED a 90 días, messages protegido).
 * - C11: Cadencia de 15 min con presupuesto duro de 10s y pausas de 2s entre lotes para no saturar Supavisor.
 * - FOR UPDATE SKIP LOCKED en CTEs para evitar contención de bloqueos con transacciones activas.
 */
export class RetentionService {
  private isRunning: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number = 15 * 60 * 1000; // Cada 15 minutos
  private readonly batchSize: number = 500;
  private readonly interBatchPauseMs: number = 2000; // C11: Pausa de 2s entre lotes
  private readonly maxExecutionTimeMs: number = 10000; // C11: Presupuesto duro de 10s por corrida

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info({ intervalMs: this.intervalMs }, '🧹 RetentionService iniciado');

    this.timer = setInterval(async () => {
      try {
        await this.runPurgeCycle();
      } catch (err) {
        logger.error({ err }, 'Error en ciclo periódico de RetentionService');
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('🛑 RetentionService detenido');
  }

  /**
   * Ejecuta un ciclo de purga respetando el presupuesto de tiempo de 10 segundos
   * y realizando pausas de 2 segundos entre lotes sucesivos (C11).
   */
  public async runPurgeCycle(): Promise<RetentionStats> {
    const startTime = Date.now();
    const stats: RetentionStats = {
      inboundDone: 0,
      inboundFailed: 0,
      outboxSent: 0,
      outboxFailed: 0,
      statusEvents: 0,
      mediaFiles: 0,
    };

    const hasTimeRemaining = () => Date.now() - startTime < this.maxExecutionTimeMs;

    // 1. Purga de inbound_events en estado DONE (> 7 días)
    while (hasTimeRemaining()) {
      const deleted = await this.purgeTableBatch(
        `
        WITH targets AS (
          SELECT id FROM public.inbound_events
          WHERE status = 'DONE'
            AND COALESCE(processed_at, created_at) < NOW() - ($1 || ' days')::INTERVAL
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM public.inbound_events WHERE id IN (SELECT id FROM targets) RETURNING id;
        `,
        [CONSTANTS.INBOUND.RETENTION_DAYS, this.batchSize]
      );
      stats.inboundDone += deleted;
      if (deleted < this.batchSize) break;
      await this.sleep(this.interBatchPauseMs);
    }

    // 2. Purga de inbound_events en estado FAILED (> 90 días)
    while (hasTimeRemaining()) {
      const deleted = await this.purgeTableBatch(
        `
        WITH targets AS (
          SELECT id FROM public.inbound_events
          WHERE status = 'FAILED'
            AND created_at < NOW() - ($1 || ' days')::INTERVAL
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM public.inbound_events WHERE id IN (SELECT id FROM targets) RETURNING id;
        `,
        [90, this.batchSize]
      );
      stats.inboundFailed += deleted;
      if (deleted < this.batchSize) break;
      await this.sleep(this.interBatchPauseMs);
    }

    // 3. Purga de outbox_messages en estado SENT (> 7 días)
    while (hasTimeRemaining()) {
      const deleted = await this.purgeTableBatch(
        `
        WITH targets AS (
          SELECT id FROM public.outbox_messages
          WHERE status = 'SENT'
            AND created_at < NOW() - ($1 || ' days')::INTERVAL
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM public.outbox_messages WHERE id IN (SELECT id FROM targets) RETURNING id;
        `,
        [CONSTANTS.INBOUND.RETENTION_DAYS, this.batchSize]
      );
      stats.outboxSent += deleted;
      if (deleted < this.batchSize) break;
      await this.sleep(this.interBatchPauseMs);
    }

    // 4. Purga de outbox_messages en estado FAILED (> 90 días)
    while (hasTimeRemaining()) {
      const deleted = await this.purgeTableBatch(
        `
        WITH targets AS (
          SELECT id FROM public.outbox_messages
          WHERE status = 'FAILED'
            AND created_at < NOW() - ($1 || ' days')::INTERVAL
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM public.outbox_messages WHERE id IN (SELECT id FROM targets) RETURNING id;
        `,
        [90, this.batchSize]
      );
      stats.outboxFailed += deleted;
      if (deleted < this.batchSize) break;
      await this.sleep(this.interBatchPauseMs);
    }

    // 5. Purga de message_status_events (> 30 días)
    while (hasTimeRemaining()) {
      const deleted = await this.purgeTableBatch(
        `
        WITH targets AS (
          SELECT id FROM public.message_status_events
          WHERE created_at < NOW() - ($1 || ' days')::INTERVAL
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM public.message_status_events WHERE id IN (SELECT id FROM targets) RETURNING id;
        `,
        [30, this.batchSize]
      );
      stats.statusEvents += deleted;
      if (deleted < this.batchSize) break;
      await this.sleep(this.interBatchPauseMs);
    }

    try {
      stats.mediaFiles = await purgeMediaFiles(env.MEDIA_RETENTION_DAYS);
    } catch (error) {
      logger.warn({ error }, 'No se pudieron purgar binarios de media');
    }

    const totalPurged =
      stats.inboundDone +
      stats.inboundFailed +
      stats.outboxSent +
      stats.outboxFailed +
      stats.statusEvents +
      stats.mediaFiles;

    if (totalPurged > 0) {
      logger.info(
        { stats, durationMs: Date.now() - startTime },
        '🧹 Ciclo de purga LGPD de RetentionService completado con éxito'
      );
    }

    return stats;
  }

  private async purgeTableBatch(sql: string, params: any[]): Promise<number> {
    const client = await db.getClient();
    try {
      const res = await client.query(sql, params);
      return res.rowCount ?? res.rows.length;
    } catch (err) {
      logger.error({ err }, 'Error purgando lote en RetentionService');
      return 0;
    } finally {
      client.release();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const retentionService = new RetentionService();
