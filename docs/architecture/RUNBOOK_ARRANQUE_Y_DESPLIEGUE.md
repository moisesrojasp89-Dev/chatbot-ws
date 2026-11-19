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
npm run migrate           # aplica 001 → 015
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

- Migraciones: **001 → 015**.
- La **015** cambia `UNIQUE(wamid)` por `UNIQUE(channel, wamid)` en `inbound_events`.

### Verificar en SQL

```sql
SELECT count(*) FROM public.migrations_history;  -- debe dar 15
SELECT conname FROM pg_constraint
WHERE conrelid = 'public.inbound_events'::regclass
  AND contype = 'u';
-- Debe incluir uq_inbound_events_channel_wamid
```

### ⚠️ Orden obligatorio en despliegue (single-VPS)

```bash
sudo systemctl stop chatbot-ws
npm run migrate
npm run build
sudo systemctl start chatbot-ws
```

**No hagas rolling deploy de la 015:** el código viejo usa `ON CONFLICT (wamid)` y, tras eliminar esa constraint, fallaría con `42P10`. El código nuevo también falla con `42P10` si arranca **antes** de aplicar la 015.

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
- [ ] `SELECT count(*) FROM migrations_history` → `15`.
- [ ] Webhook de Meta verificado (`GET /webhook` challenge).
- [ ] Webhook de Telegram registrado (`getWebhookInfo`).
- [ ] Un mensaje de prueba entra, se persiste y responde por el mismo canal.
- [ ] Logs sin tokens ni PII.

---

## 7. Troubleshooting

| Síntoma | Causa probable | Acción |
| :--- | :--- | :--- |
| `42P10` en inbound | Migración 015 no aplicada o código viejo tras migrar | `stop → npm run migrate → start` |
| `Canal habilitado sin adaptador` al arrancar | `CHANNELS_ENABLED` incluye un canal no implementado | Corregir la lista o implementar el adaptador |
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

---

## 9. Seguridad operativa

- `.env` nunca se commitea (está en `.gitignore`).
- Los tokens no se imprimen en logs; si rotas uno, actualiza `.env` y reinicia.
- El proyecto de pruebas y el de producción deben ser Supabase distintos.
- Antes de desplegar: `npm run quality-gate` debe estar 4/4.
