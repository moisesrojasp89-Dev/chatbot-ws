import { logger } from './logger.js';

/**
 * Ref histórico del proyecto Supabase dedicado a pruebas (São Paulo).
 * El proyecto original fue eliminado, por lo que el ref se puede rotar por entorno
 * mediante TEST_PROJECT_REF sin necesidad de tocar código.
 */
export const DEFAULT_TEST_PROJECT_REF = 'bsdaswbwxekfedqrzdzc';

/**
 * Resuelve el ref exigido por el guard en tiempo de ejecución.
 * Se evalúa en cada llamada (no al importar el módulo) para que `dotenv` ya haya
 * cargado `.env`, independientemente del orden de imports.
 */
export function getTestProjectRef(): string {
  const override = process.env.TEST_PROJECT_REF?.trim();
  return override || DEFAULT_TEST_PROJECT_REF;
}

/**
 * Auditor 5A Check: Valida que DATABASE_URL pertenezca al proyecto dedicado de pruebas.
 * Previene la ejecución accidental de tests o migraciones destructivas sobre bases de datos reales.
 *
 * ⚠️ El ref se configura con TEST_PROJECT_REF, pero NUNCA debe apuntar a un proyecto
 * con datos reales: la suite de pruebas borra filas de negocio en su `beforeEach`.
 */
export function assertTestDatabase(databaseUrl?: string, caller: string = 'Test Suite'): void {
  const url = databaseUrl || process.env.DATABASE_URL || '';
  if (!url) {
    const msg = `🚨 GUARD DE SEGURIDAD: ${caller} abortado. DATABASE_URL no definida.`;
    logger.fatal(msg);
    throw new Error(msg);
  }

  const requiredRef = getTestProjectRef();

  try {
    const parsed = new URL(url);
    const username = parsed.username || '';
    const host = parsed.hostname || '';

    const matchesRef =
      username.includes(requiredRef) ||
      host.includes(requiredRef) ||
      url.includes(requiredRef);

    if (!matchesRef) {
      const errMsg = `🚨 GUARD DE SEGURIDAD ACTIVADO: ${caller} abortado. DATABASE_URL no corresponde al ref del proyecto de pruebas (${requiredRef}). Operación denegada.`;
      logger.fatal({ username, host, requiredRef }, errMsg);
      throw new Error(errMsg);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('GUARD DE SEGURIDAD')) {
      throw err;
    }
    const parseErrMsg = `🚨 GUARD DE SEGURIDAD: Error al parsear DATABASE_URL en ${caller}`;
    logger.fatal({ err }, parseErrMsg);
    throw new Error(parseErrMsg);
  }
}
