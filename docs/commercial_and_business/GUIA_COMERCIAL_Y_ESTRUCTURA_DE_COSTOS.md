# 💼 Chatbot WS — Guía Comercial, Modelo de Negocio y Estructura de Costos

> **Documento Estratégico para el Equipo Comercial y Ventas**  
> **Producto:** Chatbot Empresarial de Respuesta Inmediata con Inteligencia Artificial (WhatsApp Cloud API)  
> **Región Objetivo:** LATAM (Colombia, México, Brasil, Chile, Perú, etc.)  
> **Versión:** 1.0 — Comercial & Operaciones

---

## 🎯 1. ¿Qué es exactamente lo que vendemos?

No vendemos un "bot básico de botones" ni un software que envía mensajes masivos de spam (que provocan el bloqueo del número).

Vendemos un **Sistema Empresarial de Atención Comercial de Respuesta Inmediata**:
1. **Respuesta en menos de 2 segundos (< 2s):** En ventas digitales por WhatsApp, el 70% de los clientes compra al primero que le responde. Si una empresa tarda 15 minutos, el cliente ya le compró a la competencia.
2. **Inteligencia Artificial con Límites Estrictos (Guardrails):** La IA razona con fluidez humana pero **tiene prohibido inventar precios, inventar promociones o salirse del catálogo oficial** de la empresa.
3. **Calificación y Captura de Leads:** Identifica el interés real del cliente, recopila sus datos y, cuando está listo para pagar o requiere atención especializada, lo transfiere con todo el historial a un asesor humano.
4. **Infraestructura Anti-Caídas (Transactional Outbox):** Si Meta o el internet de la empresa parpadea, ningún mensaje se pierde ni se duplica.

---

## 💸 2. Desglose Real de Costos de Infraestructura (Lo que nos cuesta operarlo)

El sistema funciona con **4 componentes tecnológicos**. Aquí está el costo real de cada uno para que conozcas los márgenes exactos:

```text
[Cliente en WhatsApp]
         │
         ▼
[1. Meta Cloud API] ──► [2. Servidor VPS] ──► [3. Base de Datos Supabase]
                               │
                               ▼
                      [4. Inteligencia Artificial]
```

### A. Servidor en la Nube (VPS)
* **¿Qué hace?** Es la computadora en la nube donde corre el código del bot las 24 horas del día.
* **Proveedores recomendados:** Hetzner Cloud (Europa/USA), <VPS_PROVIDER> o AWS Lightsail.
* **Costo real:** **$5.00 a $10.00 USD al mes**.
* **Capacidad:** Un solo servidor de $10 USD/mes tiene potencia suficiente para correr los bots de **3 a 5 empresas pequeñas/medianas simultáneamente**.

### B. Base de Datos (PostgreSQL en Supabase)
* **¿Qué hace?** Guarda los contactos, los mensajes, el catálogo de productos y el registro de ventas.
* **Costo inicial (Tier Gratuito):** **$0.00 USD**. Cubre hasta 500 MB (suficiente para más de 150,000 mensajes y miles de clientes).
* **Costo profesional (Supabase Pro):** **$25.00 USD al mes**. Para clientes corporativos grandes; incluye copias de seguridad diarias automáticas y almacenamiento de 8 GB.

### C. Cerebro de Inteligencia Artificial (Google Gemini 2.5 Flash)
* **¿Qué hace?** Lee la consulta del usuario, consulta el catálogo y redacta la respuesta natural.
* **Costo real:** Gemini es extraordinariamente económico:
  * ~$0.075 USD por 1 millón de tokens de entrada.
  * ~$0.30 USD por 1 millón de tokens de salida.
* **En lenguaje real:**
  * Cada 1,000 respuestas generadas por la IA cuestan apenas **$0.15 a $0.25 USD** (menos de un cuarto de dólar).
  * Para un negocio con 2,000 conversaciones al mes, el costo de IA ronda **$1.50 a $3.00 USD mensuales**.

### D. Meta WhatsApp Cloud API (La regla de las 24 horas)
* **Meta NO cobra por mensaje individual enviado o recibido.**
* **Meta cobra por "Ventana de Conversación de 24 horas":**
  * Cuando un cliente escribe al bot, se abre una ventana de 24 horas. Dentro de ese día, el cliente y el bot pueden intercambiar 5, 20 o 50 mensajes y Meta lo factura como **una sola conversación**.
* **El Regalo de Meta:** Cada cuenta de WhatsApp Business tiene **1,000 conversaciones de atención (Servicio) GRATIS todos los meses**.
* **Costo por conversación adicional (después de las 1,000 gratis):**
  * **Colombia / Perú / Chile / Argentina:** ~$0.012 a $0.025 USD por conversación.
  * **México:** ~$0.034 USD por conversación.
  * **Brasil:** ~$0.032 USD por conversación.

---

## 📊 3. Dos Ejemplos Prácticos con Números Reales

### Ejemplo 1: Negocio Pequeño / Local (Clínica, Tienda de Ropa, Restaurante)
* **Volumen mensual:** 800 conversaciones con clientes al mes (~4,000 mensajes).
* **Costos reales del mes:**
  * Servidor VPS (compartido): $5.00 USD
  * Base de datos (Supabase Free): $0.00 USD
  * Meta WhatsApp API: $0.00 USD *(dentro de las 1,000 gratis)*
  * IA Gemini: ~$1.00 USD
* **👉 Costo total operativo real:** **~$6.00 USD / mes**
* **👉 Precio sugerido de venta al cliente:** **$120.00 USD / mes**
* **💰 Ganancia Neta Mensual:** **~$114.00 USD (Margen del 95%)**

---

### Ejemplo 2: Empresa Mediana / E-commerce (Ventas continuas en redes sociales)
* **Volumen mensual:** 3,000 conversaciones con clientes al mes (~15,000 mensajes).
* **Costos reales del mes:**
  * Servidor VPS dedicado: $10.00 USD
  * Base de datos Supabase Pro: $25.00 USD
  * Meta WhatsApp API (1,000 gratis + 2,000 pagadas @ $0.030 USD): ~$60.00 USD
  * IA Gemini: ~$3.50 USD
* **👉 Costo total operativo real:** **~$98.50 USD / mes**
* **👉 Precio sugerido de venta al cliente:** **$350.00 USD / mes**
* **💰 Ganancia Neta Mensual:** **~$251.50 USD (Margen del 71%)**

---

## 🏷️ 4. Estructura Comercial Recomendada (Cómo cobrar)

Para vender este servicio a empresas, la mejor estrategia es dividir el cobro en dos partes:

```text
┌────────────────────────────────────────────────────────┐
│  1. SETUP / IMPLEMENTACIÓN INICIAL (Pago Único)         │
│     Rango: $350 a $800 USD                             │
├────────────────────────────────────────────────────────┤
│  2. MENSUALIDAD / MANTENIMIENTO (Ingreso Recurrente)    │
│     Rango: $100 a $450 USD / mes                       │
└────────────────────────────────────────────────────────┘
```

### 1. Tarifa de Setup (Pago único de instalación)
Se cobra al iniciar el proyecto para cubrir la configuración técnica:
* Alta y verificación oficial del número en Meta Cloud API (evita que WhatsApp bloquee la línea).
* Carga y estructuración de la base de datos con su catálogo, productos, servicios y preguntas frecuentes.
* Configuración del tono de voz, personalidad del bot y guardrails de seguridad.
* Pruebas de integración y puesta en marcha.

### 2. Planes Mensuales de Mantenimiento

| Nivel de Plan | Tipo de Cliente Ideal | Volumen Incluido | Costo Operativo | **Precio al Cliente** | Tu Margen Estimado |
|---|---|:---:|:---:|:---:|:---:|
| **Plan Básico** | Consultorios, firmas pequeñas, restaurantes, negocios de servicios locales. | Hasta 1,000 chats/mes | ~$6 a $10 USD | **$120 a $150 USD/mes** | **~90%** |
| **Plan Crecimiento** | Tiendas virtuales, inmobiliarias, academias, empresas de seguros. | Hasta 3,000 chats/mes | ~$70 a $100 USD | **$280 a $380 USD/mes** | **~70%** |
| **Plan Corporativo** | Distribuidores, concesionarios, múltiples sedes o catálogos dinámicos. | Personalizado (>5k chats) | Variable | **$500 a $900 USD/mes** *(+ Meta al costo)* | **Altamente rentable** |

> 💡 **Consejo Comercial Pro:** En planes medianos y grandes, puedes cobrar una cuota fija por el software y soporte (ej. $200 USD/mes) y hacer que el cliente registre su propia tarjeta en el Meta Business Manager para que los consumos variables de WhatsApp los pague Meta directamente a su tarjeta. Así **tú nunca asumes riesgo de saldo negativo**.

---

## 🛠️ 5. ¿Qué incluye el "Mantenimiento Mensual"? (Justificación del cobro)

Cuando el cliente pregunte: *"¿Por qué tengo que pagar una mensualidad si el bot ya está programado?"*, se le entrega esta lista de valor continuo:

1. **Garantía de Disponibilidad 24/7 (Uptime):** Monitoreo permanente del servidor en la nube para asegurar que el bot responda al instante en cualquier momento (noches, fines de semana, días festivos).
2. **Actualizaciones de Catálogo Incluidas:** Modificación de precios, incorporación de nuevos productos o promociones especiales (ej. 2 a 4 cambios mensuales incluidos en la cuota).
3. **Seguridad y Actualizaciones de API de Meta:** Meta actualiza su Graph API varias veces al año. El mantenimiento garantiza que la integración no quede obsoleta ni deje de funcionar.
4. **Respaldo de Base de Datos y Registro de Leads:** Almacenamiento seguro de todos los clientes y cotizaciones generadas.
5. **Afinación Continua del Modelo de IA:** Análisis periódico de las conversaciones para ajustar las instrucciones de la IA, reduciendo malentendidos y aumentando las ventas cerradas.

---

## 🎯 6. El Argumento Imbatible de Venta (El "Pitch")

Este es el guion central para presentarle la propuesta al dueño del negocio o director comercial:

> *"Estimado [Nombre del Cliente],*
> 
> *Un asesor de ventas humano te cuesta entre **$400 y $700 USD al mes** (más prestaciones sociales). Ese asesor atiende de 8:00 AM a 6:00 PM, atiende un solo chat a la vez, tarda en responder cuando está ocupado y no trabaja domingos ni festivos.*
> 
> *Si un cliente te escribe a las 9:00 PM con ganas de comprar y nadie le responde en 5 minutos, se va a Google o a Instagram y le compra a tu competencia.*
> 
> *Nuestro sistema de Inteligencia Artificial atiende **en menos de 2 segundos**, conoce de memoria el 100% de tu catálogo de productos y precios, atiende a 50 personas al mismo tiempo sin saturarse, las 24 horas del día, los 365 días del año. Y cuando detecta que el cliente está listo para pagar o agendar, se lo transfiere a tu equipo con los datos listos en bandeja.*
> 
> *Todo eso cuesta una fracción de lo que pagas por un salario mínimo: apenas **$120 a $250 USD al mes**. Con que el bot recupere 2 o 3 ventas que hoy se te escapan en la noche, el sistema se paga completamente solo."*

---

## 🛡️ 7. Manejo de Preguntas y Objeciones Comunes

### Objeción 1: *"¿Por qué no uso ManyChat o una herramienta barata de $15 dólares?"*
* **Respuesta:** *"ManyChat funciona con flujos rígidos de botones ('Presione 1 para ventas, presione 2 para soporte'). Si el cliente escribe con faltas de ortografía, envía una nota de voz o hace una pregunta compuesta, el bot se rompe y dice 'No te entendí'. Nuestro sistema usa Inteligencia Artificial generativa conectada a tu base de datos: razona, entiende contexto, negocia con naturalidad y responde en lenguaje fluido."*

### Objeción 2: *"¿La Inteligencia Artificial no va a inventar precios o decir cosas inapropiadas?"*
* **Respuesta:** *"No. Nuestro sistema cuenta con 4 niveles de seguridad por código (Guardrails). La IA está bloqueada estrictamente para que solo pueda cotizar lo que existe en el catálogo verificado. Si alguien intenta engañarla pidiéndole descuentos no autorizados, el sistema detecta la anomalía y mantiene firme la política de la empresa."*

### Objeción 3: *"¿Me pueden bloquear el número de WhatsApp?"*
* **Respuesta:** *"No, porque no usamos métodos piratas de emulación web (como escanear códigos QR que Meta bloquea al cabo de semanas). Trabajamos a través de la **API Oficial de Meta WhatsApp Cloud**, lo que le da a tu número legitimidad total, estabilidad y la posibilidad de solicitar la insignia verde de negocio verificado."*

---

## 📋 8. Resumen Ejecutivo de Ganancias (Escenario a 6 Meses)

Si tu hermano consigue una cartera modesta de apenas **10 clientes**:
* **Ingreso por Setups iniciales (10 × $400 USD):** **$4,000 USD** (pago de entrada).
* **Ingreso Recurrente Mensual (10 × $180 USD promedio):** **$1,800 USD / mes**.
* **Costo de Servidores e Infraestructura para los 10 bots:** **~$120 USD / mes**.
* **💰 Beneficio Neto Recurrente:** **~$1,680 USD limpios todos los meses**.

Este negocio es de **alta retención**: una vez que una empresa instala un bot que le genera ventas y atiende a sus clientes en las noches, **casi nunca lo cancela**, convirtiéndose en un flujo de caja predecible y escalable.
