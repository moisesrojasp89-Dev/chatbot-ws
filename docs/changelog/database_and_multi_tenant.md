# 🗄️ Bitácora Técnica: Base de Datos, Multi-Tenant & Repositorios

> **Dominio:** Esquemas PostgreSQL, Migraciones DDL, Aislamiento RLS, Repositorios Tipados, Inbound Durable y Políticas de Retención.

---

## 🚀 Evolución y Decisiones Clave por Fase

### 1. Modelo de Datos Relacional & Migraciones DDL (Fase 2)
* **Tablas Principales:**
  * `contacts`: Directorio de remitentes con número telefónico e información de perfil.
  * `conversations`: Sesiones conversacionales con puntero al estado FSM (`current_state`), ventana de actividad y `context_summary`.
  * `messages`: Historial persistente con tipo (`text`, `image`, `interactive`), dirección (`inbound`/`outbound`), `wamid`, tokens consumidos y `latency_ms`.
  * `leads`: Registro calificado de intenciones comerciales (producto cotizado, intención, metadatos JSONB).
  * `handoff_sessions`: Gestión de transferencias a operadores humanos con notas y timeouts.
  * `audit_log`: Tabla append-only para trazabilidad forense de eventos de seguridad y llamadas a tools.
* **Migraciones Versionadas:**
  * Scripts SQL secuenciales en `src/database/migrations/` ejecutables de forma idempotente con `npm run migrate`.

### 2. Aislamiento Multi-Tenant & Row-Level Security (RLS)
* **Particionamiento Lógico por Negocio:**
  * Inyección de `business_id` / `tenant_id` en todas las consultas y repositorios.
  * Políticas de Row-Level Security (RLS) activadas para asegurar que ninguna consulta transversal filtre datos entre clientes corporativos.
  * Reclamos de colas scopeados por par `(sender_phone, phone_number_id)` para prevenir serialización cruzada o bloqueos mutuos entre diferentes empresas.

### 3. Inbound Durable (`inbound_events`) & Desacoplamiento (Fase 5B)
* **Persistencia Previa al ACK:**
  * Cada webhook entrante se persiste en `public.inbound_events` antes de retornar el HTTP 200 a Meta.
  * Garantiza que ningún mensaje se pierda ante caídas abruptas del proceso Node.js o reinicios del servidor.
* **Worker Inbound con Reclamo Competitivo:**
  * `SELECT ... FOR UPDATE OF i SKIP LOCKED` para permitir que múltiples instancias worker procesen eventos en paralelo sin carreras.
  * Fencing con `lock_token UUID` y lease expiratorio para permitir auto-recuperación de eventos colgados (Reaper).

### 4. Políticas de Retención y Minimización de Datos LGPD (Fase 5C)
* **Servicio `RetentionService`:**
  * Purga automática de eventos completados (`DONE`) con antigüedad mayor a 7 días.
  * Purga de eventos fallidos (`FAILED`) tras 90 días para auditoría forense.
  * Cumplimiento con principios de minimización de datos y privacidad en LATAM (LGPD Brasil, Ley 1581 Colombia).
