import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { ChannelSendError, ChannelSender, normalizeChannelName } from './channelTypes.js';
import { getMetaConfig } from './meta/metaConfig.js';
import { MetaChannelSender } from './meta/metaChannelSender.js';
import { getTelegramConfig } from './telegram/telegramConfig.js';
import { TelegramChannelSender } from './telegram/telegramChannelSender.js';

/**
 * Registro de adaptadores de canal.
 *
 * El núcleo resuelve el emisor por nombre de canal; no conoce SDKs ni detalles
 * del proveedor. Para agregar un canal: implementar ChannelSender y registrarlo.
 */
export class ChannelRegistry {
  private readonly senders = new Map<string, ChannelSender>();

  constructor() {
    this.register(new MetaChannelSender());
    this.register(new TelegramChannelSender());
  }

  public register(sender: ChannelSender): void {
    this.senders.set(normalizeChannelName(sender.channel), sender);
  }

  public has(channel: string): boolean {
    return this.senders.has(normalizeChannelName(channel));
  }

  public get(channel: string): ChannelSender {
    const sender = this.senders.get(normalizeChannelName(channel));
    if (!sender) {
      throw new ChannelSendError('FATAL', `Canal no registrado: ${channel}`);
    }
    return sender;
  }

  /** Canales habilitados por configuración (CSV en CHANNELS_ENABLED). */
  public enabledChannels(): string[] {
    return (env.CHANNELS_ENABLED ?? 'whatsapp')
      .split(',')
      .map((channel) => channel.trim().toLowerCase())
      .filter((channel) => channel.length > 0);
  }

  public isEnabled(channel: string): boolean {
    return this.enabledChannels().includes(channel);
  }

  /**
   * Valida al arranque que todo canal habilitado tenga adaptador y configuración.
   * La ausencia de META_* solo es válida si `whatsapp` no está habilitado y existe
   * otro adaptador registrado (p. ej. Telegram, que se implementa en la Ola 1).
   */
  public validateEnabledChannels(): void {
    const enabled = this.enabledChannels();
    if (enabled.length === 0) {
      throw new Error('CHANNELS_ENABLED no puede estar vacío.');
    }

    for (const channel of enabled) {
      if (!this.senders.has(channel)) {
        throw new Error(`Canal habilitado sin adaptador registrado: ${channel}`);
      }
    }

    if (enabled.includes('whatsapp')) {
      // Falla temprano y con mensaje claro si faltan credenciales de Meta.
      getMetaConfig();
    }
    if (enabled.includes('telegram')) {
      getTelegramConfig();
    }

    logger.info({ channels: enabled }, '📡 Canales habilitados y validados');
  }
}

export const channelRegistry = new ChannelRegistry();
