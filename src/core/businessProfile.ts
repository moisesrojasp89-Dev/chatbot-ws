import fs from 'node:fs/promises';
import { BusinessPack, BusinessProfile, businessPackSchema } from './types.js';

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
 * El pack es la única fuente de perfil, catálogo y reglas de prompt.
 */
export async function loadBusinessPack(filePath: string): Promise<BusinessPack> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return businessPackSchema.parse(parsed);
}

export function getDefaultBusinessProfile(): BusinessProfile {
  return { ...DEFAULT_BUSINESS_PROFILE };
}
