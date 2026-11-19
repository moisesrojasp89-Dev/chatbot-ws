# 📦 Archivo Histórico — Chatbot WS

> **Propósito:** preservar la evidencia documental e histórica del proyecto (expedientes de certificación, auditorías externas, diffs de subsanación y bitácoras legacy) sin contaminar la documentación normativa viva.

Este dominio es **inmutable por naturaleza de auditoría**: los documentos aquí conservados no se reescriben; si un hallazgo requiere acción vigente, se documenta en [`docs/architecture/`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/architecture/README.md), [`docs/standards_and_harness/`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/README.md) o [`docs/changelog/`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/README.md) y aquí solo se referencia.

---

## 🗂️ Expedientes y Registros Históricos

| Documento | Contenido | Fase / Hito | Formato |
| :--- | :--- | :---: | :---: |
| [**`CHATBOT_CHANGELOG_MONOLITH_LEGACY.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/CHATBOT_CHANGELOG_MONOLITH_LEGACY.md) | Bitácora monolítica original (~50 KB) previa a la modularización por dominios, preservada intacta para auditoría retroactiva. | Hitos 0–5A | Markdown |
| [**`EXPEDIENTE_CERTIFICACION_FASE_5B.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/EXPEDIENTE_CERTIFICACION_FASE_5B.md) | Expediente de certificación de la Fase 5B: resolución de las 6 observaciones del auditor (AbortSignal/deadline ReAct, Circuit Breaker preventivo, RLS `ALTER DEFAULT PRIVILEGES`, retención unificada de PII, side-effects diferidos y reaper con Poison Pill) con código fuente completo. | Fase 5B | Markdown |
| [**`EXPEDIENTE_CERTIFICACION_FASE_5C.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/EXPEDIENTE_CERTIFICACION_FASE_5C.md) | Expediente de certificación de la Fase 5C: locking `EvalPlanQual`, Sliding Worker Pool, Rate Limiter Dual RPM/TPM, coalescencia y retención LGPD continua (125/125 tests). | Fase 5C | Markdown |
| [**`WALKTHROUGH_FASE_5C.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/WALKTHROUGH_FASE_5C.md) | Walkthrough de implementación de la Fase 5C: componente por componente, con la trazabilidad de las observaciones C1–C13 resueltas. | Fase 5C | Markdown |
| [**`DICTAMEN_FINAL_FASE_5C.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/DICTAMEN_FINAL_FASE_5C.md) | Dictamen final del arquitecto auditor sobre la Fase 5C. | Fase 5C | Markdown |
| [**`PLAN_IMPLEMENTACION_FASE_5C.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/PLAN_IMPLEMENTACION_FASE_5C.md) | Plan de implementación original de la Fase 5C. | Fase 5C | Markdown |
| [**`CIERRE_DE_PROYECTO_LISTO_PARA_PRODUCCION.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/CIERRE_DE_PROYECTO_LISTO_PARA_PRODUCCION.md) | Acta de cierre del proyecto y declaración de readiness para producción. | Cierre | Markdown |
| [**`DIFF_SUBSANACION_AUDITORIA_FASE_4.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/DIFF_SUBSANACION_AUDITORIA_FASE_4.md) | Diff de subsanación de las observaciones de auditoría de la Fase 4. | Fase 4 | Markdown |
| [**`DOSSIER_CODE_REVIEW_FASE_4.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/DOSSIER_CODE_REVIEW_FASE_4.md) | Dossier de code review de la Fase 4 (Outbox, status updates, hardening). | Fase 4 | Markdown |

---

## 📑 Paquete de Auditoría Fase 5B (DOCX)

📂 [**`auditorias_fase_5b/`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/auditorias_fase_5b/README.md)

Entregables en Word preparados para revisión del auditor externo, con el código fuente íntegro embebido:

| Documento | Alcance |
| :--- | :--- |
| `AUDITORIA_5B_PARTE_1_DISPATCHER_Y_REPOSITORY.docx` | `inboundRepository.ts` e `inboundDispatcher.ts`: Head-of-Line, lease, fencing token, reaper y purga LGPD. |
| `AUDITORIA_5B_PARTE_2_WEBHOOK_SERVER_Y_LLM.docx` | `webhookController.ts`, `server.ts` y `geminiClient.ts`: ACK duradero, apagado coordinado y timeout LLM. |
| `AUDITORIA_5B_PARTE_3_MIGRACIONES_Y_LOGGER.docx` | Migraciones 007–010 y `logger.ts`: RLS, revocación de privilegios y sanitización de PII. |
| `AUDITORIA_5B_PARTE_4_TESTS_MUTACION_ROLLBACK_RLS.docx` | `tests/inbound.test.ts` y `tests/rlsAndLogger.test.ts`. |
| `AUDITORIA_FASE_5B_COMPLETO.docx` | Compilación de las cuatro partes en un único expediente. |
| `FASE_5B_DIFF_AUDITOR.txt` | Diff completo de la Fase 5B entregado como evidencia al auditor. |

**Regeneración del paquete** (requiere `python-docx`):

```bash
python scripts/tools/build_auditor_docx.py
```

El generador resuelve rutas contra la raíz del repositorio y escribe siempre en `docs/archive/auditorias_fase_5b/`, por lo que puede ejecutarse desde cualquier directorio de trabajo sin volver a ensuciar la raíz.

---

## 🧭 Reglas del Dominio

1. **No editar el contenido histórico.** Es evidencia de auditoría; las correcciones se documentan en los dominios vivos.
2. **Nuevos registros históricos** (dictámenes, expedientes, diffs, auditorías externas) se incorporan aquí, no en la raíz del repositorio.
3. **Documentos normativos vigentes** (arquitectura, estándares, changelog, negocio) pertenecen a sus dominios respectivos, nunca a `archive/`.
4. Toda entrada nueva debe quedar enlazada desde este README y desde [`docs/INDEX.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/INDEX.md).
