/**
 * Constantes globales del sistema Chatbot WS
 */

export const CONSTANTS = {
  // Configuración de Rate Limiting (Token Bucket)
  RATE_LIMIT: {
    MAX_TOKENS: 10,              // 10 mensajes permitidos
    REFILL_INTERVAL_MS: 60000,   // Ventana de 1 minuto (60 segundos)
  },

  // Tiempos y SLAs
  SLA: {
    WEBHOOK_GATEWAY_TIMEOUT_MS: 500, // SLA máximo de acuse de recibo
    TYPING_CADENCE_MIN_MS: 1500,     // Retardo natural mínimo
    TYPING_CADENCE_MAX_MS: 2500,     // Retardo natural máximo
  },

  // F4-C5: Configuración del Circuit Breaker de Red (Meta Graph API)
  CIRCUIT_BREAKER: {
    FAILURE_THRESHOLD: 5,        // Número consecutivo de fallos para abrir circuito
    RESET_TIMEOUT_MS: 30000,     // Tiempo en estado OPEN antes de probar HALF-OPEN (30s)
    HALF_OPEN_SUCCESSES: 2,      // Éxitos consecutivos necesarios para cerrar circuito
  },

  // Configuración del Transactional Outbox Worker
  OUTBOX: {
    POLL_INTERVAL_MS: 500,       // Intervalo de sondeo en background (500ms)
    BATCH_SIZE: 10,              // Mensajes reclamados por ciclo con SKIP LOCKED
    MAX_RETRIES: 3,              // Reintentos máximos antes de marcar FAILED
    BACKOFF_BASE_SECONDS: 1,     // Base de backoff exponencial: 1s, 2s, 4s
    REAPER_INTERVAL_MS: 30000,   // Frecuencia de escaneo de filas huérfanas (30s)
    REAPER_TIMEOUT_MINUTES: 2,   // Tiempo de expiración de lease para considerar fila huérfana (2 min)
  },

  // Auditor 5B (I18): Configuración del Inbound Worker Daemon
  INBOUND: {
    POLL_INTERVAL_MS: 500,       // Intervalo de sondeo en background (500ms)
    BATCH_SIZE: 10,              // Mensajes reclamados por ciclo con SKIP LOCKED
    CONCURRENCY_LIMIT: Number(process.env.INBOUND_CONCURRENCY ?? 10), // Fase 5C (C12): Concurrencia máxima del Sliding Pool
    COALESCE_MAX_MESSAGES: 5,    // Fase 5C: Límite máximo de mensajes coalescidos por turno
    MAX_RETRIES: 3,              // Reintentos máximos antes de marcar FAILED
    BACKOFF_BASE_SECONDS: 1,     // Base de backoff exponencial: 1s, 2s, 4s
    LEASE_TIMEOUT_SECONDS: 45,   // Tiempo de expiración de lease para reaper (45s > 24s deadline)
    LLM_TIMEOUT_MS: 20000,       // Timeout de llamada a proveedor LLM (20s)
    MAX_MESSAGE_AGE_MS: 1800000, // Umbral de frescura de mensaje (30 min) tras caída
    RETENTION_DAYS: 7,           // Días de retención para eventos DONE (LGPD / Minimización PII)
  },

  // Estados FSM de la Conversación
  FSM_STATES: {
    IDLE: 'IDLE',
    QUALIFYING: 'QUALIFYING',
    CATALOG_QUERY: 'CATALOG_QUERY',
    BOOKING: 'BOOKING',
    CLOSING: 'CLOSING',
    CLOSED: 'CLOSED',
    HUMAN_ESCALATION: 'HUMAN_ESCALATION',
  } as const,

  // Estados de Contacto
  CONTACT_STATUS: {
    BOT_ACTIVE: 'BOT_ACTIVE',
    HUMAN_HANDOFF: 'HUMAN_HANDOFF',
    OPTED_OUT: 'OPTED_OUT',
  } as const,

  // Mensajes predeterminados del sistema
  MESSAGES: {
    RATE_LIMIT_WARNING: 'Por favor, espera unos segundos antes de enviar nuevos mensajes.',
    FALLBACK_DEMAND: 'En este momento estamos experimentando una alta demanda. Un asesor humano revisará tu mensaje en breve.',
    HANDOFF_ALERT: 'Te he conectado con nuestro equipo. Un asesor tomará el chat enseguida.',
  },
} as const;
