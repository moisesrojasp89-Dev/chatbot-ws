import { env } from '../../../config/env.js';

export class MetaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaConfigError';
  }
}

export interface MetaConfig {
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  phoneNumberId: string;
}

/**
 * Resuelve y valida la configuración de Meta solo cuando el adaptador de
 * WhatsApp está habilitado. Así el proceso puede arrancar en despliegues que
 * no usan Meta (siempre que no habiliten el canal `whatsapp`).
 */
export function getMetaConfig(): MetaConfig {
  const accessToken = env.META_ACCESS_TOKEN;
  const appSecret = env.META_APP_SECRET;
  const verifyToken = env.WEBHOOK_VERIFY_TOKEN;

  if (!accessToken || !appSecret || !verifyToken) {
    throw new MetaConfigError(
      'Configuración de Meta incompleta: META_ACCESS_TOKEN, META_APP_SECRET y WEBHOOK_VERIFY_TOKEN son obligatorias cuando CHANNELS_ENABLED incluye "whatsapp".'
    );
  }

  return {
    accessToken,
    appSecret,
    verifyToken,
    phoneNumberId: env.META_PHONE_NUMBER_ID,
  };
}
