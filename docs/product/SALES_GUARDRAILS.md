# 🛡️ Guardrails de ventas — Chatbot WS

> Capa determinista que impide que el agente invente precios, prometa crédito, confirme disponibilidad/test drive sin datos o aplique descuentos no autorizados.

---

## 1. Capas del harness

| Capa | Dónde | Qué bloquea |
| :--- | :--- | :--- |
| **Nivel 1 — Pre-inferencia** | `guardrails.checkPreInference` | Jailbreak / prompt injection |
| **Nivel 3 — Grounding Lock** | `guardrails.checkGroundingLock` | Montos sin tool de catálogo |
| **Nivel 4 — Denylist** | `guardrails.checkPostInferenceDenylist` | Consejos médicos/legales, lenguaje impropio |
| **Ventas** | `checkSalesPolicy` | Crédito, disponibilidad, test drive, descuentos y precios fuera de catálogo |
| **Acción** | Tools | Test drive sin licencia, vehículo inexistente |
| **Prompt** | `MASTER_SYSTEM_PROMPT` | Reglas 8–10: crédito, test drive, descuentos/urgencia |

La respuesta del modelo nunca se envía tal cual: pasa por Grounding Lock, Denylist y Sales Policy.

---

## 2. Violaciones y respuestas seguras

| Código | Disparador | Respuesta segura |
| :--- | :--- | :--- |
| `UNVERIFIED_PRICE` | Monto sin catálogo o fuera de los precios permitidos | “Déjame verificar el precio exacto…” |
| `CREDIT_PROMISE` | “crédito aprobado”, “sin requisitos”, “100% garantizado” | “La aprobación la confirma un asesor…” |
| `UNVERIFIED_AVAILABILITY` | “disponible”, “en stock”, “última unidad” sin catálogo | “Déjame verificar disponibilidad…” |
| `UNCONFIRMED_TEST_DRIVE` | “test drive confirmado” sin lead/registro | “La cita se confirma cuando un asesor valide…” |
| `UNAUTHORIZED_DISCOUNT` | Descuento con monto/% sin catálogo | “Los descuentos los autoriza un asesor…” |

---

## 3. Escenarios de evaluación

Runner: `src/harness/salesScenarios.ts` — 10 casos S01–S10:

1. Precio exacto con catálogo → PASS.
2. Precio inventado con catálogo → `UNVERIFIED_PRICE`.
3. Precio sin catálogo → `UNVERIFIED_PRICE`.
4. Crédito aprobado → `CREDIT_PROMISE`.
5. Disponibilidad sin catálogo → `UNVERIFIED_AVAILABILITY`.
6. Test drive confirmado sin registro → `UNCONFIRMED_TEST_DRIVE`.
7. Descuento inventado → `UNAUTHORIZED_DISCOUNT`.
8. Solicitud de test drive sujeta a confirmación → PASS.
9. “Última unidad” sin catálogo → `UNVERIFIED_AVAILABILITY`.
10. “No está disponible” sin catálogo → PASS.

Ejecutar:

```bash
npx vitest run tests/salesGuardrails.test.ts
```

El test falla si un escenario deja de bloquear o si se bloquea un caso legítimo.

---

## 4. Reescritura acotada

Si Grounding, Denylist o Sales Policy bloquean la respuesta, el motor hace **un solo reintento** con el motivo del bloqueo y las tools ya ejecutadas. Si la reescritura vuelve a violar, se envía la respuesta segura. Nunca hay bucles de reescritura.

## 5. Integración con el motor

`agentEngine` ejecuta en orden:

1. Guardrail pre-inferencia.
2. ReAct con tools del pack.
3. Grounding Lock.
4. Denylist.
5. **Sales Policy** con precios permitidos del pack (`BUSINESS_PACK_PATH`) o del catálogo default.

Si una capa bloquea, se sustituye la respuesta por el mensaje seguro y se registra el código; el turno no se cae.

---

## 6. Límites

- Los guardrails son **regex + reglas deterministas**, no comprensión semántica; pueden producir falsos positivos/negativos.
- La verificación de precio exige que el monto sea exactamente un precio del catálogo; presupuestos o rangos del cliente pueden requerir revisión.
- No valida la verdad de datos externos ni disponibilidad en tiempo real si el catálogo está desactualizado.
- La evaluación es de guardrails, no de calidad conversacional; para eso falta un eval con LLM simulado/real y rúbricas.
