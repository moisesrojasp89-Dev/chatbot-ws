# 🧾 Paquete de Auditoría — Fase 5B (Inbound Durable & RLS/PII)

> **Propósito:** conservar los entregables Word y el diff que se entregaron al auditor externo para la certificación de la Fase 5B, junto con el generador reproducible de esos documentos.

---

## 📑 Entregables

| Archivo | Contenido | Fuente embebida |
| :--- | :--- | :--- |
| [**`AUDITORIA_5B_PARTE_1_DISPATCHER_Y_REPOSITORY.docx`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/auditorias_fase_5b/AUDITORIA_5B_PARTE_1_DISPATCHER_Y_REPOSITORY.docx) | Inbound Pipeline y resiliencia | `src/repositories/inboundRepository.ts`, `src/services/inboundDispatcher.ts` |
| [**`AUDITORIA_5B_PARTE_2_WEBHOOK_SERVER_Y_LLM.docx`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/auditorias_fase_5b/AUDITORIA_5B_PARTE_2_WEBHOOK_SERVER_Y_LLM.docx) | Ingesta Webhook, apagado coordinado y cliente LLM | `src/controllers/webhookController.ts`, `src/server.ts`, `src/providers/llm/geminiClient.ts` |
| [**`AUDITORIA_5B_PARTE_3_MIGRACIONES_Y_LOGGER.docx`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/auditorias_fase_5b/AUDITORIA_5B_PARTE_3_MIGRACIONES_Y_LOGGER.docx) | Migraciones y sanitización forense de logs | Migraciones `007`–`010`, `src/utils/logger.ts` |
| [**`AUDITORIA_5B_PARTE_4_TESTS_MUTACION_ROLLBACK_RLS.docx`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/auditorias_fase_5b/AUDITORIA_5B_PARTE_4_TESTS_MUTACION_ROLLBACK_RLS.docx) | Suites de pruebas automatizadas | `tests/inbound.test.ts`, `tests/rlsAndLogger.test.ts` |
| [**`AUDITORIA_FASE_5B_COMPLETO.docx`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/auditorias_fase_5b/AUDITORIA_FASE_5B_COMPLETO.docx) | Expediente completo consolidado (12 bloques de código) | Las cuatro partes anteriores |
| [**`FASE_5B_DIFF_AUDITOR.txt`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/auditorias_fase_5b/FASE_5B_DIFF_AUDITOR.txt) | Diff íntegro de la Fase 5B entregado como evidencia | Repositorio (snapshot de certificación) |

> El contenido narrativo de la certificación (observaciones del auditor y su resolución) vive en [`EXPEDIENTE_CERTIFICACION_FASE_5B.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/EXPEDIENTE_CERTIFICACION_FASE_5B.md).

---

## 🔁 Regeneración

```bash
python scripts/tools/build_auditor_docx.py
```

- Requiere `python-docx` (`pip install python-docx`).
- Las rutas de entrada se resuelven contra la raíz del repositorio y la salida va siempre a este directorio.
- Regenerar sobrescribe los `.docx` con el código **actual** de `src/` y `tests/`; para conservar la evidencia original de la Fase 5B, no regenerar sin antes versionar los cambios.

---

## 🧭 Reglas

1. Los `.docx` y el diff son **evidencia inmutable** de la certificación de la Fase 5B.
2. No agregar nuevos entregables aquí: cada fase histórica tiene su propio paquete o su entrada en [`docs/archive/README.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/README.md).
