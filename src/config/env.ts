import dotenv from 'dotenv';
import { z } from 'zod';

// Cargar variables de entorno desde .env
dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Credenciales del adaptador Meta/WhatsApp: obligatorias solo si
  // CHANNELS_ENABLED incluye "whatsapp" (se validan al arrancar el canal).
  META_ACCESS_TOKEN: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(10).optional()
  ),
  META_APP_SECRET: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(10).optional()
  ),
  WEBHOOK_VERIFY_TOKEN: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(6).optional()
  ),
  CHANNELS_ENABLED: z.string().default('whatsapp'),
  // Pack de negocio opcional (perfil + catálogo + prompt). Sin él se usa el default.
  BUSINESS_PACK_PATH: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().optional()
  ),
  TELEGRAM_BOT_TOKEN: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(10).optional()
  ),
  TELEGRAM_WEBHOOK_SECRET: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(6).optional()
  ),
  // Proveedor LLM genérico (API compatible con Chat Completions de OpenAI).
  // Sin nombres de proveedor hardcodeados: todo se configura por entorno.
  LLM_API_KEY: z.string().min(10, 'LLM_API_KEY requerida para el proveedor LLM'),
  LLM_BASE_URL: z.string().url('LLM_BASE_URL debe ser una URL válida (ej. https://api.openai.com/v1)'),
  LLM_MODEL: z.string().min(1, 'LLM_MODEL requerida (ej. gpt-4o-mini)'),
  LLM_MAX_RPM: z.coerce.number().positive().optional(),
  LLM_MAX_TPM: z.coerce.number().positive().optional(),
  META_PHONE_NUMBER_ID: z.string().default('123456789012345'),
  DATABASE_URL: z.string().min(10, 'DATABASE_URL requerida para persistencia e idempotencia'),
  // Ref del proyecto Supabase dedicado a pruebas (ver src/utils/databaseGuard.ts).
  // Opcional: si no se define, el guard usa DEFAULT_TEST_PROJECT_REF.
  TEST_PROJECT_REF: z.string().optional(),
  // Umbral de backlog por canal pausado/OPEN para alertas operativas.
  BACKLOG_ALERT_THRESHOLD: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.coerce.number().int().positive().default(100)
  ),
  // Pipeline de media: descarga y almacenamiento local seguro (no binario en DB).
  MEDIA_STORAGE_ENABLED: z.enum(['true', 'false']).default('true'),
  MEDIA_STORAGE_DIR: z.string().default('./media'),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  MEDIA_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  // Cuotas anti-bucle por conversación (no por proceso)
  MAX_CONVERSATION_TURNS: z.coerce.number().int().positive().default(40),
  MAX_CONVERSATION_TOKENS: z.coerce.number().int().positive().default(100000),
  // Webhook opcional de on-call compatible con Slack/genérico. Solo HTTPS.
  ALERT_WEBHOOK_URL: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .url()
      .refine((value) => value.startsWith('https://'), 'ALERT_WEBHOOK_URL debe usar https')
      .optional()
  ),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Error crítico en variables de entorno:');
  console.error(JSON.stringify(parsedEnv.error.format(), null, 2));
  process.exit(1);
}

export const env = parsedEnv.data;
