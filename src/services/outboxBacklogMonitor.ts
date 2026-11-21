import { outboxRepository } from '../repositories/outboxRepository.js';
import { channelRegistry } from '../providers/channels/channelRegistry.js';
import { normalizeChannelName } from '../providers/channels/channelTypes.js';
import { getChannelCircuitBreaker } from '../utils/circuitBreaker.js';
import { env } from '../config/env.js';
import { sendOnCallAlert } from './alertNotifier.js';
import { logger } from '../utils/logger.js';

export interface ChannelBacklogSnapshot {
  channel: string;
  pending: number;
  paused: boolean;
  enabled: boolean;
  breakerState: string;
  threshold: number;
}

/**
 * Monitorea backlog PENDING por canal y emite alertas deduplicadas.
 * Extraido de OutboxDispatcher para mantener el orquestador por debajo del cap.
 */
export class OutboxBacklogMonitor {
  private isChecking = false;
  private readonly lastAlerts = new Map<string, string>();

  public reset(): void {
    this.lastAlerts.clear();
  }

  public async getSnapshot(isChannelPaused: (channel: string) => boolean): Promise<ChannelBacklogSnapshot[]> {
    const rows = await outboxRepository.countPendingByChannel();
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = normalizeChannelName(row.channel);
      counts.set(key, (counts.get(key) ?? 0) + row.pending);
    }

    const channels = new Set<string>([
      ...channelRegistry.enabledChannels(),
      ...counts.keys(),
      ...this.lastAlerts.keys(),
    ]);

    return Array.from(channels).map((channel) => ({
      channel,
      pending: counts.get(channel) ?? 0,
      paused: isChannelPaused(channel),
      enabled: channelRegistry.isEnabled(channel),
      breakerState: getChannelCircuitBreaker(channel).getState(),
      threshold: env.BACKLOG_ALERT_THRESHOLD,
    }));
  }

  public async check(
    isChannelPaused: (channel: string) => boolean
  ): Promise<ChannelBacklogSnapshot[]> {
    if (this.isChecking) return [];
    this.isChecking = true;

    try {
      const snapshot = await this.getSnapshot(isChannelPaused);

      for (const item of snapshot) {
        const needsAlert = !item.enabled || item.paused || item.breakerState !== 'CLOSED';

        if (item.pending === 0) {
          if (this.lastAlerts.has(item.channel)) {
            const delivered = await sendOnCallAlert({
              alert: 'CHANNEL_BACKLOG_RESOLVED',
              channel: item.channel,
              pending: item.pending,
              threshold: item.threshold,
              enabled: item.enabled,
              paused: item.paused,
              breakerState: item.breakerState,
            });

            if (delivered) {
              this.lastAlerts.delete(item.channel);
              logger.info(
                { alert: 'CHANNEL_BACKLOG_RESOLVED', channel: item.channel, pending: item.pending },
                `✅ Backlog drenado en canal ${item.channel}`
              );
            } else {
              logger.warn(
                { alert: 'CHANNEL_BACKLOG_RESOLVED', channel: item.channel },
                'No se pudo entregar la resolución al webhook de on-call; se reintentará'
              );
            }
          }
          continue;
        }

        if (!needsAlert) continue;

        const level = item.pending >= item.threshold ? 'error' : 'warn';
        const signature = `${level}:${item.enabled}:${item.paused}:${item.breakerState}`;
        if (this.lastAlerts.get(item.channel) === signature) continue;

        const alert = {
          alert: 'CHANNEL_BACKLOG' as const,
          channel: item.channel,
          pending: item.pending,
          threshold: item.threshold,
          paused: item.paused,
          enabled: item.enabled,
          breakerState: item.breakerState,
        };
        const message = `⚠️ Backlog retenido en canal ${item.channel}: ${item.pending} PENDING (habilitado=${item.enabled}, pausado=${item.paused}, breaker=${item.breakerState})`;

        if (level === 'error') logger.error(alert, message);
        else logger.warn(alert, message);

        const delivered = await sendOnCallAlert({
          alert: 'CHANNEL_BACKLOG',
          channel: item.channel,
          pending: item.pending,
          threshold: item.threshold,
          enabled: item.enabled,
          paused: item.paused,
          breakerState: item.breakerState,
        });

        if (delivered) {
          this.lastAlerts.set(item.channel, signature);
        } else {
          logger.warn(
            { alert: 'CHANNEL_BACKLOG', channel: item.channel },
            'No se pudo entregar la alerta al webhook de on-call; se reintentará'
          );
        }
      }

      const activeChannels = new Set(snapshot.map((item) => item.channel));
      for (const channel of this.lastAlerts.keys()) {
        if (!activeChannels.has(channel)) this.lastAlerts.delete(channel);
      }

      return snapshot;
    } finally {
      this.isChecking = false;
    }
  }
}
