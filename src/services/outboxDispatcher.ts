import { outboxRepository } from '../repositories/outboxRepository.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { channelRegistry } from '../providers/channels/channelRegistry.js';
import {
  ChannelSendError,
  isTransientChannelError,
  normalizeChannelName,
} from '../providers/channels/channelTypes.js';
import { getChannelCircuitBreaker, CircuitOpenError } from '../utils/circuitBreaker.js';
import { typingCadence } from '../harness/typingCadence.js';
import { CONSTANTS } from '../config/constants.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { OutboxRecord } from '../types/states.js';

export type DispatchResult = 'SENT' | 'RETRY' | 'DEFERRED' | 'LEASE_LOST' | 'FAILED';

export interface ChannelBacklogSnapshot {
  channel: string;
  pending: number;
  paused: boolean;
  enabled: boolean;
  breakerState: string;
  threshold: number;
}

export class OutboxDispatcher {
  private pollTimer: NodeJS.Timeout | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  private backlogTimer: NodeJS.Timeout | null = null;
  private isCheckingBacklog: boolean = false;
  private readonly lastBacklogAlerts = new Map<string, string>();
  private isPolling: boolean = false; // F4-C3: Anti-overlapping guard
  private isRunning: boolean = false;
  private isStopping: boolean = false; // Auditor 5A: Bandera de apagado en curso
  private inFlight: Promise<void> | null = null; // B2 & R2: Guarda de terminación en vuelo
  private backgroundTasks: Set<Promise<void>> = new Set(); // Auditor 5A: Tareas de persistencia en background
  private pausedUntil: number = 0; // Pausa global explícita (todas las canales)
  private readonly pausedUntilByChannel = new Map<string, number>();

  /**
   * Pausa únicamente el canal afectado por un error sistémico o de configuración.
   * Los demás canales siguen operando.
   */
  public pauseChannel(channel: string, durationMs: number = 300000): void {
    const key = normalizeChannelName(channel);
    const until = Date.now() + durationMs;
    this.pausedUntilByChannel.set(key, until);
    logger.fatal(
      { channel: key, pausedUntil: new Date(until).toISOString(), durationMinutes: durationMs / 60000 },
      '🚨 ALERTA CRÍTICA: canal pausado por error sistémico del proveedor'
    );
  }

  /** Pausa explícita de todos los canales (operación manual). */
  public pauseGlobal(durationMs: number = 300000): void {
    this.pausedUntil = Date.now() + durationMs;
    logger.fatal(
      { pausedUntil: new Date(this.pausedUntil).toISOString(), durationMinutes: durationMs / 60000 },
      '🚨 ALERTA CRÍTICA: OutboxDispatcher pausado globalmente'
    );
  }

  public isChannelPaused(channel: string): boolean {
    const key = normalizeChannelName(channel);
    const channelUntil = this.pausedUntilByChannel.get(key) ?? 0;
    return Date.now() < this.pausedUntil || Date.now() < channelUntil;
  }

  public isPaused(channel?: string): boolean {
    return channel ? this.isChannelPaused(channel) : Date.now() < this.pausedUntil;
  }

  private channelPauseRemainingSeconds(channel: string): number {
    const key = normalizeChannelName(channel);
    const until = Math.max(this.pausedUntil, this.pausedUntilByChannel.get(key) ?? 0);
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  }

  /** Snapshot del backlog PENDING por canal, con pausa y breaker. */
  public async getBacklogSnapshot(): Promise<ChannelBacklogSnapshot[]> {
    const rows = await outboxRepository.countPendingByChannel();
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = normalizeChannelName(row.channel);
      counts.set(key, (counts.get(key) ?? 0) + row.pending);
    }

    const channels = new Set<string>([...channelRegistry.enabledChannels(), ...counts.keys()]);

    return Array.from(channels).map((channel) => ({
      channel,
      pending: counts.get(channel) ?? 0,
      paused: this.isChannelPaused(channel),
      enabled: channelRegistry.isEnabled(channel),
      breakerState: getChannelCircuitBreaker(channel).getState(),
      threshold: env.BACKLOG_ALERT_THRESHOLD,
    }));
  }

  /**
   * Emite alertas estructuradas para canales con backlog que no están sanos
   * (deshabilitados, pausados o breaker no CLOSED). Deduplica por transición y
   * emite un log de resolución al normalizarse.
   */
  public async checkChannelBacklog(): Promise<ChannelBacklogSnapshot[]> {
    if (this.isCheckingBacklog) return [];
    this.isCheckingBacklog = true;

    try {
      const snapshot = await this.getBacklogSnapshot();

      for (const item of snapshot) {
        const needsAlert = !item.enabled || item.paused || item.breakerState !== 'CLOSED';

        if (!needsAlert || item.pending === 0) {
          if (this.lastBacklogAlerts.has(item.channel)) {
            this.lastBacklogAlerts.delete(item.channel);
            logger.info(
              { alert: 'CHANNEL_BACKLOG_RESOLVED', channel: item.channel, pending: item.pending },
              `✅ Backlog normalizado en canal ${item.channel}`
            );
          }
          continue;
        }

        const level = item.pending >= item.threshold ? 'error' : 'warn';
        const signature = `${level}:${item.enabled}:${item.paused}:${item.breakerState}`;
        if (this.lastBacklogAlerts.get(item.channel) === signature) continue;
        this.lastBacklogAlerts.set(item.channel, signature);

        const alert = {
          alert: 'CHANNEL_BACKLOG' as const,
          channel: item.channel,
          pending: item.pending,
          threshold: item.threshold,
          paused: item.paused,
          enabled: item.enabled,
          breakerState: item.breakerState,
        };
        const message = `⚠️ Backlog retenido en canal ${item.channel}: ${item.pending} PENDING (habilitado=${item.enabled}, pausado=${item.paused}, breaker=${item.breakerState})`;

        if (level === 'error') {
          logger.error(alert, message);
        } else {
          logger.warn(alert, message);
        }
      }

      // Poda de canales que ya no aparecen en el snapshot.
      const activeChannels = new Set(snapshot.map((item) => item.channel));
      for (const channel of this.lastBacklogAlerts.keys()) {
        if (!activeChannels.has(channel)) this.lastBacklogAlerts.delete(channel);
      }

      return snapshot;
    } finally {
      this.isCheckingBacklog = false;
    }
  }

  public resume(): void {
    this.pausedUntil = 0;
    this.pausedUntilByChannel.clear();
    this.lastBacklogAlerts.clear();
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
    this.lastBacklogAlerts.clear();
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

    this.backlogTimer = setInterval(() => {
      this.checkChannelBacklog().catch((err) => {
        logger.error({ err }, 'Error en ciclo de alertas de backlog del OutboxDispatcher');
      });
    }, CONSTANTS.OUTBOX.BACKLOG_CHECK_INTERVAL_MS);
    this.backlogTimer.unref?.();
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
    if (this.backlogTimer) {
      clearInterval(this.backlogTimer);
      this.backlogTimer = null;
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
    // Pausa global explícita: no se reclama nada (las pausas por canal se filtran después).
    if (Date.now() < this.pausedUntil) {
      logger.debug('OutboxDispatcher en pausa global: omitiendo reclamo de lotes');
      return 0;
    }

    // Claim filtrado por canales sanos: un canal caído/pausado no puede acaparar el lote.
    const enabledChannels = channelRegistry.enabledChannels();
    const healthyChannels = enabledChannels.filter(
      (channel) => !this.isChannelPaused(channel) && getChannelCircuitBreaker(channel).getState() !== 'OPEN'
    );
    if (healthyChannels.length === 0) {
      logger.debug({ channels: enabledChannels }, 'Todos los canales pausados/OPEN: omitiendo reclamo de lote');
      return 0;
    }

    // B2 & Fencing: Reclamo atómico con FOR UPDATE SKIP LOCKED
    const records = await outboxRepository.claimPendingBatch(limit, undefined, healthyChannels);
    if (records.length === 0) {
      return 0;
    }

    // Aislamiento por canal: pausa/breaker de un canal no frena a los demás.
    const dispatchableRecords: OutboxRecord[] = [];
    for (const record of records) {
      const channel = normalizeChannelName(record.channel);
      const breaker = getChannelCircuitBreaker(channel);
      const paused = this.isChannelPaused(channel);
      if (paused || breaker.getState() === 'OPEN') {
        const breakerDelaySeconds =
          breaker.getState() === 'OPEN'
            ? Math.max(1, Math.ceil((breaker.getOpenUntil() - Date.now()) / 1000))
            : 0;
        const delaySeconds = paused
          ? Math.max(1, this.channelPauseRemainingSeconds(channel))
          : breakerDelaySeconds;
        logger.debug(
          { outboxId: record.id, channel, delaySeconds },
          'Mensaje omitido: canal pausado o breaker OPEN (se libera sin quemar reintentos)'
        );
        if (record.lock_token) {
          await outboxRepository.release(record.id, record.lock_token, delaySeconds);
        }
        continue;
      }
      dispatchableRecords.push(record);
    }

    if (dispatchableRecords.length === 0) {
      return 0;
    }

    logger.debug({ count: dispatchableRecords.length }, 'Lote de mensajes reclamado para despacho');

    // I15: Agrupar por canal + destinatario para garantizar concurrencia segura y aislada.
    const recipientGroups = new Map<string, OutboxRecord[]>();
    for (const record of dispatchableRecords) {
      const key = `${normalizeChannelName(record.channel)}:${record.recipient_phone}`;
      const group = recipientGroups.get(key) || [];
      group.push(record);
      recipientGroups.set(key, group);
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
          // Los hermanos del mismo destinatario no deben quedar varados en PROCESSING:
          // se liberan para que se reintenten sin consumir su presupuesto.
          for (let j = i + 1; j < messagesForPhone.length; j++) {
            const brother = messagesForPhone[j];
            if (brother.lock_token) {
              await outboxRepository.release(brother.id, brother.lock_token, 0);
            }
          }
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
    const channel = normalizeChannelName(record.channel);

    // M2: pausa activada en medio del lote (otro grupo u operador): no llamar al proveedor.
    if (this.isChannelPaused(channel)) {
      if (record.lock_token) {
        const delaySeconds = Math.max(1, this.channelPauseRemainingSeconds(channel));
        await outboxRepository.release(record.id, record.lock_token, delaySeconds);
      }
      return 'DEFERRED';
    }

    const breaker = getChannelCircuitBreaker(channel);

    // B1: Si el breaker del canal se abrió en medio del lote, liberar sin esperar
    if (breaker.getState() === 'OPEN') {
      if (record.lock_token) {
        await outboxRepository.release(
          record.id,
          record.lock_token,
          CONSTANTS.CIRCUIT_BREAKER.RESET_TIMEOUT_MS / 1000
        );
      }
      return 'DEFERRED';
    }
    if (!channelRegistry.isEnabled(channel)) {
      // Deshabilitar un canal es una acción reversible del operador: no se quema el mensaje.
      logger.warn({ outboxId: record.id, channel }, '⏸️ Canal no habilitado en CHANNELS_ENABLED: liberando mensaje para cuando se reactive');
      if (record.lock_token) {
        await outboxRepository.release(record.id, record.lock_token, 300);
      }
      return 'DEFERRED';
    }
    if (!channelRegistry.has(channel)) {
      const message = `Canal no registrado: ${channel}`;
      logger.error({ outboxId: record.id, channel }, '❌ Canal sin adaptador registrado: marcando mensaje como FAILED');
      if (record.lock_token) {
        await outboxRepository.terminalFailed(record.id, record.lock_token, message);
      }
      return 'FAILED';
    }
    const sender = channelRegistry.get(channel);

    // S5: Simular cadencia humana de escritura
    await typingCadence.simulateTyping(record.phone_number_id, record.recipient_phone, undefined, channel);

    // Auditor Point 1 & Ajuste Menor: Pre-Send Fencing Check
    // Comprobar que el lease sigue activo inmediatamente antes de la llamada irreversible al proveedor
    if (!record.lock_token) {
      logger.error({ outboxId: record.id }, 'Registro de outbox sin lock_token requerido');
      return 'LEASE_LOST';
    }

    const isLeaseStillValid = await outboxRepository.isLeaseValid(record.id, record.lock_token);
    if (!isLeaseStillValid) {
      logger.warn(
        { outboxId: record.id },
        '🛑 Fencing Pre-Send: Lease expirado antes de contactar al proveedor. Omitiendo llamada externa para evitar duplicado.'
      );
      return 'LEASE_LOST';
    }

    // =========================================================================
    // FASE 1: Llamada de Red Externa protegida por Circuit Breaker (B1, I14, R1)
    // =========================================================================
    let externalMessageId: string;
    try {
      const sendResult = await breaker.execute(
        async () =>
          sender.sendText({
            accountId: record.phone_number_id,
            recipientId: record.recipient_phone,
            text: record.content,
            outboxId: record.id,
          }),
        (error) => {
          // Solo errores transitorios del canal cuentan para abrir el Circuit Breaker
          if (error instanceof ChannelSendError) {
            return isTransientChannelError(error);
          }
          return true;
        }
      );
      externalMessageId = sendResult.externalMessageId;
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
      if (networkError instanceof ChannelSendError && networkError.kind === 'SYSTEMIC_AUTH') {
        this.pauseChannel(channel, 5 * 60 * 1000); // Pausa aislada del canal
        logger.fatal(
          { outboxId: record.id, channel, error: errorMessage },
          `🚨 ALERTA CRÍTICA: Error sistémico del canal ${channel}. Canal pausado; mensaje retenido en PENDING.`
        );
        await outboxRepository.release(record.id, record.lock_token, 300);
        return 'DEFERRED';
      }

      // I14 & Auditor 5A: Errores 4xx de cliente (número inválido, ventana 24h) -> FAILED terminal de inmediato
      if (networkError instanceof ChannelSendError && networkError.kind === 'FATAL') {
        logger.error(
          { outboxId: record.id, error: errorMessage },
          '❌ Error permanente del canal. Marcando como FAILED'
        );
        await outboxRepository.terminalFailed(record.id, record.lock_token, errorMessage);
        return 'FAILED';
      }

      // Fallo transitorio de red -> Reintento con backoff exponencial y fencing por lock_token
      const providerDelay =
        networkError instanceof ChannelSendError ? networkError.retryAfterSeconds : undefined;
      const backoffSeconds =
        providerDelay && providerDelay > 0
          ? providerDelay
          : CONSTANTS.OUTBOX.BACKOFF_BASE_SECONDS * Math.pow(2, record.retry_count);

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
    // FASE 2: Mensaje YA aceptado por el proveedor. NUNCA revertir a PENDING ni llamar a markFailed (B3)
    // Fencing Estricto: Compara record.lock_token UUID obligatorio
    // Ajuste menor: 3 reintentos cortos de markSent con backoff antes de rendirse
    // Auditor 5A: Si falla, reintentar en background con presupuesto (< stop_grace_period)
    // =========================================================================
    let sentRecord: OutboxRecord | null = null;
    let markSentError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        sentRecord = await outboxRepository.markSent(record.id, externalMessageId, record.lock_token);
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
        { outboxId: record.id, externalMessageId, error: markSentError },
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
            const updated = await outboxRepository.markSent(record.id, externalMessageId, record.lock_token!);
            if (!updated) {
              logger.warn(
                { outboxId: record.id, externalMessageId },
                'Reintento de markSent abortado: lease perdido (0 filas afectadas en DB)'
              );
              return;
            }
            logger.info({ outboxId: record.id, externalMessageId }, '✅ markSent confirmado en reintento background');
            return;
          } catch (retryErr) {
            markSentError = retryErr;
          }
        }

        // Auditor 5A: Intento final antes de rendirse con alerta de reconciliación manual
        try {
          const finalUpdated = await outboxRepository.markSent(record.id, externalMessageId, record.lock_token!);
          if (finalUpdated) {
            logger.info({ outboxId: record.id, externalMessageId }, '✅ markSent confirmado en intento final de cierre');
            return;
          }
        } catch (finalErr) {
          markSentError = finalErr;
        }

        logger.error(
          { outboxId: record.id, externalMessageId, error: markSentError },
          '🚨 RECONCILIACIÓN MANUAL REQUERIDA: markSent agotó presupuesto de reintento sin confirmar en DB'
        );
      })();

      this.backgroundTasks.add(bgRetry);
      bgRetry
        .catch((err) => {
          logger.error({ outboxId: record.id, externalMessageId, err }, 'Error no capturado en bgRetry de markSent');
        })
        .finally(() => this.backgroundTasks.delete(bgRetry));
    } else if (!sentRecord) {
      logger.warn(
        { outboxId: record.id, externalMessageId },
        '⚠️ Fencing Post-Send: markSent afectó 0 filas. El lease expiró en BD pero el mensaje ya fue despachado por el canal.'
      );
    }

    if (record.conversation_id) {
      try {
        await messageRepository.saveOutboundMessage({
          conversationId: record.conversation_id,
          wamid: externalMessageId,
          content: record.content,
          promptTokens: record.prompt_tokens,
          completionTokens: record.completion_tokens,
          latencyMs: record.latency_ms,
        });
        // Auditor 5A: saveOutboundMessage ya nace con piso 'sent', eliminando llamada redundante
      } catch (saveErr) {
        logger.error({ outboxId: record.id, externalMessageId, saveErr }, 'Error al guardar mensaje en historial local');
      }
    }

    logger.info(
      { outboxId: record.id, externalMessageId, channel, recipient: record.recipient_phone },
      '✅ Mensaje despachado exitosamente por el canal ' + channel
    );
    return 'SENT';
  }
}

export const outboxDispatcher = new OutboxDispatcher();
