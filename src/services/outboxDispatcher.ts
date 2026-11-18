import { outboxRepository } from '../repositories/outboxRepository.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { whatsappClient, MetaGraphApiError } from '../providers/meta/whatsappClient.js';
import { metaCircuitBreaker, CircuitOpenError } from '../utils/circuitBreaker.js';
import { typingCadence } from '../harness/typingCadence.js';
import { CONSTANTS } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { OutboxRecord } from '../types/states.js';

export type DispatchResult = 'SENT' | 'RETRY' | 'DEFERRED' | 'LEASE_LOST' | 'FAILED';

export class OutboxDispatcher {
  private pollTimer: NodeJS.Timeout | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  private isPolling: boolean = false; // F4-C3: Anti-overlapping guard
  private isRunning: boolean = false;
  private isStopping: boolean = false; // Auditor 5A: Bandera de apagado en curso
  private inFlight: Promise<void> | null = null; // B2 & R2: Guarda de terminación en vuelo
  private backgroundTasks: Set<Promise<void>> = new Set(); // Auditor 5A: Tareas de persistencia en background
  private pausedUntil: number = 0; // Auditor Point 3: Pausa global ante errores sistémicos

  /**
   * Auditor Point 3: Pausa globalmente el despachador por un lapso ante fallos
   * sistémicos de credenciales o cuenta (401, 190, 131031, etc.).
   */
  public pauseGlobal(durationMs: number = 300000): void {
    this.pausedUntil = Date.now() + durationMs;
    logger.fatal(
      { pausedUntil: new Date(this.pausedUntil).toISOString(), durationMinutes: durationMs / 60000 },
      '🚨 ALERTA CRÍTICA: OutboxDispatcher pausado globalmente por error sistémico en Meta API'
    );
  }

  public isPaused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  public resume(): void {
    this.pausedUntil = 0;
    this.isStopping = false;
    this.isPolling = false;
    this.inFlight = null;
    this.backgroundTasks.clear();
    logger.info('🟢 OutboxDispatcher reanudado manualmente');
  }

  /**
   * Inicia el daemon de despacho en segundo plano.
   */
  public start(): void {
    if (this.isRunning) {
      logger.warn('OutboxDispatcher ya está en ejecución');
      return;
    }

    this.isRunning = true;
    this.isStopping = false;
    logger.info(
      { intervalMs: CONSTANTS.OUTBOX.POLL_INTERVAL_MS, batchSize: CONSTANTS.OUTBOX.BATCH_SIZE },
      '🚀 Outbox Dispatcher Daemon iniciado'
    );

    this.pollTimer = setInterval(() => {
      if (this.isPolling) return;
      this.isPolling = true;

      this.inFlight = this.processNextBatch()
        .then(() => undefined)
        .catch((err) => {
          logger.error({ err }, 'Error en ciclo de sondeo de OutboxDispatcher');
        })
        .finally(() => {
          this.isPolling = false;
          this.inFlight = null;
        });
    }, CONSTANTS.OUTBOX.POLL_INTERVAL_MS);

    this.reaperTimer = setInterval(async () => {
      try {
        await outboxRepository.reapStaleProcessing(CONSTANTS.OUTBOX.REAPER_TIMEOUT_MINUTES);
      } catch (err) {
        logger.error({ err }, 'Error en ciclo de reaper de OutboxDispatcher');
      }
    }, CONSTANTS.OUTBOX.REAPER_INTERVAL_MS);
  }

  /**
   * B2 & R2 & Auditor 5A: Detiene el daemon de despacho con presupuesto de shutdown (~25s),
   * esperando a que el lote y reintentos de persistencia en vuelo finalicen antes de ceder el control.
   */
  public async stop(shutdownBudgetMs: number = 25000): Promise<void> {
    this.isStopping = true;
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }

    if (this.inFlight || this.backgroundTasks.size > 0) {
      logger.info(
        { inFlight: !!this.inFlight, backgroundTasksCount: this.backgroundTasks.size, shutdownBudgetMs },
        '⏳ Esperando a que finalice el lote de despacho y tareas en vuelo...'
      );
      const allTasks = Promise.all([
        this.inFlight ?? Promise.resolve(),
        ...Array.from(this.backgroundTasks),
      ]);
      let budgetTimer: NodeJS.Timeout;
      const timeoutPromise = new Promise<void>((resolve) => {
        budgetTimer = setTimeout(() => {
          logger.warn('⚠️ Presupuesto de stop() alcanzado antes de finalizar inFlight/backgroundTasks');
          resolve();
        }, shutdownBudgetMs);
      });

      await Promise.race([allTasks, timeoutPromise]);
      clearTimeout(budgetTimer!);
      this.inFlight = null;
    }

    logger.info('🛑 Outbox Dispatcher Daemon detenido limpiamente');
  }

  /**
   * B1 & I15 & Auditor Checkpoints (R1, R2, R3): Procesa el lote pendiente con:
   * - Pausa global si hubo error sistémico de credenciales (Auditor Point 3).
   * - Cortocircuito inmediato si el Breaker está OPEN (B1).
   * - Concurrencia por destinatario usando allSettled y orden secuencial por created_at en JS.
   * - Si un mensaje A falla para un cliente, los siguientes mensajes (B, C...) se liberan explícitamente con su lock_token.
   * - Ante LEASE_LOST, el grupo se detiene de inmediato sin tocar a los hermanos (R3).
   */
  public async processNextBatch(limit: number = CONSTANTS.OUTBOX.BATCH_SIZE): Promise<number> {
    // Auditor Point 3: Verificar pausa global por error sistémico
    if (Date.now() < this.pausedUntil) {
      const remainingSec = Math.ceil((this.pausedUntil - Date.now()) / 1000);
      logger.debug({ remainingSec }, 'OutboxDispatcher en pausa global: Omitiendo reclamo de lotes');
      return 0;
    }

    // B1: No reclamar si el Circuit Breaker está en OPEN
    if (metaCircuitBreaker.getState() === 'OPEN') {
      logger.debug('Breaker en estado OPEN: Omitiendo reclamo de lote para no saturar');
      return 0;
    }

    // B2 & Fencing: Reclamo atómico con FOR UPDATE SKIP LOCKED
    const records = await outboxRepository.claimPendingBatch(limit);
    if (records.length === 0) {
      return 0;
    }

    logger.debug({ count: records.length }, 'Lote de mensajes reclamado para despacho');

    // I15: Agrupar por destinatario para garantizar concurrencia segura
    const recipientGroups = new Map<string, OutboxRecord[]>();
    for (const record of records) {
      const group = recipientGroups.get(record.recipient_phone) || [];
      group.push(record);
      recipientGroups.set(record.recipient_phone, group);
    }

    const groupPromises = Array.from(recipientGroups.values()).map(async (messagesForPhone) => {
      // Ajuste menor: RETURNING en Postgres no garantiza created_at. Ordenar explícitamente en JS.
      messagesForPhone.sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );

      let sentCount = 0;
      for (let i = 0; i < messagesForPhone.length; i++) {
        const record = messagesForPhone[i];
        if (!record.lock_token) continue;

        // Auditor 5A: Comprobar isStopping antes de cada mensaje para respetar shutdown ordenado
        if (this.isStopping) {
          logger.warn(
            { recipient: record.recipient_phone, outboxId: record.id },
            '🛑 Dispatcher apagándose: liberando mensaje reclamado con su lock_token'
          );
          await outboxRepository.release(record.id, record.lock_token, 5);
          break;
        }

        const result = await this.dispatchSingleMessage(record);

        if (result === 'SENT') {
          sentCount++;
        } else if (result === 'LEASE_LOST') {
          // Auditor Point R3: Ante LEASE_LOST el grupo se detiene sin tocar a los hermanos,
          // porque ya no nos pertenecen (fueron reclamados por otro worker o el reaper).
          logger.warn(
            { recipient: record.recipient_phone, outboxId: record.id },
            '🛑 Lease perdido para este mensaje. Deteniendo grupo sin modificar mensajes posteriores.'
          );
          break;
        } else if (result === 'FAILED') {
          logger.error(
            { recipient: record.recipient_phone, outboxId: record.id },
            '❌ Mensaje falló de forma terminal (4xx cliente o max reintentos agotados)'
          );
          break;
        } else {
          // result === 'RETRY' || result === 'DEFERRED'
          // Auditor Point 4 & R3: Si el mensaje A falla o se difiere,
          // liberar INMEDIATAMENTE todos los mensajes subsiguientes (B, C...)
          // de PROCESSING a PENDING con el mismo backoff o reset timeout de A,
          // usando el lock_token de cada fila para no tocar filas de otros workers.
          const delaySeconds =
            result === 'DEFERRED'
              ? CONSTANTS.CIRCUIT_BREAKER.RESET_TIMEOUT_MS / 1000
              : CONSTANTS.OUTBOX.BACKOFF_BASE_SECONDS * Math.pow(2, record.retry_count);

          logger.debug(
            {
              recipient: record.recipient_phone,
              deferredCount: messagesForPhone.length - (i + 1),
              delaySeconds,
            },
            'Diferidos y liberados explícitamente mensajes posteriores del mismo cliente para preservar orden secuencial'
          );

          for (let j = i + 1; j < messagesForPhone.length; j++) {
            const brother = messagesForPhone[j];
            if (brother.lock_token) {
              await outboxRepository.release(brother.id, brother.lock_token, delaySeconds);
            }
          }
          break;
        }
      }
      return sentCount;
    });

    // I15: Usar allSettled y registrar rechazos inesperados
    const results = await Promise.allSettled(groupPromises);
    return results.reduce((sum, res) => {
      if (res.status === 'fulfilled') {
        return sum + res.value;
      } else {
        logger.error({ reason: res.reason }, 'Error no capturado en procesamiento de grupo de destinatario');
        return sum;
      }
    }, 0);
  }

  /**
   * B1, B3, I14, Fencing: Despacha un mensaje individual con separación estricta de fases:
   * 1. Pre-Check de Breaker.
   * 2. Simulación de cadencia humana.
   * 3. Pre-Send Fencing inmediatamente antes de la llamada de red.
   * 4. Fase de Red con captura de CircuitOpenError (R1) y errores sistémicos.
   * 5. Fase de Persistencia Local con reintentos cortos de markSent (R3).
   */
  private async dispatchSingleMessage(record: OutboxRecord): Promise<DispatchResult> {
    // B1: Si el breaker se abrió en medio del lote, liberar sin esperar
    if (metaCircuitBreaker.getState() === 'OPEN') {
      if (record.lock_token) {
        await outboxRepository.release(
          record.id,
          record.lock_token,
          CONSTANTS.CIRCUIT_BREAKER.RESET_TIMEOUT_MS / 1000
        );
      }
      return 'DEFERRED';
    }

    // S5: Simular cadencia humana de escritura
    await typingCadence.simulateTyping(record.phone_number_id, record.recipient_phone);

    // Auditor Point 1 & Ajuste Menor: Pre-Send Fencing Check
    // Comprobar que el lease sigue activo inmediatamente antes de la llamada irreversible a Meta
    if (!record.lock_token) {
      logger.error({ outboxId: record.id }, 'Registro de outbox sin lock_token requerido');
      return 'LEASE_LOST';
    }

    const isLeaseStillValid = await outboxRepository.isLeaseValid(record.id, record.lock_token);
    if (!isLeaseStillValid) {
      logger.warn(
        { outboxId: record.id },
        '🛑 Fencing Pre-Send: Lease expirado antes de contactar a Meta. Omitiendo llamada externa para evitar duplicado.'
      );
      return 'LEASE_LOST';
    }

    // =========================================================================
    // FASE 1: Llamada de Red Externa protegida por Circuit Breaker (B1, I14, R1)
    // =========================================================================
    let wamid: string;
    try {
      wamid = await metaCircuitBreaker.execute(
        async () => {
          return whatsappClient.sendTextMessage(
            record.phone_number_id,
            record.recipient_phone,
            record.content
          );
        },
        (error) => {
          // I14: Solo errores transitorios (5xx, 429, timeouts, 131056) cuentan en el Circuit Breaker
          if (error instanceof MetaGraphApiError) {
            return error.isTransient;
          }
          return true;
        }
      );
    } catch (networkError) {
      // Auditor R1: Rechazo del Circuit Breaker (OPEN o HALF_OPEN_BUSY) -> DEFERRED sin quemar reintentos
      if (networkError instanceof CircuitOpenError) {
        logger.warn(
          { outboxId: record.id },
          '🛑 Breaker OPEN / HALF_OPEN_BUSY: Mensaje liberado a PENDING sin consumir presupuesto de reintentos'
        );
        await outboxRepository.release(
          record.id,
          record.lock_token,
          CONSTANTS.CIRCUIT_BREAKER.RESET_TIMEOUT_MS / 1000
        );
        return 'DEFERRED';
      }

      const errorMessage = networkError instanceof Error ? networkError.message : String(networkError);

      // Auditor Point 3: Errores Sistémicos de Credenciales o Cuenta (401, 190, 131031, etc.)
      if (networkError instanceof MetaGraphApiError && networkError.isSystemicAuth) {
        this.pauseGlobal(5 * 60 * 1000); // Pausa global de 5 minutos
        logger.fatal(
          { outboxId: record.id, error: errorMessage },
          '🚨 ALERTA CRÍTICA: Error sistémico en Meta API. Despachador pausado globalmente. Mensaje retenido en PENDING.'
        );
        await outboxRepository.release(record.id, record.lock_token, 300);
        return 'DEFERRED';
      }

      // I14 & Auditor 5A: Errores 4xx de cliente (número inválido, ventana 24h) -> FAILED terminal de inmediato
      if (networkError instanceof MetaGraphApiError && !networkError.isTransient) {
        logger.error(
          { outboxId: record.id, error: errorMessage },
          '❌ Error permanente de cliente de Meta. Marcando como FAILED'
        );
        await outboxRepository.terminalFailed(record.id, record.lock_token, errorMessage);
        return 'FAILED';
      }

      // Fallo transitorio de red -> Reintento con backoff exponencial y fencing por lock_token
      const backoffSeconds =
        CONSTANTS.OUTBOX.BACKOFF_BASE_SECONDS * Math.pow(2, record.retry_count);

      if (record.retry_count + 1 >= record.max_retries) {
        logger.error(
          { outboxId: record.id, attempts: record.retry_count + 1, error: errorMessage },
          '🚨 Límite de reintentos superado para el mensaje saliente. Transicionando a FAILED'
        );
        await outboxRepository.terminalFailed(
          record.id,
          record.lock_token,
          `Max retries (${record.max_retries}) exceeded: ${errorMessage}`
        );
        return 'FAILED';
      }

      logger.warn(
        { outboxId: record.id, retryCount: record.retry_count + 1, backoffSeconds, error: errorMessage },
        '⚠️ Fallo transitorio de red. Programando reintento con backoff'
      );

      await outboxRepository.markFailed(record.id, record.lock_token, errorMessage, backoffSeconds);
      return 'RETRY';
    }

    // =========================================================================
    // FASE 2: Mensaje YA aceptado por Meta. NUNCA revertir a PENDING ni llamar a markFailed (B3)
    // Fencing Estricto: Compara record.lock_token UUID obligatorio
    // Ajuste menor: 3 reintentos cortos de markSent con backoff antes de rendirse
    // Auditor 5A: Si falla, reintentar en background con presupuesto (< stop_grace_period)
    // =========================================================================
    let sentRecord: OutboxRecord | null = null;
    let markSentError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        sentRecord = await outboxRepository.markSent(record.id, wamid, record.lock_token);
        markSentError = null;
        break;
      } catch (err) {
        markSentError = err;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        }
      }
    }

    if (markSentError) {
      logger.error(
        { outboxId: record.id, wamid, error: markSentError },
        '🚨 Fallo inmediato en markSent: programando reintento en segundo plano con presupuesto acotado'
      );
      // Auditor 5A: Reintento en segundo plano con presupuesto (~20s < 30s de Docker), registrado en backgroundTasks
      const bgRetry = (async () => {
        const start = Date.now();
        const budgetMs = 20000;
        let attempt = 0;
        while (Date.now() - start < budgetMs && !this.isStopping) {
          attempt++;
          await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 4000)));
          try {
            const updated = await outboxRepository.markSent(record.id, wamid, record.lock_token!);
            if (!updated) {
              logger.warn(
                { outboxId: record.id, wamid },
                'Reintento de markSent abortado: lease perdido (0 filas afectadas en DB)'
              );
              return;
            }
            logger.info({ outboxId: record.id, wamid }, '✅ markSent confirmado en reintento background');
            return;
          } catch (retryErr) {
            markSentError = retryErr;
          }
        }

        // Auditor 5A: Intento final antes de rendirse con alerta de reconciliación manual
        try {
          const finalUpdated = await outboxRepository.markSent(record.id, wamid, record.lock_token!);
          if (finalUpdated) {
            logger.info({ outboxId: record.id, wamid }, '✅ markSent confirmado en intento final de cierre');
            return;
          }
        } catch (finalErr) {
          markSentError = finalErr;
        }

        logger.error(
          { outboxId: record.id, wamid, error: markSentError },
          '🚨 RECONCILIACIÓN MANUAL REQUERIDA: markSent agotó presupuesto de reintento sin confirmar en DB'
        );
      })();

      this.backgroundTasks.add(bgRetry);
      bgRetry
        .catch((err) => {
          logger.error({ outboxId: record.id, wamid, err }, 'Error no capturado en bgRetry de markSent');
        })
        .finally(() => this.backgroundTasks.delete(bgRetry));
    } else if (!sentRecord) {
      logger.warn(
        { outboxId: record.id, wamid },
        '⚠️ Fencing Post-Send: markSent afectó 0 filas. El lease expiró en BD pero el mensaje ya fue despachado a Meta.'
      );
    }

    if (record.conversation_id) {
      try {
        await messageRepository.saveOutboundMessage({
          conversationId: record.conversation_id,
          wamid,
          content: record.content,
          promptTokens: record.prompt_tokens,
          completionTokens: record.completion_tokens,
          latencyMs: record.latency_ms,
        });
        // Auditor 5A: saveOutboundMessage ya nace con piso 'sent', eliminando llamada redundante
      } catch (saveErr) {
        logger.error({ outboxId: record.id, wamid, saveErr }, 'Error al guardar mensaje en historial local');
      }
    }

    logger.info(
      { outboxId: record.id, wamid, recipient: record.recipient_phone },
      '✅ Mensaje despachado exitosamente a Meta WhatsApp API'
    );
    return 'SENT';
  }
}

export const outboxDispatcher = new OutboxDispatcher();
