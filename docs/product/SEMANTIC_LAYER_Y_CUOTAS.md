# 🧠 Capa semántica, alcance y cuotas

> Cómo evitar que el bot se “bugee” cuando no encuentra un dato, cómo impedir que salga del nicho y cómo cortar conversaciones que queman tokens.

---

## 1. Catálogo semántico

`JsonCatalogProvider` ahora acepta configuración del pack:

```json
{
  "search": {
    "synonyms": {
      "camioneta": ["pickup", "suv"],
      "carro": ["suv", "sedan"],
      "automática": ["automatic"],
      "usado": ["used"]
    },
    "minScore": 0.35
  }
}
```

Devuelve:

| Campo | Uso |
| :--- | :--- |
| `found` | Si hay evidencia suficiente para responder |
| `confidence` | Score del mejor match (0–1) |
| `items` | Resultados solo si `found=true` |
| `alternatives` | Candidatos cercanos cuando no hay match |
| `total` | Total de candidatos |

Incluye sinónimos, cobertura de tokens y fuzzy matching para typos (`RAV-4` → `RAV4`). No es un embedding; es la primera capa barata y determinista. Si el catálogo crece, se reemplaza por búsqueda híbrida con vectores.

---

## 2. Fallback ladder

El agente debe decidir, no improvisar:

1. **Evidencia suficiente** → responde solo con los datos del tool.
2. **Falta un dato** → una pregunta de aclaración.
3. **Sin match** → ofrece alternativas o pregunta.
4. **Dos intentos sin evidencia** → handoff.
5. **Tema fuera del nicho** → redirección de alcance.
6. **Cuota agotada** → cierre y handoff sin LLM.

La regla: el guardrail no es la respuesta; es el cinturón.

---

## 3. Guardrail de alcance

`guardrails.checkScope(mensaje, negocio, rubro)` bloquea temas ajenos al negocio antes de llamar al LLM:

- salud/recetas,
- legal/demandas,
- política,
- programación,
- tareas/poemas,
- religión/horóscopo.

Respuesta:

> “Solo puedo ayudarte con consultas de Automotriz Demo (automotive): productos, precios, disponibilidad, citas y atención…”

Es una red determinista; el prompt también incluye la regla 11 de alcance. No pretende ser un clasificador semántico perfecto.

---

## 4. Cuota por conversación

| Variable | Default | Efecto |
| :--- | :--- | :--- |
| `MAX_CONVERSATION_TURNS` | 40 | Al alcanzar 40 mensajes inbound (turnos), se escala |
| `MAX_CONVERSATION_TOKENS` | 100000 | Techo de tokens por conversación; se escala al alcanzarlo |

`ConversationQuotaService` cuenta mensajes **inbound** y toma el **máximo** entre tokens del historial y tokens del outbox (incluye turnos pendientes), antes de llamar al LLM. Si la cuota se agotó:

- no se llama al LLM (0 tokens),
- se crea un handoff `SYSTEM_DELAY`,
- se envía un mensaje de cierre,
- la conversación queda en `HUMAN_ESCALATION`.

Si la consulta de cuota falla, se permite el turno y se registra el error: la protección no debe tumbar ventas.

---

## 5. Límites

- La semántica es léxica (sinónimos + fuzzy), no comprensión profunda.
- La cuota es por conversación, no por usuario/canal global. 100k es un techo de costo, no una promesa de conversación infinita.
- El guardrail de alcance puede tener falsos positivos; se ajusta por pack.
- No hay aún RAG de documentos ni verificación semántica de cada afirmación.
- Falta un eval con paráfrasis reales y conversaciones del piloto.
