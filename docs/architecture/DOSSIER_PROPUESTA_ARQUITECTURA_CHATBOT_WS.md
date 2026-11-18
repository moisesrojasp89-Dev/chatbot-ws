# 📑 Dossier Técnico: Estudio de Arquitectura, Psicología Conversacional & Propuestas Tecnológicas (Chatbot WS)

**Documento:** `docs/DOSSIER_PROPUESTA_ARQUITECTURA_CHATBOT_WS.md`  
**Estado:** Propuesta Técnica para Revisión y Auditoría  
**Versión:** 1.0  
**Fecha:** Septiembre 2026  
**Audiencia:** Fundadores, Arquitectos de Software y Líderes de Producto  

---

## 🧭 Introducción & Justificación Estratégica

Este dossier ha sido elaborado para servir como **marco de decisión integral** antes de iniciar la construcción del código fuente. 

El objetivo es erradicar la precariedad actual del mercado de automatización en América Latina (bots lentos, caídas de servicio, respuestas frías y banales que espantan a los clientes, y riesgos de baneo de líneas telefónicas comerciales).

---

## 🏛️ 1. ¿Cómo Funciona Realmente un Chatbot de WhatsApp Empresarial? (El Viaje del Mensaje)

Para tomar decisiones informadas, es vital comprender el flujo que ocurre en milisegundos desde que el cliente pulsa "Enviar" en su teléfono hasta que recibe la respuesta:

```
[ CLIENTE EN WHATSAPP ] 
      │ Escribe: "¿Qué precio tiene el servicio X?"
      ▼
[ SERVIDORES DE META (WHATSAPP CLOUD) ]
      │ Dispara un HTTPS POST Webhook con payload JSON
      ▼
[ TU SERVIDOR BACKEND (WEBHOOK CONTROLLER) ]
      │ 1. Valida firma de seguridad HMAC SHA-256 (autenticidad).
      │ 2. Extrae ID del mensaje (wamid) y número del cliente.
      │ 3. Responde HTTP 200 OK a Meta de inmediato (< 500ms).
      │ 4. Encola la tarea en el worker de procesamiento asíncrono.
      ▼
[ WORKER & MOTOR AGÉNTICO (HARNESS) ]
      │ 1. Activa indicador "Escribiendo..." en el chat del cliente.
      │ 2. Busca en Base de Datos: Historial, nombre, estado en el embudo.
      │ 3. Evalúa Guardrails: ¿Solicita hablar con un humano? ¿Intenta jailbreak?
      │ 4. Inyecta Contexto al LLM (Gemini): Instrucciones de tono + Tools (Catálogo/Precios).
      │ 5. El Modelo razona y genera respuesta concisa o llama a la Tool de Precios.
      ▼
[ OUTBOX DISPATCHER ]
      │ Formatea la respuesta (negritas de WhatsApp, botones interactivos, emojis moderados).
      │ Envía la respuesta vía Meta Graph API.
      ▼
[ CLIENTE EN WHATSAPP ] 
      Recibe respuesta fluida y precisa en < 2.0 segundos.
```

---

## 🎭 2. Psicología Conversacional: Cómo Sonar Profesional, Cálido y Humano (Evitar Fuga de Clientes)

El mayor motivo por el que los usuarios en LATAM abandonan una conversación con un bot es la **frustración por deshumanización**: textos kilométricos, saludos robóticos repetitivos y la sensación de hablar contra una pared.

### A. Los 5 Vicios que Espantan al Cliente:
1. **La "Biblia" de Texto:** Enviar un párrafo de 30 líneas. En WhatsApp la gente lee en diagonal en pantallas de 6 pulgadas.
2. **El Saludo Bucle:** Si el cliente escribe 4 mensajes, responder los 4 con: *"¡Hola! Claro que sí, con mucho gusto..."*.
3. **La Respuesta a Velocidad Luz Inhumana:** Responder un mensaje complejo en $0.05\text{ segundos}$ resulta antinatural y confirma inmediatamente que es una máquina sin criterio.
4. **Falta de Salida Humana Fácil:** Forzar al cliente a navegar menús numéricos infinitos sin poder pedir ayuda de una persona.
5. **Lenguaje Excesivamente Rebuscado:** Usar frases como *"Estimado usuario, he procedido a verificar en nuestro sistema central..."* en lugar de *"¡Hola Carlos! Ya mismo te confirmo el precio..."*.

### B. Las 5 Leyes para un Tono Humano y Altamente Converso:
1. **La Ley del Micro-Mensaje:** Respuestas directas de máximo 2 a 4 líneas. Si hay dos ideas distintas, se envían dos mensajes breves concatenados.
2. **Retardo Humano Simulado (*Natural Typing Cadence*):**
   * Mostrar el estado `"typing..."` durante 1.5 a 2.5 segundos.
   * Psicológicamente, esto genera anticipación y transmite la sensación de que alguien está redactando con atención.
3. **Escucha Activa y Nombres Propios:**
   * Usar el nombre del cliente de forma natural (extraído de su perfil o pedido al inicio).
   * Confirmar lo que el cliente preguntó antes de responder: *"Entiendo, buscas para entrega en Bogotá..."*.
4. **Preguntas de Cierre Operativas:**
   * Nunca terminar una respuesta en punto muerto. Concluir siempre con una pregunta que facilite el siguiente paso:
     * *Ejemplo:* *"¿Te gustaría que te agende una videollamada de 15 minutos para ver la demo o prefieres que te envíe el PDF resumen?"*.
5. **Transparencia Amigable:**
   * No engañar diciendo que eres una persona de carne y hueso si preguntan directamente, pero presentarse con calidez ejecutiva:
     > *"¡Hola! Soy Sofía, asistente virtual de [Empresa]. Estoy aquí para darte información inmediata, cotizar y ayudarte en segundos. Si en cualquier momento prefieres un asesor humano, solo dímelo."*

---

## 📡 3. Comparativa de Canales de Conexión a WhatsApp

Existen tres formas de conectar un software a WhatsApp. Esta es la auditoría de cada una:

| Criterio | Opción 1: Meta Cloud API Oficial (Directa) | Opción 2: BSPs Intermediarios (Twilio, WATI, etc.) | Opción 3: Emulación Web/Sockets (Baileys, WPPConnect) |
|---|:---:|:---:|:---:|
| **Legalidad / Términos de Meta** | 100% Oficial y Autorizado | 100% Oficial (Reventa de Meta) | **Viola Términos de Servicio de Meta** |
| **Riesgo de Baneo de la Línea** | **0% Riesgo de Baneo** | **0% Riesgo de Baneo** | **Riesgo MUY ALTO de Baneo Irreversible** |
| **Costo por Intermediario** | **$0 / mes** (Solo pagas a Meta) | $50 a $250 / mes + sobrecosto por mensaje | $0 / mes (Open Source) |
| **Costos de Mensajería Meta** | Primeras 1,000 conversaciones de servicio al mes son **GRATIS** | Meta cobra + recargo del proveedor | Gratis (pero con riesgo de bloqueo de SIM) |
| **Funciones Avanzadas** | Botones interactivos, listas desplegables, catálogos, plantillas oficiales | Soporte estándar | Soporte limitado y frágil a cambios de WhatsApp Web |
| **Estabilidad de Conexión** | 99.9% Uptime garantizado por Meta | 99.5% Uptime | Se desconecta al cerrar sesión o actualizar la app |

### 💡 Veredicto de Arquitectura:
* Para una empresa que cuida su marca y su línea telefónica comercial, **la única opción admisible es la Meta Cloud API Oficial**.
* Perder el número de teléfono corporativo por un baneo de Meta debido a librerías no oficiales destruye la confianza del cliente corporativo.
* La API oficial de Meta directa (sin intermediarios como Twilio) nos da **costo $0 de plataforma**, control total del código y máxima velocidad.

---

## 💻 4. Comparativa de Pila Tecnológica (Tech Stack)

### Opción A: Ecosistema Node.js / TypeScript (Pila Recomendada)
* **Backend:** Node.js con Fastify o Express en TypeScript.
* **Procesamiento de Colas & Idempotencia:** Redis + BullMQ (maneja miles de webhooks en paralelo sin colapsar).
* **Base de Datos & Auth:** PostgreSQL (mediante Supabase o base de datos propia).
* **Motor de IA:** SDK oficial de Google Gen AI (`@google/genai` con modelo **Gemini 2.5 Flash**).
* **Ventajas:**
  * Fastify/Node maneja I/O concurrente de forma sobresaliente (ideal para webhooks de mensajería).
  * Tipado estricto con TypeScript para evitar errores en tiempo de ejecución.
  * Ecosistema masivo de librerías para WhatsApp y validación de schemas (Zod).

### Opción B: Ecosistema Python (Pila Alternativa)
* **Backend:** Python con FastAPI + Uvicorn.
* **Colas & Tareas:** Celery + Redis o RQ.
* **Base de Datos:** PostgreSQL con SQLAlchemy / Tortoise ORM.
* **Motor de IA:** Google GenAI Python SDK.
* **Ventajas:**
  * Excelente si se planea integrar procesamiento de datos masivo, embeddings locales o frameworks de investigación.
  * Ligeramente mayor consumo de RAM por worker en concurrencia masiva comparado con Node.

---

## 💰 5. Estructura de Costos Reales de Operación

Para que el modelo de negocio sea transparente y rentable:

1. **Meta WhatsApp Cloud API:**
   * Conversaciones iniciadas por el usuario (Servicio al Cliente): Las primeras **1,000 conversaciones al mes son GRATIS**. Luego, aproximadamente $\$0.01$ a $\$0.03$ USD por conversación de 24 horas (según el país de LATAM).
2. **Inferencia de IA (Gemini 2.5 Flash):**
   * Gemini 2.5 Flash tiene un costo aproximado de $\$0.075$ USD por millón de tokens de entrada y $\$0.30$ USD por millón de salida.
   * Una conversación promedio consume $\approx 2,000$ tokens ($\approx \$0.0003$ USD).
   * **Costo de IA por cada 1,000 conversaciones: menos de $\$0.50$ USD.**
3. **Infraestructura Cloud (Servidor / VPS):**
   * Servidor VPS Linux (2 vCPU, 4GB RAM) o contenedor en Render/Railway/Fly.io: $\approx \$7$ a $\$15$ USD / mes.

---

## 📋 6. Hoja de Ruta Propuesta (Roadmap por Fases Sin Prisa)

```
┌─────────────────────────┐
│ FASE 1: AUDITORÍA &     │ ──► Alineación del Dossier, elección del Stack y definición
│ DISEÑO DE IDENTIDAD     │     de la personalidad del bot.
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│ FASE 2: ENTORNO BASE &  │ ──► Configuración de TypeScript/Fastify, variables tipadas,
│ WEBHOOK GATEWAY         │     validación HMAC y control de idempotencia de Meta.
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│ FASE 3: HARNESS & IA    │ ──► Integración de Gemini 2.5 Flash con schemas tipados,
│ (CEREBRO CONTROLADO)    │     ventana móvil de contexto, guardrails y typing delay.
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│ FASE 4: TOOLS & NEGOCIO │ ──► Conexión a Base de Datos (catálogo de productos,
│                         │     captura de leads en CRM, protocolo de Human Handoff).
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│ FASE 5: SUITE DE EVALS  │ ──► Batería de 30 pruebas automatizadas y despliegue piloto.
└─────────────────────────┘
```
