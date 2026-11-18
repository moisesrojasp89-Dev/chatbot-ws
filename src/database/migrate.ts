import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../providers/database/dbClient.js';
import { logger } from '../utils/logger.js';
import { assertTestDatabase } from '../utils/databaseGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Identificador numérico estable para el advisory lock de migraciones en PostgreSQL
const MIGRATIONS_ADVISORY_LOCK_ID = 892341982;

/**
 * Ejecuta todas las migraciones SQL pendientes en orden alfabético.
 * Garantiza:
 * 1. Exclusión mutua entre réplicas concurrentes mediante pg_advisory_lock.
 * 2. Transaccionalidad atómica estricta (BEGIN ... COMMIT) por archivo migrado.
 * 3. Habilitación inmediata de RLS en migrations_history desde su creación.
 * 4. Idempotencia y resiliencia ante caídas intermedias.
 */
export async function runMigrations(): Promise<boolean> {
  // Auditor 5A: Validar que no se ejecuten migraciones destructivas en una BD incorrecta
  if (process.env.NODE_ENV === 'test') {
    assertTestDatabase(undefined, 'Database Migrator');
  }

  logger.info('🔄 Iniciando ejecución de migraciones de base de datos...');

  const isHealthy = await db.isHealthy();
  if (!isHealthy) {
    logger.warn('⚠️ No se puede conectar a PostgreSQL. Verifique DATABASE_URL.');
    return false;
  }

  const migrationsDir = path.join(__dirname, 'migrations');
  const client = await db.getClient();

  try {
    // 1. Adquirir Advisory Lock de sesión para evitar ejecuciones concurrentes entre réplicas
    logger.debug('🔒 Adquiriendo pg_advisory_lock para migraciones...');
    await client.query('SELECT pg_advisory_lock($1);', [MIGRATIONS_ADVISORY_LOCK_ID]);
    logger.debug('🔓 Lock de migración adquirido con éxito.');

    // 2. Tabla de tracking con RLS habilitado y privilegios revocados desde su nacimiento
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.migrations_history (
        filename VARCHAR(255) PRIMARY KEY,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE public.migrations_history ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE public.migrations_history FROM PUBLIC, anon, authenticated;
    `);

    const files = await fs.readdir(migrationsDir);
    const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

    const executedRes = await client.query(`SELECT filename FROM public.migrations_history;`);
    const executedSet = new Set(executedRes.rows.map((r: { filename: string }) => r.filename));

    for (const file of sqlFiles) {
      if (executedSet.has(file)) {
        logger.debug({ file }, `Migración ya aplicada, omitiendo: ${file}`);
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = await fs.readFile(filePath, 'utf-8');

      logger.info({ file }, `Ejecutando migración atómica: ${file}`);

      // Transacción explícita por archivo para garantizar atomicidad e integridad
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO public.migrations_history (filename) VALUES ($1);`,
          [file]
        );
        await client.query('COMMIT');
        logger.info({ file }, `✅ Migración completada y registrada atómicamente: ${file}`);
      } catch (migrationError) {
        await client.query('ROLLBACK');
        logger.error({ file, error: migrationError }, `❌ Fallo en migración ${file}. Transacción revertida.`);
        throw migrationError;
      }
    }

    logger.info('🎉 Todas las migraciones fueron aplicadas con éxito.');
    return true;
  } catch (error) {
    logger.error({ error }, '❌ Error crítico al ejecutar las migraciones SQL');
    throw error;
  } finally {
    try {
      // Liberar advisory lock de sesión y devolver conexión al pool
      await client.query('SELECT pg_advisory_unlock($1);', [MIGRATIONS_ADVISORY_LOCK_ID]);
    } catch (unlockErr) {
      logger.warn({ unlockErr }, 'Aviso al liberar pg_advisory_unlock');
    }
    client.release();
  }
}

// Ejecución directa desde CLI (npm run migrate)
const isMainModule = process.argv[1] === __filename || process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js');
if (isMainModule) {
  runMigrations()
    .then((success) => {
      db.close().finally(() => process.exit(success ? 0 : 1));
    })
    .catch(() => {
      db.close().finally(() => process.exit(1));
    });
}
