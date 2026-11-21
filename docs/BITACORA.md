# 🧭 Bitácora de Ingeniería — Chatbot WS

> **Propósito:** registro cronológico único de cambios, decisiones, evidencia de pruebas y deuda aceptada.
> **Regla:** toda Ola o cambio relevante se anota aquí con commit, verificación y veredicto adversarial. Las bitácoras por dominio (`docs/changelog/`) siguen existiendo para el detalle técnico.

---

## 2026-11-19 — Ola 2: multicanal, resiliencia y despliegue

| Commit | Cambio | Evidencia | Auditoría |
| :--- | :--- | :--- | :--- |
| `105ec76` | **Ola 0:** egress desacoplado de Meta con `ChannelSender` + `ChannelRegistry`. | Gate 4/4 | Adversarial: A0 con hallazgos H2/H4/H5/R1/R3 corregidos |
| `6a67f84` | **Ola 1:** Telegram ingress/egress, identidad `(channel, wamid)` y migración 015. | 155 tests | A1/A2 cerrados tras re-auditoría |
| `10a82e9` | Runbook de arranque/despliegue y corrección de docs legadas. | Gate 4/4 | — |
| `531df2a` | Breaker, pausa y claim aislados por canal; agrupación `channel:recipient`. | 161 tests | A1 (claim global) corregido; re-auditoría PASS |
| `c191bb1` | Schema guard fail-fast (014/015/016, columnas y unicidad). | 167 tests | PASS tras endurecer tests y semántica de BD caída |
| `b82e583` | **Ola 2:** `ChannelAdapter` verificado/parseado + sobre normalizado; migración 016. | 172 tests | Alto de despliegue (016 “en caliente”) y medios corregidos; PASS con reservas |
| `d33488c` | Ensayo de migración `001 → 016` desde cero documentado. | 172 tests / 4-4 gate | No aplica (solo docs) |
| `9337c5a` | **Ola 2.1:** contrato completo — registry de adapters, ingestor genérico, router/challenge declarados por el adaptador y tests solo-Telegram/no-leak/ingestor. | 179 tests | PASS con reservas; residuales documentales corregidos |
| `3b063f8` | **Ola 3A:** alertas `CHANNEL_BACKLOG` con dedupe, snapshot por canal y `/health` informativo; sin `/ready` para outbox. | 184 tests | PASS con reservas; residuales corregidos |
| `59d3708` | **Ola 3A.1:** entrega de transiciones `CHANNEL_BACKLOG` a webhook de on-call HTTPS, opcional, con reintento por ciclo. | 191 tests | PASS con reservas; residuales corregidos |
| `07bab68` | **Ola 3B:** grupos de Telegram con remitente `from.id` y destinatario `chat.id`; migración 017 `recipient_id` y coalescencia por chat. | 196 tests | PASS |
| c38dd4e | **Ola 3C:** conversaciones/FSM/handoff aislados por chat_id; migración 018. | 198 tests | PASS con reservas; residuales corregidos |
| c2f8763 | **Ola 3D:** media de Telegram normalizada (foto/documento/audio/video) con caption; sin descarga ni visión. | 201 tests | PASS con reservas; residuales corregidos |
| b7bfe15 | **Ola 3E:** pipeline real de media — descarga en dispatcher, límite de tamaño, almacenamiento por hash, ruta en payload y purga por retención. | 208 tests | PASS |
| — | **Ola 4A (docs):** Sales Readiness Audit y especificación del pack automotriz; sin cambios de código. | 208 tests | Pendiente de implementación |
| pendiente | **Ola 4A.1:** base de Sales Pack — perfil validado, catálogo JSON, ToolRegistry y pack automotriz seed. | 214 tests | Pendiente de cierre |

### Decisiones registradas

1. **LLM agnóstico:** se eliminó Gemini; todo pasa por `LLM_BASE_URL`, `LLM_MODEL` y `LLM_API_KEY` compatibles con Chat Completions.
2. **El canal es un adaptador:** el núcleo consume `ChannelSender` (egress) y `ChannelAdapter` (verify/parse, sobre normalizado).
3. **Identidad inbound:** `(channel, wamid)`; Telegram usa `tg:in:<update_id>` y `tg:out:<chatId>:<messageId>`.
4. **Router de webhooks:** cada adaptador declara `webhookPath`, `rawBody` y `verifyWebhookChallenge`; `app.ts` registra GET/POST sin ramas por canal.
5. **Ingesta común:** `inboundIngestor` persiste, aplica rate limit y reconcilia statuses; el adaptador no toca la base.
6. **Migraciones 015/016 requieren ventana:** `stop → npm run migrate → start`; no rolling deploy. El guard exige 014, 015 y 016.
7. **Resiliencia por canal:** breaker, pausa y claim filtrado evitan que un canal caído acapare el lote.
8. **Ensayo desde cero:** 001 → 016 aplicado en base descartable; fila legada backfilleada y `/health` + `/ready` verificados.

### Evidencia del ensayo de despliegue

- 16/16 migraciones desde base vacía.
- Fila legada Meta → `text`, `type`, `senderName`, `occurredAt` UTC y `raw` = mensaje original.
- Segunda pasada de 016 idempotente (0 filas).
- `assertSchemaReady`, `/health` y `/ready` OK.
- Base descartable eliminada.

### Deuda aceptada

| Tema | Estado |
| :--- | :--- |

| `wamid` como nombre legado | Aceptado |
| Visión/transcripción del binario por el LLM | Pendiente |
| Migración no concurrente en tablas calientes | Aceptado |
| Backoff/tope y cola para webhook de on-call | Pendiente |
| Índice parcial para conteo de backlog | Aceptado |
| Tests `buildApp()` solo-Telegram y no-leak | Pendiente |

---

## Cómo mantener esta bitácora

1. Añadir una fila por commit relevante con: hash, cambio, evidencia (tests/gate) y veredicto adversarial.
2. Si hay una decisión de arquitectura, registrarla en “Decisiones” con fecha.
3. Mover la deuda cerrada a “Deuda aceptada” solo si sigue viva; si se resolvió, eliminarla.
4. Enlazar el detalle técnico en `docs/changelog/<dominio>.md` cuando aplique.
