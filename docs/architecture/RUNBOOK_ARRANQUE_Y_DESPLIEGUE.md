# 🚀 Runbook de Arranque y Despliegue — Chatbot WS

> **Vigente:** 2026-11-19 · **Alcance:** arranque local, despliegue single-VPS (systemd) y verificación post-deploy.
> Este documento reemplaza como referencia operativa al informe histórico de despliegue WhatsApp/Meta.

---

## 1. Prerrequisitos

- Node.js **≥ 20**
- PostgreSQL **≥ 15** (Supabase o instancia propia)
- Un proveedor LLM con API **compatible con Chat Completions** (OpenAI, Groq, OpenRouter, DeepSeek, vLLM, Ollama…)
- Canal de mensajería:
  - **WhatsApp Cloud API** (Meta): app, token, App Secret y verify token.
  - **Telegram** (opcional): bot token y secret token de webhook.
- Dominio público con HTTPS para los webhooks (Cloudflare Tunnel o proxy equivalente).

---

## 2. Variables de entorno

Copia `.env.example` a `.env` y completa:

### Obligatorias

| Variable | Ejemplo | Nota |
| :--- | :--- | :--- |
| `DATABASE_URL` | `postgresql://postgres.[REF]:[DB-PASSWORD]@aws-1-...pooler.supabase.com:5432/postgres` | **Session Pooler (5432)**; el 6543 no garantiza estado de sesión para `pg_advisory_lock` |
| `TEST_PROJECT_REF` | `<REF>` | Ref del proyecto Supabase de pruebas; el guard lo exige |
| `LLM_API_KEY` | `sk-...` | Clave del proveedor LLM elegido |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | Endpoint compatible con Chat Completions |
| `LLM_MODEL` | `gpt-4o-mini` | Modelo con soporte de function calling |
| `CHANNELS_ENABLED` | `whatsapp` o `whatsapp,telegram` | Canales activos; cada uno exige su configuración |
| `BUSINESS_PACK_PATH` | `packs/automotive/pack.json` | Opcional: perfil/catálogo/prompt del negocio |
| `BACKLOG_ALERT_THRESHOLD` | `100` | Desde este umbral el log `CHANNEL_BACKLOG` pasa de `warn` a `error` |
| `MEDIA_STORAGE_ENABLED` | `true` | Descarga/almacena media en el dispatcher |
| `MEDIA_STORAGE_DIR` | `./media` | Directorio local; debe estar fuera de git |
| `MEDIA_MAX_BYTES` | `10485760` | Límite duro por archivo |
| `MEDIA_RETENTION_DAYS` | `7` | Purga de binarios por antigüedad |
| `ALERT_WEBHOOK_URL` | `https://hooks.slack.com/...` | Opcional: recibe transiciones `CHANNEL_BACKLOG` por POST HTTPS; sin redirects, timeout 5s |

### Por canal

| Canal | Variables |
| :--- | :--- |
| WhatsApp/Meta | `META_ACCESS_TOKEN`, `META_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN` (y `META_PHONE_NUMBER_ID`) |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` |

> Si `CHANNELS_ENABLED` no incluye `whatsapp`, las credenciales `META_*` pueden omitirse. Lo mismo aplica a Telegram.

---

## 3. Arranque local

```bash
npm ci
cp .env.example .env      # completar variables
npm run migrate           # aplica 001 → 018
npm run build
npm test
npm run quality-gate
npm start                 # o npm run dev
```

Verificación:

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/ready
```

---

## 4. Base de datos y migraciones

### Estado actual

- Migraciones: **001 → 018**.
- La **015** cambia `UNIQUE(wamid)` por `UNIQUE(channel, wamid)` en `inbound_events`.
- La **016** backfillea payloads inbound legados al sobre normalizado. Requiere la misma ventana que la 015: `stop → migrate → start`.
- La **017** agrega `recipient_id` y lo backfillea con `sender_phone`. Permite responder al chat del grupo sin perder la identidad del remitente.
- La **018** agrega chat_id a conversations y lo backfillea con el teléfono del contacto: FSM, contexto y handoff quedan aislados por chat.

### Verificar en SQL

```sql
SELECT count(*) FROM public.migrations_history;  -- debe dar 18
SELECT conname FROM pg_constraint
WHERE conrelid = 'public.inbound_events'::regclass
  AND contype = 'u';
-- Debe incluir uq_inbound_events_channel_wamid
```

### ✅ Ensayo desde cero (verificado 2026-11-19)

En una base descartable del proyecto de pruebas se validó:

- `npm run migrate` aplicó **001 → 018** (18/18) en una base vacía.
- Una fila legada con shape Meta se backfilleó correctamente: `text`, `type`, `senderName`, `occurredAt` en UTC y `raw` = mensaje original; segunda pasada idempotente (0 filas).
- `assertSchemaReady`, `GET /health` y `GET /ready` respondieron OK contra esa base.
- La base descartable se eliminó al finalizar.

### ⚠️ Orden obligatorio en despliegue (single-VPS)

```bash
sudo systemctl stop chatbot-ws
npm run migrate
npm run build
sudo systemctl start chatbot-ws
```

**No hagas rolling deploy de la 015 ni de la 016:** el código viejo usa `ON CONFLICT (wamid)` y, tras eliminar esa constraint, fallaría con `42P10`. El código nuevo falla con `42P10` si arranca **antes** de la 015, y leería sin texto las filas legadas si arranca antes de la 016. Aplica ambas con el servicio detenido.

> En systemd, configura Restart=on-failure y revisa journalctl -u chatbot-ws. Si el guard de esquema falla, el proceso aborta con exit 1 y no acepta webhooks.

### Entornos nuevos

`npm run migrate` aplica todo el historial. No hay que ejecutar SQL a mano.

---

## 5. Webhooks

### WhatsApp/Meta

- URL: `https://<dominio>/webhook`
- Verificación: `hub.verify_token` = `WEBHOOK_VERIFY_TOKEN`
- Firma: HMAC SHA-256 (`X-Hub-Signature-256`) con `META_APP_SECRET`.

### Telegram

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<dominio>/webhook/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

El adaptador valida `X-Telegram-Bot-Api-Secret-Token` y responde `200` tras persistir el update.

---

## 6. Checklist post-deploy

- [ ] `GET /health` → `200` con `database: connected`.
- [ ] `GET /ready` → `200` con `status: ready`.
- [ ] `SELECT count(*) FROM migrations_history` → `18`.
- [ ] El arranque validó el esquema (migraciones 014-018, columnas `channel`/`recipient_id`/`chat_id` y unicidad por canal).
- [ ] Webhook de Meta verificado (`GET /webhook` challenge).
- [ ] Webhook de Telegram registrado (`getWebhookInfo`).
- [ ] Un mensaje de prueba entra, se persiste y responde por el mismo canal.
- [ ] Logs sin tokens ni PII.

### 6.1 Observabilidad de backlog

- `CHANNEL_BACKLOG` (warn/error) aparece cuando un canal deshabilitado, pausado o con breaker distinto de `CLOSED` tiene filas `PENDING`.
- El log incluye `channel`, `pending`, `threshold`, `enabled`, `paused` y `breakerState`; se deduplica por transición y emite `CHANNEL_BACKLOG_RESOLVED` cuando el backlog llega a 0.
- `GET /health` incluye `outbox: "ok" | "paused"` como dato informativo. **`/ready` no depende de la pausa del outbox**: sacar la instancia de rotación por un problema de egress provocaría un restart-loop que perdería webhooks que el inbound sí puede procesar.
- La pausa global del outbox es una operación interna (no hay endpoint público); la pausa por canal (error sistémico) se refleja en `CHANNEL_BACKLOG`.
- Si `ALERT_WEBHOOK_URL` está definido, cada transición (alerta o resolución) se POSTea; si el webhook falla, se reintenta en el siguiente ciclo (timeout 5s, sin backoff ni tope). Sin URL solo hay logs.

---

### 6.2 Grupos de Telegram

- El remitente (`senderId` = `from.id`) identifica el contacto; el destinatario (`recipientId` = `chat.id`) es a donde se responde.
- En privados ambos coinciden; en grupos el bot responde al grupo, no al usuario por separado. La conversación/FSM/handoff se aísla por `chat_id` (migración 018).
- La identidad del evento sigue siendo `tg:in:<update_id>` y la deduplicación no cambia.
- Media: el webhook solo persiste metadata (`type`, `media.fileId`, caption); el **dispatcher** descarga con `getFile`, valida tamaño y guarda el binario bajo `MEDIA_STORAGE_DIR/<canal>/<sha256>`. La ruta queda en `payload.media.storagePath`. El LLM recibe caption/nota, **no el binario**: falta visión/transcripción multimodal. Los binarios se purgan a los `MEDIA_RETENTION_DAYS` días por `RetentionService`.

---

## 7. Troubleshooting

| Síntoma | Causa probable | Acción |
| :--- | :--- | :--- |
| `42P10` en inbound | Migración 015 no aplicada o código viejo tras migrar | `stop → npm run migrate → start` |
| Arranque aborta con "Esquema incompatible" | Faltan migraciones 014/015, columnas `channel` o unicidad por canal | `stop → npm run migrate → start`; no rolling deploy |
| `Canal habilitado sin adaptador` al arrancar | `CHANNELS_ENABLED` incluye un canal no implementado | Corregir la lista o implementar el adaptador |
| `CHANNEL_BACKLOG` en logs | Canal deshabilitado, pausado o breaker no `CLOSED` con filas `PENDING` | Revisar `CHANNELS_ENABLED`, logs de pausa y estado del breaker; el inbound puede seguir sano |
| `Configuración de Meta/Telegram incompleta` | Faltan credenciales del canal habilitado | Completar `.env` |
| Webhook Telegram `401` | Secret token distinto al registrado | Repetir `setWebhook` con el secret correcto |
| `401` del LLM | Clave/base URL/modelo incorrectos | Validar `LLM_*` |
| Mensajes atascados en `PENDING` | Canal deshabilitado o breaker abierto | Revisar `CHANNELS_ENABLED` y logs del breaker |
| Outbound Telegram sin historial | Colisión de `message_id` entre chats | Ya mitigado con `tg:out:<chatId>:<messageId>` |

---

## 8. Rollback

1. Detener el servicio.
2. Restaurar el commit anterior.
3. Si hay que revertir la 015, recrear `UNIQUE(wamid)` **solo** después de detener el código nuevo:

```sql
ALTER TABLE public.inbound_events DROP CONSTRAINT IF EXISTS uq_inbound_events_channel_wamid;
ALTER TABLE public.inbound_events ADD CONSTRAINT inbound_events_wamid_key UNIQUE (wamid);
```

4. `npm run build` y arrancar.

La 016 es reversible con `UPDATE inbound_events SET payload = payload -> 'raw' WHERE payload ? 'raw' AND NOT (payload ? 'message');` (conserva el mensaje original, no contact/metadata).

---

## 9. Seguridad operativa

- `.env` nunca se commitea (está en `.gitignore`).
- Los tokens no se imprimen en logs; si rotas uno, actualiza `.env` y reinicia.
- El proyecto de pruebas y el de producción deben ser Supabase distintos.
- Antes de desplegar: `npm run quality-gate` debe estar 4/4.
