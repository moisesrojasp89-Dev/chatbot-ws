import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { whatsappClient } from '../providers/meta/whatsappClient.js';

export class TypingCadenceSimulator {
  /**
   * Simula cadencia humana natural:
   * 1. Envía indicador "typing..." a la API de Meta.
   * 2. Espera un tiempo aleatorio humanizado entre 1.5s y 2.5s antes del despacho.
   * En entorno de test, el delay se minimiza a 5ms para mantener la suite veloz.
   */
  public async simulateTyping(
    phoneNumberId: string,
    recipientPhone: string,
    customDelayMs?: number
  ): Promise<void> {
    // 1. Enviar estado typing a Meta
    await whatsappClient.sendTypingIndicator(phoneNumberId, recipientPhone);

    // 2. Cálculo del retardo humanizado
    let delay: number;
    if (customDelayMs !== undefined) {
      delay = customDelayMs;
    } else if (env.NODE_ENV === 'test') {
      delay = 5; // Acelerado para tests
    } else {
      delay = 1500 + Math.random() * 1000; // 1500ms a 2500ms
    }

    logger.debug({ recipientPhone, delayMs: Math.round(delay) }, '⏳ Simulando cadencia humana de escritura');
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

export const typingCadence = new TypingCadenceSimulator();
