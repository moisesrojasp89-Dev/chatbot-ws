# 📜 Matriz Cronológica de Hitos y Fases — Chatbot WS

> **Propósito:** Trazabilidad modular de la evolución del proyecto desglosada por fases arquitectónicas y dominios técnicos especializados.

---

## 🗺️ Matriz General de Fases y Certificaciones

| Fase / Hito | Alcance Principal | Dictamen / Calificación | Dominio Técnico |
| :--- | :--- | :--- | :--- |
| **Hito 0 & 1** | Fundación arquitectónica, TDD normativo v2.0, C4 L1/L2, DDL Postgres | **9.3 / 10 (Aprobado)** | [`database_and_multi_tenant.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/database_and_multi_tenant.md) |
| **Fase 1** | Webhook Gateway Fastify, Validación HMAC SHA-256, Idempotencia wamid | **Certificado (100% tests)** | [`webhook_and_meta.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/webhook_and_meta.md) |
| **Fase 2** | DDL, Migraciones SQL, Repositorios Tipados (contacts, conversations, messages, leads) | **Certificado (8.8 / 10)** | [`database_and_multi_tenant.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/database_and_multi_tenant.md) |
| **Fase 3** | Motor Agéntico con proveedor LLM configurable, Guardrails N1-N4, Grounding Lock, FSM | **Certificado (100% tests)** | [`llm_and_conversations.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/llm_and_conversations.md) |
| **Fase 4** | Transactional Outbox Worker, Circuit Breaker Meta API, Status Updates (sent/delivered/read) | **Certificado (Auditoría B1-B3)** | [`webhook_and_meta.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/webhook_and_meta.md) |
| **Fase 5A** | Refactorización de Arquitectura, Logging Pino, Hardening de Errores | **Certificado (Fase 5A)** | [`infra_and_deploy.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/infra_and_deploy.md) |
| **Fase 5B** | Inbound Durable (`inbound_events`), Desacoplamiento Webhook/LLM (<200ms ACK) | **Certificado (I18)** | [`database_and_multi_tenant.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/database_and_multi_tenant.md) |
| **Fase 5C** | Escala Empresarial: Sliding Worker Pool, Rate Limiter Dual (RPM/TPM), Coalescencia | **Dictamen Final Verde** | [`llm_and_conversations.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/llm_and_conversations.md) |

## 📑 Expedientes de Certificación Vinculados

| Fase | Expediente Oficial | Evidencia Complementaria |
| :---: | :--- | :--- |
| **5B** | [`EXPEDIENTE_CERTIFICACION_FASE_5B.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/EXPEDIENTE_CERTIFICACION_FASE_5B.md) | Paquete DOCX y diff del auditor en [`docs/archive/auditorias_fase_5b/`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/auditorias_fase_5b/README.md). |
| **5C** | [`EXPEDIENTE_CERTIFICACION_FASE_5C.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/EXPEDIENTE_CERTIFICACION_FASE_5C.md) | [`WALKTHROUGH_FASE_5C.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/WALKTHROUGH_FASE_5C.md) y [`DICTAMEN_FINAL_FASE_5C.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/DICTAMEN_FINAL_FASE_5C.md). |

---

## 📂 Bitácoras Modulares por Dominio Técnico

Para consultar el registro técnico detallado sin saturación de contexto, dirígete al dominio específico:

1. [**`webhook_and_meta.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/webhook_and_meta.md): Ingesta de webhooks, verificación HMAC, deduplicación atómica, Transactional Outbox, reconciliación de status updates.
2. [**`llm_and_conversations.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/llm_and_conversations.md): Motor agéntico, integración LLM genérica, esquemas de tools, guardrails N1-N4, FSM, limitación dual RPM/TPM y coalescencia.
3. [**`database_and_multi_tenant.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/database_and_multi_tenant.md): Esquemas de tablas, migraciones, RLS multi-tenant, concurrencia `SKIP LOCKED`, retención y purga LGPD.
4. [**`infra_and_deploy.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/changelog/infra_and_deploy.md): Servidor Fastify, configuración VPS <VPS_PROVIDER>, túnel Cloudflare, Systemd, variables de entorno y observabilidad.

---

> 📦 **Registro Histórico Completo:** Si requieres inspeccionar el changelog original anterior a la modularización, consulta [`docs/archive/CHATBOT_CHANGELOG_MONOLITH_LEGACY.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/CHATBOT_CHANGELOG_MONOLITH_LEGACY.md).
