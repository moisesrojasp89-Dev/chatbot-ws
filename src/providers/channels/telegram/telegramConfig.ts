import { env } from '../../../config/env.js';

export class TelegramConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramConfigError';
  }
}

export interface TelegramConfig {
  botToken: string;
  webhookSecret: string;
}

/**
 * Configuración de Telegram, validada solo cuando el canal está habilitado.
 */
export function getTelegramConfig(): TelegramConfig {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;

  if (!botToken || !webhookSecret) {
    throw new TelegramConfigError(
      'Configuración de Telegram incompleta: TELEGRAM_BOT_TOKEN y TELEGRAM_WEBHOOK_SECRET son obligatorias cuando CHANNELS_ENABLED incluye "telegram".'
    );
  }

  return { botToken, webhookSecret };
}
