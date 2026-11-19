import { db } from '../providers/database/dbClient.js';
import {
  inboundRepository,
  InboundEventRecord,
  CoalescedEventBatch,
} from '../repositories/inboundRepository.js';
import { contactRepository } from '../repositories/contactRepository.js';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { outboxRepository } from '../repositories/outboxRepository.js';
import { agentEngine } from '../harness/agentEngine.js';
import { executeLeadInTransaction } from '../harness/tools/leadTools.js';
import { executeHandoffInTransaction } from '../harness/tools/handoffTools.js';
import {
  isTransientLlmError,
  classifyLlmError,
  extractLlmRetryDelaySeconds,
} from '../providers/llm/llmClient.js';
import { CircuitBreaker, CircuitOpenError } from '../utils/circuitBreaker.js';
import { CONSTANTS } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { normalizeChannelName } from '../providers/channels/channelTypes.js';
import { ContactRecord, ConversationRecord } from '../types/states.js';

export class InboundDispatcher {
  private isRunning: boolean = false;
  private isStopping: boolean = false;
  private pausedUntil: number = 0; // I1: Timestamp absoluto de pausa independiente de isStopping
  private pollTimer: NodeJS.Timeout | null = null;
  private reaperTimer: NodeJS.Timeout | null = null; // I2: Timer dedicado para reaper desacoplado de poll
  private purgeTimer: NodeJS.Timeout | null = null;
  public llmBreaker: CircuitBreaker;
  public shutdownAbortController: AbortController = new AbortController(); // B6: AbortController de apagado

  // C4 & C12: Sliding Worker Pool & Concurrency Control
  private activeWorkers: Set<Promise<void>> = new Set();
  private activeSenders: Set<string> = new Set();
  private isPolling: boolean = false;
  private maxConcurrency: number = CONSTANTS.INBOUND.CONCURRENCY_LIMIT;

  constructor() {
    this.llmBreaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: CONSTANTS.CIRCUIT_BREAKER.RESET_TIMEOUT_MS,
      halfOpenSuccesses: 2,
    });
  }

  public isPaused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  public getPausedUntil(): number {
    return this.pausedUntil;
  }

  public pause(ms: number = 300000): void {
    this.pausedUntil = Date.now() + ms;
    logger.warn(
      { pausedUntil: this.pausedUntil, ms },
      '⏸️ InboundDispatcher pausado preventivamente tras alerta crítica'
    );
  }

  public resume(): void {
    this.pausedUntil = 0;
    this.isStopping = false;
    this.shutdownAbortController = new AbortController();
    this.activeWorkers.clear();
    this.activeSenders.clear();
    this.isPolling = false;
    this.llmBreaker.reset();
    logger.info('▶️ InboundDispatcher reanudado');
  }

  public getActiveWorkerCount(): number {
    return this.activeWorkers.size;
  }

  public getActiveSenderCount(): number {
    return this.activeSenders.size;
  }

  public start(): void {
    if (this.isRunning) {
      logger.warn('InboundDispatcher ya está en ejecución');
      return;
    }

    if (this.shutdownAbortController.signal.aborted) {
      this.shutdownAbortController = new AbortController();
    }

    this.isRunning = true;
    this.isStopping = false;
    logger.info(
      {
        intervalMs: CONSTANTS.INBOUND.POLL_INTERVAL_MS,
        concurrencyLimit: this.maxConcurrency,
      },
      '🚀 Inbound Dispatcher Sliding Pool Daemon iniciado'
    );

    // 1. Sondeo reactivo inicial
    this.triggerImmediatePoll();

    // 2. Bucle principal de sondeo rápido de respaldo (500ms)
    this.pollTimer = setInterval(() => {
      this.triggerImmediatePoll();
    }, CONSTANTS.INBOUND.POLL_INTERVAL_MS);

    // 3. I2: Timer dedicado para el Reaper (~30s), independiente del estado del breaker y de la pausa
    this.reaperTimer = setInterval(async () => {
      await this.runReaper();
    }, 30000);
  }

  /**
   * C3 & B6: Apagado elegante cancelando llamadas en vuelo mediante AbortSignal
   * y drenando trabajadores activos con timeout duro usando Promise.race (default 24s).
   */
  public async stop(graceBudgetMs: number = 24000): Promise<void> {
    logger.info('🛑 Deteniendo Inbound Dispatcher Daemon limpiamente...');
    this.isStopping = true;
    this.isRunning = false;
    this.shutdownAbortController.abort(); // Cancelar llamadas HTTP al proveedor LLM en vuelo inmediatamente

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }

    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }

    // C3: Timeout duro garantizado con Promise.race
    if (this.activeWorkers.size > 0) {
      logger.info({ activeCount: this.activeWorkers.size }, 'Drenando workers activos de inbound...');
      let timerId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<'TIMEOUT'>((resolve) => {
        timerId = setTimeout(() => resolve('TIMEOUT'), graceBudgetMs);
      });

      const drainPromise = Promise.allSettled(Array.from(this.activeWorkers));

      const winner = await Promise.race([drainPromise, timeoutPromise]);
      if (timerId) clearTimeout(timerId);

      if (winner === 'TIMEOUT') {
        logger.warn(
          { activeCount: this.activeWorkers.size, graceBudgetMs },
          '⚠️ Tiempo límite de gracia agotado al detener InboundDispatcher: algunos workers continúan en segundo plano o fueron abortados'
        );
      } else {
        logger.info('✅ Todos los workers de inbound completaron su ejecución');
      }
    }

    logger.info('🛑 Inbound Dispatcher Daemon detenido limpiamente');
  }

  /**
   * C4: Disparador reactivo inmediato de sondeo cuando se libera un worker slot
   * o al recibir un nuevo mensaje. Protegido con guarda de reentrada `isPolling`.
   */
  public triggerImmediatePoll(): void {
    if (this.isStopping || !this.isRunning || this.isPolling || this.isPaused()) {
      return;
    }
    if (this.activeWorkers.size >= this.maxConcurrency) {
      return;
    }
    if (this.llmBreaker.getState() === 'OPEN') {
      return;
    }

    this.isPolling = true;
    this.pollNextAvailableSlots()
      .catch((err) => {
        logger.error({ err }, 'Error durante ciclo de sondeo reactivo de inbound');
      })
      .finally(() => {
        this.isPolling = false;
      });
  }

  /**
   * Reclama tantos lotes coalescidos como slots disponibles existan en el worker pool.
   */
  private async pollNextAvailableSlots(): Promise<void> {
    if (this.isStopping || !this.isRunning || this.isPaused()) return;
    if (this.llmBreaker.getState() === 'OPEN') return;

    const availableSlots = this.maxConcurrency - this.activeWorkers.size;
    if (availableSlots <= 0) return;

    try {
      const batches = await inboundRepository.claimNextBatchWithCoalescing(availableSlots);
      if (batches.length === 0) return;

      for (const batch of batches) {
        if (this.isStopping) {
          const allIds = [batch.primaryEvent.id, ...batch.secondaryEvents.map((s) => s.id)];
          await inboundRepository.releaseBatch(allIds, batch.lockToken, 0).catch(() => {});
          continue;
        }
        this.spawnWorker(batch);
      }
    } catch (err) {
      logger.error({ err }, 'Error al reclamar lotes coalescidos en pollNextAvailableSlots');
    }
  }

  /**
   * C4: Instancia un worker aislado para procesar un lote coalescido.
   * Envuelto en try/catch/finally garantizando la eliminación de sets y el sondeo reactivo posterior.
   */
  private spawnWorker(batch: CoalescedEventBatch): void {
    const senderKey = `${batch.primaryEvent.phone_number_id}:${batch.primaryEvent.sender_phone}`;
    this.activeSenders.add(senderKey);

    let workerPromise: Promise<void>;
    const task = async () => {
      try {
        await this.processCoalescedBatch(batch);
      } catch (err) {
        logger.error(
          { err, batchId: batch.primaryEvent.id, sender: senderKey },
          'Error no capturado en worker de lote coalescido'
        );
      } finally {
        this.activeSenders.delete(senderKey);
        this.activeWorkers.delete(workerPromise);
        this.triggerImmediatePoll();
      }
    };

    workerPromise = task();
    this.activeWorkers.add(workerPromise);
  }

  /**
   * Retrocompatibilidad para tests o invocaciones directas.
   */
  public async processNextBatch(): Promise<void> {
    this.triggerImmediatePoll();
  }

  /**
   * I2 & T7: Ejecuta el ciclo de reaper de forma independiente al breaker.
   * Emite alertas INBOUND_TERMINAL_FAILURE individuales y encola fallback para cada poison pill.
   */
  public async runReaper(): Promise<void> {
    try {
      const { reapedCount, poisonPills } = await inboundRepository.reapOrphaned(
        CONSTANTS.INBOUND.LEASE_TIMEOUT_SECONDS
      );
      if (poisonPills.length > 0) {
        for (const pill of poisonPills) {
          logger.fatal(
            {
              alert: 'INBOUND_TERMINAL_FAILURE',
              eventId: pill.id,
              wamid: pill.wamid,
              senderPhone: pill.sender_phone,
            },
            '🚨 ALERTA CRÍTICA: Inbound event alcanzó límite de reintentos por poison pill. Pasado a FAILED.'
          );
          await this.handleReaperPoisonPillFallback(pill);
        }
      }
    } catch (reaperErr) {
      logger.error({ reaperErr }, 'Error en reaper de eventos inbound');
    }
  }

  private async handleReaperPoisonPillFallback(event: InboundEventRecord): Promise<void> {
    try {
      const contact = await contactRepository.findOrCreate(event.sender_phone);
      const conversation = await conversationRepository.getOrCreateActiveSession(contact.id);
      await outboxRepository.enqueueMessage({
        conversationId: conversation.id,
        channel: normalizeChannelName(event.channel),
        phoneNumberId: event.phone_number_id,
        recipientPhone: event.sender_phone,
        messageType: 'text',
        content:
          'Disculpa, tuvimos una dificultad técnica para procesar tu último mensaje. Un asesor humano te atenderá a la brevedad.',
      });
      logger.info({ eventId: event.id, phone: event.sender_phone }, 'Fallback de poison pill encolado en outbox');
    } catch (err) {
      logger.error({ err, eventId: event.id }, 'Error al encolar fallback de poison pill');
    }
  }

  /**
   * Procesa un único evento adaptándolo a la interfaz de lote coalescido.
   */
  public async processSingleEvent(event: InboundEventRecord): Promise<void> {
    return this.processCoalescedBatch({
      primaryEvent: event,
      secondaryEvents: [],
      lockToken: event.lock_token || '',
    });
  }

  /**
   * C9 & C10: Procesa un lote coalescido de mensajes de un mismo remitente.
   * - Concatena textos en memoria para una única inferencia LLM eficiente.
   * - Persiste CADA mensaje de forma individual e inmutable en public.messages.
   * - Compromete en una sola transacción atómica con Fencing Token.
   */
  public async processCoalescedBatch(batch: CoalescedEventBatch): Promise<void> {
    const { primaryEvent, secondaryEvents, lockToken } = batch;
    const allEvents = [primaryEvent, ...secondaryEvents];
    const allIds = allEvents.map((e) => e.id);

    if (this.isStopping) {
      logger.warn({ eventId: primaryEvent.id }, 'Apagado en progreso: liberando lote coalescido');
      if (lockToken) {
        await inboundRepository.releaseBatch(allIds, lockToken, 0);
      }
      return;
    }

    const primaryPayload = primaryEvent.payload;
    const primaryMsg = primaryPayload?.message || {};
    const primaryText = primaryMsg.text?.body || primaryMsg.interactive?.button_reply?.title || '';
    const senderName = primaryPayload?.contact?.profile?.name || 'Cliente';
    const from = primaryEvent.sender_phone;

    // C9: Concatenación en memoria para la llamada al LLM
    const texts: string[] = [];
    if (primaryText) texts.push(primaryText);
    for (const sec of secondaryEvents) {
      const secMsg = sec.payload?.message || {};
      const secText = secMsg.text?.body || secMsg.interactive?.button_reply?.title || '';
      if (secText) texts.push(secText);
    }
    const concatenatedText = texts.join('\n');
    const promptText = concatenatedText.trim()
      ? concatenatedText
      : primaryMsg.type
      ? `[Mensaje recibido de tipo ${primaryMsg.type}]`
      : 'Hola';

    let contact: ContactRecord | undefined;
    let conversation: ConversationRecord | undefined;

    try {
      // 1. Obtener o crear contacto y sesión conversacional activa
      contact = await contactRepository.findOrCreate(from, senderName);
      conversation = await conversationRepository.getOrCreateActiveSession(contact.id);

      // 2. B5: Comprobar escalamiento a humano existente ANTES de evaluar frescura
      if (contact.status === 'HUMAN_HANDOFF') {
        logger.info(
          { from, eventId: primaryEvent.id },
          'Mensajes recibidos durante HUMAN_HANDOFF: archivando sin respuesta bot'
        );
        const client = await db.getClient();
        try {
          await client.query('BEGIN');
          const fenced = await inboundRepository.markCoalescedBatchDone(
            primaryEvent.id,
            secondaryEvents.map((s) => s.id),
            lockToken,
            client
          );
          if (!fenced) throw new Error('FENCE_LOST');

          // C9: Guardar cada mensaje individualmente en messages
          for (const ev of allEvents) {
            const m = ev.payload?.message || {};
            const t = m.text?.body || m.interactive?.button_reply?.title || '';
            await messageRepository.saveInboundMessage(
              { wamid: ev.wamid, conversationId: conversation.id, content: t, rawPayload: m },
              client
            );
          }
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
        return;
      }

      // 3. B5: Frescura del mensaje tras caída prolongada (> 30 min)
      const messageAge = Date.now() - new Date(primaryEvent.created_at).getTime();
      if (messageAge > CONSTANTS.INBOUND.MAX_MESSAGE_AGE_MS) {
        logger.warn(
          { eventId: primaryEvent.id, messageAgeMs: messageAge },
          '⚠️ Mensaje inbound supera umbral de frescura: escalando a humano con SYSTEM_DELAY'
        );
        await this.handleStaleCoalescedBatch(batch, contact, conversation, allEvents);
        return;
      }

      // 4. I4: Valida y renueva el lease atómicamente antes de llamar al LLM
      const extended = await inboundRepository.extendBatchLease(allIds, lockToken);
      if (!extended) {
        logger.warn(
          { eventId: primaryEvent.id },
          'Lease no válido o expirado antes de inferencia LLM, abortando'
        );
        return;
      }

      // Si el servidor está apagándose o la señal de aborto ya fue activada (B6):
      if (this.isStopping || this.shutdownAbortController.signal.aborted) {
        logger.info(
          { eventId: primaryEvent.id },
          'Apagado detectado antes de inferencia LLM: liberando lease sin quemar reintentos'
        );
        if (lockToken) {
          await inboundRepository.releaseBatch(allIds, lockToken, 0);
        }
        return;
      }

      // 5. Inferencia LLM con presupuesto de turno determinista (24s) y AbortSignal de apagado (B6)
      const turnDeadlineMs = Date.now() + 24000;
      let decision;
      try {
        decision = await this.llmBreaker.execute(
          () =>
            agentEngine.processMessage(contact!, conversation!, promptText, {
              deferSideEffects: true,
              deadlineMs: turnDeadlineMs,
              abortSignal: this.shutdownAbortController.signal,
            }),
          (err) => {
            const type = classifyLlmError(err);
            if (type === 'DAILY_QUOTA_EXHAUSTED' || type === 'AUTH_OR_CONFIG_ERROR') {
              return 'neutral';
            }
            return isTransientLlmError(err);
          }
        );
      } catch (llmError: any) {
        if (this.shutdownAbortController.signal.aborted) {
          logger.info(
            { eventId: primaryEvent.id },
            'Inferencia LLM abortada por apagado: liberando lease sin quemar reintentos'
          );
          if (lockToken) {
            await inboundRepository.releaseBatch(allIds, lockToken, 0);
          }
          return;
        }

        if (llmError instanceof CircuitOpenError) {
          logger.warn(
            {
              eventId: primaryEvent.id,
              retryAfterMs: llmError.retryAfterMs,
              breakerState: this.llmBreaker.getState(),
            },
            '🛑 LLM Circuit Breaker rechazó llamada (OPEN): posponiendo eventos sin quemar reintentos'
          );
          if (lockToken) {
            const delaySec = Math.max(1, Math.ceil(llmError.retryAfterMs / 1000));
            await inboundRepository.releaseBatch(allIds, lockToken, delaySec);
          }
          return;
        }

        const errorType = classifyLlmError(llmError);
        logger.warn(
          { eventId: primaryEvent.id, errorType, err: llmError.message },
          'Clasificación de error LLM en inboundDispatcher'
        );

        if (errorType === 'AUTH_OR_CONFIG_ERROR') {
          logger.fatal(
            { alert: 'LLM_AUTH_OR_CONFIG_ERROR', eventId: primaryEvent.id, err: llmError.message },
            '🚨 ALERTA CRÍTICA: Error de credenciales o configuración del proveedor LLM. Pausando dispatcher sin quemar eventos.'
          );
          this.pause(300000);
          if (lockToken) {
            await inboundRepository.releaseBatch(allIds, lockToken, 300);
          }
          return;
        }

        if (errorType === 'DAILY_QUOTA_EXHAUSTED') {
          logger.fatal(
            { alert: 'LLM_QUOTA_EXHAUSTED', eventId: primaryEvent.id, err: llmError.message },
            '🚨 ALERTA CRÍTICA: Cuota diaria del proveedor LLM agotada. Disparando breaker con pausa prolongada.'
          );
          this.llmBreaker.trip(600000);
          if (lockToken) {
            await inboundRepository.releaseBatch(allIds, lockToken, 600);
          }
          return;
        }

        if (errorType === 'TRANSIENT_RATE_LIMIT' || errorType === 'NETWORK_OR_TIMEOUT') {
          if (primaryEvent.retry_count + 1 >= CONSTANTS.INBOUND.MAX_RETRIES) {
            await this.handleTerminalInboundFailure(batch, contact!, conversation!, llmError);
          } else {
            const recommendedDelay = extractLlmRetryDelaySeconds(llmError);
            const backoff =
              recommendedDelay ??
              CONSTANTS.INBOUND.BACKOFF_BASE_SECONDS * Math.pow(2, primaryEvent.retry_count);
            if (lockToken) {
              await inboundRepository.retryFailedBatch(allIds, lockToken, llmError.message, backoff);
            }
          }
          return;
        }

        await this.handleTerminalInboundFailure(batch, contact!, conversation!, llmError);
        return;
      }

      // 6. B4: Manejo estricto de respuesta vacía del LLM
      if (!decision.replyText && !decision.pendingHandoff) {
        throw new Error('EMPTY_LLM_RESPONSE: El modelo no generó texto de respuesta ni ejecutó handoff');
      }

      if (decision.pendingHandoff && !decision.replyText) {
        decision.replyText =
          'Te estamos transfiriendo con un asesor humano de nuestro equipo. En un momento te atenderemos.';
      }

      // 7. UNA SOLA TRANSACCIÓN PARA EL RESULTADO ATÓMICO (C9)
      const client = await db.getClient();
      try {
        await client.query('BEGIN');

        // A. FENCE CHECK ATÓMICO: Marcar lote como DONE exigiendo lock_token exacto
        const fenced = await inboundRepository.markCoalescedBatchDone(
          primaryEvent.id,
          secondaryEvents.map((s) => s.id),
          lockToken,
          client
        );
        if (!fenced) {
          throw new Error('FENCE_LOST: Inbound event lease expired or reallocated');
        }

        // B. Ejecución atómica de efectos secundarios diferidos de las tools (Leads / Handoff)
        if (decision.pendingLead) {
          await executeLeadInTransaction(decision.pendingLead, client);
        }
        if (decision.pendingHandoff) {
          await executeHandoffInTransaction(decision.pendingHandoff, client);
        }

        // C. Transición de estado conversacional
        let targetState = conversation.current_state;
        if (conversation.current_state === 'IDLE') {
          targetState = 'QUALIFYING';
        }
        if (targetState !== conversation.current_state) {
          await conversationRepository.transitionState(
            conversation.id,
            targetState,
            undefined,
            conversation.current_state,
            client
          );
        }

        // D. C9: Persistencia individual inmutable en public.messages para cada mensaje del lote
        for (const ev of allEvents) {
          const m = ev.payload?.message || {};
          const t = m.text?.body || m.interactive?.button_reply?.title || '';
          await messageRepository.saveInboundMessage(
            {
              wamid: ev.wamid,
              conversationId: conversation.id,
              content: t,
              rawPayload: m,
            },
            client
          );
        }

        // E. Encolado de la respuesta saliente en outbox_messages
        if (decision.replyText) {
          await outboxRepository.enqueueMessage(
            {
              conversationId: conversation.id,
              channel: normalizeChannelName(primaryEvent.channel),
              phoneNumberId: primaryEvent.phone_number_id,
              recipientPhone: from,
              messageType: 'text',
              content: decision.replyText,
              promptTokens: decision.promptTokens,
              completionTokens: decision.completionTokens,
              latencyMs: decision.totalLatencyMs,
            },
            client
          );
        }

        await client.query('COMMIT');
        logger.info(
          {
            primaryId: primaryEvent.id,
            wamid: primaryEvent.wamid,
            coalescedCount: allEvents.length,
          },
          '✅ Lote de eventos inbound procesado y comprometido atómicamente'
        );
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
    } catch (error: any) {
      if (this.shutdownAbortController.signal.aborted) {
        logger.info(
          { eventId: primaryEvent.id },
          'Procesamiento cancelado por apagado: liberando lease sin quemar reintentos'
        );
        if (lockToken) {
          await inboundRepository.releaseBatch(allIds, lockToken, 0);
        }
        return;
      }

      if (error?.message?.includes('FENCE_LOST')) {
        logger.warn({ eventId: primaryEvent.id }, 'Transacción revertida: lease robado o expirado');
        return;
      }

      logger.error({ eventId: primaryEvent.id, error }, 'Error al procesar lote coalescido de inbound');
      if (lockToken) {
        if (primaryEvent.retry_count + 1 >= CONSTANTS.INBOUND.MAX_RETRIES) {
          await this.handleTerminalInboundFailure(batch, contact, conversation, error);
        } else {
          const backoff =
            CONSTANTS.INBOUND.BACKOFF_BASE_SECONDS * Math.pow(2, primaryEvent.retry_count);
          await inboundRepository.retryFailedBatch(
            allIds,
            lockToken,
            error?.message || 'Generic error',
            backoff
          );
        }
      }
    }
  }

  /**
   * B5: Manejo de mensajes obsoletos tras caídas del sistema para un lote coalescido.
   */
  private async handleStaleCoalescedBatch(
    batch: CoalescedEventBatch,
    contact: ContactRecord,
    conversation: ConversationRecord,
    allEvents: InboundEventRecord[]
  ): Promise<void> {
    const { primaryEvent, secondaryEvents, lockToken } = batch;
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const fenced = await inboundRepository.markCoalescedBatchDone(
        primaryEvent.id,
        secondaryEvents.map((s) => s.id),
        lockToken,
        client
      );
      if (!fenced) throw new Error('FENCE_LOST');

      await executeHandoffInTransaction(
        {
          contactId: contact.id,
          conversationId: conversation.id,
          reason: 'SYSTEM_DELAY',
          briefing: `Mensajes recibidos con retraso significativo (${Math.round(
            (Date.now() - new Date(primaryEvent.created_at).getTime()) / 60000
          )} min) tras interrupción técnica.`,
        },
        client
      );

      for (const ev of allEvents) {
        const m = ev.payload?.message || {};
        const t = m.text?.body || m.interactive?.button_reply?.title || '';
        await messageRepository.saveInboundMessage(
          {
            wamid: ev.wamid,
            conversationId: conversation.id,
            content: t,
            rawPayload: m,
          },
          client
        );
      }

      await outboxRepository.enqueueMessage(
        {
          conversationId: conversation.id,
          channel: normalizeChannelName(primaryEvent.channel),
          phoneNumberId: primaryEvent.phone_number_id,
          recipientPhone: primaryEvent.sender_phone,
          messageType: 'text',
          content:
            'Hola, recibimos tu mensaje con retraso debido a una pausa técnica temporal. Un asesor de nuestro equipo te atenderá de forma prioritaria en breve.',
        },
        client
      );

      await client.query('COMMIT');
      logger.info(
        { eventId: primaryEvent.id },
        '✅ Lote de mensajes obsoletos transferido a asesor humano atómicamente (SYSTEM_DELAY)'
      );
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ e, eventId: primaryEvent.id }, 'Error al procesar lote de mensajes obsoletos');
    } finally {
      client.release();
    }
  }

  /**
   * Manejo de fallo terminal para evento o lote inbound.
   * Transiciona todos los eventos a FAILED y encola el mensaje de fallback en la MISMA transacción con fence.
   */
  private async handleTerminalInboundFailure(
    batchOrEvent: CoalescedEventBatch | InboundEventRecord,
    contact?: ContactRecord,
    conversation?: ConversationRecord,
    error?: any
  ): Promise<void> {
    const isBatch = 'primaryEvent' in batchOrEvent;
    const primaryEvent = isBatch ? batchOrEvent.primaryEvent : batchOrEvent;
    const secondaryIds = isBatch ? batchOrEvent.secondaryEvents.map((s) => s.id) : [];
    const lockToken = isBatch ? batchOrEvent.lockToken : batchOrEvent.lock_token;

    logger.error(
      {
        alert: 'INBOUND_TERMINAL_FAILURE',
        eventId: primaryEvent.id,
        wamid: primaryEvent.wamid,
        senderPhone: primaryEvent.sender_phone,
        error: String(error?.message || error),
      },
      '🚨 ALERTA CRÍTICA: Evento inbound terminó en FAILED tras agotar reintentos o fallo permanente'
    );

    if (!lockToken) return;

    let activeConversation = conversation;
    if (!activeConversation?.id && primaryEvent.sender_phone) {
      try {
        const c = await contactRepository.findOrCreate(primaryEvent.sender_phone);
        activeConversation = await conversationRepository.getOrCreateActiveSession(c.id);
      } catch (e) {
        logger.error(
          { e, eventId: primaryEvent.id },
          'No se pudo resolver conversación de respaldo para fallo terminal'
        );
      }
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const allIds = [primaryEvent.id, ...secondaryIds];
      const failed = await inboundRepository.terminalFailedBatch(
        allIds,
        lockToken,
        String(error?.message || error),
        client
      );

      if (failed && activeConversation?.id && primaryEvent.sender_phone) {
        await outboxRepository.enqueueMessage(
          {
            conversationId: activeConversation.id,
            channel: normalizeChannelName(primaryEvent.channel),
            phoneNumberId: primaryEvent.phone_number_id,
            recipientPhone: primaryEvent.sender_phone,
            messageType: 'text',
            content:
              'Disculpa, en este momento experimentamos dificultades técnicas temporales. Hemos notificado a nuestro equipo y un asesor te atenderá a la brevedad.',
          },
          client
        );
      }

      await client.query('COMMIT');
      logger.info(
        { eventId: primaryEvent.id, recipient: primaryEvent.sender_phone },
        '✅ Fallo terminal y mensaje de fallback comprometidos atómicamente con fence'
      );
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ txErr, eventId: primaryEvent.id }, 'Error en transacción atómica de fallo terminal');
    } finally {
      client.release();
    }
  }
}

export const inboundDispatcher = new InboundDispatcher();
