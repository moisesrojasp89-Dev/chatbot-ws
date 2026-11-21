# 🔍 Auditoría de cambios y norte del proyecto

> **Fecha:** 2026-11-21
> **Baseline:** `bd9d628` (commit inmediatamente anterior a la primera Ola)
> **HEAD:** `49e2876`
> **Pregunta:** ¿el proyecto sigue sólido y con norte, o solo acumulamos features?

---

## 1. Veredicto ejecutivo

**No se perdió el norte original. Se amplió el alcance.**

La base que recibí ya era sólida: 134 tests, documentación modular, arquitectura multicanal incipiente y separación de responsabilidades. Eso se conservó y se endureció.

Pero el proyecto pasó de “ordenar y desacoplar el bot existente” a “plantilla de bot de ventas con pack, guardrails, cuota, RAG y media saliente”. Ese segundo norte lo pediste tú después, no fue una deriva accidental. El riesgo real no es que el código sea malo: es que **hoy el proyecto es más ancho que profundo**. Hay mucha capacidad construida y poca validación con clientes reales.

**Conclusión honesta:** ~60% de lo agregado es infraestructura que sí vale; ~40% es capa de producto prometedora pero **no validada en un piloto**. No estamos “solo metiendo features”, pero sí estamos cerca de hacerlo si no frenamos y probamos.

---

## 2. Qué cambió, en números

| Métrica | Baseline | Ahora | Delta |
| :--- | ---: | ---: | ---: |
| Commits | — | 44 | 44 |
| Archivos tocados | — | 89 | +7.628 / −474 líneas |
| Archivos fuente | 50 | 79 | +29 |
| Archivos de test | 15 | 29 | +14 |
| Tests | 134 | 240 | +106 |
| Migraciones | 13 | 19 | +6 (014–019) |
| Documentación | — | +948 líneas | 12 archivos |
| Quality Gate | 4/4 | 4/4 | se mantiene |

### ¿Se perdió código?

Solo dos cambios estructurales:

- `src/controllers/webhookController.ts` fue reemplazado por `channelWebhookController.ts` + `telegramWebhookController.ts`.
- `src/providers/meta/whatsappClient.ts` se movió a `src/providers/channels/meta/`.

No se eliminó una capacidad de negocio; se reubicó y se generalizó.

---

## 3. Qué se conservó del norte original

| Principio | Estado |
| :--- | :--- |
| Documentación modular fuera de la raíz | ✅ |
| Canal como adaptador, no como producto | ✅ `ChannelAdapter`, `ChannelSender`, `ChannelRegistry` |
| Núcleo sin SDK de Meta | ✅ `outboxDispatcher` usa el contrato, no el cliente |
| LLM agnóstico | ✅ `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` |
| Idempotencia y deduplicación | ✅ inbound durable, outbox, fences |
| Calidad determinista | ✅ 240 tests, gate 4/4 |
| Cero secretos en código | ✅ escaneo Zero-Trust |

Eso no se rompió. Al contrario: las Olas 0–3 son la parte más sólida del trabajo.

---

## 4. Dónde sí se desvió el norte: los monolitos

El objetivo original incluía **acabar con los monolitos**. Aquí hay una regresión medible:

| Archivo | Baseline | Ahora | Delta |
| :--- | ---: | ---: | ---: |
| `src/services/outboxDispatcher.ts` | 431 | 675 | **+56,6%** |
| `src/harness/agentEngine.ts` | 224 | 346 | **+54,5%** |
| `src/services/inboundDispatcher.ts` | 729 | 799 | **+9,6%** |
| `src/harness/contextManager.ts` | 124 | 152 | **+22,6%** |

Se crearon 29 módulos nuevos y se separaron adaptadores, pero los dos orquestadores más grandes **crecieron**. Parte del crecimiento es funcionalidad legítima (breaker por canal, alertas, cuota, media, reescritura), pero el resultado neto es que el problema de monolitos **no se resolvió; se aplazó**.

Esto es lo que más se aleja del norte original.

---

## 5. Qué se agregó y para qué

### Olas 0–3E — infraestructura (alto valor)

- Egress desacoplado de Meta.
- Telegram ingress/egress, grupos, identidad `(channel, wamid)`.
- Inbound durable, outbox transaccional, fencing, breaker por canal.
- Schema guard fail-fast y migraciones 014–019.
- Media entrante, almacenamiento, retención.
- Alertas de backlog, on-call, aislamiento por chat.
- Runbook y ensayo de migración desde cero.

**Valor:** reduce riesgo operativo real. Es la base que permite vender sin caídas silenciosas.

### Olas 4A — producto de ventas (valor medio, no validado)

- Pack configurable: perfil, catálogo, tools, prompt.
- 6 tools automotrices.
- Guardrails de precio, crédito, disponibilidad, test drive y descuento.
- Cuota anti-bucle por conversación.
- Catálogo semántico, RAG léxico y embeddings opcionales.
- Media saliente por URL.

**Valor:** convierte la infraestructura en una plantilla de ventas. Pero **nadie lo ha usado todavía con un cliente real**, un catálogo real y un número real. Los tests prueban comportamiento, no demanda.

---

## 6. ¿Es una pila de features?

Parcialmente. La clasificación honesta:

| Capa | Veredicto |
| :--- | :--- |
| Canales, outbox, inbound, schema guard, retención | **Construir y mantener** |
| Pack, catálogo, tools, guardrails, cuota | **Validar con piloto** |
| Media saliente por URL | **Validar; falta hosting propio** |
| Embeddings opcionales y RAG vectorial | **Pausar hasta que el piloto lo justifique** |
| Más canales (Instagram/TikTok), agent kernel, multi-tenant | **No ahora** |

El RAG vectorial para 5 documentos es arquitectónicamente correcto pero **prematuro**. El catálogo semántico y los guardrails sí tienen impacto directo en la conversación.

---

## 7. Lo que aún no demuestra valor real

- No hay conversación con un cliente real.
- No hay catálogo cargado por un negocio.
- No hay envío real de media a Meta/Telegram (tests con mocks).
- No hay panel de onboarding; el pack es JSON manual.
- No hay load test, RLS multi-tenant ni despliegue productivo.
- La suite tuvo flakiness de BD en corridas completas.

**Traducción:** hoy tienes una **plantilla técnicamente prometedora**, no un producto validado.

---

## 8. Qué haría ahora (freno de features)

1. **Refactor de monolitos** (2–3 días):
   - sacar de `outboxDispatcher` alertas/backlog y envío;
   - sacar de `agentEngine` verificación/reescritura y ejecución de tools;
   - sacar de `inboundDispatcher` cuota/media.
2. **Piloto automotriz real** (1–2 semanas):
   - catálogo real, imágenes reales, número de prueba;
   - medir: primera respuesta, lead calificado, test drive, handoff, contención.
3. **Load/RLS** antes de prometer producción.
4. **Solo después**: embeddings, más canales o agent kernel.

## 9. Criterio para saber si hay valor real

El piloto debe demostrar:

- ≥90% de consultas de stock/precio resueltas sin inventar.
- ≥1 test drive agendado por cada 20 conversaciones.
- Handoff correcto con contexto.
- Respuesta <5s.
- Coste por conversación dentro del presupuesto.

Si eso no pasa, no importa cuántas features tenga: el producto no está listo.

---

## 10. Dictamen final

**El proyecto sigue sólido y el norte original se conservó.** Lo que cambió fue el alcance: de “ordenar el bot” a “plantilla de ventas”. Esa ampliación fue pedida y tiene sentido comercial, pero hoy está **más ancha que profunda**.

La deuda principal no es de código: es de **validación**. Y la deuda técnica principal sí es concreta: **los monolitos crecieron**, justo lo que queríamos evitar.

Mi recomendación: **congelar features nuevas**, refactorizar los tres orquestadores y hacer el piloto. Si el piloto funciona, las features tendrán sentido. Si no, habremos construido una plataforma muy ordenada para un problema que nadie compró.
