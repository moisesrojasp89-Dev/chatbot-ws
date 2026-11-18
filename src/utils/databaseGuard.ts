import { logger } from './logger.js';

export const TEST_PROJECT_REF = 'bsdaswbwxekfedqrzdzc';

/**
 * Auditor 5A Check: Valida que DATABASE_URL pertenezca al proyecto dedicado de pruebas.
 * Previene la ejecución accidental de tests o migraciones destructivas sobre bases de datos reales.
 */
export function assertTestDatabase(databaseUrl?: string, caller: string = 'Test Suite'): void {
  const url = databaseUrl || process.env.DATABASE_URL || '';
  if (!url) {
    const msg = `🚨 GUARD DE SEGURIDAD: ${caller} abortado. DATABASE_URL no definida.`;
    logger.fatal(msg);
    throw new Error(msg);
  }

  try {
    const parsed = new URL(url);
    const username = parsed.username || '';
    const host = parsed.hostname || '';

    const matchesRef =
      username.includes(TEST_PROJECT_REF) ||
      host.includes(TEST_PROJECT_REF) ||
      url.includes(TEST_PROJECT_REF);

    if (!matchesRef) {
      const errMsg = `🚨 GUARD DE SEGURIDAD ACTIVADO: ${caller} abortado. DATABASE_URL no corresponde al ref del proyecto de pruebas (${TEST_PROJECT_REF}). Operación denegada.`;
      logger.fatal({ username, host, requiredRef: TEST_PROJECT_REF }, errMsg);
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
