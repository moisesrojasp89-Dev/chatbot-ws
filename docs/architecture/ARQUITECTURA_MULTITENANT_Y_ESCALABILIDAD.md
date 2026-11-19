# 🏢 Chatbot WS — Arquitectura Multi-Tenant, Escalabilidad y Despliegue de Múltiples Clientes

> **Guía Estratégica de Arquitectura y Operaciones**  
> **Tema:** Cómo escalar el sistema a múltiples clientes sin duplicar repositorios, aislando datos y automatizando el despliegue.  
> **Versión:** 1.0 — Arquitectura Multi-Tenant

---

## 🔒 1. La Base de Datos Actual: ¿Se toca o no?

### **Respuesta Definitiva: NO, esa base de datos no se toca para clientes reales.**

La base de datos de desarrollo, pruebas y certificación es un **proyecto Supabase dedicado** (Staging/Dev), separado de cualquier base de clientes reales y configurado mediante `DATABASE_URL` + `TEST_PROJECT_REF`:

> **Nota de vigencia:** el proyecto histórico en São Paulo (`bsdaswbwxekfedqrzdzc`) fue eliminado de Supabase. Su ref ya no resuelve por DNS, por lo que el ref del proyecto de pruebas se configura con la variable `TEST_PROJECT_REF` (ver `src/utils/databaseGuard.ts`). El guard exige que `DATABASE_URL` pertenezca a ese ref antes de correr tests o migraciones.

```text
┌────────────────────────────────────────────────────────────────────────┐
│  BASE DE DATOS DE PRUEBAS (Staging / Dev - proyecto Supabase dedicado) │
│  • Es nuestro "laboratorio" de ingeniería.                             │
│  • Aquí corren los 155 tests automatizados.                            │
│  • Aquí probamos migraciones SQL antes de aplicarlas a clientes.       │
│  • Contiene datos de prueba y mocks de Meta.                           │
│  ⚠️ NUNCA se mezcla con clientes reales ni con ventas comerciales.     │
└────────────────────────────────────────────────────────────────────────┘
                                    │
       ┌────────────────────────────┼────────────────────────────┐
       ▼                            ▼                            ▼
[DB Cliente 1: Dealer Brasil] [DB Cliente 2: Tienda Ropa] [DB Cliente 3: Clínica]
(Totalmente aislada)         (Totalmente aislada)        (Totalmente aislada)
```

Cada cliente nuevo que tu hermano consiga tendrá **su propia base de datos limpia y aislada**, garantizando que los datos de sus clientes, cotizaciones y ventas permanezcan 100% privados y seguros.

---

## 🏛️ 2. ¿Cómo se administra el Código en GitHub? (Motor Maestro)

### La Regla de Oro: **UN SOLO REPOSITORIO CENTRAL**

No creamos un repositorio de GitHub nuevo para cada cliente. El repositorio que tienes actualmente (`Chatbot WS`) es el **Motor Maestro de Software (Core Engine)**.

```text
                       TU GITHUB CENTRAL (`Chatbot WS`)
                                     │
                 ┌───────────────────┼───────────────────┐
                 │ (Mismo código)    │ (Mismo código)    │ (Mismo código)
                 ▼                   ▼                   ▼
           [Contenedor 1]      [Contenedor 2]      [Contenedor 3]
           Dealer Autos        Tienda de Ropa      Clínica Médica
           (Lee .env.dealer)   (Lee .env.tienda)   (Lee .env.clinica)
```

### ¿Por qué esta es la forma profesional?
1. **Actualizaciones en 5 segundos:** Si mañana Meta actualiza su API de WhatsApp, o agregamos una mejora al motor LLM, o conectamos Instagram DMs, tú haces un solo `git push` en tu GitHub y **todos tus clientes reciben la mejora al instante**.
2. **Cero Deuda Técnica:** Si tuvieras 10 repositorios distintos, tendrías que abrir 10 proyectos, cambiar código a mano 10 veces y probar 10 veces. Con un repositorio maestro, tu costo de mantenimiento es casi cero.
3. **Control Total:** Tú eres el único dueño del código fuente. Los clientes solo compran el acceso al servicio, no tu propiedad intelectual.

---

## 🗄️ 3. Aislamiento de Base de Datos para Cada Cliente

Para las empresas que contraten el servicio, la privacidad de datos es sagrada (la tienda de autos no puede ver los clientes de la clínica médica).

### Modelo Recomendado: Un Proyecto de Supabase por Cliente
* Para cada cliente que firme contrato, entras a tu cuenta de Supabase y creas un proyecto nuevo (tarda 2 minutos):
  * Ejemplo: `prod-dealer-brasil`
* En la terminal ejecutas la migración automática:
  ```bash
  DATABASE_URL="postgres://<USER>:<PASSWORD>@<SUPABASE_POOLER>:5432/postgres" npm run migrate
  ```
  Usa el **Session Pooler (puerto 5432)**: las migraciones toman un `pg_advisory_lock` de sesión y el Transaction Pooler (6543) no garantiza estado de sesión.
* En 10 segundos, ese nuevo proyecto de Supabase tiene creadas todas las tablas (`contacts`, `conversations`, `messages`, `outbox_messages`, etc.) completamente vacías y listas para ese cliente.

---

## 🐳 4. Cómo Corre en el Servidor (VPS): Dockerización

En un solo servidor VPS de **$10 USD / mes** (Hetzner, <VPS_PROVIDER> o AWS), corre **Docker**.

Cada cliente es un **Contenedor** que corre el mismo código compilado, pero alimentado por su propio archivo de variables de entorno:

### Estructura en el Servidor:
```text
/opt/chatbot-ws/
├── dist/                   # Código compilado maestro (idéntico para todos)
├── docker-compose.yml      # Orquestador de clientes
├── .env.dealer-brasil      # Token de WhatsApp del Dealer + DB del Dealer
├── .env.tienda-ropa        # Token de WhatsApp de la Tienda + DB de la Tienda
└── .env.clinica-medica     # Token de WhatsApp de la Clínica + DB de la Clínica
```

### ¿Qué contiene el archivo `.env` de cada cliente?
Es lo único que cambia entre una empresa y otra:
1. `META_PHONE_NUMBER_ID`: El número de WhatsApp oficial del cliente.
2. `META_ACCESS_TOKEN`: El token de Meta de ese negocio.
3. `DATABASE_URL`: La conexión a su base de datos aislada en Supabase.
4. `SYSTEM_PROMPT`: La personalidad, tono y reglas del negocio (vendedor de autos en portugués, asesor de moda en español, etc.).

---

## ⚡ 5. Manual Operativo: Cómo Activar un Cliente Nuevo en 20 Minutos

Cuando tu hermano te diga: *"¡Listo Moisés, el Dealer de Brasil firmó y pagó el Setup!"*, este es tu checklist paso a paso:

```text
┌────────────────────────────────────────────────────────────────────────┐
│               CHECKLIST DE ACTIVACIÓN DE NUEVO CLIENTE                 │
├────────────────────────────────────────────────────────────────────────┤
│ 1. ALTA EN SUPABASE (3 min)                                           │
│    • Crear proyecto en Supabase (región São Paulo sa-east-1).          │
│    • Ejecutar `npm run migrate` con la URL de la nueva DB.             │
│                                                                        │
│ 2. CARGA DE CATÁLOGO (5 min)                                          │
│    • Importar el inventario de autos/productos a la tabla del catálogo.│
│                                                                        │
│ 3. CREDENCIALES DE META (5 min)                                        │
│    • Obtener el Phone Number ID y Token en el Meta Business Manager.   │
│    • Registrar el Webhook URL en Meta: `https://tudominio.com/webhook` │
│                                                                        │
│ 4. CONFIGURACIÓN DEL .ENV (2 min)                                      │
│    • Crear `.env.nombre-cliente` con sus credenciales y su prompt.     │
│                                                                        │
│ 5. LANZAR CONTENEDOR DOCKER (1 min)                                   │
│    • Ejecutar: `docker compose up -d bot-nombre-cliente`               │
│                                                                        │
│ 6. TEST EN VIVO (4 min)                                                │
│    • Mandar un mensaje de prueba al WhatsApp desde tu teléfono.        │
│    • Verificar que responda en < 2 segundos.                           │
└────────────────────────────────────────────────────────────────────────┘
```

**Tiempo total de trabajo técnico:** **¡20 minutos!**  
Y a cambio, cobraste entre **$350 y $600 USD de Setup** más una mensualidad asegurada de **$150 a $300 USD / mes**.

---

## 🔀 6. ¿Qué pasa si un cliente pide algo súper personalizado? (Git Branching)

Si el 95% de los clientes usan el bot estándar, pero una empresa muy grande te pide una integración exclusiva con un software contable o un ERP privado:
* **NO creas un repositorio nuevo.**
* En tu mismo GitHub creas una **Rama (Branch)**:
  ```bash
  git checkout -b cliente-corporativo-x
  ```
* Desarrollas la función exclusiva en esa rama.
* Si más adelante haces mejoras de seguridad en la rama principal (`main`), puedes incorporar esas mejoras a la rama del cliente con un simple `git merge main`.

---

## 📋 7. Resumen Ejecutivo para la Toma de Decisiones

| Elemento | ¿Cómo se maneja? | Responsable |
|---|---|:---:|
| **Código Fuente** | **1 solo repositorio en tu GitHub (`Chatbot WS`)**. | Moisés (Control Total) |
| **Base de Datos Actual** | **Se queda intacta como laboratorio de pruebas y certificación.** | Moisés / Tests |
| **Bases de Datos Nuevas** | **1 proyecto nuevo en Supabase por cada cliente que pague.** | Automático vía script |
| **Servidor** | **1 solo VPS de $10 USD/mes corriendo Docker para todos.** | Infraestructura Compartida |
| **Ventas y Clientes** | **Conseguir los números de WhatsApp y los catálogos.** | Tu Hermano |

Con esta arquitectura, el negocio es **ultra-escalable, limpio, seguro y fácil de mantener**.
