# 🧠 Chatbot WS — Catálogo de Errores con Auto-Aprendizaje y Memoria Persistente

> **Propósito:** Dotar al sistema de una memoria histórica inmutable sobre fallos pasados, sus causas raíz y los candados algorítmicos implementados (*Harness dentro del Harness*).  
> **Mandato:** Todo agente o desarrollador que detecte una anomalía o regresión debe registrar el incidente utilizando la metodología de los 5 Porqués (5-Whys) y vincular el test unitario / tripwire correspondiente.

---

## 🗂️ Registro Sistemático de Incidentes y Tripwires

### [ERR-001] Mensajes Duplicados por Timeout en Webhook de Meta
* **Fecha:** Retrospectivo Fase 4 | **Severidad:** Alta | **Módulo:** Webhook Dispatcher
* **Síntoma:** Clientes de WhatsApp recibían 2 o 3 respuestas idénticas cuando el LLM tardaba más de 5 segundos.
* **Análisis 5-Whys:**
  1. *¿Por qué recibían respuestas duplicadas?* Porque Meta reenviaba el webhook al no recibir `HTTP 200 OK` en 5-10 segundos.
  2. *¿Por qué tardaba en responder el webhook?* Porque el servidor procesaba la llamada a Gemini sincrónicamente dentro de la solicitud HTTP del webhook.
  3. *¿Por qué se ejecutaba sincrónico?* Falta de desacoplamiento entre el acuse de recibo y la generación de respuesta.
  4. *¿Cómo se solucionó?* Respondiendo `HTTP 200` de inmediato (<200ms) tras validar firma HMAC y encolando el procesamiento del mensaje en segundo plano con deduplicación por `wamid`.
  5. *¿Qué candado permanente evita su repetición?* La separación arquitectónica en `inbound_events` y Transactional Outbox.
* **Contra-Medida Permanente:**
  - Acuse `200 OK` instantáneo (<200ms).
  - Almacenamiento y validación de `wamid` en PostgreSQL con índice único y fast-path en memoria.
* **Candado de Regresión (Tripwire):**
  - Test en `tests/webhook.test.ts`: Reintento con idéntico `wamid` devuelve 200 OK pero intercepta la duplicidad sin despachar llamadas adicionales.

---

### [ERR-002] Carrera Asíncrona en Inbound Durable: Evento Pasa a PROCESSING Antes de Aserción
* **Fecha:** Octubre 2026 (Auditoría Fase 5B) | **Severidad:** Media | **Módulo:** `InboundDispatcher` & Tests
* **Síntoma:** Tests unitarios de persistencia de ACK fallaban esperando estado `PENDING` y recibiendo `PROCESSING`.
* **Análisis 5-Whys:**
  1. *¿Por qué el test recibió `PROCESSING` en vez de `PENDING`?* Porque el daemon de despacho en segundo plano ya había reclamado el evento de la base de datos.
  2. *¿Por qué lo reclamó tan rápido?* Porque el polling del dispatcher estaba corriendo concurrentemente con un intervalo de 500ms durante la ejecución del test.
  3. *¿Por qué estaba corriendo el dispatcher en un test que solo evaluaba la capa de persistencia del Webhook?* Porque `inboundDispatcher.start()` se activó globalmente sin aislamiento o pausa controlada en `beforeEach`/`afterEach`.
  4. *¿Cómo se solucionó?* Pausando el dispatcher explícitamente (`inboundDispatcher.pause()`) durante pruebas que requieran validar el estado de reposo, reanudándolo solo en pruebas end-to-end de procesamiento.
  5. *¿Qué candado permanente evita su repetición?* Métodos `pause()` y `resume()` en `InboundDispatcher` con control determinista de estado en la suite de pruebas.
* **Contra-Medida Permanente:**
  - Guardas de control de ciclo de vida en dispatchers para desacoplar tests de persistencia de tests de workers activos.
* **Candado de Regresión (Tripwire):**
  - Test en `tests/inbound.test.ts` con aislamiento determinista de ciclo de vida.

---

### [ERR-003] Congelamiento de Temporizadores por `Date.now` Spied sin Restauración
* **Fecha:** Octubre 2026 (Auditoría Fase 4 / Lifecycle) | **Severidad:** Alta | **Módulo:** Test Harness (`tests/lifecycle.test.ts`)
* **Síntoma:** El test `Ciclo de Vida 8` sufría timeout de 30,000ms al ejecutar `outboxDispatcher.stop()`.
* **Análisis 5-Whys:**
  1. *¿Por qué `stop()` excedió el timeout de 30s?* Porque el `Promise.race` con el presupuesto de parada (`shutdownBudgetMs`) no se resolvía ni avanzaban los temporizadores de Node.js.
  2. *¿Por qué no avanzaba el tiempo de forma consistente?* Porque un test precedente (`Ciclo de Vida 6`) mockeó `Date.now` con un valor estático adelantado 35s (`vi.spyOn(Date, 'now').mockReturnValue(...)`) para forzar `HALF_OPEN`.
  3. *¿Por qué afectó al test 8?* Porque el mock de `Date.now` no fue restaurado inmediatamente al terminar la verificación del test 6, contaminando los cálculos de tiempo subsiguientes en el dispatcher y en Vitest.
  4. *¿Cómo se solucionó?* Restaurando el espía de `Date.now` inmediatamente en el bloque `finally` o al concluir el bloque del test, y reseteando el Circuit Breaker de forma determinista.
  5. *¿Qué candado permanente evita su repetición?* Inclusión de `vi.restoreAllMocks()` obligatorio en el bloque `afterEach` y restauración puntual de espías temporales.
* **Contra-Medida Permanente:**
  - Uso de métodos nativos de control de reloj de Vitest (`vi.useFakeTimers()`) o restauración inline garantizada con `mockRestore()`.
* **Candado de Regresión (Tripwire):**
  - Suite de `tests/lifecycle.test.ts` ejecutándose completa y limpia sin temporizadores congelados.

---

### [ERR-004] Alucinación de Precios en Respuestas del Modelo sin Tool Calling
* **Fecha:** Retrospectivo Fase 3 | **Severidad:** Crítica | **Módulo:** Agent Engine & Guardrails
* **Síntoma:** En pruebas de conversación, el modelo respondía a preguntas de clientes inventando precios de servicios o vehículos sin haber consultado la base de datos oficial.
* **Análisis 5-Whys:**
  1. *¿Por qué inventó un precio el modelo?* Porque los LLMs son probabilísticos y tienden a rellenar números cuando se les pide un costo si no tienen una restricción arquitectónica dura.
  2. *¿Por qué el System Prompt no lo impidió?* Porque las instrucciones en lenguaje natural ("no inventes precios") son heurísticas y sufren de degradación o jailbreak probabilístico.
  3. *¿Por qué no se verificó antes de enviar?* Porque la respuesta del modelo salía directamente hacia el cliente sin validación sintáctica ni semántica intermedia.
  4. *¿Cómo se solucionó?* Implementando el **Guardrail Nivel 3 (Grounding Lock)** por código determinista en TypeScript.
  5. *¿Cómo opera el Grounding Lock?* Inspecciona el texto generado en busca de patrones monetarios (`$`, `USD`, `R$`, montos numéricos) y verifica en la bitácora de la sesión si la tool `searchProductCatalog` fue ejecutada en ese turno. Si no fue ejecutada, el guardrail aborta la respuesta y fuerza la consulta oficial al catálogo.
* **Contra-Medida Permanente:**
  - `src/harness/guardrails.ts`: Validación programática ineludible pre-despacho.
* **Candado de Regresión (Tripwire):**
  - `tests/guardrails.test.ts`: Verificación de rechazo inmediato y redirección a catálogo cuando el bot intenta citar precios sin tool call.

---

### [ERR-005] Carrera Inversa de Webhooks de Estado (Delivered antes de Sent)
* **Fecha:** Retrospectivo Fase 4 | **Severidad:** Media | **Módulo:** Status Updates Handler
* **Síntoma:** Mensajes quedaban marcados erróneamente con estado atrasado o fallaban al recibir el webhook de Meta antes de que la transacción local de base de datos confirmara el envío.
* **Análisis 5-Whys:**
  1. *¿Por qué fallaba la actualización?* Porque Meta despachó el webhook de `delivered` y nuestro servidor lo procesó en milisegundos antes de que el worker completara la inserción de `outbound` en base de datos.
  2. *¿Por qué ocurre esto?* Porque la red de Meta y la infraestructura de telecomunicaciones pueden entregar el webhook con extrema rapidez mientras la red local hacia Postgres procesa el commit.
  3. *¿Por qué degradaba el estado?* Porque las actualizaciones no validaban la monotonicidad jerárquica de los estados (`queued` $\to$ `sent` $\to$ `delivered` $\to$ `read`).
  4. *¿Cómo se solucionó?* Implementando en SQL una cláusula condicional de progresión monótona: un estado no puede sobrescribir a uno de mayor jerarquía, y si el registro aún no existe, se registra el evento en cola de absorción.
* **Contra-Medida Permanente:**
  - `MessageRepository.updateDeliveryStatus` con lógica monótona y absorción de carreras inversas.
* **Candado de Regresión (Tripwire):**
  - `tests/statusUpdates.test.ts`: Simulación de evento `delivered` recibido antes del registro de `outbound` con absorción sin degradación.

---

### [ERR-006] Omisión de Filas en Polling por Congelamiento de NOW() en Transacciones de PostgreSQL
* **Fecha:** Octubre 2026 (Auditoría Harness y Modularización) | **Severidad:** Alta | **Módulo:** `InboundRepository` & `OutboxRepository`
* **Síntoma:** Consultas de reclamo (`claimPendingBatch`) retornaban 0 filas inmediatamente después de insertar eventos válidos con `next_retry_at = NOW()`, provocando aserciones vacías intermitentes en pipelines concurrentes.
* **Análisis 5-Whys:**
  1. *¿Por qué `claimPendingBatch` retornaba 0 filas?* Porque la condición `WHERE next_retry_at <= NOW()` evaluaba falso para eventos recién insertados.
  2. *¿Por qué evaluaba falso si ambos usaban `NOW()`?* Porque en PostgreSQL dentro de una transacción (`BEGIN`), `NOW()` es un alias de `transaction_timestamp()`, cuyo valor queda congelado al momento exacto en que inició la transacción.
  3. *¿Por qué el `next_retry_at` de la fila era mayor que `transaction_timestamp()`?* Porque la inserción en otra conexión se ejecutó microsegundos después de la apertura de la transacción del claimer, recibiendo una marca de tiempo milisegundos más reciente que el `NOW()` congelado.
  4. *¿Por qué esto afectaba pruebas de alta concurrencia?* Porque al competir workers o correr suites rápidas, las transacciones abiertas con `BEGIN` leían un snapshot temporal congelado que excluía los mensajes encolados concurrentemente.
  5. *¿Qué candado algorítmico permanente elimina el problema?* Reemplazar `NOW()` por `clock_timestamp()` en la cláusula `WHERE next_retry_at <= clock_timestamp()` en `InboundRepository` y `OutboxRepository`. A diferencia de `NOW()`, `clock_timestamp()` lee el reloj real de pared en el instante exacto de la ejecución de la consulta.
* **Contra-Medida Permanente:**
  - Modificación de todas las consultas CTE de reclamo con `clock_timestamp()` en `src/repositories/inboundRepository.ts` y `src/repositories/outboxRepository.ts`.
* **Candado de Regresión (Tripwire):**
  - Suites `tests/inbound.test.ts` (Criterio 2: T3 / T4) y `tests/outbox.test.ts` (Auditor 5A) ejecutando transacciones concurrentes con `BEGIN` sin omisión de eventos.

---

### [ERR-007] Desalineación de Nombres de Columnas entre Esquemas de Migración y Repositorios de Dominio
* **Fecha:** Octubre 2026 (Auditoría Fase M1/M2 TrasladosYa) | **Severidad:** Alta | **Módulo:** `TripRepository`, `RetentionService` & `DriverRepository`
* **Síntoma:** Consultas SQL dinámicas arrojaban errores de relación como `column "started_at" of relation "trasladosya_trips" does not exist` y `column "rating_avg" does not exist` en `trasladosya_drivers`.
* **Análisis 5-Whys:**
  1. *¿Por qué fallaron las consultas?* Porque los repositorios TypeScript invocaban nombres abreviados (`dest_lat`, `started_at`, `rating_avg`) en vez de los nombres oficiales de las migraciones SQL (`destination_lat`, `trip_started_at`, `rating`).
  2. *¿Por qué ocurrió la desalineación?* Porque las interfaces TypeScript se redactaron paralelamente a los borradores iniciales de especificación sin validar contra el catálogo real de columnas de la migración `013_trasladosya_mobility_schema.sql`.
  3. *¿Por qué no lo detectó TypeScript en compilación (`tsc --noEmit`)?* Porque las consultas se ejecutaban como strings de texto SQL parametrizados a través de `db.query()`, donde el compilador de TS no puede auditar el esquema interno de la base de datos de PostgreSQL.
  4. *¿Cómo se detectó?* Mediante la ejecución de pruebas de integración con cobertura completa de todas las transiciones de la FSM de movilidad (`mobilityRepositories.test.ts` y `mobilityMotor.test.ts`).
  5. *¿Qué candado arquitectónico permanente previene este error?* Alinear estrictamente todos los nombres de columnas en `TripRecord` y `DriverRecord` con las migraciones oficiales `013` a `017`, y agregar pruebas exhaustivas de ciclo de vida completo (`draft` $\to$ `completed`) en la suite de pruebas automatizadas.
* **Contra-Medida Permanente:**
  - `src/repositories/tripRepository.ts`: Renombrado de `dest_lat`/`dest_lng` a `destination_lat`/`destination_lng` y `started_at`/`completed_at` a `trip_started_at`/`trip_completed_at`.
  - `src/repositories/driverRepository.ts`: Renombrado y ordenamiento por `rating` oficial.
  - `src/services/retentionService.ts`: Inclusión de purgas periódicas LGPD (7 días para `DONE` y 90 días para `FAILED`) para `telegram_inbound_events` y `telegram_outbox_messages`.
* **Candado de Regresión (Tripwire):**
  - `tests/mobilityRepositories.test.ts`: Test de transición integral hasta `completed` con verificación de `trip_started_at` y `trip_completed_at`.
  - `tests/mobilityMotor.test.ts`: Ciclo completo de despacho y resolución.

---

### [ERR-008] Pérdida del Proyecto Supabase de Pruebas y Ref Truncado en el Guard
* **Fecha:** 2026-11-19 | **Severidad:** Alta | **Módulo:** `databaseGuard`, Infra Supabase & CI
* **Síntoma:** El Quality Gate falló con 59 pruebas en rojo y `npm test` devolvía `(ENOTFOUND) tenant/user postgres.bsdaswbwxekfedqrzdzc not found`. Tras crear un proyecto nuevo, el workflow de keep-alive siguió fallando con `tenant/user postgres.vmlw... not found` aunque el host resolvía y el puerto 5432 respondía.
* **Análisis 5-Whys:**
  1. *¿Por qué fallaban todas las suites que tocan base de datos?* Porque `DATABASE_URL` apuntaba a un proyecto Supabase que ya no existía: su host `bsdaswbwxekfedqrzdzc.supabase.co` no resolvía por DNS (NXDOMAIN). No era una pausa ni un problema de red.
  2. *¿Por qué apuntaba a un proyecto inexistente?* Porque el proyecto original se perdió al perder acceso a la cuenta/correo con que se creó el repositorio; el código se clonó a una cuenta personal, pero la base de datos y su `ref` no se reconstruyeron ni se actualizó `.env` ni el guard.
  3. *¿Por qué el guard no lo detectó antes?* Porque `TEST_PROJECT_REF` estaba hardcodeado al ref histórico y solo comparaba subcadenas de la URL. Cualquier URL que contuviera ese ref pasaba la validación, sin verificar longitud ni existencia real del proyecto.
  4. *¿Por qué siguió fallando tras crear el proyecto nuevo?* Porque el ref se transcribió con 19 caracteres (`vmlwqpqxzscicglyyzr`) en lugar de los 20 reales (`vmlwwqpxqzsciclgyyzr`), y el secreto de GitHub Actions conservó una variante obsoleta. Supabase responde `(ENOTFOUND) tenant/user ... not found`, un mensaje que parece de red pero significa "ese proyecto/ref no está registrado en el pooler".
  5. *¿Qué candado permanente evita su repetición?* (a) `TEST_PROJECT_REF` parametrizado por entorno en `src/utils/databaseGuard.ts`, con fallback al ref histórico; (b) protocolo de preflight: verificar que el ref tenga 20 caracteres y que `<ref>.supabase.co` resuelva por DNS antes de migrar; (c) workflow de keep-alive que consulta la base periódicamente y falla en rojo si el proyecto desaparece o se pausa; (d) `tests/setup.ts` ejecuta `assertTestDatabase` en cada suite.
* **Contra-Medida Permanente:**
  - `src/utils/databaseGuard.ts`: ref exigido resuelto desde `TEST_PROJECT_REF` (fallback `DEFAULT_TEST_PROJECT_REF`), evaluado en tiempo de ejecución para que `dotenv` ya esté cargado.
  - `src/config/env.ts` y `.env.example`: `TEST_PROJECT_REF` validado/documentado, con advertencia de no apuntar a producción.
  - Proyecto de pruebas dedicado `chatbot-ws-test` (ref de 20 caracteres) reconstruido con las 13 migraciones, RLS en las 10 tablas y 134 pruebas en verde.
  - `.github/workflows/supabase-keepalive.yml`: consulta `select now()` y el conteo de migraciones cada 5 días para evitar la pausa del plan FREE; requiere el secreto `SUPABASE_DB_URL` con el Session Pooler (puerto 5432).
  - Documentación de arquitectura corregida: ya no afirma que el proyecto eliminado sigue vivo y usa Session Pooler 5432 para migraciones (`pg_advisory_lock` de sesión).
* **Candado de Regresión (Tripwire):**
  - `tests/setup.ts` + `assertTestDatabase`: toda suite aborta si `DATABASE_URL` no contiene el `TEST_PROJECT_REF` vigente.
  - `.github/workflows/supabase-keepalive.yml`: falla en rojo si el tenant/proyecto deja de responder (proyecto pausado o eliminado), actuando como alarma con 5 días de antelación al umbral de pausa.
  - Preflight manual documentado: ref de **20 caracteres** + `Resolve-DnsName <ref>.supabase.co` antes de ejecutar `npm run migrate` sobre una base nueva.

---

## 📝 Plantilla para Nuevos Incidentes

Ante cualquier nuevo fallo detectado en producción o tests, copia y completa el siguiente bloque:

```markdown
### [ERR-XXX] Breve Título Descriptivo del Fallo
* **Fecha:** YYYY-MM-DD | **Severidad:** [Crítica | Alta | Media | Baja] | **Módulo:** Nombre del Módulo
* **Síntoma:** Descripción clara de lo que experimentó el usuario o el sistema.
* **Análisis 5-Whys:**
  1. *¿Por qué ocurrió el síntoma?* ...
  2. *¿Por qué...?* ...
  3. *¿Por qué...?* ...
  4. *¿Por qué...?* ...
  5. *¿Por qué...?* ...
* **Contra-Medida Permanente:**
  - Solución técnica y arquitectónica implementada.
* **Candado de Regresión (Tripwire):**
  - Archivo de test y aserción exacta que garantiza que el fallo nunca vuelva a ocurrir.
```
