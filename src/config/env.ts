import dotenv from 'dotenv';
import { z } from 'zod';

// Cargar variables de entorno desde .env
dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  META_ACCESS_TOKEN: z.string().min(10, 'META_ACCESS_TOKEN requerido'),
  META_APP_SECRET: z.string().min(10, 'META_APP_SECRET requerido para validación HMAC SHA-256'),
  WEBHOOK_VERIFY_TOKEN: z.string().min(6, 'WEBHOOK_VERIFY_TOKEN requerido'),
  GEMINI_API_KEY: z.string().min(10, 'GEMINI_API_KEY requerida'),
  META_PHONE_NUMBER_ID: z.string().default('123456789012345'),
  DATABASE_URL: z.string().min(10, 'DATABASE_URL requerida para persistencia e idempotencia'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Error crítico en variables de entorno:');
  console.error(JSON.stringify(parsedEnv.error.format(), null, 2));
  process.exit(1);
}

export const env = parsedEnv.data;
