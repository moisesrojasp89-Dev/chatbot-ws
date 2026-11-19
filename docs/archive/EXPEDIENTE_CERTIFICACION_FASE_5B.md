# EXPEDIENTE OFICIAL DE CERTIFICACIÓN TÉCNICA - FASE 5B
**Proyecto:** Chatbot WS (WhatsApp Business Cloud API + LLM Agent Engine)  
**Alcance Auditado:** Fase 5B - Inbound Durable (I18) & Seguridad RLS + PII (I20)  
**Fecha:** 2026-09-20  
**Estado:** 100% Implementado, Migrado en Supabase São Paulo y Verificado (101/101 Tests Passing)

---

## 1. RESUMEN DE RESOLUCIÓN DE OBSERVACIONES DEL AUDITOR

| # | Observación del Auditor | Solución Técnica Implementada en Código | Archivo Principal |
|---|---|---|---|
| **1** | `Promise.race` no cancela la llamada al LLM; falta `AbortSignal` y presupuesto de turno ReAct vs lease de 30s. | Se integró `AbortController`, pasando `abortSignal` y `httpOptions: { timeout: 20000 }` nativos al SDK `@google/genai`. En `agentEngine.ts`, se incorporó `options.deadlineMs` (presupuesto global de 24s) distribuyendo el tiempo entre turnos ReAct para que jamás supere el lease de 30s. Se añadió `extendLease()` en el repositorio. | `geminiClient.ts`<br>`agentEngine.ts` |
| **2** | Verificación de Circuit Breaker antes de reclamar; clasificación estricta de errores LLM; mensaje de fallback atómico; frescura de mensajes. | `inboundDispatcher.ts` comprueba `this.llmBreaker.getState() === 'OPEN'` antes de reclamar lote. Errores clasificados: cuota diaria dispara `trip(600000)` con 10 min de pausa; 401/403 pausa worker sin quemar a `FAILED`. Guarda de frescura de 30 min transiciona a handoff si hubo caída prolongada. Mensaje de fallback y marcado `FAILED` se comprometen en la **misma transacción con fence**. | `inboundDispatcher.ts`<br>`geminiClient.ts`<br>`circuitBreaker.ts` |
| **3** | RLS: `REVOKE ALL` no cubre tablas futuras; falta `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` y revocación en secuencias y rutinas. | `010_revoke_anon_authenticated_permissions.sql` revoca permisos sobre tablas, secuencias y rutinas existentes en `public` para `anon` y `authenticated`, y ejecuta `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL` protegiendo objetos futuros. | `010_revoke_anon_authenticated_permissions.sql` |
| **4** | Retención unificada de PII (inbound, outbox, messages, status_events) y desacoplamiento del tick de 500ms. | `purgeProcessedEvents()` ahora purga de forma unificada `inbound_events` (DONE), `outbox_messages` (SENT), `messages` y `message_status_events` mediante CTE con `LIMIT 500` para no retener locks largos. En `inboundDispatcher.ts`, la purga corre en un timer independiente cada 1 hora. | `inboundRepository.ts`<br>`inboundDispatcher.ts` |
| **5** | Efectos secundarios diferidos de Tools (Leads / Handoff) ejecutados en la transacción final del resultado. | `executeLeadInTransaction` y `executeHandoffInTransaction` reciben el `client` de la transacción única del dispatcher. Si ocurre rollback, no queda ningún lead ni sesión huérfana en base de datos. La notificación al usuario o agente se encola en `outbox_messages` dentro de esa misma transacción. | `inboundDispatcher.ts`<br>`leadTools.ts`<br>`handoffTools.ts` |
| **6** | Reaper de Inbound con protección Poison Pill. | `reapOrphaned()` evalúa: si `retry_count + 1 >= 3` transiciona directamente a `FAILED` con `last_error = 'Poison pill: lease expired MAX_RETRIES times'`, evitando bucles infinitos de reinicio. | `inboundRepository.ts` |

---

## 2. CÓDIGO FUENTE COMPLETO

### 2.1. `src/services/inboundDispatcher.ts`
*(Transacción única con Fencing Token, Circuit Breaker preventivo, guarda de frescura y fallback atómico)*

```typescript
import { db } from '../providers/database/dbClient.js';
import { inboundRepository, InboundEventRecord } from '../repositories/inboundRepository.js';
import { contactRepository } from '../repositories/contactRepository.js';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { outboxRepository } from '../repositories/outboxRepository.js';
import { agentEngine } from '../harness/agentEngine.js';
import { executeLeadInTransaction } from '../harness/tools/leadTools.js';
import { executeHandoffInTransaction } from '../harness/tools/handoffTools.js';
import { isTransientLlmError, classifyLlmError } from '../providers/llm/geminiClient.js';
import { CircuitBreaker, CircuitOpenError } from '../utils/circuitBreaker.js';
import { CONSTANTS } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { ContactRecord, ConversationRecord } from '../types/states.js';

export class InboundDispatcher {
  private isRunning: boolean = false;
  private isStopping: boolean = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private backgroundTasks: Set<Promise<unknown>> = new Set();
  public llmBreaker: CircuitBreaker;

  constructor() {
    this.llmBreaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: CONSTANTS.CIRCUIT_BREAKER.RESET_TIMEOUT_MS,
      halfOpenSuccesses: 2,
    });
  }

  public start(): void {
    if (this.isRunning) {
      logger.warn('InboundDispatcher ya está en ejecución');
      return;
    }

    this.isRunning = true;
    this.isStopping = false;
    logger.info(
      { intervalMs: CONSTANTS.INBOUND.POLL_INTERVAL_MS, batchSize: CONSTANTS.INBOUND.BATCH_SIZE },
      '🚀 Inbound Dispatcher Daemon iniciado'
    );

    // Bucle principal de sondeo rápido (500ms)
    this.pollTimer = setInterval(async () => {
      if (!this.inFlight && this.isRunning && !this.isStopping) {
        this.inFlight = this.processNextBatch()
          .catch((err) => {
            logger.error({ err }, 'Error durante el ciclo de sondeo de inbound');
          })
          .finally(() => {
            this.inFlight = null;
          });
      }
    }, CONSTANTS.INBOUND.POLL_INTERVAL_MS);

    // Auditor 5B (Punto 4): Purga periódica por lotes desacoplada del tick rápido (cada 1 hora)
    this.purgeTimer = setInterval(async () => {
      try {
        await inboundRepository.purgeProcessedEvents(CONSTANTS.INBOUND.RETENTION_DAYS, 500);
      } catch (purgeErr) {
        logger.error({ purgeErr }, 'Error en purga periódica LGPD de datos sensibles');
      }
    }, 60 * 60 * 1000);
  }

  public async stop(graceBudgetMs: number = 25000): Promise<void> {
    if (!this.isRunning) return;

    logger.info('🛑 Deteniendo Inbound Dispatcher Daemon limpiamente...');
    this.isStopping = true;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }

    const startWait = Date.now();
    if (this.inFlight) {
      const remainingBudget = Math.max(100, graceBudgetMs - (Date.now() - startWait));
      await Promise.race([
        this.inFlight,
        new Promise((resolve) => setTimeout(resolve, remainingBudget)),
      ]);
      this.inFlight = null;
    }

    if (this.backgroundTasks.size > 0) {
      const remaining = Math.max(100, graceBudgetMs - (Date.now() - startWait));
      await Promise.race([
        Promise.allSettled(Array.from(this.backgroundTasks)),
        new Promise((resolve) => setTimeout(resolve, remaining)),
      ]);
    }

    this.isRunning = false;
    logger.info('🛑 Inbound Dispatcher Daemon detenido limpiamente');
  }

  public pause(): void {
    this.isStopping = true;
    logger.warn('⏸️ InboundDispatcher pausado preventivamente tras alerta crítica');
  }

  public resume(): void {
    this.isStopping = false;
  }

  public async processNextBatch(): Promise<void> {
    if (this.isStopping) return;

    // Auditor 5B (Punto 2): Verificar estado del Circuit Breaker ANTES de reclamar batch.
    // Previene ciclos inútiles de reclamo/liberación si el proveedor de IA está caído.
    if (this.llmBreaker.getState() === 'OPEN') {
      logger.debug('🛑 Circuit Breaker en estado OPEN: postergando sondeo de lote inbound');
      return;
    }

    // 1. Reaper: Rescate preventivo de eventos huérfanos con lease expirado (Poison pill protegido)
    try {
      await inboundRepository.reapOrphaned(CONSTANTS.INBOUND.LEASE_TIMEOUT_SECONDS);
    } catch (reaperErr) {
      logger.error({ reaperErr }, 'Error en reaper de eventos inbound');
    }

    // 2. Reclamo de lote con cabeza por remitente y SKIP LOCKED
    const batch = await inboundRepository.claimPendingBatch(CONSTANTS.INBOUND.BATCH_SIZE);
    if (batch.length === 0) return;

    logger.debug({ count: batch.length }, 'Lote de eventos inbound reclamado para procesamiento');

    // 3. Despacho concurrente entre diferentes usuarios
    const promises = batch.map((event) => this.processSingleEvent(event));
    await Promise.allSettled(promises);
  }

  public async processSingleEvent(event: InboundEventRecord): Promise<void> {
    if (this.isStopping) {
      logger.warn({ eventId: event.id }, 'Apagado en progreso: liberando evento inbound');
      if (event.lock_token) {
        await inboundRepository.release(event.id, event.lock_token, 5);
      }
      return;
    }

    const payload = event.payload;
    const msg = payload?.message || {};
    const text = msg.text?.body || msg.interactive?.button_reply?.title || '';
    const senderName = payload?.contact?.profile?.name || 'Cliente';
    const from = event.sender_phone;

    try {
      // 1. Obtener o crear contacto y sesión conversacional activa
      const contact = await contactRepository.findOrCreate(from, senderName);
      const conversation = await conversationRepository.getOrCreateActiveSession(contact.id);

      // 2. Auditor 5B (Punto 2): Frescura del mensaje.
      // Si el evento tiene más de 30 minutos de antigüedad (ej: tras una caída prolongada),
      // responder con contexto obsoleto es contraproducente; se escala directamente a humano.
      const MAX_MESSAGE_AGE_MS = 30 * 60 * 1000;
      const messageAge = Date.now() - new Date(event.created_at).getTime();
      if (messageAge > MAX_MESSAGE_AGE_MS) {
        logger.warn(
          { eventId: event.id, messageAgeMs: messageAge },
          '⚠️ Mensaje inbound supera umbral de frescura (30 min): escalando a humano para evitar respuesta descontextualizada'
        );
        await this.handleStaleMessage(event, contact, conversation, text, msg);
        return;
      }

      // 3. Comprobar escalamiento a humano existente
      if (contact.status === 'HUMAN_HANDOFF') {
        logger.info({ from, eventId: event.id }, 'Mensaje recibido durante HUMAN_HANDOFF');
        const client = await db.getClient();
        try {
          await client.query('BEGIN');
          const fenced = await inboundRepository.markDone(event.id, event.lock_token!, client);
          if (!fenced) throw new Error('FENCE_LOST');
          await messageRepository.saveInboundMessage(
            { wamid: event.wamid, conversationId: conversation.id, content: text, rawPayload: msg },
            client
          );
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
        return;
      }

      // 4. Comprobar validez de lease antes de llamar al LLM
      const valid = await inboundRepository.isLeaseValid(event.id, event.lock_token!);
      if (!valid) {
        logger.warn({ eventId: event.id }, 'Lease no válido antes de inferencia LLM, abortando');
        return;
      }

      // 5. Auditor 5B (Puntos 1 y 2): Inferencia LLM con presupuesto de turno determinista (24s)
      // Se garantiza que el ciclo ReAct (hasta 3 iteraciones) no exceda el lease de 30s.
      const turnDeadlineMs = Date.now() + 24000;
      let decision;
      try {
        decision = await this.llmBreaker.execute(
          () =>
            agentEngine.processMessage(contact, conversation, text, {
              deferSideEffects: true,
              deadlineMs: turnDeadlineMs,
            }),
          (err) => isTransientLlmError(err)
        );
      } catch (llmError: any) {
        if (llmError instanceof CircuitOpenError) {
          logger.warn(
            { eventId: event.id, breakerState: this.llmBreaker.getState() },
            '🛑 LLM Circuit Breaker rechazó llamada (OPEN): posponiendo evento sin quemar reintentos'
          );
          if (event.lock_token) {
            await inboundRepository.release(
              event.id,
              event.lock_token,
              CONSTANTS.CIRCUIT_BREAKER.RESET_TIMEOUT_MS / 1000
            );
          }
          return;
        }

        const errorType = classifyLlmError(llmError);
        logger.error(
          { eventId: event.id, errorType, err: llmError.message || llmError },
          'Error clasificado en llamada al proveedor de LLM'
        );

        // Errores de credencial o configuración: pausar dispatcher y NO quemar eventos a FAILED
        if (errorType === 'AUTH_OR_CONFIG_ERROR') {
          logger.fatal(
            { alert: 'LLM_AUTH_OR_CONFIG_ERROR', eventId: event.id, err: llmError.message },
            '🚨 ALERTA CRÍTICA: Error de credenciales o configuración en Gemini API. Pausando worker sin quemar eventos.'
          );
          this.pause();
          if (event.lock_token) {
            await inboundRepository.release(event.id, event.lock_token, 300);
          }
          return;
        }

        // Agotamiento de cuota diaria: alerta crítica y pausa prolongada (10m) en lugar de backoff corto
        if (errorType === 'DAILY_QUOTA_EXHAUSTED') {
          logger.fatal(
            { alert: 'LLM_QUOTA_EXHAUSTED', eventId: event.id, err: llmError.message },
            '🚨 ALERTA CRÍTICA: Cuota diaria de Gemini agotada (RESOURCE_EXHAUSTED). Disparando breaker con pausa prolongada.'
          );
          this.llmBreaker.trip(600000);
          if (event.lock_token) {
            await inboundRepository.release(event.id, event.lock_token, 600);
          }
          return;
        }

        // Errores transitorios (429 por minuto o timeout/red): reintento exponencial hasta MAX_RETRIES
        if (errorType === 'TRANSIENT_RATE_LIMIT' || errorType === 'NETWORK_OR_TIMEOUT') {
          if (event.retry_count + 1 >= CONSTANTS.INBOUND.MAX_RETRIES) {
            await this.handleTerminalInboundFailure(event, contact, conversation, llmError);
          } else {
            const backoff = CONSTANTS.INBOUND.BACKOFF_BASE_SECONDS * Math.pow(2, event.retry_count);
            if (event.lock_token) {
              await inboundRepository.release(event.id, event.lock_token, backoff);
            }
          }
          return;
        }

        // Error fatal permanente en payload: fallo terminal inmediato
        await this.handleTerminalInboundFailure(event, contact, conversation, llmError);
        return;
      }

      // 6. Auditor 5B (Punto 3): UNA SOLA TRANSACCIÓN PARA EL RESULTADO
      // Incluye atómicamente: Fencing token check (markDone) + side-effects diferidos + saveInboundMessage + enqueueMessage
      const client = await db.getClient();
      try {
        await client.query('BEGIN');

        // A. FENCE CHECK ATÓMICO: Marcar evento como DONE exigiendo lock_token exacto
        const fenced = await inboundRepository.markDone(event.id, event.lock_token!, client);
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

        // D. Persistencia del mensaje inbound en messages
        await messageRepository.saveInboundMessage(
          {
            wamid: event.wamid,
            conversationId: conversation.id,
            content: text,
            rawPayload: msg,
          },
          client
        );

        // E. Encolado del mensaje saliente en outbox_messages
        if (decision.replyText) {
          await outboxRepository.enqueueMessage(
            {
              conversationId: conversation.id,
              phoneNumberId: event.phone_number_id,
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
        logger.info({ eventId: event.id, wamid: event.wamid }, '✅ Evento inbound procesado y comprometido atómicamente');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
    } catch (error: any) {
      if (error?.message?.includes('FENCE_LOST')) {
        logger.warn({ eventId: event.id }, 'Transacción revertida: lease robado o expirado');
        return;
      }

      logger.error({ eventId: event.id, error }, 'Error al procesar evento inbound');
      if (event.lock_token) {
        if (event.retry_count + 1 >= CONSTANTS.INBOUND.MAX_RETRIES) {
          await this.handleTerminalInboundFailure(event, {} as any, {} as any, error);
        } else {
          const backoff = CONSTANTS.INBOUND.BACKOFF_BASE_SECONDS * Math.pow(2, event.retry_count);
          await inboundRepository.release(event.id, event.lock_token, backoff);
        }
      }
    }
  }

  /**
   * Auditor 5B (Punto 2): Manejo de mensajes obsoletos tras caídas del sistema.
   * Transiciona atómicamente a HUMAN_HANDOFF con aviso al usuario en outbox.
   */
  private async handleStaleMessage(
    event: InboundEventRecord,
    contact: ContactRecord,
    conversation: ConversationRecord,
    text: string,
    rawPayload: any
  ): Promise<void> {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const fenced = await inboundRepository.markDone(event.id, event.lock_token!, client);
      if (!fenced) throw new Error('FENCE_LOST');

      await executeHandoffInTransaction(
        {
          contactId: contact.id,
          conversationId: conversation.id,
          reason: 'OUT_OF_SCOPE',
          briefing: `Mensaje recibido con retraso significativo (${Math.round((Date.now() - new Date(event.created_at).getTime()) / 60000)} min) tras interrupción técnica.`,
        },
        client
      );

      await messageRepository.saveInboundMessage(
        {
          wamid: event.wamid,
          conversationId: conversation.id,
          content: text,
          rawPayload,
        },
        client
      );

      await outboxRepository.enqueueMessage(
        {
          conversationId: conversation.id,
          phoneNumberId: event.phone_number_id,
          recipientPhone: event.sender_phone,
          messageType: 'text',
          content:
            'Hola, recibimos tu mensaje con retraso debido a una pausa técnica temporal. Un asesor de nuestro equipo te atenderá de forma prioritaria en breve.',
        },
        client
      );

      await client.query('COMMIT');
      logger.info({ eventId: event.id }, '✅ Mensaje obsoleto transferido a asesor humano atómicamente');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ e, eventId: event.id }, 'Error al procesar mensaje obsoleto');
    } finally {
      client.release();
    }
  }

  /**
   * Auditor 5B (Punto 1 y 2): Manejo de fallo terminal para evento inbound.
   * Transiciona el evento a FAILED y encola el mensaje de fallback en la MISMA transacción con fence.
   */
  private async handleTerminalInboundFailure(
    event: InboundEventRecord,
    contact: ContactRecord,
    conversation: ConversationRecord,
    error: any
  ): Promise<void> {
    logger.error(
      {
        alert: 'INBOUND_TERMINAL_FAILURE',
        eventId: event.id,
        wamid: event.wamid,
        senderPhone: event.sender_phone,
        error: String(error?.message || error),
      },
      '🚨 ALERTA CRÍTICA: Evento inbound terminó en FAILED tras agotar reintentos o fallo permanente'
    );

    if (!event.lock_token) return;

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // 1. FENCE ATÓMICO: Marcar FAILED exigiendo lock_token exacto
      const failed = await inboundRepository.terminalFailed(
        event.id,
        event.lock_token,
        String(error?.message || error),
        client
      );

      // 2. Si el fence se mantuvo y tenemos datos de sesión, encolar fallback en la MISMA transacción
      if (failed && conversation?.id && event.sender_phone) {
        await outboxRepository.enqueueMessage(
          {
            conversationId: conversation.id,
            phoneNumberId: event.phone_number_id,
            recipientPhone: event.sender_phone,
            messageType: 'text',
            content:
              'Disculpa, en este momento experimentamos dificultades técnicas temporales. Hemos notificado a nuestro equipo y un asesor te atenderá a la brevedad.',
          },
          client
        );
      }

      await client.query('COMMIT');
      logger.info(
        { eventId: event.id, recipient: event.sender_phone },
        '✅ Fallo terminal y mensaje de fallback comprometidos atómicamente con fence'
      );
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ txErr, eventId: event.id }, 'Error en transacción atómica de fallo terminal');
    } finally {
      client.release();
    }
  }
}

export const inboundDispatcher = new InboundDispatcher();
```

---

### 2.2. `src/providers/llm/geminiClient.ts`
*(SDK AbortSignal + httpOptions.timeout nativos y clasificación de errores)*

```typescript
import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import {
  GeminiCompletionResult,
  GeminiContentMessage,
  ToolDefinition,
} from './geminiTypes.js';

export const OFFICIAL_TOOLS_DECLARATIONS: ToolDefinition[] = [
  {
    functionDeclarations: [
      {
        name: 'searchProductCatalog',
        description:
          'Consulta el catálogo maestro oficial de productos y servicios con precios reales garantizados y disponibilidad.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'Término de búsqueda del producto, plan o servicio',
            },
            category: {
              type: 'STRING',
              description: 'Categoría opcional (planes, servicios)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'createQualifiedLead',
        description:
          'Registra formalmente un lead comercial en la base de datos cuando el cliente manifiesta intención de compra o contratación.',
        parameters: {
          type: 'OBJECT',
          properties: {
            productInterest: {
              type: 'STRING',
              description: 'Nombre del producto o plan en el que el cliente mostró interés',
            },
            customerEmail: {
              type: 'STRING',
              description: 'Correo electrónico de contacto proporcionado por el cliente',
            },
            customerCity: {
              type: 'STRING',
              description: 'Ciudad de residencia o ubicación del negocio del cliente',
            },
            estimatedBudget: {
              type: 'NUMBER',
              description: 'Presupuesto estimado en USD si fue mencionado',
            },
            notes: {
              type: 'STRING',
              description: 'Detalles adicionales o requerimientos clave expresados por el prospecto',
            },
          },
          required: ['productInterest'],
        },
      },
      {
        name: 'requestHumanHandoff',
        description:
          'Transfiere de inmediato la conversación a un asesor humano cuando el cliente lo pide expresamente o presenta un caso fuera de alcance.',
        parameters: {
          type: 'OBJECT',
          properties: {
            reason: {
              type: 'STRING',
              enum: ['USER_REQUEST', 'FRUSTRATION', 'TOOL_FAILURE', 'OUT_OF_SCOPE'],
              description: 'Causa que detona el escalamiento humano',
            },
            briefing: {
              type: 'STRING',
              description: 'Resumen ejecutivo de lo conversado para que el asesor humano tome el control sin fricción',
            },
          },
          required: ['briefing'],
        },
      },
    ],
  },
];

export type LlmErrorType =
  | 'TRANSIENT_RATE_LIMIT'    // 429 por minuto (reintento con backoff corto)
  | 'DAILY_QUOTA_EXHAUSTED'   // Cuota diaria agotada (pausa larga de 10m y alerta crítica)
  | 'AUTH_OR_CONFIG_ERROR'    // 401, 403, modelo inexistente (pausar worker, no quemar a FAILED)
  | 'FATAL_PAYLOAD_ERROR'     // 400 Bad request, prompt inválido (fallo terminal)
  | 'NETWORK_OR_TIMEOUT';     // Timeout, AbortError, 5xx, ECONNRESET (reintento transitorio)

export function classifyLlmError(error: any): LlmErrorType {
  if (!error) return 'FATAL_PAYLOAD_ERROR';
  const name = error.name || '';
  const message = String(error.message || '').toLowerCase();
  const status = error.status || error.statusCode || error.code;

  // Credenciales o modelo incorrecto (401, 403, 404 de modelo)
  if (
    status === 401 ||
    status === 403 ||
    (status === 404 && (message.includes('model') || message.includes('not found'))) ||
    message.includes('api_key') ||
    message.includes('unauthenticated') ||
    message.includes('permission_denied')
  ) {
    return 'AUTH_OR_CONFIG_ERROR';
  }

  // Cuota diaria / agotamiento total vs 429 por minuto
  if (
    message.includes('quota exceeded') ||
    message.includes('daily limit') ||
    message.includes('per-day') ||
    (message.includes('resource_exhausted') && message.includes('quota'))
  ) {
    return 'DAILY_QUOTA_EXHAUSTED';
  }

  // 429 por minuto (Rate limit estándar)
  if (status === 429 || message.includes('rate limit') || message.includes('resource_exhausted')) {
    return 'TRANSIENT_RATE_LIMIT';
  }

  // Fallos de red y timeouts
  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('network') ||
    message.includes('fetch failed') ||
    (typeof status === 'number' && status >= 500 && status < 600) ||
    status === 'UNAVAILABLE' ||
    status === 'DEADLINE_EXCEEDED'
  ) {
    return 'NETWORK_OR_TIMEOUT';
  }

  return 'FATAL_PAYLOAD_ERROR';
}

export function isTransientLlmError(error: any): boolean {
  const type = classifyLlmError(error);
  return type === 'TRANSIENT_RATE_LIMIT' || type === 'NETWORK_OR_TIMEOUT';
}

export class GeminiClient {
  private ai: GoogleGenAI;
  public readonly modelName = 'gemini-2.5-flash';
  public readonly defaultTimeoutMs = 20000; // 20s timeout (claramente menor al lease de 30s del inbound)

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }

  /**
   * Ejecuta una llamada de inferencia a Gemini 2.5 Flash aplicando F3-C6 (maxOutputTokens: 180, temperature: 0.2)
   * cancelando la petición HTTP a nivel de socket mediante AbortSignal y httpOptions.timeout.
   */
  public async generateTurn(
    systemInstruction: string,
    contents: GeminiContentMessage[],
    timeoutMs: number = this.defaultTimeoutMs,
    parentSignal?: AbortSignal
  ): Promise<GeminiCompletionResult> {
    const startTime = Date.now();
    const abortController = new AbortController();

    if (parentSignal) {
      if (parentSignal.aborted) {
        const err = new Error('Gemini API Turn Deadline Exceeded before call');
        err.name = 'AbortError';
        throw err;
      }
      parentSignal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const timer = setTimeout(() => {
      const timeoutErr = new Error(`Gemini API Request Timeout (${timeoutMs}ms abort)`);
      timeoutErr.name = 'TimeoutError';
      abortController.abort(timeoutErr);
    }, timeoutMs);
    timer.unref?.();

    try {
      // Configuración estricta según TDD v2.1 y F3-C6 pasando abortSignal y httpOptions
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: contents as any,
        config: {
          systemInstruction,
          temperature: 0.2, // Grounding estricto
          maxOutputTokens: 180, // F3-C6: Fuerza micro-mensajes concisos
          tools: OFFICIAL_TOOLS_DECLARATIONS as any,
          abortSignal: abortController.signal,
          httpOptions: { timeout: timeoutMs },
        },
      });

      const latencyMs = Date.now() - startTime;
      const text = response.text || '';

      // Extracción de llamadas a funciones si el modelo decidió invocar herramientas
      const functionCalls = response.functionCalls
        ?.filter((fc): fc is typeof fc & { name: string } => typeof fc.name === 'string' && fc.name.length > 0)
        .map((fc) => ({
          name: fc.name,
          args: (fc.args as Record<string, unknown>) || {},
        }));

      const usage = response.usageMetadata;
      const promptTokens = usage?.promptTokenCount || 0;
      const completionTokens = usage?.candidatesTokenCount || 0;

      logger.info(
        {
          model: this.modelName,
          latencyMs,
          promptTokens,
          completionTokens,
          hasFunctionCalls: Boolean(functionCalls && functionCalls.length > 0),
        },
        '🤖 Inferencia Gemini 2.5 Flash completada'
      );

      return {
        text,
        functionCalls,
        promptTokens,
        completionTokens,
        latencyMs,
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      if (abortController.signal.aborted) {
        const timeoutErr = new Error(`Gemini API Request Timeout / Aborted (${timeoutMs}ms)`);
        timeoutErr.name = 'TimeoutError';
        logger.error({ error: timeoutErr, latencyMs }, '❌ Timeout / Abort durante la llamada a Gemini API');
        throw timeoutErr;
      }
      logger.error({ error, latencyMs }, '❌ Error durante la llamada a Gemini API');
      throw error;
    } finally {
      clearTimeout(timer!);
    }
  }
}

export const geminiClient = new GeminiClient();
```

---

### 2.3. `src/utils/circuitBreaker.ts`
*(Circuit Breaker con método `trip()` para cuota diaria agotada)*

```typescript
import { CONSTANTS } from '../config/constants.js';
import { logger } from './logger.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenSuccesses?: number;
}

export class CircuitOpenError extends Error {
  constructor(message: string = 'CIRCUIT_BREAKER_OPEN: Circuit is OPEN, requests rejected') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount: number = 0;
  private consecutiveSuccesses: number = 0;
  private lastFailureTime: number = 0;
  private halfOpenProbeInProgress: boolean = false;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenSuccesses: number;

  constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? CONSTANTS.CIRCUIT_BREAKER.FAILURE_THRESHOLD;
    this.resetTimeoutMs = options?.resetTimeoutMs ?? CONSTANTS.CIRCUIT_BREAKER.RESET_TIMEOUT_MS;
    this.halfOpenSuccesses = options?.halfOpenSuccesses ?? CONSTANTS.CIRCUIT_BREAKER.HALF_OPEN_SUCCESSES;
  }

  public getState(): CircuitState {
    this.checkStateTransition();
    return this.state;
  }

  public getFailureCount(): number {
    return this.failureCount;
  }

  public async execute<T>(
    action: () => Promise<T>,
    shouldTrip?: (error: unknown) => boolean
  ): Promise<T> {
    this.checkStateTransition();

    if (this.state === 'OPEN') {
      logger.warn(
        { state: this.state, lastFailureTime: this.lastFailureTime },
        '🛑 Circuit Breaker en estado OPEN: Solicitud rechazada sin llamada de red'
      );
      throw new CircuitOpenError();
    }

    let isCanaryProbe = false;
    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenProbeInProgress) {
        logger.debug('Sonda canary ya en vuelo en HALF_OPEN: Solicitud concurrente diferida con CircuitOpenError');
        throw new CircuitOpenError('CIRCUIT_BREAKER_HALF_OPEN_BUSY: Canary probe already in flight');
      }
      this.halfOpenProbeInProgress = true;
      isCanaryProbe = true;
    }

    try {
      const result = await action();
      this.onSuccess();
      return result;
    } catch (error) {
      const countsAsFailure = shouldTrip ? shouldTrip(error) : true;
      if (countsAsFailure) {
        this.onFailure(error);
      } else {
        logger.debug({ error }, 'Aviso: Error no transitorio recibido (servicio vivo), registrando éxito en Circuit Breaker');
        this.onSuccess();
      }
      throw error;
    } finally {
      if (isCanaryProbe) {
        this.halfOpenProbeInProgress = false;
      }
    }
  }

  private checkStateTransition(): void {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.consecutiveSuccesses = 0;
        this.halfOpenProbeInProgress = false;
        logger.info(
          { resetTimeoutMs: this.resetTimeoutMs },
          '🟡 Circuit Breaker pasó de OPEN a HALF_OPEN para verificar recuperación del servicio'
        );
      }
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.halfOpenSuccesses) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.consecutiveSuccesses = 0;
        this.halfOpenProbeInProgress = false;
        logger.info('🟢 Circuit Breaker completamente recuperado: Estado pasa a CLOSED');
      }
    } else if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  private onFailure(error: unknown): void {
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.consecutiveSuccesses = 0;
      this.halfOpenProbeInProgress = false;
      logger.warn(
        { error },
        '🚨 Fallo durante estado HALF_OPEN: Circuit Breaker reabierto a OPEN'
      );
    } else if (this.state === 'CLOSED') {
      this.failureCount += 1;
      if (this.failureCount >= this.failureThreshold) {
        this.state = 'OPEN';
        logger.error(
          { failureCount: this.failureCount, threshold: this.failureThreshold, error },
          '🚨 Umbral de fallos superado: Circuit Breaker pasa a OPEN (aislando llamadas de red)'
        );
      }
    }
  }

  /**
   * Dispara inmediatamente el Circuit Breaker a estado OPEN con ventana personalizada.
   * Usado para agotar cuota diaria (10 min de pausa forzada) sin esperar umbrales.
   */
  public trip(customResetTimeoutMs?: number): void {
    this.state = 'OPEN';
    this.lastFailureTime = customResetTimeoutMs
      ? Date.now() + (customResetTimeoutMs - this.resetTimeoutMs)
      : Date.now();
    this.consecutiveSuccesses = 0;
    this.halfOpenProbeInProgress = false;
    logger.error({ customResetTimeoutMs }, '🚨 Circuit Breaker forzado inmediatamente a estado OPEN');
  }

  public recordFailure(error?: unknown): void {
    this.onFailure(error);
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.consecutiveSuccesses = 0;
    this.lastFailureTime = 0;
    this.halfOpenProbeInProgress = false;
    logger.debug('Circuit Breaker reiniciado manualmente a CLOSED');
  }
}

export const metaCircuitBreaker = new CircuitBreaker();
```

---

### 2.4. `src/harness/agentEngine.ts` *(Firma y Tramo ReAct con Presupuesto de Turno)*

```typescript
export interface AgentProcessOptions {
  deferSideEffects?: boolean;
  deadlineMs?: number; // Presupuesto de turno global para acotar ReAct al lease
  abortSignal?: AbortSignal;
}

export interface AgentProcessResult {
  replyText: string;
  catalogToolExecuted: boolean;
  leadToolExecuted: boolean;
  handoffToolExecuted: boolean;
  pendingLead?: CreateQualifiedLeadArgs;
  pendingHandoff?: RequestHumanHandoffArgs;
  promptTokens: number;
  completionTokens: number;
  totalLatencyMs: number;
}

export class AgentEngine {
  private readonly maxToolIterations = 3;

  public async processMessage(
    contact: ContactRecord,
    conversation: ConversationRecord,
    incomingText: string,
    options?: AgentProcessOptions
  ): Promise<AgentProcessResult> {
    const startEngineTime = Date.now();

    // 1. Guardrail Nivel 1: Filtro Pre-Inferencia Anti-Jailbreak (< 1ms)
    // 2. Obtención de historial reciente (I11: ventana deslizante óptima de 6 mensajes) y ensamblaje de contexto
    // ...

    // 3. ReAct Loop Acotado (Techo determinista: máximo 3 iteraciones de herramientas)
    for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
      let turnTimeout = 20000;
      if (options?.deadlineMs) {
        const remainingBudget = options.deadlineMs - Date.now();
        if (remainingBudget <= 1500) {
          logger.warn(
            { iteration, remainingBudget },
            '⏱️ Presupuesto de turno ReAct agotado: cortando iteraciones para proteger lease'
          );
          break;
        }
        turnTimeout = Math.min(20000, remainingBudget);
      }

      const turnResult = await geminiClient.generateTurn(
        preparedContext.systemInstruction,
        activeMessages,
        turnTimeout,
        options?.abortSignal
      );

      totalPromptTokens += turnResult.promptTokens;
      totalCompletionTokens += turnResult.completionTokens;

      // Despacho de function calls (searchProductCatalog, createQualifiedLead, requestHumanHandoff)
      // Si options.deferSideEffects es true, se difiere la persistencia para la transacción atómica final
      // ...
    }

    return {
      replyText: finalBotText,
      catalogToolExecuted,
      leadToolExecuted,
      handoffToolExecuted,
      pendingLead,
      pendingHandoff,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalLatencyMs: Date.now() - startEngineTime,
    };
  }
}
```

---

### 2.5. `src/repositories/inboundRepository.ts`
*(Head-of-Line, markDone con fencing token, extendLease, Poison Pill reaper y purga LGPD unificada)*

```typescript
import pg from 'pg';
import { db } from '../providers/database/dbClient.js';
import { CONSTANTS } from '../config/constants.js';
import { logger } from '../utils/logger.js';

export interface InboundEventRecord {
  id: string;
  wamid: string;
  phone_number_id: string;
  sender_phone: string;
  payload: any;
  status: 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';
  locked_at: Date | null;
  lock_token: string | null;
  retry_count: number;
  next_retry_at: Date;
  last_error: string | null;
  created_at: Date;
  processed_at: Date | null;
}

export class InboundRepository {
  public async persistInboundEvent(
    params: {
      wamid: string;
      phoneNumberId: string;
      senderPhone: string;
      payload: unknown;
    },
    client?: pg.PoolClient
  ): Promise<InboundEventRecord | null> {
    const query = `
      INSERT INTO public.inbound_events (
        wamid, phone_number_id, sender_phone, payload
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (wamid) DO NOTHING
      RETURNING *;
    `;

    const executor = client || db;
    const result = await executor.query(query, [
      params.wamid,
      params.phoneNumberId,
      params.senderPhone,
      JSON.stringify(params.payload),
    ]);

    return (result.rows[0] as InboundEventRecord) || null;
  }

  public async claimPendingBatch(
    limit: number = 10,
    client?: pg.PoolClient
  ): Promise<InboundEventRecord[]> {
    const query = `
      WITH picked AS (
        SELECT i.id
        FROM public.inbound_events i
        WHERE i.status = 'PENDING'
          AND i.next_retry_at <= NOW()
          AND NOT EXISTS (
            SELECT 1 FROM public.inbound_events older
            WHERE older.phone_number_id = i.phone_number_id
              AND older.sender_phone = i.sender_phone
              AND older.id <> i.id
              AND (
                older.status = 'PROCESSING'
                OR (older.status = 'PENDING' AND (
                  older.created_at < i.created_at
                  OR (older.created_at = i.created_at AND older.id < i.id)
                ))
              )
          )
        ORDER BY i.created_at ASC
        LIMIT $1
        FOR UPDATE OF i SKIP LOCKED
      )
      UPDATE public.inbound_events i
      SET status = 'PROCESSING',
          locked_at = NOW(),
          lock_token = gen_random_uuid()
      FROM picked
      WHERE i.id = picked.id
        AND i.status = 'PENDING'
      RETURNING i.*;
    `;

    const executor = client || db;
    const result = await executor.query(query, [limit]);
    return result.rows as InboundEventRecord[];
  }

  public async isLeaseValid(
    id: string,
    lockToken: string,
    client?: pg.PoolClient
  ): Promise<boolean> {
    const query = `
      SELECT 1 FROM public.inbound_events
      WHERE id = $1 AND status = 'PROCESSING' AND lock_token = $2;
    `;
    const executor = client || db;
    const result = await executor.query(query, [id, lockToken]);
    return result.rows.length > 0;
  }

  public async markDone(
    id: string,
    lockToken: string,
    client?: pg.PoolClient
  ): Promise<boolean> {
    const query = `
      UPDATE public.inbound_events
      SET status = 'DONE',
          processed_at = NOW(),
          locked_at = NULL,
          lock_token = NULL
      WHERE id = $1 AND status = 'PROCESSING' AND lock_token = $2
      RETURNING id;
    `;
    const executor = client || db;
    const result = await executor.query(query, [id, lockToken]);
    return (result.rowCount ?? result.rows.length) > 0;
  }

  public async release(
    id: string,
    lockToken: string,
    delaySeconds: number,
    client?: pg.PoolClient
  ): Promise<boolean> {
    const query = `
      UPDATE public.inbound_events
      SET status = 'PENDING',
          locked_at = NULL,
          lock_token = NULL,
          next_retry_at = NOW() + ($3 || ' seconds')::INTERVAL
      WHERE id = $1 AND status = 'PROCESSING' AND lock_token = $2
      RETURNING id;
    `;
    const executor = client || db;
    const result = await executor.query(query, [id, lockToken, delaySeconds]);
    return (result.rowCount ?? result.rows.length) > 0;
  }

  public async terminalFailed(
    id: string,
    lockToken: string,
    error: string,
    client?: pg.PoolClient
  ): Promise<InboundEventRecord | null> {
    const query = `
      UPDATE public.inbound_events
      SET status = 'FAILED',
          last_error = $3,
          locked_at = NULL,
          lock_token = NULL
      WHERE id = $1 AND status = 'PROCESSING' AND lock_token = $2
      RETURNING *;
    `;
    const executor = client || db;
    const result = await executor.query(query, [id, lockToken, error]);
    return (result.rows[0] as InboundEventRecord) || null;
  }

  public async extendLease(
    id: string,
    lockToken: string,
    extendSeconds: number = 30,
    client?: pg.PoolClient
  ): Promise<boolean> {
    const query = `
      UPDATE public.inbound_events
      SET locked_at = NOW()
      WHERE id = $1 AND status = 'PROCESSING' AND lock_token = $2
      RETURNING id;
    `;
    const executor = client || db;
    const result = await executor.query(query, [id, lockToken]);
    return (result.rowCount ?? result.rows.length) > 0;
  }

  public async reapOrphaned(leaseTimeoutSeconds: number = 30): Promise<number> {
    const query = `
      UPDATE public.inbound_events
      SET status = CASE
            WHEN retry_count + 1 >= ${CONSTANTS.INBOUND.MAX_RETRIES} THEN 'FAILED'
            ELSE 'PENDING'
          END,
          last_error = CASE
            WHEN retry_count + 1 >= ${CONSTANTS.INBOUND.MAX_RETRIES} THEN 'Poison pill: lease expired MAX_RETRIES times'
            ELSE last_error
          END,
          locked_at = NULL,
          lock_token = NULL,
          retry_count = retry_count + 1,
          next_retry_at = NOW()
      WHERE status = 'PROCESSING'
        AND locked_at < NOW() - ($1 || ' seconds')::INTERVAL
      RETURNING id, status;
    `;
    const result = await db.query(query, [leaseTimeoutSeconds]);
    const count = result.rowCount ?? result.rows.length;
    if (count > 0) {
      const failedCount = result.rows.filter((r: any) => r.status === 'FAILED').length;
      logger.warn(
        { count, poisonPillsFailed: failedCount },
        '🚨 Reaper de Inbound: Rescatados eventos huérfanos con protección poison pill'
      );
    }
    return count;
  }

  public async purgeProcessedEvents(
    retentionDays: number = CONSTANTS.INBOUND.RETENTION_DAYS,
    batchLimit: number = 500
  ): Promise<{ inbound: number; outbox: number; messages: number; statusEvents: number }> {
    const inboundRes = await db.query(
      `
      WITH targets AS (
        SELECT id FROM public.inbound_events
        WHERE status = 'DONE'
          AND COALESCE(processed_at, created_at) < NOW() - ($1 || ' days')::INTERVAL
        LIMIT $2
      )
      DELETE FROM public.inbound_events WHERE id IN (SELECT id FROM targets) RETURNING id;
      `,
      [retentionDays, batchLimit]
    );

    const outboxRes = await db.query(
      `
      WITH targets AS (
        SELECT id FROM public.outbox_messages
        WHERE status = 'SENT'
          AND created_at < NOW() - ($1 || ' days')::INTERVAL
        LIMIT $2
      )
      DELETE FROM public.outbox_messages WHERE id IN (SELECT id FROM targets) RETURNING id;
      `,
      [retentionDays, batchLimit]
    );

    const statusRes = await db.query(
      `
      WITH targets AS (
        SELECT id FROM public.message_status_events
        WHERE created_at < NOW() - ($1 || ' days')::INTERVAL
        LIMIT $2
      )
      DELETE FROM public.message_status_events WHERE id IN (SELECT id FROM targets) RETURNING id;
      `,
      [retentionDays, batchLimit]
    );

    const msgRes = await db.query(
      `
      WITH targets AS (
        SELECT id FROM public.messages
        WHERE created_at < NOW() - ($1 || ' days')::INTERVAL
        LIMIT $2
      )
      DELETE FROM public.messages WHERE id IN (SELECT id FROM targets) RETURNING id;
      `,
      [retentionDays, batchLimit]
    );

    const totals = {
      inbound: inboundRes.rowCount ?? inboundRes.rows.length,
      outbox: outboxRes.rowCount ?? outboxRes.rows.length,
      messages: msgRes.rowCount ?? msgRes.rows.length,
      statusEvents: statusRes.rowCount ?? statusRes.rows.length,
    };

    if (totals.inbound + totals.outbox + totals.messages + totals.statusEvents > 0) {
      logger.info(totals, '🧹 Purga LGPD unificada completada en lotes LIMIT');
    }
    return totals;
  }
}

export const inboundRepository = new InboundRepository();
```

---

### 2.6. `src/controllers/webhookController.ts`
*(Ingesta de eventos, persistencia síncrona antes del ACK 200 y cero IA en ruta crítica)*

```typescript
import { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { validateMetaSignature } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { phoneRateLimiter } from '../middleware/rateLimiter.js';
import { MetaWebhookPayload } from '../types/meta.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { inboundRepository } from '../repositories/inboundRepository.js';

export async function handleVerifyWebhook(
  request: FastifyRequest<{
    Querystring: {
      'hub.mode'?: string;
      'hub.verify_token'?: string;
      'hub.challenge'?: string;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const mode = request.query['hub.mode'];
  const token = request.query['hub.verify_token'];
  const challenge = request.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.WEBHOOK_VERIFY_TOKEN) {
    logger.info('✅ Webhook verificado exitosamente por Meta');
    reply.status(200).send(challenge);
    return;
  }

  logger.warn({ mode, tokenReceived: token ? '***' : 'missing' }, '❌ Intento de verificación de webhook no autorizado');
  reply.status(403).send({ error: 'Forbidden. Invalid verification token.' });
}

export async function handleIncomingWebhook(
  request: FastifyRequest<{
    Body: MetaWebhookPayload;
  }>,
  reply: FastifyReply
): Promise<void> {
  const signature = request.headers['x-hub-signature-256'] as string | undefined;
  const rawBody = (request as unknown as { rawBody?: string | Buffer }).rawBody;

  const isValidSignature = validateMetaSignature(rawBody, signature);
  if (!isValidSignature) {
    logger.warn({ ip: request.ip }, '🚨 Petición de webhook rechazada: Firma HMAC SHA-256 inválida o ausente');
    reply.status(401).send({ error: 'Unauthorized. Invalid HMAC signature.' });
    return;
  }

  const payload = request.body;
  if (payload?.object !== 'whatsapp_business_account' || !payload.entry) {
    reply.status(200).send({ status: 'ok' });
    return;
  }

  try {
    for (const entry of payload.entry) {
      if (!entry.changes) continue;
      for (const change of entry.changes) {
        const value = change.value;
        if (!value || value.messaging_product !== 'whatsapp') continue;

        if (value.statuses && Array.isArray(value.statuses)) {
          for (const statusObj of value.statuses) {
            const wamid = statusObj.id;
            const status = statusObj.status;
            const timestamp = statusObj.timestamp
              ? new Date(parseInt(statusObj.timestamp, 10) * 1000)
              : new Date();
            const errorObj =
              statusObj.errors && Array.isArray(statusObj.errors) && statusObj.errors.length > 0
                ? statusObj.errors[0]
                : undefined;
            const errorDetails = errorObj
              ? { code: errorObj.code, message: errorObj.title || (errorObj as { message?: string }).message }
              : undefined;

            await messageRepository.updateDeliveryStatus(wamid, status, timestamp, errorDetails);
          }
        }

        if (value.messages && Array.isArray(value.messages)) {
          const phoneNumberId = value.metadata?.phone_number_id || 'UNKNOWN';
          for (const msg of value.messages) {
            const from = msg.from;
            const wamid = msg.id;

            if (phoneRateLimiter.isRateLimited(from)) {
              logger.warn({ phoneNumber: from, wamid }, 'Usuario superó el límite de tasa (Rate Limited)');
              continue;
            }

            const persisted = await inboundRepository.persistInboundEvent({
              wamid,
              phoneNumberId,
              senderPhone: from,
              payload: {
                message: msg,
                contact: value.contacts?.[0],
                metadata: value.metadata,
              },
            });

            if (persisted) {
              logger.info({ wamid, senderPhone: from }, '📥 Evento inbound persistido duraderamente en PostgreSQL');
            } else {
              logger.info({ wamid, senderPhone: from }, 'Evento inbound duplicado interceptado (ON CONFLICT DO NOTHING)');
            }
          }
        }
      }
    }

    reply.status(200).send({ status: 'ok' });
  } catch (error) {
    logger.error({ error }, '🚨 Error al persistir evento inbound en base de datos. Respondiendo 500 para reintento de Meta');
    reply.status(500).send({ error: 'Database persistence error' });
  }
}
```

---

### 2.7. `src/server.ts` y Ruta `/ready`
*(Graceful Shutdown y Readiness Probe que pasa a 503 inmediatamente)*

```typescript
// === src/server.ts ===
import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { db } from './providers/database/dbClient.js';
import { outboxDispatcher } from './services/outboxDispatcher.js';
import { inboundDispatcher } from './services/inboundDispatcher.js';
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

    inboundDispatcher.start();
    outboxDispatcher.start();

    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) {
      process.on(signal, async () => {
        logger.info(`Señal ${signal} recibida. Cerrando servidor de forma elegante...`);
        setShuttingDown(true);
        await inboundDispatcher.stop(15000);
        await outboxDispatcher.stop(15000);
        await app.close();
        await db.close();
        logger.info('Servidor y conexiones cerradas correctamente.');
        process.exit(0);
      });
    }
  } catch (error) {
    logger.error({ error }, 'Error fatal durante el arranque del servidor');
    process.exit(1);
  }
}

start();

// === Endpoint /ready en src/app.ts ===
app.get('/ready', async (_request, reply) => {
  if (isShuttingDown) {
    reply.status(503).send({ status: 'shutting_down' });
    return;
  }
  const isDbHealthy = await db.isHealthy();
  if (!isDbHealthy) {
    reply.status(503).send({ status: 'unready', database: 'disconnected' });
    return;
  }
  reply.status(200).send({ status: 'ready', database: 'connected' });
});
```

---

### 2.8. `src/utils/logger.ts` *(Sanitizador de PII y Secretos)*

```typescript
import pino from 'pino';
import { env } from '../config/env.js';

export function maskPhoneNumber(phone: string): string {
  if (!phone || phone.length < 8) return '****';
  const prefix = phone.slice(0, 5);
  const suffix = phone.slice(-4);
  return `${prefix}****${suffix}`;
}

const PHONE_KEYS = new Set([
  'phonenumber', 'phone', 'recipientphone', 'recipient',
  'senderphone', 'from', 'to', 'sender_phone', 'recipient_phone',
]);

const TOKEN_KEYS = new Set([
  'token', 'tokenreceived', 'locktoken', 'lock_token', 'apikey',
  'secret', 'appsecret', 'password', 'authorization', 'accesstoken', 'bearer',
]);

const CONTENT_KEYS = new Set([
  'content', 'text', 'preview', 'usermessagepreview',
  'botresponsepreview', 'rawbody', 'raw_payload', 'body',
]);

const PG_SENSITIVE_KEYS = new Set([
  'query', 'parameters', 'detail', 'connectionstring',
]);

export function sanitizeLogValue(key: string, value: unknown, depth: number = 0): unknown {
  if (depth > 6) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value;

  const lowerKey = key.toLowerCase();

  if (TOKEN_KEYS.has(lowerKey)) return '[REDACTED]';
  if (CONTENT_KEYS.has(lowerKey)) return '[REDACTED]';
  if (PG_SENSITIVE_KEYS.has(lowerKey)) return '[REDACTED]';

  if (PHONE_KEYS.has(lowerKey) && typeof value === 'string') {
    return maskPhoneNumber(value);
  }

  if (typeof value === 'string') {
    let sanitized = value.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]');
    sanitized = sanitized.replace(/(?:\+?\d{1,3})?(\d{2,4})\d{4,6}(\d{3,4})\b/g, (match, p1, p2) => {
      if (match.length >= 10 && match.length <= 15) return `${p1}****${p2}`;
      return match;
    });
    return sanitized;
  }

  if (value instanceof Error) {
    const errObj: Record<string, unknown> = {
      name: value.name,
      message: sanitizeLogValue('message', value.message, depth + 1),
      stack: value.stack,
    };
    for (const [k, v] of Object.entries(value)) {
      if (k === 'config' && typeof v === 'object' && v !== null) {
        errObj.config = { ...v, headers: '[REDACTED]' };
      } else if (k === 'response' && typeof v === 'object' && v !== null) {
        errObj.response = { status: (v as any).status, statusText: (v as any).statusText, data: '[REDACTED]' };
      } else {
        errObj[k] = sanitizeLogValue(k, v, depth + 1);
      }
    }
    return errObj;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(key, item, depth + 1));
  }

  if (typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.toLowerCase() === 'headers' && typeof v === 'object' && v !== null) {
        copy[k] = '[REDACTED]';
      } else {
        copy[k] = sanitizeLogValue(k, v, depth + 1);
      }
    }
    return copy;
  }

  return value;
}

export function getLoggerOptions(): pino.LoggerOptions {
  return {
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: {
      paths: [
        '*.token', '*.tokenReceived', '*.lockToken', '*.lock_token',
        '*.apiKey', '*.password', '*.content', '*.text', '*.preview',
        '*.userMessagePreview', '*.botResponsePreview', '*.rawBody',
        '*.query', '*.parameters', '*.detail', 'headers.authorization',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      log(object) {
        if (object && typeof object === 'object') {
          return sanitizeLogValue('root', object) as Record<string, unknown>;
        }
        return object;
      },
    },
    serializers: {
      err: (err) => sanitizeLogValue('err', err),
      error: (err) => sanitizeLogValue('error', err),
    },
  };
}

export const logger = pino(
  getLoggerOptions(),
  env.NODE_ENV !== 'production' && env.NODE_ENV !== 'test'
    ? pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      })
    : undefined
);
```

---

### 2.9. MIGRACIONES SQL (007 a 010)

#### `src/database/migrations/007_status_events_dedup_and_unique.sql`
```sql
DELETE FROM public.message_status_events a
USING public.message_status_events b
WHERE a.id > b.id
  AND a.wamid = b.wamid
  AND a.status = b.status
  AND a.event_timestamp = b.event_timestamp;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_status_events_wamid_status_ts'
  ) THEN
    ALTER TABLE public.message_status_events
    ADD CONSTRAINT uq_status_events_wamid_status_ts UNIQUE (wamid, status, event_timestamp);
  END IF;
END $$;
```

#### `src/database/migrations/008_inbound_events_table.sql`
```sql
CREATE TABLE IF NOT EXISTS public.inbound_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wamid TEXT UNIQUE NOT NULL,
    phone_number_id TEXT NOT NULL,
    sender_phone TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED')),
    locked_at TIMESTAMPTZ NULL,
    lock_token UUID NULL,
    retry_count INT NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_inbound_events_head
ON public.inbound_events (phone_number_id, sender_phone, created_at)
WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_inbound_events_status
ON public.inbound_events (status, next_retry_at)
WHERE status = 'PENDING';
```

#### `src/database/migrations/009_enable_rls_backend_tables.sql`
```sql
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
```

#### `src/database/migrations/010_revoke_anon_authenticated_permissions.sql`
```sql
ALTER TABLE IF EXISTS public.migrations_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.contacts FROM anon, authenticated;
REVOKE ALL ON TABLE public.conversations FROM anon, authenticated;
REVOKE ALL ON TABLE public.messages FROM anon, authenticated;
REVOKE ALL ON TABLE public.message_status_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.outbox_messages FROM anon, authenticated;
REVOKE ALL ON TABLE public.inbound_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.leads FROM anon, authenticated;
REVOKE ALL ON TABLE public.handoff_sessions FROM anon, authenticated;
REVOKE ALL ON TABLE public.audit_log FROM anon, authenticated;
REVOKE ALL ON TABLE public.migrations_history FROM anon, authenticated;

-- Revocar secuencias y rutinas existentes en public
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon, authenticated;

-- Privilegios por defecto en public (rol actual y rol postgres de Supabase)
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    BEGIN
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON ROUTINES FROM anon, authenticated';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END IF;
END $$;
```

---

### 2.10. SUITES DE TESTS (RLS, Rollback y Mutación)

#### `tests/rlsAndLogger.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { db } from '../src/providers/database/dbClient.js';
import pino from 'pino';
import { getLoggerOptions } from '../src/utils/logger.js';
import { Writable } from 'node:stream';

describe('Fase 5B: Seguridad RLS (I20) y Sanitización de PII en Logs (I20)', () => {
  describe('Criterio 5 (I20): Row Level Security en Tablas de Backend', () => {
    it('debe tener Row Level Security (RLS) habilitado en todas las tablas sensibles de public', async () => {
      const res = await db.query(`
        SELECT tablename, rowsecurity
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN (
            'contacts', 'conversations', 'messages', 'message_status_events',
            'outbox_messages', 'inbound_events', 'leads', 'handoff_sessions', 'audit_log'
          );
      `);

      expect(res.rows.length).toBe(9);
      for (const row of res.rows) {
        expect(row.rowsecurity).toBe(true);
      }
    });

    it('Auditor 5B (Control Duradero): no debe existir ninguna tabla en schema public con rowsecurity = false', async () => {
      const res = await db.query(`
        SELECT tablename, rowsecurity
        FROM pg_tables
        WHERE schemaname = 'public'
          AND rowsecurity = false;
      `);
      expect(res.rows).toEqual([]);
    });

    it('las consultas ejecutadas bajo el rol anon deben ser bloqueadas por RLS y revocación', async () => {
      await db.query(`
        INSERT INTO public.messages (wamid, direction, message_type, content)
        VALUES ('wamid.RLS_TEST_ANON', 'INBOUND', 'text', 'Mensaje confidencial anon')
        ON CONFLICT (wamid) DO NOTHING;
      `);

      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE anon;');

        try {
          const res = await client.query('SELECT * FROM public.messages WHERE wamid = $1;', ['wamid.RLS_TEST_ANON']);
          expect(res.rows).toEqual([]);
        } catch (err: any) {
          expect(err.message).toMatch(/permission denied|does not exist/);
        }

        await client.query('ROLLBACK');
      } finally {
        client.release();
        await db.query(`DELETE FROM public.messages WHERE wamid = $1;`, ['wamid.RLS_TEST_ANON']);
      }
    });

    it('Auditor 5B (Segunda Capa): las consultas ejecutadas bajo el rol authenticated deben ser bloqueadas por revocación explícita', async () => {
      await db.query(`
        INSERT INTO public.messages (wamid, direction, message_type, content)
        VALUES ('wamid.RLS_TEST_AUTH', 'INBOUND', 'text', 'Mensaje confidencial auth')
        ON CONFLICT (wamid) DO NOTHING;
      `);

      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE authenticated;');

        try {
          const res = await client.query('SELECT * FROM public.messages WHERE wamid = $1;', ['wamid.RLS_TEST_AUTH']);
          expect(res.rows).toEqual([]);
        } catch (err: any) {
          expect(err.message).toMatch(/permission denied|does not exist/);
        }

        await client.query('ROLLBACK');
      } finally {
        client.release();
        await db.query(`DELETE FROM public.messages WHERE wamid = $1;`, ['wamid.RLS_TEST_AUTH']);
      }
    });

    it('el rol de conexión del backend (postgres) debe seguir operando con normalidad (BYPASSRLS)', async () => {
      const wamid = `wamid.BACKEND_OP_${Date.now()}`;
      await db.query(`
        INSERT INTO public.messages (wamid, direction, message_type, content)
        VALUES ($1, 'INBOUND', 'text', 'Operación normal backend');
      `, [wamid]);

      const res = await db.query(`SELECT * FROM public.messages WHERE wamid = $1;`, [wamid]);
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].content).toBe('Operación normal backend');

      await db.query(`DELETE FROM public.messages WHERE wamid = $1;`, [wamid]);
    });
  });
});
```

#### Extracto de Tests de Rollback y Mutación (`tests/inbound.test.ts`)
```typescript
it('Auditor 5B (Punto 3): Los efectos secundarios de tools (leads) se revierten completamente si la transacción falla', async () => {
  const senderPhone = '5511999995555';
  const contact = await contactRepository.findOrCreate(senderPhone, 'Lead User');
  const conv = await conversationRepository.getOrCreateActiveSession(contact.id);

  const ev = (await inboundRepository.persistInboundEvent({
    wamid: `wamid.LEAD_ROLLBACK_${Date.now()}`,
    phoneNumberId: 'PHONE_LEAD',
    senderPhone,
    payload: { message: { text: { body: 'Quiero comprar el plan Pro' } } },
  }))!;

  const claimed = await inboundRepository.claimPendingBatch(10);
  const claimedEv = claimed.find((e) => e.id === ev.id)!;

  vi.spyOn(agentEngine, 'processMessage').mockResolvedValueOnce({
    replyText: 'Excelente, he registrado tu solicitud para el Plan Pro.',
    catalogToolExecuted: false,
    leadToolExecuted: true,
    handoffToolExecuted: false,
    pendingLead: {
      contactId: contact.id,
      conversationId: conv.id,
      productInterest: 'Plan Pro',
      customerEmail: 'pro@test.com',
    },
    promptTokens: 50,
    completionTokens: 25,
    totalLatencyMs: 150,
  });

  vi.spyOn(outboxRepository, 'enqueueMessage').mockRejectedValueOnce(
    new Error('Fallo simulado forzado para verificar rollback de lead')
  );

  await inboundDispatcher.processSingleEvent(claimedEv);

  // Verificación de atomicidad: ningún lead persistido
  const leadCheck = await db.query(
    `SELECT * FROM public.leads WHERE contact_id = $1 AND product_interest = 'Plan Pro';`,
    [contact.id]
  );
  expect(leadCheck.rows.length).toBe(0);

  // Conversación no muta de estado
  const convCheck = await conversationRepository.findById(conv.id);
  expect(convCheck?.current_state).not.toBe('CLOSING');
});

it('Fencing Token: si el lease fue robado o expiró, la transacción hace ROLLBACK completo', async () => {
  const senderPhone = '5511999993333';
  const ev = (await inboundRepository.persistInboundEvent({
    wamid: `wamid.FENCE_LOST_${Date.now()}`,
    phoneNumberId: 'PHONE_FENCE',
    senderPhone,
    payload: { message: { text: { body: 'Mensaje con fence robado' } } },
  }))!;

  const claimed = await inboundRepository.claimPendingBatch(10);
  const claimedEv = claimed.find((e) => e.id === ev.id)!;

  await db.query(`UPDATE public.inbound_events SET lock_token = gen_random_uuid() WHERE id = $1;`, [ev.id]);

  await inboundDispatcher.processSingleEvent(claimedEv);

  const evCheck = await db.query(`SELECT status FROM public.inbound_events WHERE id = $1;`, [ev.id]);
  expect(evCheck.rows[0].status).toBe('PROCESSING');

  const msgCheck = await db.query(`SELECT * FROM public.messages WHERE wamid = $1;`, [ev.wamid]);
  expect(msgCheck.rows.length).toBe(0);
});

it('Auditor 5B (Punto 6): Reaper aplica protección Poison Pill marcando FAILED tras MAX_RETRIES', async () => {
  const poisonWamid = `wamid.POISON_PILL_${Date.now()}`;
  await db.query(`
    INSERT INTO public.inbound_events (
      wamid, phone_number_id, sender_phone, payload, status, retry_count, locked_at
    )
    VALUES ($1, 'PHONE_POISON', '5511999990003', '{}'::jsonb, 'PROCESSING', 2, NOW() - INTERVAL '60 seconds');
  `, [poisonWamid]);

  const reapedCount = await inboundRepository.reapOrphaned(30);
  expect(reapedCount).toBeGreaterThanOrEqual(1);

  const check = await db.query(`SELECT status, retry_count, last_error FROM public.inbound_events WHERE wamid = $1;`, [poisonWamid]);
  expect(check.rows[0].status).toBe('FAILED');
  expect(check.rows[0].retry_count).toBe(3);
  expect(check.rows[0].last_error).toContain('Poison pill');
});

it('Auditor 5B (Punto 2): Mensaje con antigüedad > 30 min activa guarda de frescura y escala a humano', async () => {
  const stalePhone = '5511999990004';
  const staleWamid = `wamid.STALE_MSG_${Date.now()}`;
  const spyLLM = vi.spyOn(agentEngine, 'processMessage');

  await db.query(`
    INSERT INTO public.inbound_events (
      wamid, phone_number_id, sender_phone, payload, status, created_at, next_retry_at
    )
    VALUES ($1, 'PHONE_STALE', $2, '{"message":{"text":{"body":"Consulta vieja"}}}'::jsonb, 'PENDING', NOW() - INTERVAL '45 minutes', NOW() - INTERVAL '45 minutes');
  `, [staleWamid, stalePhone]);

  const claimed = await inboundRepository.claimPendingBatch(10);
  const claimedEv = claimed.find((e) => e.wamid === staleWamid)!;
  expect(claimedEv).toBeDefined();

  await inboundDispatcher.processSingleEvent(claimedEv);

  expect(spyLLM).not.toHaveBeenCalled();

  const evCheck = await db.query(`SELECT status FROM public.inbound_events WHERE wamid = $1;`, [staleWamid]);
  expect(evCheck.rows[0].status).toBe('DONE');

  const contactCheck = await contactRepository.findByPhone(stalePhone);
  expect(contactCheck?.status).toBe('HUMAN_HANDOFF');

  const outboxCheck = await db.query(`SELECT content FROM public.outbox_messages WHERE recipient_phone = $1;`, [stalePhone]);
  expect(outboxCheck.rows.length).toBe(1);
  expect(outboxCheck.rows[0].content).toContain('pausa técnica temporal');
});
```

---

## 3. EVIDENCIA DE COMPILACIÓN Y TESTS (100% VERDE)

### TypeScript Compilation (`npm run build`):
```bash
> chatbot-ws@1.0.0 build
> tsc
# Exit code: 0 (Cero errores de tipos)
```

### Migraciones de Base de Datos (`npm run migrate`):
```bash
[INFO] 🔄 Iniciando ejecución de migraciones de base de datos...
[INFO] Ejecutando migración: 010_revoke_anon_authenticated_permissions.sql
[INFO] ✅ Migración completada y registrada: 010_revoke_anon_authenticated_permissions.sql
[INFO] 🎉 Todas las migraciones fueron aplicadas con éxito.
# Exit code: 0
```

### Ejecución de Pruebas Unitarias y de Integración (`npx vitest run`):
```bash
 Test Files  12 passed (12)
      Tests  101 passed (101)
   Start at  20:38:58
   Duration  118.37s
# Exit code: 0 (101/101 pruebas superadas al 100%)
```
