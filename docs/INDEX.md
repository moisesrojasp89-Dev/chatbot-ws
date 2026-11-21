# 🧭 Chatbot WS — Mapa Central y Gobernanza Documental Unificada

Bienvenido al centro de documentación técnica y gobernanza del ecosistema **Chatbot WS** (Plataforma Empresarial de Chatbots de Respuesta Inmediata para WhatsApp en LATAM).

La documentación está organizada bajo el estándar de **Modularización Jerárquica** de grado institucional para prevenir la saturación de contexto y garantizar trazabilidad técnica exacta.

## 📜 Bitácora Cronológica

[**`BITACORA.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/BITACORA.md) — cambios, decisiones, evidencia de tests y deuda aceptada por commit. **Empieza aquí** para saber qué se hizo y por qué.

---

## 🏛️ 1. Dominio de Arquitectura & Especificaciones Técnicas
📂 [**`docs/architecture/`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/architecture/README.md)

| Documento | Descripción / Alcance | Nivel |
| :--- | :--- | :---: |
| [**`TDD_ARQUITECTURA_TECNICA_DETALLADA.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/architecture/TDD_ARQUITECTURA_TECNICA_DETALLADA.md) | Technical Design Document normativo v2.0: C4 N1/N2, DDL PostgreSQL, FSM, tools del LLM, Human Handoff. | L2 - Núcleo |
| [**`ARQUITECTURA_MULTITENANT_Y_ESCALABILIDAD.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/architecture/ARQUITECTURA_MULTITENANT_Y_ESCALABILIDAD.md) | Aislamiento multi-tenant, Row-Level Security (RLS) en PostgreSQL, escalabilidad horizontal y pooling. | L3 - Avanzado |
| [**`GUIA_OMNICANAL_Y_DEALERS_AUTOMOTRICES.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/architecture/GUIA_OMNICANAL_Y_DEALERS_AUTOMOTRICES.md) | Flujos especializados para concesionarios automotrices (cotización, test drive, catálogo). | L2 - Industria |
| [**`GUIA_ARQUITECTURA_Y_BUENAS_PRACTICAS.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/architecture/GUIA_ARQUITECTURA_Y_BUENAS_PRACTICAS.md) | Manifiesto de desarrollo asistido por IA, prevención de los 10 anti-patrones en LLMs y checklist pre-producción. | L1 - Fundacional |
| [**`DOSSIER_PROPUESTA_ARQUITECTURA_CHATBOT_WS.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/architecture/DOSSIER_PROPUESTA_ARQUITECTURA_CHATBOT_WS.md) | Estudio de arquitectura de referencia, comparativa de canales y justificación técnica. | L1 - Estratégico |
| [**`INFORME_DESPLIEGUE_VPS_Y_CLOUDFLARE_TUNNEL.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/architecture/INFORME_DESPLIEGUE_VPS_Y_CLOUDFLARE_TUNNEL.md) | Certificación de aprovisionamiento en <VPS_PROVIDER> <VPS_REGION>, dominio oficial, Cloudflare Tunnel Zero Trust y systemd. | L2 - Operaciones |
| [**`RUNBOOK_ARRANQUE_Y_DESPLIEGUE.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/architecture/RUNBOOK_ARRANQUE_Y_DESPLIEGUE.md) | Runbook vigente: variables de entorno, migraciones, orden stop→migrate→start, webhooks Meta/Telegram, verificación y rollback. | L1 - Operaciones |

---

## 🛡️ 2. Dominio de Estándares, Harness y Auto-Aprendizaje
📂 [**`docs/standards_and_harness/`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/README.md)

| Documento | Descripción / Alcance | Estado |
| :--- | :--- | :---: |
| [**`GUIA_HARNESS_ENGINEERING.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/GUIA_HARNESS_ENGINEERING.md) | 🧠 **Harness Engineering v3.5.0 (arXiv:2609.00006, 0xwhrrari, OpenAI Codex & Anthropic):** 8 funciones de producción, arquitectura Managed, The Twin Absences y Loop ReAct. | **Mandatorio** |
| [**`GUIA_SKILLS_Y_WORKFLOWS_AGENTICOS.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/GUIA_SKILLS_Y_WORKFLOWS_AGENTICOS.md) | 🛠️ **Skills de Ingeniería & Workflows (Addy Osmani):** SDLC 6 fases, Matriz Anti-Racionalizaciones y 5-Axis Review. | **Mandatorio** |
| [**`CERTIFICACION_RESILIENCIA_Y_REVERSE_ENGINEERING.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/CERTIFICACION_RESILIENCIA_Y_REVERSE_ENGINEERING.md) | 🛡️ **Reverse Engineering & Resiliencia Red Team:** Mitigación de fallos en LLM, tormentas de webhooks y concurrencia. | Certificado |
| [**`self_learning_error_catalog.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/self_learning_error_catalog.md) | 🧠 **Catálogo de Auto-Aprendizaje (5-Whys):** Memoria de incidentes, causas raíz y tripwires de regresión. | **Mandatorio** |
| [**`ENGINEERING_STANDARDS.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/ENGINEERING_STANDARDS.md) | SLAs de respuesta inmediata (<1.5s), Zero-Trust, tipado TypeScript estricto y presupuesto de tests. | Normativo |
| [**`GUIA_HARNESS_CHATBOT.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/GUIA_HARNESS_CHATBOT.md) | Marco agéntico institucional: $\text{Chatbot} = \text{Modelo} + \text{Harness}$. Guardrails duros por código. | Normativo |
| [**`CONVENTIONS.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/CONVENTIONS.md) | Guía de estilo, estructura modular de carpetas, validación de `.env.example` y Conventional Commits. | Normativo |

---

## 📜 3. Bitácoras Técnicas Modulares (Changelog)
📂 [**`docs/changelog/`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/README.md)

| Documento | Dominio Técnico Especializado | Fases Cubiertas |
| :--- | :--- | :---: |
| [**`webhook_and_meta.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/webhook_and_meta.md) | Ingesta de webhooks, verificación HMAC, deduplicación atómica, Outbox y Status Updates. | Fases 1 y 4 |
| [**`llm_and_conversations.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/llm_and_conversations.md) | Motor agéntico, proveedor LLM, Guardrails N1-N4, FSM, Rate Limiter Dual y Coalescencia. | Fases 3 y 5C |
| [**`database_and_multi_tenant.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/database_and_multi_tenant.md) | Esquemas PostgreSQL, RLS multi-tenant, Inbound Durable, SKIP LOCKED y purga LGPD. | Fases 2, 5B y 5C |
| [**`infra_and_deploy.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/infra_and_deploy.md) | Servidor Fastify, Systemd, <VPS_PROVIDER> VPS, Cloudflare Tunnel y Observabilidad (Pino). | Fases 1, 5A y Ops |

---

## 💼 4. Dominio Comercial & Negocio
📂 [**`docs/commercial_and_business/`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/commercial_and_business/README.md)

| Documento | Descripción / Alcance |
| :--- | :--- |
| [**`GUIA_COMERCIAL_Y_ESTRUCTURA_DE_COSTOS.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/commercial_and_business/GUIA_COMERCIAL_Y_ESTRUCTURA_DE_COSTOS.md) | Costos unitarios por mensaje, estructura de pricing B2B, márgenes y amortización de infraestructura. |
| [**`SINTESIS_COMERCIAL_Y_PROPUESTA_OMNICANAL.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/commercial_and_business/SINTESIS_COMERCIAL_Y_PROPUESTA_OMNICANAL.md) | Propuesta de valor empresarial y catálogo de soluciones omnicanal para el mercado corporativo LATAM. |

---

## 🧩 5. Producto y Packs

| Documento | Descripción / Alcance | Nivel |
| :--- | :--- | :---: |
| [**`SALES_READINESS_AUDIT.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/product/SALES_READINESS_AUDIT.md) | Auditoría de readiness del bot de ventas: qué es genérico, qué está sesgado y qué falta para un piloto real. | L1 - Producto |
| [**`AUTOMOTIVE_PACK_SPEC.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/packs/AUTOMOTIVE_PACK_SPEC.md) | Especificación del pack piloto automotriz: catálogo, tools, flujos, evaluación. Solo para pruebas. | L1 - Pack |
| [**`SALES_GUARDRAILS.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/product/SALES_GUARDRAILS.md) | Guardrails deterministas y 10 escenarios adversariales de venta. | L1 - Harness |
| [**SEMANTIC_LAYER_Y_CUOTAS.md**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/product/SEMANTIC_LAYER_Y_CUOTAS.md) | Catálogo semántico, fallback, alcance y cuotas anti-bucle. | L1 - Harness |
| [**AUDITORIA_CAMBIOS_Y_NORTE.md**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/product/AUDITORIA_CAMBIOS_Y_NORTE.md) | Auditoría del diff, valor real, regresión de monolitos y norte del proyecto. | L0 - Producto |`n| [**`ARCHITECTURE.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/ARCHITECTURE.md) | Reglas de capas y presupuesto de tamaño; el Quality Gate las valida. | L0 - Arquitectura |`n| [**`DEUDA_MONOLITOS.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/architecture/DEUDA_MONOLITOS.md) | Caps legacy y plan de reducción de los orquestadores. | L1 - Arquitectura |`n| [**`pilot/`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/pilot/README.md) | Pilot kit automotriz: pack, 20 pruebas, métricas y checklist. | L1 - Piloto |

---

## 📦 6. Archivo Histórico, Expedientes y Auditorías
📂 [**`docs/archive/`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/README.md)

| Documento | Descripción / Alcance | Fase |
| :--- | :--- | :---: |
| [**`auditorias_fase_5b/`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/auditorias_fase_5b/README.md) | Paquete de auditoría entregado al auditor externo: partes 1–4 en DOCX, expediente consolidado y diff íntegro de la Fase 5B. | Fase 5B |
| [**`EXPEDIENTE_CERTIFICACION_FASE_5B.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/EXPEDIENTE_CERTIFICACION_FASE_5B.md) | Certificación de Inbound Durable (I18) y RLS/PII (I20): resolución de las 6 observaciones del auditor con código fuente completo. | Fase 5B |
| [**`EXPEDIENTE_CERTIFICACION_FASE_5C.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/EXPEDIENTE_CERTIFICACION_FASE_5C.md) | Certificación de escala: Sliding Worker Pool, Rate Limiter Dual RPM/TPM, coalescencia y retención LGPD (125/125 tests). | Fase 5C |
| [**`WALKTHROUGH_FASE_5C.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/WALKTHROUGH_FASE_5C.md) | Walkthrough de implementación de la Fase 5C con la trazabilidad de las observaciones C1–C13. | Fase 5C |
| [**`DICTAMEN_FINAL_FASE_5C.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/DICTAMEN_FINAL_FASE_5C.md) | Dictamen final del arquitecto auditor sobre la Fase 5C. | Fase 5C |
| [**`PLAN_IMPLEMENTACION_FASE_5C.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/PLAN_IMPLEMENTACION_FASE_5C.md) | Plan de implementación original de la Fase 5C. | Fase 5C |
| [**`CIERRE_DE_PROYECTO_LISTO_PARA_PRODUCCION.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/CIERRE_DE_PROYECTO_LISTO_PARA_PRODUCCION.md) | Acta de cierre del proyecto y declaración de readiness para producción. | Cierre |
| [**`DIFF_SUBSANACION_AUDITORIA_FASE_4.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/DIFF_SUBSANACION_AUDITORIA_FASE_4.md) | Diff de subsanación de las observaciones de auditoría de la Fase 4. | Fase 4 |
| [**`DOSSIER_CODE_REVIEW_FASE_4.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/DOSSIER_CODE_REVIEW_FASE_4.md) | Dossier de code review de la Fase 4 (Outbox, status updates, hardening). | Fase 4 |
| [**`CHATBOT_CHANGELOG_MONOLITH_LEGACY.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/CHATBOT_CHANGELOG_MONOLITH_LEGACY.md) | Bitácora histórica monolítica original (~50 KB) preservada intacta para auditoría retroactiva. | Hitos 0–5A |

---

## 🛑 Guardrails Operativos del Repositorio
Para consultar las reglas que gobiernan a los agentes de IA y desarrolladores, consulta [**`AGENTS.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/AGENTS.md) en la raíz del proyecto.
