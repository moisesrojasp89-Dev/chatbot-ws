# 🤖 Chatbot WS — Enterprise Immediate-Response WhatsApp Assistant

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-4.28-black.svg)](https://fastify.dev/)
[![Gemini 2.5 Flash](https://img.shields.io/badge/Google_GenAI-Gemini_2.5_Flash-orange.svg)](https://ai.google.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue.svg)](https://www.postgresql.org/)
[![Tests](https://img.shields.io/badge/Tests-125%2F125_Passing-success.svg)](./tests)
[![Quality Gate](https://img.shields.io/badge/Quality_Gate-Certified_100%25-success.svg)](#-quality-gate-y-certificación-institucional)

Plataforma de alta velocidad y gobernanza agéntica para atención al cliente y ventas inmediatas en **WhatsApp Business Cloud API**, diseñada para el mercado corporativo de América Latina y Brasil.

---

## 🏛️ Arquitectura: Dual-Daemon & Harness con Rigor de Ingeniería

El núcleo del sistema desacopla la red externa y la inferencia de lenguaje mediante un patrón **Dual Daemon** respaldado por persistencia durable en PostgreSQL:

$$\text{Chatbot Empresarial} = \text{Pipeline Inbound Durable} + \text{Motor LLM / Harness} + \text{Transactional Outbox}$$

### Pilares de Arquitectura y Resiliencia:
1. **Pipeline de Inbound Durable (I18):**
   * El Webhook Gateway responde `HTTP 200 OK` inmediatamente a Meta tras persistir el payload crudo en `inbound_events` (`INSERT ... ON CONFLICT (wamid) DO NOTHING`).
   * Despacho asíncrono con `InboundDispatcher` garantizando procesamiento ordenado (**Head-of-Line Claiming** por `sender_phone` con `FOR UPDATE OF i SKIP LOCKED` y `clock_timestamp()`).
   * **Transacción Única Atómica con Fencing Token:** Side-effects de tools (leads, handoff), transiciones FSM, encolado de respuesta en outbox y marcado a `DONE` se ejecutan bajo un solo commit con validación de lease.
2. **Transactional Outbox Pattern (Fase 4 & 5A):**
   * Despacho controlado a Meta Graph API mediante `OutboxDispatcher` con **Head-of-Line Claiming** por `recipient_phone`.
   * **Reconciliación Monótona de Estados:** Procesamiento de eventos `sent` $\rightarrow$ `delivered` $\rightarrow$ `read` con cota mínima (`floor 'sent'`) tolerando llegadas de webhooks desordenadas.
3. **Resiliencia & Tolerancia a Fallos:**
   * **Circuit Breakers Tri-State:** Aislamiento granular contra caídas de Meta Graph API y cuotas de Gemini (`RESOURCE_EXHAUSTED` con pausa automática).
   * **Reaper Daemons con Poison Pill Protection:** Rescate de eventos colgados con transición automática a `FAILED` y mensaje de fallback institucional tras 3 reintentos.
   * **Presupuesto ReAct & AbortSignal:** `deadlineMs` global de 24s distribuido entre turnos para nunca exceder el lease de 30s.
   * **Readiness Probe (`GET /ready`):** Monitoreo de salud operativa para orquestadores de contenedores (Kubernetes/Docker).
4. **Seguridad y Privacidad LGPD / GDPR:**
   * **Row Level Security (RLS):** Habilitado en todas las tablas sensibles del esquema `public` con revocación de privilegios para roles `anon` y `authenticated` (Migraciones 001 a 012).
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
├── GEMINI.md                    # Espejo de directivas operativas institucionales
├── docs/                        # Documentación técnica modularizada por dominio
│   ├── INDEX.md                 # Mapa de navegación central y taxonomía documental
│   ├── architecture/            # Diseños de arquitectura técnica, multitenancy y despliegue
│   ├── standards_and_harness/   # Estándares de ingeniería y catálogo de errores con auto-aprendizaje
│   │   └── self_learning_error_catalog.md # Catálogo 5-Whys y tripwires de regresión (ERR-001 a ERR-006)
│   ├── commercial_and_business/ # Análisis comercial, pricing y unit economics
│   ├── changelog/               # Bitácora modular por componente (Webhook, LLM, DB, Infra)
│   └── archive/                 # Registros históricos consolidados (sin pérdida de información)
├── scripts/
│   └── tools/
│       └── chatbot_quality_gate.ts # Script determinista de certificación Quality Gate
├── src/
│   ├── config/                  # Constantes y variables de entorno validadas con Zod
│   ├── controllers/             # Gateway Webhook Meta con HMAC SHA-256 y reconciliación de estados
│   ├── database/                # Migraciones DDL SQL (001 a 012) y runner automatizado
│   ├── harness/                 # Motor Agéntico, Context Manager, Tools y Guardrails
│   ├── middleware/              # Rate Limiter Token Bucket por teléfono
│   ├── providers/               # Clientes externos (PostgreSQL, Gemini 2.5 Flash, Meta Graph API)
│   ├── repositories/            # Repositorios SQL (Inbound, Outbox, Contact, Conversation, Message, etc.)
│   ├── services/                # Daemons asíncronos (InboundDispatcher, OutboxDispatcher, RetentionService)
│   └── utils/                   # Circuit Breaker, crypto HMAC, logger estructurado con sanitizador PII
└── tests/                       # Suite de 14 archivos de pruebas con Vitest (125/125 passing)
```

---

## 🛡️ Quality Gate y Certificación Institucional

Todo cambio de código, refactorización o PR debe superar el **Quality Gate** de forma previa e innegociable:

```bash
npm run quality-gate
```

El script ejecuta 4 verificaciones deterministas:
1. **Compilación TypeScript AST:** `tsc --noEmit` (0 errores, 0 advertencias, prohibido `any` indiscriminado).
2. **Escaneo Zero-Trust:** Inspección exhaustiva contra tokens reales de Meta, API keys de Gemini y credenciales en texto plano.
3. **Integridad de Configuración & Harness:** Validación bidireccional entre `.env.example`, `.gitignore`, `src/config/env.ts`, `AGENTS.md` y `GEMINI.md`.
4. **Suite Completa de Pruebas Unitarias/Integración:** `vitest run` ejecutando las 125 pruebas automatizadas al 100%.

---

## 🚀 Inicio Rápido

### 1. Requisitos Previos
* Node.js $\ge 20$
* PostgreSQL $\ge 15$ (Supabase o instancia local)
* Cuenta Meta Developers con WhatsApp Business Cloud API
* Google Gemini API Key

### 2. Instalación
```bash
npm install
```

### 3. Variables de Entorno
Copia `.env.example` a `.env` y configura tus credenciales:
```bash
cp .env.example .env
```

### 4. Migraciones de Base de Datos
Ejecuta las migraciones incrementales (001 a 012):
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
 Test Files  14 passed (14)
      Tests  125 passed (125)
   Coverage  Pipelines Inbound/Outbox, Circuit Breakers, Guardrails, Webhook HMAC, Multi-Tenant RLS
```

---

## 📄 Licencia
Privada y Confidencial — Propiedad de Chatbot WS Core Team. Todos los derechos reservados.
