# 🧠 Bitácora Técnica: Motor Agéntico, LLM & Gestión Conversacional

> **Dominio:** Integración con Google Gemini, Guardrails Multi-Nivel, Máquina de Estados (FSM), Function Calling, Control de Cuotas (RPM/TPM) y Coalescencia.

---

## 🚀 Evolución y Decisiones Clave por Fase

### 1. Motor Agéntico y Gemini 2.5 Flash (Fase 3)
* **SDK Oficial `@google/genai`:**
  * Uso de Google GenAI SDK con modelo `gemini-2.5-flash` para balance óptimo de latencia (<1.5s) y razonamiento estructurado.
* **Máquina de Estados Finitos (FSM):**
  * Estados soportados: `IDLE`, `QUALIFYING`, `CATALOG_QUERY`, `BOOKING`, `CLOSING`, `CLOSED`, `HUMAN_ESCALATION`.
  * Interceptor global para `HUMAN_ESCALATION` accesible desde cualquier punto de la conversación.
* **Token Budgeting y Compresión de Contexto:**
  * Ventana deslizante de historial (últimos 6 mensajes).
  * Auto-generación de `context_summary` y persistencia en DB cuando se supera el límite de mensajes para no exceder cuotas de tokens.
  * Límite estricto de generación a 180 completion tokens para mantener respuestas breves y directas en WhatsApp.

### 2. Guardrails Inviolables Multi-Nivel (Fase 3)
* **Nivel 1 (Input Guard):**
  * Detección determinista de intentos de Jailbreak, prompts maliciosos o evasiones de rol antes de invocar la API del LLM.
* **Nivel 2 (FSM State Guard):**
  * Restricciones de flujo según el estado actual de la conversación (ej. no permitir checkout sin haber calificado los datos del cliente).
* **Nivel 3 (Grounding Lock):**
  * Protección contra alucinaciones de precios y disponibilidad. Prohibición estricta de citar valores monetarios sin haber ejecutado previamente la tool de catálogo `searchProductCatalog`.
* **Nivel 4 (Output Denylist):**
  * Filtro de salida para bloquear términos restringidos, datos internos o lenguaje impropio previo al despacho del mensaje.

### 3. Escala Empresarial, Rate Limiting Dual & Coalescencia (Fase 5C)
* **Rate Limiter Dual (RPM & TPM):**
  * Algoritmo Leaky Bucket dual para controlar simultáneamente Requests Per Minute (RPM) y Tokens Per Minute (TPM).
  * Reserva anticipada de tokens con estimación inicial (3,000 tokens) y reconciliación exacta posterior contra los metadatos de uso reportados por Gemini (`usageMetadata`).
  * Reembolso del 100% de los tokens reservados si la llamada al LLM falla, evitando fugas de cuota acumuladas.
* **Coalescencia de Mensajes Contiguos:**
  * Si un usuario de WhatsApp envía múltiples mensajes de texto sucesivos en ráfaga (ej: "Hola", "¿Tienen autos?", "En Santiago"), el sistema coalese hasta 5 mensajes contiguos en un solo turno de inferencia LLM.
  * Preserva contigüidad estricta: se detiene ante mensajes no-texto (imágenes, audios) para no romper el orden semántico.
