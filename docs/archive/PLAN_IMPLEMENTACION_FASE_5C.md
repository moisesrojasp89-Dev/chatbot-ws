# Plan de Implementación — Fase 5C (v2.1 Definitivo): Escala, Sliding Worker Pool, Control de Tasa a LLM & Coalescencia

> [!NOTE]
> **Revisión v2.1 (Aprobación Final):** Incorpora el guard `AND u.status = 'PENDING'` en el UPDATE final de claim (C1), el control de reentrancia y parada en `triggerImmediatePoll` (C4), la reconciliación real de TPM con telemetría de Gemini (C7), la política de coalescencia estrictamente contigua (C10) y los dos tests específicos de colisión SQL exigidos por el Arquitecto Técnico (Dictamen: **8.5/10 — Listo para Aprobar**).

---

## 🏛️ 1. Corrección Bloqueante C1 & Guard de Reentrancia C4

### C1 — Guard de Estado Atómico en el UPDATE Final de Claim (Mecanismo EvalPlanQual)
* **Problema Identificado por el Arquitecto:** `head_messages` es un snapshot calculado al inicio. Si dos transacciones concurrentes calculan el mismo `head_messages`, la primera actualiza a `PROCESSING`. La segunda, al desbloquearse tras el lock de fila, revalida únicamente el WHERE del UPDATE. Como `u.id = h.id` sigue siendo verdadero, la segunda transacción sobreescribiría el `lock_token` de la primera, causando doble-claim.
* **Solución Técnica Aplicada:** Incorporación del guard de estado en la cláusula WHERE del UPDATE final:
  ```sql
  WITH candidate_senders AS (
    SELECT i.sender_phone
    FROM public.inbound_events i
    WHERE i.status = 'PENDING'
      AND i.next_retry_at <= NOW()
      AND NOT EXISTS (
        SELECT 1 FROM public.inbound_events p
        WHERE p.sender_phone = i.sender_phone
          AND p.status = 'PROCESSING'
      )
    GROUP BY i.sender_phone
    ORDER BY MIN(i.created_at) ASC
    LIMIT $1
  ),
  head_messages AS (
    SELECT DISTINCT ON (i.sender_phone) i.*
    FROM public.inbound_events i
    JOIN candidate_senders cs ON i.sender_phone = cs.sender_phone
    WHERE i.status = 'PENDING'
      AND i.next_retry_at <= NOW()
    ORDER BY i.sender_phone, i.created_at ASC
  )
  UPDATE public.inbound_events u
  SET status = 'PROCESSING',
      locked_at = NOW(),
      lock_token = $2
  FROM head_messages h
  WHERE u.id = h.id
    AND u.status = 'PENDING'  -- Guard obligatorio: previene doble-claim en EvalPlanQual
  RETURNING u.*;
  ```
  * Cuando la segunda transacción se desbloquea, `u.status = 'PENDING'` evalúa a falso (la fila ya está en `'PROCESSING'`), impidiendo la actualización y retornando cero filas.

### C4 — Guard de Reentrancia y Apagado en `triggerImmediatePoll()`
* **Problema Identificado:** Si varios workers finalizan simultáneamente, cada uno invocaría `triggerImmediatePoll()` en paralelo, compitiendo por locks. Además, si un worker termina tras expirar el presupuesto de gracia de `stop()`, podría reclamar trabajo en un servidor en proceso de apagado.
* **Solución Técnica Aplicada:**
  1. Flag booleano `isPolling: boolean = false` como cerrojo de reentrancia.
  2. Guarda temprana en `triggerImmediatePoll()`:
     ```typescript
     private isPolling: boolean = false;

     private triggerImmediatePoll(): void {
       // Guard 1: No procesar si el dispatcher se está apagando o ya fue detenido
       if (this.isStopping || !this.isRunning || this.isPaused()) {
         return;
       }

       // Guard 2: No disparar nueva consulta si ya existe un claim en ejecución
       if (this.isPolling) {
         return;
       }

       // Guard 3: Solo consultar si hay slots disponibles en el pool
       if (this.activeWorkers.size >= this.maxConcurrency) {
         return;
       }

       // Ejecutar el siguiente ciclo de sondeo de forma reactiva no bloqueante
       this.pollNextAvailableSlots().catch((err) => {
         logger.error({ err }, 'Error en triggerImmediatePoll');
       });
     }
     ```

---

## ⚡ 2. Especificación Detallada de Componentes

### Componente 1: Sliding Worker Pool con Garantía de 1 Worker por Remitente
* **Estructura en Memoria:**
  - `activeWorkers: Set<Promise<void>> = new Set()`
  - `activeSenders: Set<string> = new Set()` (remitentes actualmente en vuelo para exclusión rápida en memoria).
  - `maxConcurrency = Number(process.env.INBOUND_CONCURRENCY ?? 10)` (C12: nullish coalescing).
* **Ciclo de Ejecución:**
  - En cada tick o trigger: calcula `availableSlots = this.maxConcurrency - this.activeWorkers.size`.
  - Reclama hasta `availableSlots` batches coalescidos con `inboundRepository.claimNextBatchWithCoalescing(availableSlots, lockToken)`.
  - Despacha cada batch en un worker independiente encapsulado con `try/catch/finally`.
  - En el `finally`: remueve de `activeSenders`, remueve de `activeWorkers` y dispara `triggerImmediatePoll()`.
* **Apagado Elegante `stop(graceBudgetMs = 24000)`:**
  - Conmuta `isStopping = true`, aborta `shutdownAbortController` y detiene timers.
  - Ejecuta `Promise.race` entre `Promise.allSettled(Array.from(activeWorkers))` y `setTimeout(resolve, graceBudgetMs).unref()` (C3).

### Componente 2: Control Dual de Cuotas (Token Bucket Continuo RPM + TPM)
* **Motor Matemático:**
  - Recarga continua en cada milisegundo transcurrido:
    $$\Delta\text{tokens} = \text{elapsedMs} \times \left(\frac{\text{capacity}}{60000}\right)$$
  - Bucket dual: **RPM** (`capacity = 60`) y **TPM** (`capacity = 100,000`).
* **Consumo Síncrono y Cola FIFO Ordenada (C8):**
  - Chequeo y descuento en el mismo tick síncrono.
  - Si falta saldo, encola en `queue: Array<QueuedRequest>` y drena en estricto orden FIFO.
* **Ajuste Menor C7 (Estimación Real y Reconciliación Post-Inferencia):**
  - Estimación inicial de cota superior:
    $$\text{estimatedTokens} = \lceil\text{promptText.length} / 4\rceil + \text{maxOutputTokens}$$
    donde `maxOutputTokens` es el límite real configurado en la llamada (180 tokens).
  - **Reconciliación Post-Inferencia:** Tras recibir la respuesta del SDK `@google/genai`, se lee `response.usageMetadata.totalTokenCount`. Si el uso real fue menor a la cota estimada, se devuelve el sobrante al bucket de TPM (`tokens += (estimatedTokens - realTokens)`), evitando desviaciones acumulativas.

### Componente 3: Coalescencia Inteligente Estrictamente Contigua (C9 y C10)
* **Decisión de Producto C10 (Coalescencia Estrictamente Contigua):**
  - Si un usuario envía: `Texto 1` $\rightarrow$ `Texto 2` $\rightarrow$ `Texto 3`: se coalescen los 3 textos en un solo prompt.
  - Si un usuario envía: `Texto 1` $\rightarrow$ `Audio/Imagen 2` $\rightarrow$ `Texto 3`: la coalescencia **se detiene ante el primer evento no-texto**. `Texto 1` se procesa solo; la imagen/audio se procesa individualmente por el handler multimedia; y `Texto 3` se procesa posteriormente respetando el orden cronológico estricto de la conversación.
* **Persistencia Inmutable Individual en `messages` (C9):**
  - Cada mensaje del cliente se inserta como una fila independiente en `public.messages` con su propio `wamid`, contenido y timestamp.
  - La concatenación de texto (`"Texto 1 \n Texto 2"`) existe **únicamente en memoria** para el prompt de ese turno.
  - Los eventos secundarios coalescidos en `inbound_events` se marcan como `DONE` con metadata `coalesced_into: primaryWamid`.

### Componente 4: Módulo Autónomo de Retención LGPD Continua (C11)
* **Desacoplamiento:** `RetentionService` corre en su propio intervalo (cada 15 minutos).
* **Protección del Pool Supavisor:**
  - Procesa lotes de 500 filas con una **pausa obligatoria de 2 segundos** (`await sleep(2000)`) entre lotes para no saturar las conexiones transaccionales.
  - Presupuesto máximo de ejecución dura de 10 segundos por corrida.
  - Cada lote adquiere y libera inmediatamente la conexión del pool en bloque `finally`.
  - Exclusión formal de la tabla `public.messages` de la purga automática de transporte.

### Componente 5: Endurecimiento Multi-Tenant del Webhook Gateway (C5)
* **Erradicación del Fallback Global:**
  - Si `phoneNumberId` viene ausente o no reconocido en el webhook, se emite log con severidad `WARN` (`alert: 'MALFORMED_WEBHOOK_PAYLOAD'`), se registra en `audit_log`, se responde `HTTP 200 OK` a Meta y se descarta el evento. Jamás se inyecta `env.META_PHONE_NUMBER_ID` para evitar enrutamientos indebidos en entornos multi-tenant.

---

## 🧪 3. Suite de Pruebas Automatizadas (Vitest)

Se creará [`tests/phase5cScale.test.ts`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/tests/phase5cScale.test.ts) incorporando los casos exigidos por el Arquitecto:

1. **Test de Carrera SQL Real sobre la Query de C1 (Exigido por Arquitecto):**
   - Abrir dos conexiones concurrentes de base de datos (`clientA` y `clientB`).
   - Ambas ejecutan simultáneamente la consulta de claim compitiendo por el mismo evento `PENDING`.
   - Verificar que gracias al guard `AND u.status = 'PENDING'`, exactamente **un solo cliente** obtiene la fila en su `RETURNING`, mientras que el otro obtiene 0 filas (cero doble-claim a nivel físico de PostgreSQL).
2. **Test de `triggerImmediatePoll()` tras `stop()` (Exigido por Arquitecto):**
   - Simular un worker que finaliza deliberadamente después de que `stop()` retornó el control.
   - Verificar que su llamada a `triggerImmediatePoll()` retorna de inmediato y no dispara ninguna consulta SQL ni reclama trabajo nuevo en un dispatcher detenido.
3. **Test de Serialización Estricta por Remitente bajo Carga:**
   - Encolar 5 mensajes del usuario A y 5 mensajes del usuario B con concurrencia máxima 10.
   - Verificar que los mensajes de A se ejecutan en estricto orden secuencial sin solapamiento temporal, mientras que los de B corren en paralelo con respecto a A.
4. **Test de `stop(graceBudgetMs)` con Worker Colgado:**
   - Iniciar un worker con promesa que no resuelve.
   - Invocar `stop(1000)` y verificar con medición de tiempo que el proceso corta forzosamente a los ~1000ms vía `Promise.race`.
5. **Test de Cero Doble-Gasto en Rate Limiter con Concurrencia Pura:**
   - Disparar 50 llamadas simultáneas con `Promise.all` hacia un bucket con capacidad de 10 tokens.
   - Verificar que pasan exactamente 10 de inmediato y las 40 restantes entran en cola FIFO sin permitir sobregiro.
6. **Test de Reconciliación de TPM con Telemetría de Gemini:**
   - Verificar que tras una llamada donde se consumieron menos tokens de los estimados, el bucket de TPM recupera el saldo sobrante.
7. **Test de Coalescencia Estrictamente Contigua:**
   - Secuencia: `Texto 1` $\rightarrow$ `Texto 2` $\rightarrow$ `Texto 3`: verifica 3 inserciones en `messages` y 1 sola llamada consolidada al LLM.
   - Secuencia: `Texto 1` $\rightarrow$ `Imagen 2` $\rightarrow$ `Texto 3`: verifica que la imagen interrumpe la coalescencia y no se mezcla en el prompt.
8. **Regresión Completa:**
   - 115 tests existentes intactos + 8 tests de Fase 5C (**123/123 tests pasando al 100%**).
   - `npm run build` (`tsc`) con 0 errores.
