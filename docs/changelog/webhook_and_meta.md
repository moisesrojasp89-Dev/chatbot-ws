# 📡 Bitácora Técnica: Webhook Gateway, Meta Cloud API & Outbox

> **Dominio:** Ingesta de Webhooks, Validación Criptográfica, Idempotencia, Despacho Saliente y Reconciliación de Estados de Mensajería.

---

## 🚀 Evolución y Decisiones Clave por Fase

### 1. Ingesta de Webhooks y Validación HMAC (Fase 1)
* **Validación Criptográfica en Tiempo Constante:**
  * Implementación en `src/utils/crypto.ts` con `crypto.timingSafeEqual` y HMAC SHA-256 para prevenir ataques de temporización (timing attacks).
  * Middleware de bytes crudos `fastify-raw-body` para preservar la firma exacta emitida por Meta antes de parsear JSON.
* **Idempotencia Dual por `wamid`:**
  * Fast-path en memoria con Map de TTL de 15 minutos y evicción automática periódica cada 5 minutos.
  * Fuente de verdad persistente en PostgreSQL con constraint `UNIQUE (wamid)`.
* **SLA de Acuse Inmediato (<200ms):**
  * Respuesta HTTP 200 inmediata para evitar que Meta interprete timeout y reintente el envío.

### 2. Transactional Outbox y Despacho Asíncrono (Fase 4)
* **Patrón Transactional Outbox:**
  * Cola desacoplada en tabla `public.outbox_messages` con estados `PENDING`, `PROCESSING`, `SENT`, `FAILED`.
  * Reclamo concurrente seguro con `SELECT ... FOR UPDATE SKIP LOCKED`.
* **Fencing Tokens (`lock_token UUID`):**
  * Cada worker que reclama un mensaje adquiere un `lock_token`.
  * Pre-Send y Post-Send fencing para evitar que un worker demorado ("zombie") sobrescriba o re-envíe un mensaje reclamado por otro worker o el reaper.
* **Cadencia Humana (`typingCadence`):**
  * Simulación de presencia humana activa emitiendo indicador "typing..." a Meta y esperando un retardo humanizado aleatorio (1.5s - 2.5s) en producción (acelerado a 5ms en test).
* **Circuit Breaker para Meta Graph API (`metaCircuitBreaker`):**
  * Umbral de 5 fallos consecutivos para abrir circuito.
  * Estado HALF_OPEN con sonda canary.
  * Distinción estricta de errores sistémicos (401, 190, token revocado) que activan pausa global vs fallos transitorios de red con backoff exponencial.

### 3. Reconciliación de Status Updates (Fase 4)
* **Ingesta de Estados:**
  * Ingesta de eventos `sent`, `delivered`, `read`, `failed` desde webhooks de Meta.
* **Guarda de Progresión Monótona:**
  * Los estados de mensajes siguen una jerarquía estricta: `queued` $\to$ `sent` $\to$ `delivered` $\to$ `read`.
  * Un estado inferior nunca puede sobrescribir a uno superior (evita carreras de red inversas donde `delivered` llega antes que `sent`).
* **Absorción de Carreras Inversas:**
  * Si un webhook `delivered` llega antes de que el worker complete la escritura en base de datos, el evento se absorbe limpiamente.
