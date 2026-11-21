# 🤖 Chatbot WS — Plataforma Omnicanal de Atención y Ventas con IA

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-4.28-black.svg)](https://fastify.dev/)
[![LLM](https://img.shields.io/badge/LLM-Provider_Agnostic-blueviolet.svg)](#-arquitectura-dual-daemon--harness-con-rigor-de-ingeniería)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue.svg)](https://www.postgresql.org/)
[![Multichannel](https://img.shields.io/badge/Channels-Multichannel-25D366.svg)](#-canales-y-verticales)
[![Tests](https://img.shields.io/badge/Tests-215%2F215_Passing-success.svg)](./tests)
[![Quality Gate](https://img.shields.io/badge/Quality_Gate-Certified_100%25-success.svg)](#-quality-gate-y-certificación-institucional)

Plataforma **omnicanal** de atención, ventas y automatización con IA para empresas de LATAM. Un solo núcleo conversacional —memoria, FSM, guardrails y herramientas de negocio— está diseñado para operar sobre **WhatsApp, Instagram, Telegram, TikTok o canales propios**, con motor LLM intercambiable y sin lock-in de proveedor.

> **Canales productivos hoy:** WhatsApp Business Cloud API y Telegram Bot API (texto). El diseño separa ingesta, inferencia y despacho, de modo que nuevos canales se incorporan como adaptadores sobre el mismo motor conversacional; Instagram DM, TikTok y webchat están en roadmap.

### 🎯 Valor diferencial

- **Omnicanal por diseño, no un bot de un solo canal:** WhatsApp es una integración, no el producto. Reduce la dependencia de un único canal y de sus cambios de tarifas.
- **Sin lock-in de LLM:** `LLM_BASE_URL` + `LLM_MODEL` permiten alternar OpenAI, Groq, OpenRouter, DeepSeek, modelos locales y cualquier API compatible.
- **Economía operativa:** micro-mensajes (180 tokens), coalescencia de ráfagas, rate limiter dual RPM/TPM y contexto comprimido.
- **Multi-vertical:** automotriz y dealers, retail, salud, educación, inmobiliaria, servicios profesionales y atención B2B/B2C.
- **Confianza operativa:** idempotencia por `wamid`, outbox transaccional, circuit breakers, RLS multi-tenant y guardrails deterministas.

### 📡 Canales y verticales

| Canal | Estado | Integración |
| :--- | :---: | :--- |
| WhatsApp Business Cloud API | ✅ Operativo | Webhook HMAC + Graph API + outbox transaccional |
| Instagram DM | 🧭 Roadmap | Meta Graph API (requiere permisos de la app) |
| Telegram | ✅ Operativo | Bot API (texto, webhook con secret token) |
| TikTok | 🧭 Roadmap | API de mensajería (según disponibilidad regional) |
| Webchat / API propia | 🧭 Roadmap | Adaptador HTTP sobre el mismo pipeline |

---

## 🏛️ Arquitectura: Dual-Daemon & Harness con Rigor de Ingeniería

El núcleo del sistema desacopla la red externa y la inferencia de lenguaje mediante un patrón **Dual Daemon** respaldado por persistencia durable en PostgreSQL:

$$\text{Plataforma Omnicanal} = \text{Capa de Canales} + \text{Pipeline Inbound Durable} + \text{Motor LLM / Harness} + \text{Transactional Outbox}$$

### Pilares de Arquitectura y Resiliencia:
1. **Pipeline de Inbound Durable (I18):**
   * El Webhook Gateway responde `HTTP 200 OK` inmediatamente a Meta tras persistir el payload crudo en `inbound_events` (`INSERT ... ON CONFLICT (wamid) DO NOTHING`).
   * Despacho asíncrono con `InboundDispatcher` garantizando procesamiento ordenado (**Head-of-Line Claiming** por `sender_phone` con `FOR UPDATE OF i SKIP LOCKED` y `clock_timestamp()`).
   * **Transacción Única Atómica con Fencing Token:** Side-effects de tools (leads, handoff), transiciones FSM, encolado de respuesta en outbox y marcado a `DONE` se ejecutan bajo un solo commit con validación de lease.
2. **Transactional Outbox Pattern (Fase 4 & 5A):**
   * Despacho controlado a Meta Graph API mediante `OutboxDispatcher` con **Head-of-Line Claiming** por `recipient_phone`.
   * **Reconciliación Monótona de Estados:** Procesamiento de eventos `sent` $\rightarrow$ `delivered` $\rightarrow$ `read` con cota mínima (`floor 'sent'`) tolerando llegadas de webhooks desordenadas.
3. **Resiliencia & Tolerancia a Fallos:**
   * **Circuit Breakers Tri-State:** Aislamiento granular contra caídas de Meta Graph API y cuotas del proveedor LLM (429 / `RESOURCE_EXHAUSTED` con pausa automática).
   * **Reaper Daemons con Poison Pill Protection:** Rescate de eventos colgados con transición automática a `FAILED` y mensaje de fallback institucional tras 3 reintentos.
   * **Presupuesto ReAct & AbortSignal:** `deadlineMs` global de 24s distribuido entre turnos para nunca exceder el lease de 30s.
   * **Readiness Probe (`GET /ready`):** Monitoreo de salud operativa para orquestadores de contenedores (Kubernetes/Docker).
4. **Seguridad y Privacidad LGPD / GDPR:**
   * **Row Level Security (RLS):** Habilitado en todas las tablas sensibles del esquema `public` con revocación de privilegios para roles `anon` y `authenticated` (Migraciones 001 a 018).
   * **Sanitizador Recursivo de Logs:** Enmascaramiento automático de teléfonos E.164, tokens Bearer y API keys.
5. **Harness Agéntico & Guardrails Multi-Nivel:**
   * Grounding Lock por código (mitigación de alucinaciones de precios).
   * Context Manager con auto-summarization > 6 turnos y compactación de entidades.
   * Herramientas de negocio (`searchProductCatalog`, `createQualifiedLead`, `requestHumanHandoff`).
   * Soporte bilingüe nativo: **Português do Brasil (PT-BR)** y **Español (LATAM)**.

---

## 📁 Estructura Modular del Proyecto

El repositorio adopta el estándar institucional de modularización y arnés de auto-aprendizaje:

```text
Chatbot WS/
├── AGENTS.md                    # Mandato institucional para Antigravity, Claude, Cursor y agentes IA
├── docs/                        # Documentación técnica modularizada por dominio
│   ├── INDEX.md                 # Mapa de navegación central y taxonomía documental
│   ├── BITACORA.md              # Bitácora cronológica: cambios, decisiones, evidencia y deuda
│   ├── architecture/            # Diseños de arquitectura técnica, multitenancy y despliegue
│   ├── standards_and_harness/   # Estándares de ingeniería y catálogo de errores con auto-aprendizaje
│   │   └── self_learning_error_catalog.md # Catálogo 5-Whys y tripwires de regresión (ERR-001 a ERR-008)
│   ├── product/                 # Auditoría de readiness y estrategia de producto de ventas
│   ├── packs/                   # Especificaciones de packs por rubro (piloto automotriz)
│   ├── commercial_and_business/ # Análisis comercial, pricing y unit economics
│   ├── changelog/               # Bitácora modular por componente (Webhook, LLM, DB, Infra)
│   └── archive/                 # Expedientes de certificación, auditorías y registros históricos
│       └── auditorias_fase_5b/  # Paquete DOCX de auditoría + diff de la Fase 5B
├── scripts/
│   └── tools/
│       ├── chatbot_quality_gate.ts # Script determinista de certificación Quality Gate
│       └── build_auditor_docx.py   # Generador del paquete DOCX de auditoría (docs/archive)
├── src/
│   ├── config/                  # Constantes y variables de entorno validadas con Zod
│   ├── controllers/             # Gateway Webhook Meta con HMAC SHA-256 y reconciliación de estados
│   ├── database/                # Migraciones DDL SQL (001 a 018) y runner automatizado
│   ├── harness/                 # Motor Agéntico, Context Manager, Tools y Guardrails
│   ├── middleware/              # Rate Limiter Token Bucket por teléfono
│   ├── providers/               # Clientes externos (PostgreSQL, proveedor LLM, adaptadores de canal)
│   ├── repositories/            # Repositorios SQL (Inbound, Outbox, Contact, Conversation, Message, etc.)
│   ├── services/                # Daemons asíncronos (InboundDispatcher, OutboxDispatcher, RetentionService)
│   └── utils/                   # Circuit Breaker, crypto HMAC, logger estructurado con sanitizador PII
└── tests/                       # Suite de 26 archivos de pruebas con Vitest (215/215 passing)
```

---

## 🛡️ Quality Gate y Certificación Institucional

Todo cambio de código, refactorización o PR debe superar el **Quality Gate** de forma previa e innegociable:

```bash
npm run quality-gate
```

El script ejecuta 4 verificaciones deterministas:
1. **Compilación TypeScript AST:** `tsc --noEmit` (0 errores, 0 advertencias, prohibido `any` indiscriminado).
2. **Escaneo Zero-Trust:** Inspección exhaustiva contra tokens reales de Meta, API keys del proveedor LLM y credenciales en texto plano.
3. **Integridad de Configuración & Harness:** Validación bidireccional entre `.env.example`, `.gitignore`, `src/config/env.ts` y `AGENTS.md`.
4. **Suite Completa de Pruebas Unitarias/Integración:** `vitest run` ejecutando las 215 pruebas automatizadas al 100%.

---

## 🚀 Inicio Rápido

### 1. Requisitos Previos
* Node.js $\ge 20$
* PostgreSQL $\ge 15$ (Supabase o instancia local)
* Cuenta Meta Developers con WhatsApp Business Cloud API
* API key de un proveedor LLM compatible con OpenAI (OpenAI, Groq, OpenRouter, DeepSeek, vLLM, Ollama, etc.)

### 2. Instalación
```bash
npm install
```

### 3. Variables de Entorno
Copia `.env.example` a `.env` y configura tus credenciales:
```bash
cp .env.example .env
```

Variables del proveedor LLM (sin proveedor ni modelo hardcodeados):
```dotenv
LLM_API_KEY=tu_clave_del_proveedor
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=nombre-del-modelo
```

Canales habilitados por configuración (cada canal debe tener su adaptador registrado):
```dotenv
CHANNELS_ENABLED=whatsapp
# Opcional: agregar "telegram" y configurar el bot
TELEGRAM_BOT_TOKEN=tu_token_de_telegram
TELEGRAM_WEBHOOK_SECRET=tu_secret_token
```

Alertas operativas de backlog (opcional, default 100):
```dotenv
BACKLOG_ALERT_THRESHOLD=100
```

> 📘 Guía operativa completa de arranque y despliegue: [**`RUNBOOK_ARRANQUE_Y_DESPLIEGUE.md`**](docs/architecture/RUNBOOK_ARRANQUE_Y_DESPLIEGUE.md)
>
> 📜 Bitácora cronológica de cambios y decisiones: [**BITACORA.md**](docs/BITACORA.md)

### 4. Migraciones de Base de Datos
Ejecuta las migraciones incrementales (001 a 018):
```bash
npm run migrate
```

### 5. Compilación y Ejecución
```bash
# Modo Desarrollo con recarga automática
npm run dev

# Compilación TypeScript para Producción
npm run build

# Ejecución de la Suite Completa de Pruebas
npm test

# Ejecución del Quality Gate Institucional
npm run quality-gate
```

---

## 🧪 Estado de la Suite de Pruebas

```bash
 Test Files  26 passed (26)
      Tests  215 passed (215)
   Coverage  Pipelines Inbound/Outbox, Circuit Breakers, Guardrails, Webhook HMAC, Multi-Tenant RLS
```

---

## 📄 Licencia
Privada y Confidencial — Propiedad de Chatbot WS Core Team. Todos los derechos reservados.
