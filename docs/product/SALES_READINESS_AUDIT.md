# 🔎 Sales Readiness Audit — Chatbot WS como bot de ventas

> **Fecha:** 2026-11-21 · **Alcance:** evaluar qué tan listo está el repositorio para ser una **plantilla de bot de ventas y atención** clonable por negocio/rubro.
> **Decisión de producto:** este repo se enfoca en ventas/atención. El *agent kernel* universal de acciones se trabajará en otro proyecto, extrayendo contratos y patrones de este.

---

## 1. Resumen ejecutivo

La **infraestructura** está lista para producción: canales, inbound durable, outbox, idempotencia, media, handoff, schema guard, alertas y runbook.

El **cerebro comercial** no lo está: hoy es una demo que vende los planes de Chatbot WS. El catálogo, el prompt, el flujo FSM y las tools están sesgados a esa oferta y a WhatsApp. Para convertirlo en una plantilla de ventas clonable hay que **separar el pack comercial del núcleo**.

**Veredicto:** base técnica apta; producto comercial requiere un **Sales Pack configurable** antes de un piloto real.

**Estado 4A.1/4A.2:** `BusinessProfile`, `CatalogProvider`, `ToolRegistry` y el pack automotriz están cableados al motor (`BUSINESS_PACK_PATH`). Las 6 tools del pack están implementadas y los guardrails de ventas tienen 10 escenarios deterministas; falta media saliente y piloto.

---

## 2. Inventario actual

| Capacidad | Estado | Evidencia |
| :--- | :--- | :--- |
| WhatsApp ingress/egress texto | ✅ | `metaChannelSender`, `webhook` |
| Telegram texto/privados/grupos | ✅ | `telegramChannelSender` |
| Media entrante + descarga/storage | ✅ | `mediaStorage`, `NormalizedMedia` |
| Outbox durable + breaker por canal | ✅ | `outboxDispatcher` |
| Inbound durable + coalescencia | ✅ | `inboundDispatcher`, `inboundRepository` |
| Catálogo | ⚠️ hardcodeado a planes Chatbot WS | `catalogTools.ts` → `OFFICIAL_CATALOG` |
| Prompt de ventas | ⚠️ hardcodeado, dice “WhatsApp” | `contextManager.ts` → `MASTER_SYSTEM_PROMPT` |
| Tools | ⚠️ 3 tools fijas en un `switch` | `agentEngine.ts:132-199` |
| FSM | ⚠️ estados de venta fijos | `states.ts`, CHECK en migración 001 |
| Lead | ✅ tabla genérica con `extracted_data` | migración 001 |
| Handoff | ✅ por conversación | `handoffTools`, `handoff_sessions` |
| Media saliente (fotos/PDF) | ❌ | `ChannelSender` solo `sendText`/`sendTyping` |
| Plantillas WhatsApp fuera de 24h | ❌ | sin implementación |
| Panel/admin de negocio | ❌ | configuración por `.env`/código |
| Analítica de conversión | ❌ | sin endpoints/reportes |
| Evaluación de calidad | ❌ | tests técnicos, no de venta |
| Portugués | ⚠️ no evaluado | prompts en español |

---

## 3. Hallazgos

### F1 — El catálogo es la oferta de Chatbot WS, no un catálogo de negocio
`catalogTools.ts` contiene `Plan Starter`, `Plan Pro`, `Plan Enterprise` y `Setup VIP` en código. Cualquier clon vendería lo mismo salvo que se edite el archivo.

**Impacto:** bloqueante para clonar. **Fix:** proveedor de catálogo configurable (DB/JSON del pack) + interfaz `CatalogProvider`.

### F2 — El prompt está acoplado a WhatsApp y a la oferta
`MASTER_SYSTEM_PROMPT` dice “Asistente … de Ventas en WhatsApp”, exige email/ciudad y grounding contra `searchProductCatalog`. En Telegram y en otros rubros queda fuera de contexto.

**Impacto:** alto. **Fix:** prompt base + variables del pack (empresa, tono, canal, oferta, reglas).

### F3 — La FSM es de ventas y está en el esquema
Estados `QUALIFYING`, `CATALOG_QUERY`, `BOOKING`, `CLOSING` y el CHECK de la migración 001. Sirven para ventas, pero no para soporte, reservas o trámites sin tocar código.

**Impacto:** medio. **Fix:** conservar la FSM de ventas como *default pack*; a futuro, workflows configurables. No migrar todavía.

### F4 — Las tools están hardcodeadas en el motor
`agentEngine` hace `if/else` por `searchProductCatalog`, `createQualifiedLead`, `requestHumanHandoff`. Agregar una tool de pack obliga a editar el motor.

**Impacto:** alto para plantilla. **Fix:** `ToolRegistry` con contrato y registro por pack.

### F5 — Lead genérico, pero calificación fija
`leads` tiene `product_interest`, `estimated_budget`, `qualification_stage`, `extracted_data`. Es reutilizable, pero los campos que el prompt exige (email/ciudad) son fijos.

**Impacto:** medio. **Fix:** campos de calificación declarados por pack, persistidos en `extracted_data`.

### F6 — Sin media saliente
El bot puede recibir fotos, pero no enviar catálogo, ficha o PDF. Para ventas es una limitación visible.

**Impacto:** alto comercial. **Fix:** `sendMedia` en `ChannelSender` + adaptadores Meta/Telegram.

### F7 — Sin plantillas WhatsApp fuera de la ventana de 24h
No hay envío de plantillas aprobadas ni follow-up proactivo. En WhatsApp real, el bot se queda mudo fuera de la ventana.

**Impacto:** alto comercial. **Fix:** plantillas por pack, programación y consentimiento.

### F8 — Sin onboarding ni panel
El negocio no puede cargar su catálogo, horarios o políticas sin editar código.

**Impacto:** alto para clonar. **Fix:** `BusinessProfile` + catálogo en DB + endpoints/admin mínimo.

### F9 — Sin evaluación de calidad comercial
Los 208 tests validan infraestructura, no si el bot vende bien, objeta, cotiza o deriva correctamente.

**Impacto:** alto. **Fix:** escenarios de evaluación por pack con resultados medibles.

### F10 — Sin analítica
No hay leads por etapa, conversión, motivos de handoff ni tiempos.

**Impacto:** medio. **Fix:** endpoints/reportes mínimos.

### F11 — Portugués no evaluado
LATAM incluye Brasil. El prompt actual es español.

**Impacto:** medio. **Fix:** idioma por pack/negocio y escenarios en pt-BR.

### F12 — Formato de canal hardcodeado
El prompt pide formato WhatsApp (`*negritas*`) incluso en Telegram.

**Impacto:** bajo. **Fix:** capacidades de formato por adaptador.

---

## 4. Qué se reutiliza tal cual

- Canales y adaptadores.
- Inbound durable, outbox, fencing, reintentos.
- Media entrante + storage + retención.
- Handoff por conversación y ledger.
- Lead table y `extracted_data`.
- Schema guard, health, alertas, runbook, bitácora.

## 5. Qué debe ser parte del pack

| Elemento | Forma |
| :--- | :--- |
| Perfil de negocio | nombre, tono, horarios, zonas, políticas |
| Catálogo | items, precios, stock, atributos, imágenes |
| Prompt comercial | persona, reglas, objeciones, idioma |
| Tools | declaración y handler por pack |
| Calificación | campos y criterios |
| Flujos | etapas/estados y transiciones |
| Plantillas | mensajes proactivos/fuera de ventana |
| Evaluaciones | escenarios y métricas |

---

## 6. Arquitectura mínima propuesta

```text
src/
  core/
    businessProfile.ts     # perfil y configuración
    catalogProvider.ts     # interfaz + implementación DB/JSON
    toolRegistry.ts        # tools declaradas por pack
    salesPrompt.ts         # prompt base + variables
  packs/
    automotive/
      pack.ts              # perfil, catálogo seed, tools, prompt, flujos
```

Sin reescribir la FSM en esta fase. El pack declara sus etapas sobre los estados existentes.

---

## 7. Criterios de aceptación “sales ready”

- [ ] Un negocio puede cargar su catálogo sin editar código.
- [ ] El prompt se arma desde el pack y el canal.
- [ ] Una tool nueva se registra sin tocar `agentEngine`.
- [ ] Se envía al menos una imagen/PDF de catálogo.
- [ ] Hay follow-up fuera de la ventana de 24h (plantilla).
- [ ] Existen 10 escenarios de evaluación de venta.
- [ ] Hay métricas de lead, handoff y conversión.
- [ ] Un clon para otro rubro solo cambia `packs/<rubro>`.

---

## 8. Roadmap

1. **4A — Sales Pack configurable:** perfil, catálogo, prompt, tool registry, calificación.
2. **4B — Calidad:** escenarios de evaluación y ajuste de conversación.
3. **4C — Media saliente:** fotos/PDF de catálogo.
4. **4D — Follow-up y plantillas WhatsApp.**
5. **4E — Panel/analítica mínima y onboarding de clonación.**

El piloto es **automotriz multimarca**, definido en [`AUTOMOTIVE_PACK_SPEC.md`](../packs/AUTOMOTIVE_PACK_SPEC.md), sin condicionar el núcleo.
