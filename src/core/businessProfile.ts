import fs from 'node:fs/promises';
import path from 'node:path';
import { BusinessPack, BusinessProfile, businessPackSchema } from './types.js';

export const MAX_PACK_BYTES = 1024 * 1024;

export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = {
  id: 'default',
  name: 'Chatbot WS',
  vertical: 'generic',
  language: 'es',
  timezone: 'America/Caracas',
  tone: 'cálido, directo y profesional',
  hours: {},
  locations: [],
  policies: {},
};

/**
 * Carga y valida un pack de negocio desde JSON.
 * Confina la ruta a `baseDir`, limita el tamaño y envuelve errores de parseo.
 */
export async function loadBusinessPack(
  filePath: string,
  baseDir: string = process.cwd()
): Promise<BusinessPack> {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, filePath);

  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error('El pack debe estar dentro del directorio permitido');
  }

  const stat = await fs.stat(resolved);
  if (stat.size > MAX_PACK_BYTES) {
    throw new Error(`El pack excede el límite de ${MAX_PACK_BYTES} bytes`);
  }

  const raw = await fs.readFile(resolved, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('El pack no es JSON válido');
  }

  return businessPackSchema.parse(parsed);
}

export function getDefaultBusinessProfile(): BusinessProfile {
  return { ...DEFAULT_BUSINESS_PROFILE };
}
