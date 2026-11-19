# 🤖 Chatbot WS — Reglas y Guardrails para Agentes de IA (Harness Institucional)

> **Mandato Institucional Obligatorio para Antigravity, Claude, Cursor y Asistentes IA**  
> **Versión:** 1.1.0 (Certificación Institucional & Estándares Harness 2026)  
> **Ámbito:** Aplica automáticamente a todas las sesiones de desarrollo, depuración y refactorización en Chatbot WS.

---

## 🎯 1. Misión y Filosofía de Construcción
1. **Plataforma de Alta Concurrencia y Respuesta Inmediata (<1.5s):**
   - Chatbot WS es una infraestructura de mensajería transaccional crítica para negocios en LATAM.
   - Cero bloqueos en el event-loop de Node.js.
   - Todo flujo conversacional debe responder dentro de la ventana de webhook de Meta (evitar reintentos duplicados por timeout de 20s).

2. **Principio Operativo Dominante:**
   - **Los humanos dirigen. Los agentes ejecutan.**
   - Ante fallos repetidos, la respuesta jamás es *"intentar más fuerte"*, sino identificar la capacidad, herramienta o restricción faltante y hacerla mecánicamente exigible.

3. **Harness Dentro del Harness (Auto-Aprendizaje):**
   - Prohibido parches ciegos o atajos temporales.
   - Ante cualquier bug en webhooks, base de datos o LLM, consultar obligatoriamente `docs/standards_and_harness/self_learning_error_catalog.md` y agregar la entrada con 5-Whys.
   - Todo desarrollo debe regirse por la [Guía de Harness Engineering (arXiv:2609.00006 & @0xwhrrari)](docs/standards_and_harness/GUIA_HARNESS_ENGINEERING.md), la [Guía de Skills Agénticas](docs/standards_and_harness/GUIA_SKILLS_Y_WORKFLOWS_AGENTICOS.md) y la [Certificación de Resiliencia Red Team](docs/standards_and_harness/CERTIFICACION_RESILIENCIA_Y_REVERSE_ENGINEERING.md).

---

## 🛑 2. Mandamientos Inquebrantables del Código

### A. Seguridad Zero-Trust y Cero Secretos en Código
- Jamás incrustar tokens de Meta Cloud API, App Secrets de WhatsApp, contraseñas de PostgreSQL o API keys del proveedor LLM en código rastreado por git.
- Usar siempre variables de entorno tipadas y validadas con `zod`.

### B. Idempotencia y Deduplicación Estricta de Mensajes
- Todo webhook entrante debe validar `wamid` único antes de procesar para evitar responder doble a los reintentos automáticos de Meta.
- Verificación criptográfica obligatoria de la firma `x-hub-signature-256`.

### C. Aislamiento Multi-Tenant & RLS en Base de Datos
- Ninguna consulta SQL puede omitir el filtro por `business_id` / `tenant_id`.
- Políticas RLS activas en todas las tablas de producción.

### D. Presupuesto de Pruebas Determinista & Mocks de Red
- La suite completa de pruebas (`npm test` con Vitest) debe ejecutarse de forma ágil y determinista.
- **Cero peticiones reales a Meta Graph API o al proveedor LLM en tests:** Todas las llamadas externas deben interceptarse con mocks deterministas.

### E. Manejo Defensivo y Tipado Estricto
- `tsc --noEmit` debe compilar con 0 errores y 0 advertencias de tipos. Prohibido el uso indiscriminado de `any`.
- Validar esquemas de payloads de Meta con `zod`.

### F. Instrucciones como Infraestructura (Codificación Doble)
- Toda política de negocio o seguridad crítica debe codificarse **dos veces**:
  1. Como instrucción clara para el LLM en su contexto.
  2. Como chequeo mecánico por código (Zod, test de regresión, query RLS, constraint SQL) que no pueda eludirse.
- **El modelo propone; el harness determinista autoriza y ejecuta.**

---

## ⚡ 3. Quality Gate Obligatorio
Antes de dar por concluida cualquier tarea o proponer un commit:
```bash
npm run quality-gate
```
Si reporta fallos, la tarea NO está completa. Corrige la causa raíz hasta obtener 100% de verificaciones superadas.
