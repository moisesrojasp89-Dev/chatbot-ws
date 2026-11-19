import { db } from '../providers/database/dbClient.js';
import { logger } from '../utils/logger.js';

export class SchemaValidationError extends Error {
  public readonly issues: string[];

  constructor(issues: string[]) {
    super(`Esquema de base de datos incompatible:\n- ${issues.join('\n- ')}`);
    this.name = 'SchemaValidationError';
    this.issues = issues;
  }
}

const REQUIRED_MIGRATIONS = [
  '014_multichannel_channel_columns.sql',
  '015_inbound_channel_identity.sql',
  '016_backfill_normalized_inbound_payload.sql',
];

/**
 * Verificación de esquema al arranque (fail-fast).
 *
 * Evita el escenario en el que el código nuevo arranca contra una base sin las
 * migraciones 014/015 y todo el inbound falla con 42P10 o por columnas ausentes.
 * No reemplaza al migrador: solo valida que el esquema declarado ya esté aplicado.
 */
export async function assertSchemaReady(): Promise<void> {
  const issues: string[] = [];

  // 0. Conectividad: falla rápido con un mensaje claro si la BD no responde.
  const healthy = await db.isHealthy();
  if (!healthy) {
    const message = 'No se pudo conectar a PostgreSQL para validar el esquema.';
    logger.fatal(message);
    throw new SchemaValidationError([message]);
  }

  // 1. Migraciones requeridas en el historial
  try {
    const migrations = await db.query(
      'SELECT filename FROM public.migrations_history ORDER BY filename ASC;'
    );
    const applied = new Set((migrations.rows as Array<{ filename: string }>).map((row) => row.filename));

    for (const required of REQUIRED_MIGRATIONS) {
      if (!applied.has(required)) {
        issues.push(`Falta la migración ${required} en public.migrations_history.`);
      }
    }
  } catch (error) {
    issues.push(
      `No se pudo leer public.migrations_history: ${(error as Error).message}. ¿Se ejecutó npm run migrate?`
    );
  }

  // 2. Columnas channel en inbound_events y outbox_messages
  try {
    const columns = await db.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('inbound_events', 'outbox_messages')
         AND column_name = 'channel';`
    );
    const found = new Set((columns.rows as Array<{ table_name: string }>).map((row) => row.table_name));

    for (const table of ['inbound_events', 'outbox_messages']) {
      if (!found.has(table)) {
        issues.push(`Falta la tabla o columna channel en public.${table} (migración 014).`);
      }
    }
  } catch (error) {
    issues.push(`No se pudieron inspeccionar las columnas de canal: ${(error as Error).message}`);
  }

  // 3. Identidad inbound: UNIQUE(channel, wamid) y ausencia de la constraint legada
  try {
    const constraints = await db.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = to_regclass('public.inbound_events')
         AND contype = 'u';`
    );
    const rows = constraints.rows as Array<{ conname: string; definition: string }>;
    const hasChannelWamid = rows.some(
      (row) => /\(\s*channel\s*,\s*wamid\s*\)/i.test(row.definition)
    );
    const hasLegacyWamidOnly = rows.some(
      (row) => row.conname === 'inbound_events_wamid_key' || /UNIQUE\s*\(\s*wamid\s*\)/i.test(row.definition)
    );

    if (!hasChannelWamid) {
      issues.push('Falta la unicidad UNIQUE(channel, wamid) en inbound_events (migración 015).');
    }
    if (hasLegacyWamidOnly) {
      issues.push('La unicidad legada UNIQUE(wamid) sigue activa en inbound_events; falta aplicar la 015.');
    }
  } catch (error) {
    issues.push(`No se pudieron inspeccionar las constraints de inbound_events: ${(error as Error).message}`);
  }

  if (issues.length > 0) {
    logger.fatal({ issues }, '🚨 Esquema de base de datos incompatible; abortando arranque');
    throw new SchemaValidationError(issues);
  }

  logger.info('🧱 Esquema validado: migraciones 014-016, columnas channel y unicidad por canal');
}
