# Chatbot WS — Convenciones Técnicas y Estándares de Código

> **Guía oficial de estilo, arquitectura modular y convivencia en el repositorio para el proyecto Chatbot WS.**

---

## 1. Estructura Modular del Proyecto

Para evitar archivos monolíticos y garantizar que cualquier desarrollador o IA mantenga el orden, la estructura del proyecto sigue una arquitectura desacoplada por capas:

```text
Chatbot WS/
├── docs/                        # Documentación modular por dominio
│   ├── INDEX.md                 # Mapa central de navegación documental
│   ├── architecture/            # TDD, multitenancy, despliegue y operaciones
│   ├── standards_and_harness/   # Normas de ingeniería, harness y auto-aprendizaje
│   ├── changelog/               # Bitácoras modulares por componente
│   ├── commercial_and_business/ # Pricing, unit economics y propuestas
│   └── archive/                 # Expedientes, auditorías y registros históricos
├── src/
│   ├── config/                  # Constantes, configuración tipada y variables (.env)
│   │   ├── env.js / env.ts      # Validación estricta de variables de entorno (Zod / Joi)
│   │   └── constants.js         # Textos fijos, timeouts, nombres de tablas
│   ├── controllers/             # Manejadores de rutas HTTP y Webhooks
│   │   └── webhookController.js # Validación de firma Meta y respuesta HTTP 200
│   ├── harness/                 # Motor agéntico y gobernanza del chatbot
│   │   ├── stateMachine.js      # Máquina de estados conversacionales
│   │   ├── contextManager.js    # Ventana móvil y resumen de sesión
│   │   ├── guardrails.js        # Filtros anti-jailbreak, denylists y validaciones
│   │   ├── handoffManager.js    # Lógica de transferencia a agentes humanos
│   │   └── tools/               # Herramientas ejecutables por el modelo
│   │       ├── catalogTools.js
│   │       ├── bookingTools.js
│   │       └── crmTools.js
│   ├── providers/               # Adaptadores desacoplados de servicios externos
│   │   ├── whatsapp/            # Adaptador de WhatsApp (Meta Cloud API / Baileys)
│   │   │   ├── whatsappAdapter.js
│   │   │   └── messageFormatter.js
│   │   ├── llm/                 # Proveedores de IA (Gemini / OpenAI / Claude)
│   │   │   ├── llmProvider.js
│   │   │   └── geminiAdapter.js
│   │   └── database/            # Conexión y repositorio de datos (PostgreSQL / Supabase)
│   │       └── dbClient.js
│   ├── services/                # Casos de uso de negocio
│   │   ├── conversationService.js
│   │   └── outboxDispatcher.js
│   └── utils/                   # Utilidades puras
│       ├── logger.js            # Logs estructurados JSON
│       ├── sanitizer.js         # Sanitización de strings y números E.164
│       └── crypto.js            # Validación HMAC SHA-256
├── tests/                       # Batería de pruebas automatizadas y evals
│   ├── unit/
│   ├── integration/
│   └── evals/                   # Conversaciones de prueba sintéticas
├── .env.example                 # Plantilla pública de variables de entorno
├── .gitignore                   # Exclusiones de Git (cero credenciales)
├── AGENTS.md                    # Mandato institucional para agentes de IA
├── GEMINI.md                    # Espejo de directivas operativas (Antigravity/Gemini)
├── package.json                 # Dependencias y scripts de ejecución
└── README.md                    # Introducción rápida y puesta en marcha
```

### 1.1 Regla de Ubicación Documental (raíz limpia)

La raíz del repositorio solo aloja configuración y puntos de entrada (`README.md`, `AGENTS.md`, `GEMINI.md`, `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`). Toda la documentación vive en `docs/`:

| Tipo de documento | Ubicación obligatoria |
| :--- | :--- |
| Diseño, arquitectura y operaciones | `docs/architecture/` |
| Normas, harness y auto-aprendizaje | `docs/standards_and_harness/` |
| Bitácoras modulares por componente | `docs/changelog/` |
| Negocio, pricing y propuestas | `docs/commercial_and_business/` |
| Expedientes de certificación, auditorías, diffs y walkthroughs históricos | `docs/archive/` (paquete propio si incluye DOCX/PDF) |
| Generadores de entregables documentales | `scripts/tools/` |

**Prohibido** depositar auditorías, `.docx`, diffs o expedientes en la raíz: además de ensuciar el repositorio, rompen la modularización y el descubrimiento jerárquico del harness. Todo documento histórico nuevo debe quedar enlazado desde [`docs/archive/README.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/archive/README.md) y [`docs/INDEX.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/INDEX.md).

---

## 2. Nomenclatura & Convenciones de Código

### A. Archivos y Carpetas:
* Carpetas: `kebab-case` o `camelCase` uniforme (preferir `camelCase` dentro de `src/`).
* Archivos de código: `camelCase` (ejemplo: `webhookController.js`, `contextManager.js`).
* Archivos de configuración raíz: `kebab-case` o estándar de la herramienta (ejemplo: `vite.config.js`, `package.json`).

### B. Funciones y Variables:
* Funciones y métodos: `camelCase` con verbos de acción explícitos (ejemplo: `validateWebhookSignature()`, `dispatchOutboxMessages()`, `processCustomerIntent()`).
* Variables y propiedades: `camelCase` descriptivas (ejemplo: `customerPhoneNumber`, `sessionState`).
* Constantes globales e inmutables: `UPPER_SNAKE_CASE` (ejemplo: `MAX_TOOL_ITERATIONS`, `WEBHOOK_TIMEOUT_MS`).

### C. Nombres en Base de Datos (PostgreSQL):
* Tablas y columnas: `snake_case` en minúsculas (ejemplo: `contacts`, `phone_number`, `is_active`, `created_at`).
* Llaves primarias: `id` (UUID o VARCHAR único).
* Llaves foráneas: `[nombre_tabla_singular]_id` (ejemplo: `conversation_id`, `contact_id`).

---

## 3. Manejo de Secretos & Variables de Entorno

1. **La Regla del `.env.example`:**
   * El archivo `.env.example` debe estar siempre sincronizado con todas las claves que el proyecto necesita para funcionar, con valores de ejemplo vacíos o ficticios.
   * **NUNCA** registrar secretos reales en `.env.example`.
2. **Validación de Variables al Iniciar el Servidor:**
   * El sistema no debe iniciar si falta una variable crítica. Se debe usar un validador (como Zod) en `src/config/env.js` que lance error explicativo al arrancar si falta `META_ACCESS_TOKEN` o `GEMINI_API_KEY`.
3. **El Archivo `.gitignore` Obligatorio:**
   * Debe contener sin excepción:
     ```gitignore
     node_modules/
     .env
     .env.local
     .env.production
     npm-debug.log*
     *.log
     dist/
     build/
     ```

---

## 4. Normalización de Cargas Útiles (Payloads)

Para evitar que el código quede amarrado a una sola API de WhatsApp (pudiendo alternar entre Meta Cloud API oficial, Twilio o librerías de conexión directa), el sistema define un **Payload Normalizado Interno**:

```typescript
interface NormalizedInboundMessage {
  messageId: string;         // wamid único de WhatsApp
  senderPhone: string;       // Número limpio en formato E.164 (+57...)
  senderName: string;        // Nombre público del perfil
  timestamp: number;         // Timestamp UNIX
  type: 'text' | 'image' | 'audio' | 'interactive' | 'location';
  text?: string;
  mediaUrl?: string;
  interactiveResponse?: {
    id: string;
    title: string;
  };
}
```

Toda la lógica del bot y del Harness opera exclusivamente con este objeto normalizado, aislando la estructura interna de Meta en la capa de adaptadores (`providers/whatsapp/`).

---

## 5. Convención de Commits (Conventional Commits)

Cada commit en el repositorio debe seguir la convención estándar:

* `feat(...)`: Nueva funcionalidad o herramienta del chatbot (ej: `feat(booking): añadir tool para agendamiento de citas en calendar`).
* `fix(...)`: Corrección de errores en lógica o despacho (ej: `fix(webhook): evitar doble despacho ante reintentos de Meta`).
* `perf(...)`: Optimizaciones de latencia o consumo de tokens (ej: `perf(llm): implementar ventana móvil de contexto de 6 turnos`).
* `security(...)`: Endurecimiento de seguridad, guardrails o validación de firmas (ej: `security(guardrails): añadir filtro regex anti-jailbreak`).
* `refactor(...)`: Reestructuración de módulos sin cambiar comportamiento visible (ej: `refactor(harness): separar state machine de la capa de servicios`).
* `test(...)`: Incorporación o mejora de pruebas unitarias o evals (ej: `test(evals): añadir 10 pruebas sintéticas de cotización`).
* `docs(...)`: Actualizaciones en la documentación o bitácora (ej: `docs(bitacora): registrar Hito 0 de arquitectura`).
* `chore(...)`: Tareas de configuración, scripts o actualización de librerías.

---

## 6. Manejo de Errores y Logs Estructurados

1. **Cero `console.log` dispersos en Producción:**
   * Utilizar un logger centralizado que emita formato JSON estructurado con metadatos útiles (`timestamp`, `level`, `context`, `conversationId`, `error`).
2. **Respuestas de Error Defensivas:**
   * Ningún error interno de código, caída de base de datos o stack trace debe enviarse en el texto del mensaje hacia WhatsApp.
   * Si ocurre una excepción no controlada, se registra en logs para el equipo técnico y al cliente se le envía el mensaje de cortesía predeterminado.
