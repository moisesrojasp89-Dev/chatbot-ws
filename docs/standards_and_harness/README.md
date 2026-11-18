# 🛡️ Dominio de Estándares, Harness y Calidad — Chatbot WS

> **Propósito:** Gobernanza técnica, reglas de codificación, candados algorítmicos, memoria de auto-aprendizaje contra regresiones y compuertas de calidad automáticas.

---

## 📚 Documentos del Dominio

| Documento | Descripción | Estado |
| :--- | :--- | :--- |
| [**`GUIA_HARNESS_ENGINEERING.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/GUIA_HARNESS_ENGINEERING.md) | 🧠 **Harness Engineering v3.0 (arXiv:2609.00006):** Arquitectura de 7 subsistemas canónicos, The Twin Absences y Loop ReAct. | Normativo |
| [**`GUIA_SKILLS_Y_WORKFLOWS_AGENTICOS.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/GUIA_SKILLS_Y_WORKFLOWS_AGENTICOS.md) | 🛠️ **Skills de Ingeniería & Workflows (Addy Osmani):** SDLC 6 fases, Matriz Anti-Racionalizaciones y 5-Axis Review. | Normativo |
| [**`CERTIFICACION_RESILIENCIA_Y_REVERSE_ENGINEERING.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/CERTIFICACION_RESILIENCIA_Y_REVERSE_ENGINEERING.md) | 🛡️ **Reverse Engineering & Resiliencia Red Team:** Mitigación de fallos en LLM, tormentas de webhooks y concurrencia. | Certificado |
| [**`self_learning_error_catalog.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/self_learning_error_catalog.md) | 🧠 **Catálogo de Errores con Auto-Aprendizaje (5-Whys):** Memoria histórica persistente y tripwires automatizados para evitar regresiones. | Activo / Mandatorio |
| [**`ENGINEERING_STANDARDS.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/ENGINEERING_STANDARDS.md) | Estándares de ingeniería de grado institucional: SLAs de latencia, Zero-Trust, tipado estricto, presupuesto de tests. | Activo |
| [**`GUIA_HARNESS_CHATBOT.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/GUIA_HARNESS_CHATBOT.md) | Filosofía $\text{Chatbot} = \text{Modelo} + \text{Harness}$. Guardrails duros, Progressive Disclosure y Human Handoff. | Activo |
| [**`CONVENTIONS.md`**](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/standards_and_harness/CONVENTIONS.md) | Convenciones de nombrado, estructura de archivos TypeScript, manejo de variables `.env` y Conventional Commits. | Activo |

---

## ⚡ El Harness dentro del Harness

La arquitectura de ingeniería de Chatbot WS opera bajo un principio inmutable:

1. **Cero Parches Rápidos:** Cada bug detectado es diagnosticado en su causa raíz con los **5 Porqués (5-Whys)**.
2. **Candado Permanente:** Toda corrección debe ir acompañada de un test unitario o guardrail por código (*tripwire*).
3. **Quality Gate:** Todo cambio debe superar el script determinista de 4 fases antes de ser integrado (`npm run quality-gate`).
