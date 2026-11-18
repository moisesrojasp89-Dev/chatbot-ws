# Chatbot WS — Estándares de Ingeniería de Software & Infraestructura Empresarial

**Documento:** `docs/ENGINEERING_STANDARDS.md`  
**Estado:** Directriz Oficial de Arquitectura e Infraestructura  
**Versión:** 1.0  
**Fecha de Aprobación:** Septiembre 2026  
**Documentos Relacionados:**  
- 🧭 [`docs/INDEX.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/INDEX.md)  
- 🧠 [`docs/GUIA_ARQUITECTURA_Y_BUENAS_PRACTICAS.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/GUIA_ARQUITECTURA_Y_BUENAS_PRACTICAS.md)  
- ⚙️ [`docs/GUIA_HARNESS_CHATBOT.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/GUIA_HARNESS_CHATBOT.md)  
- 📐 [`docs/CONVENTIONS.md`](file:///c:/Users/indatech/Desktop/Chatbot%20WS/docs/CONVENTIONS.md)  

---

## 🏛️ 1. Misión & Filosofía: Nivel Corporativo para el Mercado LATAM

La mayoría de soluciones de WhatsApp en América Latina fallan porque son construidas como "juguetes" o scripts artesanales. En el entorno corporativo, la atención por WhatsApp representa el canal directo de ventas y retención.

> *"La diferencia entre un bot casero y una infraestructura empresarial radica en tres pilares: Idempotencia estricta, Resiliencia ante fallos externos y SLAs de respuesta inmediata."*

### Políticas de Calidad por Diseño (Quality Gates):
1. **SLA de Respuesta Inmediata:**
   * Recepción del Webhook: Respuesta HTTP `200 OK` en $< 500\text{ ms}$.
   * Indicador visual de escritura (*Typing Indicator / Mark as Read*): Activado en $< 800\text{ ms}$.
   * Despacho del mensaje final de respuesta: Latencia media $< 2.0\text{ s}$ (P95 $< 3.5\text{ s}$).
2. **Cero Duplicidad (Idempotencia Garantizada):** Tolerancia cero a mensajes repetidos.
3. **Persistencia Atómica & Trazabilidad:** Todo intercambio queda auditado en base de datos con timestamps UTC, tokens consumidos y estado de entrega.

---

## ⚡ 2. Arquitectura de Ingesta & Idempotencia de Mensajes

WhatsApp (Meta Cloud API o proveedores BSP) utiliza reintentos agresivos ante la menor degradación de red. Un sistema empresarial debe ser intrínsecamente **idempotente**.

```text
[ Webhook Entrante ]
         │
         ▼
[ Extraer wamid: "wamid.HBgL..." ]
         │
         ├──► ¿Existe wamid en Cache/DB (TTL 24h)?
         │          │
         │          ├── [ SÍ ] ──► Registrar LOG "Duplicado detectado" ──► Retornar HTTP 200 OK (Descartar ejecución)
         │          │
         │          └── [ NO ] ──► Insertar wamid (Estado: 'PROCESSING')
         │                               │
         │                               ▼
         │                 [ Encolar Evento en Cola de Tareas ]
         │                               │
         │                               ▼
         │                     Retornar HTTP 200 OK a Meta
```

### Reglas de Implementación de Idempotencia:
1. **Clave Primaria Única:** El identificador del mensaje emitido por WhatsApp (`wamid` o `id`) debe ser el identificador único o índice con restricción `UNIQUE` en la tabla de mensajes entrantes.
2. **Registro Preventivo:** El registro del `wamid` debe ocurrir **antes** de disparar la inferencia del modelo de lenguaje, evitando condiciones de carrera si dos peticiones concurrentes llegan con milisegundos de diferencia.
3. **Ventana de Retención (TTL):** La caché de deduplicación debe conservar los identificadores por al menos **24 horas**, que es la ventana estándar de reintentos de Meta.

---

## 📦 3. Patrón Transactional Outbox para Despacho de Mensajes

El envío de un mensaje a la API de WhatsApp es una operación de red externa que puede sufrir caídas, latencia o límites de concurrencia. **Nunca se debe ejecutar una llamada de red externa bloqueante dentro de una transacción crítica de base de datos.**

```text
┌──────────────────────────┐       ┌──────────────────────────┐       ┌──────────────────────────┐
│   MOTOR AGÉNTICO / IA    │ ────► │      TABLA OUTBOX        │ ────► │     OUTBOX DISPATCHER    │
│  Genera la respuesta y   │       │ (Base de datos local)    │       │ (Worker asíncrono)       │
│  actualiza la sesión     │       │ id | to | payload | stat │       │ Despacha a WhatsApp API  │
└──────────────────────────┘       └──────────────────────────┘       └────────────┬─────────────┘
                                                                                   │
                                                                                   ▼
                                                                      ┌──────────────────────────┐
                                                                      │     META GRAPH API       │
                                                                      └──────────────────────────┘
```

### Ventajas del Patrón Outbox:
* Si Meta API está temporalmente degradada, las respuestas quedan seguras en la tabla `outbox` con reintentos automáticos mediante *Exponential Backoff*.
* Se previene la pérdida de mensajes ante caídas del servidor.
* Desacoplamiento total entre la lógica del agente y la entrega física del mensaje.

---

## 🛡️ 4. Circuit Breaker & Gestión de Cuotas de Modelos de IA

Las APIs de modelos de lenguaje (Gemini, OpenAI, Claude) imponen límites de cuota (RPM / TPM) y sufren cortes ocasionales. Un chatbot corporativo no puede colapsar cuando el proveedor de IA falla.

```text
                    ┌─────────────────────────┐
                    │   ESTADO: NORMAL (CERRADO)│
                    │   Peticiones fluyen a LLM│
                    └───────────┬─────────────┘
                                │ 3 errores 429/500 seguidos
                                ▼
                    ┌─────────────────────────┐
                    │ ESTADO: PROTEGIDO (ABIERTO)│
                    │ Tráfico conmuta a       │
                    │ Respuestas Deterministas│
                    └───────────┬─────────────┘
                                │ Transcurridos 60 segundos
                                ▼
                    ┌─────────────────────────┐
                    │ ESTADO: PRUEBA (MEDIO)   │
                    │ Envía 1 petición de prueba│
                    └─────────────────────────┘
```

### Estrategia de Mitigación de Fallos:
1. **Fallback Determinista Inmediato:**
   Si la llamada a la IA excede un timeout de $3.0\text{ s}$ o retorna error `429 Too Many Requests`, el sistema conmuta instantáneamente a una plantilla de contingencia:
   > *"Hola [Nombre], estamos recibiendo un volumen inusual de consultas. He registrado tu solicitud y un asesor del equipo se comunicará contigo por este mismo chat en breve."*
2. **Provider Redundante (Multi-LLM Failover):**
   Capacidad de alternar entre proveedores primarios y secundarios (ejemplo: Gemini 2.5 Flash como motor principal por velocidad y costo, con fallback a Claude 3.5 Sonnet / OpenAI ante incidentes).
3. **Caché Semántica para Preguntas Frecuentes (FAQ):**
   Consultas idénticas sobre horarios, ubicación, métodos de pago o catálogos se resuelven mediante respuestas deterministas o caché en memoria, con costo en tokens de $\$0$ y latencia de $< 100\text{ ms}$.

---

## 🗄️ 5. Modelo de Datos & Gestión de Sesiones

### Principio de Aislamiento de Clientes (Multi-Tenant & Sesiones):
El identificador universal del cliente en WhatsApp es su número en formato E.164 (ejemplo: `+573001234567`, `+5215512345678`).

### Entidades Mínimas Requeridas:
1. **`contacts` / `customers`:**
   * `id`: UUID
   * `phone_number`: VARCHAR (Índice único, formato E.164 sanitizado)
   * `name`: VARCHAR (extraído del perfil de WhatsApp o solicitado en chat)
   * `status`: ENUM (`BOT_ACTIVE`, `HUMAN_HANDOFF`, `OPTED_OUT`)
   * `metadata`: JSONB (datos comerciales, empresa, etiquetas)
   * `created_at` / `updated_at`: TIMESTAMPTZ

2. **`conversations` / `sessions`:**
   * `id`: UUID
   * `customer_id`: FK `contacts.id`
   * `state`: ENUM (`GREETING`, `QUALIFYING`, `CATALOG_INQUIRY`, `CHECKOUT`, `SUPPORT`)
   * `context_summary`: TEXT (resumen compacto generado por el sistema)
   * `last_activity_at`: TIMESTAMPTZ (cierre automático de sesión tras inactividad)

3. **`messages`:**
   * `id`: VARCHAR (almacena el `wamid` oficial para garantizar unicidad)
   * `conversation_id`: FK `conversations.id`
   * `direction`: ENUM (`INBOUND`, `OUTBOUND`)
   * `content`: TEXT
   * `tokens_used`: INT (0 si fue determinista/humano)
   * `latency_ms`: INT
   * `created_at`: TIMESTAMPTZ

---

## ⚖️ 6. Cumplimiento Legal y Privacidad de Datos en LATAM

El despliegue comercial en países de la región (Colombia Ley 1581 Habeas Data, México LFPDPPP, Chile, Argentina) exige cumplimiento normativo obligatorio:

1. **Protocolo de Opt-Out Inviolable:**
   * Si el usuario escribe palabras clave universales de cancelación (**`BAJA`**, **`CANCELAR`**, **`STOP`**, **`NO ENVIAR`**), el sistema debe detener de inmediato todo envío automatizado y marcar el contacto como `OPTED_OUT`.
   * Este bloqueo debe ser ejecutado **por código determinista**, sin pasar por la interpretación del LLM.
2. **Consentimiento Explícito en Primer Contacto:**
   * En el primer mensaje a un nuevo usuario, incluir enlace a la Política de Tratamiento de Datos de la empresa.
3. **No Retención de Datos Financieros Sensibles:**
   * Prohibido solicitar o almacenar números de tarjetas de crédito o códigos CVV a través del chat de WhatsApp. Todos los cobros deben procesarse mediante enlaces seguros de pago (Stripe, Mercado Pago, Wompi, etc.).

---

## 📑 7. Resumen de Estándares para el Repositorio

| Dimensión | Estándar Obligatorio | Método de Verificación |
|---|---|:---:|
| **Webhooks** | HTTP 200 en $< 500\text{ ms}$, validación de firma HMAC SHA-256. | Test de carga y timeout simulado |
| **Idempotencia** | Descarte atómico de `wamid` duplicados sin re-ejecución. | Test unitario con payload duplicado |
| **Respuesta** | Latencia total $< 2.0\text{ s}$, indicador de escritura activo. | Monitoreo de APM / Logs |
| **Seguridad** | Cero tokens en código, variables en `.env`, sanitización anti-XSS/SQLi. | Linter de seguridad & git pre-commit |
| **Human Handoff** | Desconexión inmediata del bot al solicitar un asesor humano. | Test de guardrails deterministas |
| **Legal** | Soporte de comando `STOP` / `BAJA` con desactivación determinista. | Test de compliance automatizado |
