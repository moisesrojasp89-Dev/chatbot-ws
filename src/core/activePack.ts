import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { loadBusinessPack } from './businessProfile.js';
import { BusinessPack } from './types.js';

let cached: BusinessPack | null | undefined;

/**
 * Carga perezosa del pack activo. Sin BUSINESS_PACK_PATH devuelve null y el
 * motor conserva el comportamiento default (Chatbot WS).
 */
export async function getActiveBusinessPack(): Promise<BusinessPack | null> {
  if (cached !== undefined) return cached;

  const packPath = env.BUSINESS_PACK_PATH;
  if (!packPath) {
    cached = null;
    return cached;
  }

  try {
    cached = await loadBusinessPack(packPath);
    logger.info(
      { profile: cached.profile.id, catalogItems: cached.catalog.length },
      '📦 Business pack cargado'
    );
  } catch (error) {
    logger.error({ error, packPath }, 'No se pudo cargar BUSINESS_PACK_PATH; se usa el default');
    cached = null;
  }

  return cached;
}

/** Solo para tests: invalida el cache del pack. */
export function resetActiveBusinessPack(): void {
  cached = undefined;
}
