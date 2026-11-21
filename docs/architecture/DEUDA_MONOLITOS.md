# 🧱 Deuda de monolitos y plan de reducción

> Los caps viven en `architecture-baseline.json`. **Solo pueden bajar.**
> La regla está en [`ARCHITECTURE.md`](../../ARCHITECTURE.md) y la valida `checkArchitecture.ts` dentro del Quality Gate.

## Estado actual

| Archivo | Cap actual | Objetivo | Responsabilidad a extraer |
| :--- | ---: | ---: | :--- |
| `src/services/inboundDispatcher.ts` | 885 | 400 | orquestación de lote, stale/terminal failure |
| `src/repositories/inboundRepository.ts` | 637 | 400 | claim/leases vs. estados |
| `src/services/outboxDispatcher.ts` | 626 | 400 | `dispatchSingleMessage` → delivery service |
| `src/providers/llm/llmClient.ts` | 562 | 400 | declaraciones de tools y transporte |

## Progreso

- `outboxDispatcher`: 675 → **626** extrayendo `OutboxBacklogMonitor`.
- Se creó el checker y el ratchet; ningún archivo nuevo puede superar 400.

## Orden de reducción

1. **outboxDispatcher** (menor riesgo):
   - extraer `dispatchSingleMessage` a `outboxDelivery.ts` con breaker, fencing y persistencia;
   - dejar el dispatcher como loop + lifecycle.
2. **inboundDispatcher**:
   - extraer `handleStaleCoalescedBatch` y `handleTerminalInboundFailure`;
   - extraer la transacción del turno a `inboundTurnService`.
3. **inboundRepository**:
   - separar claim/lease (`inboundClaimRepository`) de estados/terminal.
4. **llmClient**:
   - mover `OFFICIAL_TOOLS` y el payload a `llmTools.ts`.

Cada extracción debe bajar el cap en el mismo commit.
