# 🤖 Chatbot WS — Reglas y Guardrails para Agentes de IA (Harness Institucional)

> **Mandato Institucional Obligatorio para Antigravity, Claude, Cursor y Asistentes IA**  
> **Versión:** 1.2.0 (Multicanal & LLM Agnóstico — Noviembre 2026)  
> **Ámbito:** Aplica automáticamente a todas las sesiones de desarrollo, depuración y refactorización en Chatbot WS, **sin importar el canal ni el proveedor de LLM**.

---

## 🎯 1. Misión y Filosofía de Construcción

1. **Plataforma Multicanal de Mensajería Transaccional y Conversacional:**
   - Chatbot WS es infraestructura crítica de atención y ventas para negocios en LATAM (ES/PT-BR).
   - **El canal es un adaptador, no el producto.** WhatsApp Business Cloud API (Meta) es la primera integración productiva; Telegram, Instagram DM, TikTok, webchat y APIs propias se incorporan como adaptadores sobre el mismo núcleo.
   - Cero bloqueos en el event-loop de Node.js.
   - Todo flujo conversacional debe responder dentro de la **ventana de acuse que declare su adaptador** (Meta: 20s; Telegram: inmediata; webchat: configurable). El núcleo no asume la ventana de Meta.

2. **Principio Operativo Dominante:**
   - **Los humanos dirigen. Los agentes ejecutan.**
   - Ante fallos repetidos, la respuesta jamás es *"intentar más fuerte"*, sino identificar la capacidad, herramienta o restricción faltante y hacerla mecánicamente exigible.

3. **Harness Dentro del Harness (Auto-Aprendizaje):**
   - Prohibido parches ciegos o atajos temporales.
   - Ante cualquier bug en canales, webhooks, base de datos o LLM, consultar obligatoriamente `docs/standards_and_harness/self_learning_error_catalog.md` y agregar la entrada con 5-Whys.
   - Todo desarrollo debe regirse por la [Guía de Harness Engineering (arXiv:2609.00006 & @0xwhrrari)](docs/standards_and_harness/GUIA_HARNESS_ENGINEERING.md), la [Guía de Skills Agénticas](docs/standards_and_harness/GUIA_SKILLS_Y_WORKFLOWS_AGENTICOS.md) y la [Certificación de Resiliencia Red Team](docs/standards_and_harness/CERTIFICACION_RESILIENCIA_Y_REVERSE_ENGINEERING.md).

---

## 🛑 2. Mandamientos Inquebrantables del Núcleo (agnósticos al canal)

### A. Seguridad Zero-Trust y Cero Secretos en Código
- Jamás incrustar tokens de **cualquier canal** (Meta/WhatsApp, Telegram, Instagram, TikTok, webchat), contraseñas de PostgreSQL ni API keys del proveedor LLM en código rastreado por git.
- Usar siempre variables de entorno tipadas y validadas con `zod`.

### B. Idempotencia y Deduplicación Multicanal
- Todo mensaje entrante se identifica por la pareja **(canal, identificador externo del mensaje)**:
  - Meta/WhatsApp: `wamid`.
  - Telegram: `update_id`.
  - Instagram DM: `mid`.
  - Webchat/API propia: `Idempotency-Key` o id propio.
- El adaptador **DEBE** verificar la autenticidad del origen antes de procesar:
  - Meta: firma HMAC SHA-256 en `x-hub-signature-256`.
  - Telegram: `X-Telegram-Bot-Api-Secret-Token`.
  - Instagram/TikTok/Webchat: firma o token del proveedor.
- Un mensaje duplicado **nunca** produce dos respuestas ni dos efectos de negocio (leads, handoff, outbox).

### C. Aislamiento Multi-Tenant & RLS en Base de Datos
- Ninguna consulta SQL puede omitir el filtro por `business_id` / `tenant_id`.
- Políticas RLS activas en todas las tablas de producción, sin importar el canal de origen.

### D. Presupuesto de Pruebas Determinista & Mocks de Red
- La suite completa de pruebas (`npm test` con Vitest) debe ejecutarse de forma ágil y determinista.
- **Cero peticiones reales a APIs de canales (Meta, Telegram, Instagram, TikTok, webchat) ni al proveedor LLM en tests:** todas las llamadas externas se interceptan con mocks deterministas.

### E. Manejo Defensivo y Tipado Estricto
- `tsc --noEmit` debe compilar con 0 errores y 0 advertencias de tipos. Prohibido el uso indiscriminado de `any`.
- Cada adaptador valida sus payloads con `zod`; el núcleo solo recibe el sobre normalizado.

### F. Instrucciones como Infraestructura (Codificación Doble)
- Toda política de negocio o seguridad crítica debe codificarse **dos veces**:
  1. Como instrucción clara para el LLM en su contexto.
  2. Como chequeo mecánico por código (Zod, test de regresión, query RLS, constraint SQL) que no pueda eludirse.
- **El modelo propone; el harness determinista autoriza y ejecuta.**

### G. Aislamiento del Canal (núcleo sin condicionantes)
- `src/harness/**` y `src/services/**` **no deben importar** SDKs, clientes ni tipos específicos de un canal.
- Todo código dependiente de un proveedor de mensajería vive en `src/providers/channels/<canal>/`.
- El núcleo solo conoce:
  - un sobre normalizado de entrada/salida,
  - las interfaces `ChannelAdapter` / `ChannelSender`,
  - un registro de canales (`ChannelRegistry`).
- **Prohibido** ramificar con `if (channel === 'whatsapp')` dentro del harness o los servicios; se resuelve por polimorfismo/registro.
- Un adaptador nuevo **no puede exigir cambios en el harness**; si los exige, el diseño del adaptador es incorrecto.

> **Deuda técnica conocida (Ola 0 completada):** el **egress** ya usa `ChannelSender` y `OutboxDispatcher` no importa Meta. La Ola 1 ya incorporó Telegram (ingress/egress), identidad inbound `(channel, wamid)` con coalescencia por canal, breaker/pausa aislados por canal y claim filtrado por canales sanos. El ingress implementa `ChannelAdapter` (verify/parse + `webhookPath`/`rawBody`), el router se registra desde el adaptador y el ingestor común persiste/ratelimita/reconcilia statuses. Deuda restante: (a) el nombre `wamid` se conserva como identificador externo genérico; (b) falta estrategia de migración no concurrente para tablas calientes; (c) Telegram acepta metadata de media (foto/documento/audio/video) pero no descarga ni procesa contenido; (d) el webhook de on-call es opcional y sin reintentos/cola; falta integración específica por proveedor. Ningún servicio nuevo puede importar Meta directamente.

---

## 📡 3. Contrato de Adaptador de Canal (obligatorio)

Todo canal nuevo (Telegram, Instagram, TikTok, webchat, etc.) **DEBE** implementar y documentar:

1. **`verifyInbound(request)`** — autenticidad criptográfica o token del proveedor; rechazo explícito con código HTTP correcto.
2. **`parseInbound(payload)`** — traducción al sobre normalizado:
   - `channel`, `external_message_id`, `external_account_id`, `sender_id`, `occurred_at`, `type`, `text`/media, referencia al payload crudo.
3. **Persistencia durable antes del ACK** — el adaptador entrega el sobre normalizado y el ingestor común (`inboundIngestor`) persiste con unicidad `(channel, external_message_id)`, rate limit y auditoría C5. El adaptador no toca la base.
4. **`sendOutbound(message)`** — envío idempotente por `(channel, outbox_id | external_message_id)`, con mapeo de errores del proveedor a la taxonomía común implementada: `SYSTEMIC_AUTH`, `RATE_LIMIT`, `TRANSIENT`, `FATAL`, `NETWORK`. El controller traduce la autenticidad a 401/503 y los fallos de persistencia a 500.
5. **`parseInbound` devuelve `statuses` normalizados** — `sent`/`delivered`/`read`/`failed`; el ingestor aplica reconciliación monótona y piso mínimo.
6. **Declaración de límites** — ventana de ACK, rate limits, tamaño máximo de payload, tipos de mensaje soportados y requisitos de aprobación del proveedor.
7. **Pruebas de conformidad** — firma inválida rechazada, duplicado sin reejecución, ACK tras persistencia, fallo de envío reintentable, aislamiento multi-tenant y mapeo de estados.

**Criterio de aceptación:** el resto del sistema (harness, FSM, guardrails, repositorios, outbox) no se modifica al agregar el canal.

---

## 🔌 4. Anexo: Reglas específicas por canal

> Estas reglas **solo** aplican al adaptador del canal correspondiente. Ninguna debe filtrarse al núcleo.

### 4.1 Meta / WhatsApp (vigente)
- Verificación HMAC SHA-256 de `x-hub-signature-256` sobre el cuerpo crudo.
- Deduplicación por `wamid` con índice único y fast-path en memoria.
- ACK `200 OK` tras persistir en `inbound_events`, dentro de la ventana de 20s (objetivo <200ms).
- Despacho vía Graph API con reconciliación monótona `sent` → `delivered` → `read` y piso mínimo `sent`.
- Respetar ventana de servicio, plantillas y políticas de Meta; un rechazo de política es fallo terminal, no transitorio.
- Tokens y App Secret exclusivamente por entorno.

### 4.2 Telegram (vigente, MVP texto)
- Validar `X-Telegram-Bot-Api-Secret-Token` en cada webhook.
- Deduplicar por `update_id`; responder al webhook con `200` inmediato tras persistir.
- Respetar `429` y `retry_after` del proveedor; mapear a `TRANSIENT_RATE_LIMIT`.
- `message_id` saliente como identificador externo para estados.

### 4.3 Instagram DM (al implementarse)
- Webhook firmado por Meta; permisos y revisión de app según políticas vigentes.
- Deduplicar por `mid`; mapear errores de ventana de mensajería a fallo terminal.
- No compartir credenciales ni lógica con el adaptador de WhatsApp: son adaptadores distintos.

### 4.4 TikTok (al implementarse)
- Verificar firma/token según la API vigente y su disponibilidad regional.
- Deduplicar por el identificador de mensaje del proveedor.
- Documentar restricciones de aprobación y límites de mensajería antes de prometer el canal.

### 4.5 Webchat / API propia (al implementarse)
- Autenticación por API key/JWT y `Idempotency-Key` obligatorio.
- Sin dependencia de Meta: el adaptador define su ventana de ACK y sus límites.
- Reutiliza el mismo pipeline durable, outbox y reglas de negocio.

---

## 🧠 5. LLM Agnóstico (obligatorio)

- Prohibido hardcodear proveedor o modelo. La configuración se resuelve con `LLM_BASE_URL`, `LLM_MODEL` y `LLM_API_KEY`.
- Las tools se declaran en JSON Schema estándar (function calling compatible con Chat Completions).
- La clasificación de errores del proveedor es genérica (HTTP status + mensaje), sin tipos de SDK propietario.
- Los tests mockean la red; ninguna suite puede depender de una API real de LLM.

---

## ⚡ 6. Quality Gate Obligatorio

Antes de dar por concluida cualquier tarea o proponer un commit:

```bash
npm run quality-gate
```

Si reporta fallos, la tarea NO está completa. Corrige la causa raíz hasta obtener 100% de verificaciones superadas. Todo adaptador nuevo debe añadir sus pruebas de conformidad a la suite.

---

## 🗺️ 7. Ruta de Desacoplamiento Multicanal (obligatoria antes del segundo canal)

1. Crear `src/providers/channels/channelTypes.ts` con el sobre normalizado, `ChannelAdapter`, `ChannelSender` y la taxonomía común de errores/estados.
2. Crear `ChannelRegistry` que resuelva el adaptador por `channel` (sin `if` en el núcleo).
3. Mover la lógica de Meta a `src/providers/channels/meta/` (parseo, firma, envío, estados).
4. Migrar `OutboxDispatcher` a `ChannelSender`; eliminar el import directo de `whatsappClient`.
5. Agregar la columna `channel` a `inbound_events` y `outbox_messages` mediante migración, con default `whatsapp` para compatibilidad.
6. Implementar el primer canal no-Meta (recomendado: Telegram) y demostrar que el harness no cambia.
7. Añadir pruebas de conformidad por adaptador al Quality Gate.
