import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { ChannelAdapter, ChannelSendError, normalizeChannelName } from './channelTypes.js';
import { getMetaConfig } from './meta/metaConfig.js';
import { MetaChannelSender } from './meta/metaChannelSender.js';
import { getTelegramConfig } from './telegram/telegramConfig.js';
import { TelegramChannelSender } from './telegram/telegramChannelSender.js';

/**
 * Registro de adaptadores de canal.
 *
 * El núcleo resuelve el adaptador por nombre de canal y solo conoce el contrato
 * `ChannelAdapter` (verify/parse + egress). No hay SDKs ni detalles de proveedor
 * en el núcleo. Para agregar un canal: implementar ChannelAdapter y registrarlo.
 */
export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  constructor() {
    this.register(new MetaChannelSender());
    this.register(new TelegramChannelSender());
  }

  public register(adapter: ChannelAdapter): void {
    this.adapters.set(normalizeChannelName(adapter.channel), adapter);
  }

  public has(channel: string): boolean {
    return this.adapters.has(normalizeChannelName(channel));
  }

  public get(channel: string): ChannelAdapter {
    const adapter = this.adapters.get(normalizeChannelName(channel));
    if (!adapter) {
      throw new ChannelSendError('FATAL', `Canal no registrado: ${channel}`);
    }
    return adapter;
  }

  public getAdapter(channel: string): ChannelAdapter {
    return this.get(channel);
  }

  /** Canales habilitados por configuración (CSV en CHANNELS_ENABLED). */
  public enabledChannels(): string[] {
    return (env.CHANNELS_ENABLED ?? 'whatsapp')
      .split(',')
      .map((channel) => channel.trim().toLowerCase())
      .filter((channel) => channel.length > 0)
      .filter((channel, index, all) => all.indexOf(channel) === index);
  }

  public isEnabled(channel: string): boolean {
    return this.enabledChannels().includes(channel);
  }

  /**
   * Valida al arranque que todo canal habilitado tenga adaptador y configuración.
   * La ausencia de META_* solo es válida si `whatsapp` no está habilitado.
   */
  public validateEnabledChannels(): void {
    const enabled = this.enabledChannels();
    if (enabled.length === 0) {
      throw new Error('CHANNELS_ENABLED no puede estar vacío.');
    }

    for (const channel of enabled) {
      if (!this.adapters.has(channel)) {
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
