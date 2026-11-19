# Walkthrough - Fase 5C: Escala, Sliding Worker Pool, Rate Limiter Dual & Coalescencia

## Estado de Certificación
- **Resultados de Tests**: **123 / 123 tests passing** en Vitest a lo largo de 14 suites en Supabase São Paulo (`sa-east-1`).
- **Compilación**: 0 errores en `tsc` (`npm run build`).
- **Resolución de Requerimientos del Arquitecto (Claude Opus 4.6)**: 12 de 12 observaciones técnicas (**C1–C12**) solventadas y verificadas con tests deterministas dedicados en [`tests/phase5cScale.test.ts`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/tests/phase5cScale.test.ts).

---

## Componentes y Arquitectura Implementada

### 1. Blindaje EvalPlanQual en PostgreSQL (C1)
- **Problema de Concurrencia**: En consultas `UPDATE ... FROM head_messages WHERE target.id = head.id`, cuando dos transacciones A y B compiten por el mismo evento pendiente con `FOR UPDATE`, B se bloquea esperando a A. Al confirmar A (`COMMIT`), PostgreSQL desbloquea a B y re-evalúa **únicamente** la cláusula `WHERE` del `UPDATE` principal (mecanismo `EvalPlanQual`). Como `target.id = head.id` sigue siendo verdadero aunque el estado haya mutado a `PROCESSING`, B sobreescribía el lock y token de A (double-claim).
- **Solución Implementada**: Se añadió la guarda `AND u.status = 'PENDING'` en la cláusula `WHERE` del comando `UPDATE` en [`inboundRepository.ts`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/src/repositories/inboundRepository.ts). Al re-evaluar la condición, B encuentra `status = 'PROCESSING'`, por lo que la condición evalúa a falso y actualiza 0 filas.
- **Verificación**: Test `C1: SQL Race Condition` ejecutado con 2 clientes concurrentes reales de PostgreSQL (`clientA` y `clientB`) compitiendo por la misma fila.

### 2. Sliding Worker Pool y Despacho Reactivo (C2, C4, C12)
- **Sliding Worker Pool**: En [`inboundDispatcher.ts`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/src/services/inboundDispatcher.ts), se desacopló el procesamiento por lotes monolíticos en un pool elástico flotante administrado por:
  - `activeWorkers: Set<Promise<void>>`
  - `activeSenders: Set<string>`
  - `maxConcurrency: Number(process.env.INBOUND_CONCURRENCY ?? 10)` (C12)
- **Trigger Reactivo Inmediato (`triggerImmediatePoll`)**: Cada vez que un worker completa su ejecución en su bloque `finally`, invoca `triggerImmediatePoll()`, reclamando de inmediato los slots vacíos sin esperar al reloj periódico de 500ms (reduciendo la latencia de cola en hasta 500ms).
- **Guarda de Reentrada `isPolling`**: Protege al sistema contra ráfagas ("thundering herd") cuando múltiples workers terminan simultáneamente. Solo un sondeo activo puede consultar y bloquear filas en PostgreSQL al mismo tiempo.
- **Manejo Seguro de Workers**: Todos los workers se instancian en un bloque `try/catch/finally` hermético, garantizando que no existan promesas flotantes ni unhandled rejections.

### 3. Rate Limiter Dual RPM/TPM Continuo para Gemini (C6, C7, C8)
- **Token Bucket Continuo ([`llmRateLimiter.ts`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/src/providers/llm/llmRateLimiter.ts))**:
  - Recarga infinitesimal basada en tiempo transcurrido en milisegundos:
    $$\Delta\text{tokens} = \text{elapsedMs} \times \frac{\text{rate}}{60000}$$
  - Erradica por completo los picos destructivos y ráfagas que se producen al cambio de minuto con rate limiters de ventana fija.
- **Reserva Síncrona Atómica (C8)**: La reserva de cuota (`tryConsumeSync`) es 100% síncrona sin ningún `await` antes de restar los tokens, impidiendo condiciones de carrera o double-spending en concurrencia masiva.
- **Cola FIFO Ordenada**: Si el saldo no es suficiente, la petición entra en una cola FIFO con `setTimeout` milimétricamente calculado para activarse tan pronto como la recarga infinitesimal cubra la demanda.
- **Control Dual y Reconciliación Post-Inferencia (C7)**: Monitorea tanto RPM como TPM. Tras la llamada en [`geminiClient.ts`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/src/providers/llm/geminiClient.ts), se lee `response.usageMetadata.totalTokenCount`. Si se estimaron 2,000 tokens pero el consumo real fue 800, se reembolsan 1,200 tokens de inmediato al bucket. Si hubo sobreconsumo, se deduce la diferencia.

### 4. Coalescencia Inteligente de Mensajes por Remitente (C9, C10)
- **Agrupación Contigua en SQL ([`inboundRepository.ts`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/src/repositories/inboundRepository.ts))**: En `claimNextBatchWithCoalescing(limit)`, el sistema toma la cabecera por remitente y busca los siguientes mensajes en `PENDING` del mismo usuario (hasta 5 mensajes en total).
- **Contigüidad Estricta (C10)**: La coalescencia se aplica únicamente si el mensaje primario es de texto y se interrumpe de inmediato ante el primer mensaje no-texto (imagen, audio, sticker). Mensajes multimedia se procesan de forma estrictamente aislada.
- **In-Memory Concatenation & Inmutable Persistence (C9)**:
  - Los textos se concatenan en memoria separados por salto de línea (`\n`) para ejecutar una única llamada agéntica a Gemini (consolidación de ráfagas sin llamadas redundantes).
  - En la base de datos, CADA mensaje se persiste de forma individual e inmutable en `public.messages` con su `wamid` original.
  - La transacción atómica marca el primario como `DONE` y los secundarios como `coalesced_into:<primary_id>`.

### 5. Retención LGPD Continua y Protección de Supavisor (C11)
- **Servicio Autónomo ([`retentionService.ts`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/src/services/retentionService.ts))**:
  - Cadencia periódica cada 15 minutos desacoplada del worker de mensajería.
  - Procesa lotes pequeños de 500 filas con pausas obligatorias de 2,000ms (`interBatchPauseMs`) entre lotes y un presupuesto duro de 10 segundos (`maxExecutionTimeMs`) por ciclo para evitar agotar las conexiones del pool en Supabase (Supavisor).
  - Consultas CTE con `FOR UPDATE SKIP LOCKED` para eliminar contención con transacciones activas de clientes en caliente.
  - Purgas diferenciadas: `DONE` / `SENT` a 7 días, `FAILED` a 90 días, `message_status_events` a 30 días, y `public.messages` 100% protegido.

### 6. Aislamiento Multi-Tenant y Seguridad en Webhook (C5)
- **Remoción de Fallback Global**: En [`webhookController.ts`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/src/controllers/webhookController.ts), se removió cualquier uso de `env.META_PHONE_NUMBER_ID` como fallback para mensajes sin `phone_number_id` en `metadata`.
- **Descarte y Auditoría**: Todo webhook entrante que carezca de un `phone_number_id` válido se clasifica como `MALFORMED_WEBHOOK_PAYLOAD`, se audita en `public.audit_log`, se emite una alerta de observabilidad y se responde `HTTP 200 OK` a Meta sin persistir ni procesar internamente.

### 7. Apagado Elegante con Timeout Duro (C3)
- **Arbitraje mediante `Promise.race`**:
  ```typescript
  const winner = await Promise.race([
    Promise.allSettled(Array.from(this.activeWorkers)),
    timeoutPromise // graceBudgetMs (default 24s)
  ]);
  ```
- Si algún worker queda colgado o una llamada externa no responde, el dispatcher no se congela indefinidamente; corta en el límite de gracia y permite la salida limpia del contenedor.

---

## Verificación de Pruebas Automatizadas

```bash
npx vitest run
```

```
 Test Files  14 passed (14)
      Tests  123 passed (123)
   Start at  15:44:55
   Duration  178.63s
```

| Suite | Tests Pasados | Estado |
|---|:---:|:---:|
| `tests/phase5cScale.test.ts` | 8 / 8 | ✅ PASSED |
| `tests/inbound.test.ts` | 24 / 24 | ✅ PASSED |
| `tests/outbox.test.ts` | 13 / 13 | ✅ PASSED |
| `tests/circuitBreaker.test.ts` | 12 / 12 | ✅ PASSED |
| `tests/guardrails.test.ts` | 9 / 9 | ✅ PASSED |
| `tests/agentEngine.test.ts` | 10 / 10 | ✅ PASSED |
| `tests/contextManager.test.ts` | 6 / 6 | ✅ PASSED |
| `tests/geminiErrorClassification.test.ts` | 5 / 5 | ✅ PASSED |
| `tests/webhook.test.ts` | 8 / 8 | ✅ PASSED |
| `tests/repositories.test.ts` | 8 / 8 | ✅ PASSED |
| `tests/lifecycle.test.ts` | 7 / 7 | ✅ PASSED |
| `tests/rlsAndLogger.test.ts` | 7 / 7 | ✅ PASSED |
| `tests/fsm.test.ts` | 5 / 5 | ✅ PASSED |
| `tests/database.test.ts` | 1 / 1 | ✅ PASSED |
| **TOTAL** | **123 / 123** | **100% EXITOSO** |
