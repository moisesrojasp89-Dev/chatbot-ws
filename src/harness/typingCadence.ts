import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { channelRegistry } from '../providers/channels/channelRegistry.js';

export class TypingCadenceSimulator {
  /**
   * Simula cadencia humana natural:
   * 1. Envía indicador "typing..." a la API de Meta.
   * 2. Espera un tiempo aleatorio humanizado entre 1.5s y 2.5s antes del despacho.
   * En entorno de test, el delay se minimiza a 5ms para mantener la suite veloz.
   */
  public async simulateTyping(
    accountId: string,
    recipientId: string,
    customDelayMs?: number,
    channel: string = 'whatsapp'
  ): Promise<void> {
    // 1. Enviar estado typing a través del adaptador de canal (si lo soporta)
    try {
      const sender = channelRegistry.get(channel);
      await sender.sendTyping?.(accountId, recipientId);
    } catch (err) {
      // El indicador de typing es best-effort: nunca debe tumbar el despacho ni dejar filas bloqueadas.
      logger.warn({ err, channel }, 'No se pudo enviar el indicador de typing (best-effort)');
    }

    // 2. Cálculo del retardo humanizado
    let delay: number;
    if (customDelayMs !== undefined) {
      delay = customDelayMs;
    } else if (env.NODE_ENV === 'test') {
      delay = 5; // Acelerado para tests
    } else {
      delay = 1500 + Math.random() * 1000; // 1500ms a 2500ms
    }

    logger.debug({ recipientId, channel, delayMs: Math.round(delay) }, '⏳ Simulando cadencia humana de escritura');
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

export const typingCadence = new TypingCadenceSimulator();
