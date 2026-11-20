import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface OnCallAlert {
  alert: 'CHANNEL_BACKLOG' | 'CHANNEL_BACKLOG_RESOLVED';
  channel: string;
  pending: number;
  threshold: number;
  enabled: boolean;
  paused: boolean;
  breakerState: string;
}

const ALERT_TIMEOUT_MS = 5000;

/**
 * Entrega una transición de backlog a un webhook externo de on-call.
 *
 * - Sin `ALERT_WEBHOOK_URL` es no-op.
 * - Solo HTTPS (validado por env), sin redirects y con timeout corto.
 * - Nunca lanza: un fallo del webhook no debe tumbar el dispatcher.
 * - No loguea la URL ni el payload completo.
 */
export async function sendOnCallAlert(alert: OnCallAlert): Promise<boolean> {
  const url = env.ALERT_WEBHOOK_URL;
  if (!url) return true; // deshabilitado intencionalmente: no es un fallo de entrega

  const text =
    alert.alert === 'CHANNEL_BACKLOG'
      ? `⚠️ Backlog retenido en ${alert.channel}: ${alert.pending} PENDING (habilitado=${alert.enabled}, pausado=${alert.paused}, breaker=${alert.breakerState}, umbral=${alert.threshold})`
      : `✅ Backlog drenado en ${alert.channel}: ${alert.pending} PENDING`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...alert }),
      redirect: 'error',
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn(
        { alert: alert.alert, channel: alert.channel, status: response.status },
        'El webhook de on-call respondió con error'
      );
      return false;
    }

    return true;
  } catch (error) {
    // No propagar detalles que puedan incluir la URL del webhook.
    logger.warn(
      { alert: alert.alert, channel: alert.channel, errorName: error instanceof Error ? error.name : 'Unknown' },
      'No se pudo entregar la alerta al webhook de on-call'
    );
    return false;
  }
}
