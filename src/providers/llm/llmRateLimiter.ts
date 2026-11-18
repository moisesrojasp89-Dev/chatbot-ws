import { logger } from '../../utils/logger.js';

export interface LlmRateLimiterConfig {
  maxRPM?: number; // Requests por minuto (default: 60)
  maxTPM?: number; // Tokens por minuto (default: 100,000)
}

interface QueuedItem {
  requestedTokens: number;
  resolve: () => void;
  reject: (err: Error) => void;
  abortSignal?: AbortSignal;
}

/**
 * Token Bucket continuo para control dual de cuotas (RPM y TPM) hacia Google Gemini API.
 * 
 * Cumple con:
 * - C6: Recarga matemática continua (tokens += elapsedMs * rate) para erradicar ráfagas en bordes de minuto.
 * - C7: Control dual de RPM y TPM con reconciliación post-inferencia.
 * - C8: Consumo atómico síncrono (sin await en la reserva) y cola FIFO ordenada sin condiciones de carrera.
 */
export class LlmRateLimiter {
  private maxRPM: number;
  private maxTPM: number;

  private rpmTokens: number;
  private tpmTokens: number;

  private lastRefillTimestamp: number;
  private queue: QueuedItem[] = [];
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(config?: LlmRateLimiterConfig) {
    this.maxRPM = config?.maxRPM ?? Number(process.env.GEMINI_MAX_RPM ?? 60);
    this.maxTPM = config?.maxTPM ?? Number(process.env.GEMINI_MAX_TPM ?? 100000);

    this.rpmTokens = this.maxRPM;
    this.tpmTokens = this.maxTPM;
    this.lastRefillTimestamp = Date.now();
  }

  /**
   * Recarga continua infinitesimal según el tiempo transcurrido en milisegundos.
   */
  private refill(): void {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - this.lastRefillTimestamp);
    if (elapsedMs === 0) return;

    // Recarga RPM
    const rpmRefill = (elapsedMs * this.maxRPM) / 60000;
    this.rpmTokens = Math.min(this.maxRPM, this.rpmTokens + rpmRefill);

    // Recarga TPM
    const tpmRefill = (elapsedMs * this.maxTPM) / 60000;
    this.tpmTokens = Math.min(this.maxTPM, this.tpmTokens + tpmRefill);

    this.lastRefillTimestamp = now;
  }

  /**
   * Reserva atómica síncrona de cuota (C8).
   * Devuelve true si pudo reservar en el mismo tick sin bloquear; false si debe encolarse.
   */
  private tryConsumeSync(tokensRequested: number): boolean {
    this.refill();

    if (this.rpmTokens >= 1 && this.tpmTokens >= tokensRequested) {
      this.rpmTokens -= 1;
      this.tpmTokens -= tokensRequested;
      return true;
    }

    return false;
  }

  /**
   * Solicita autorización para ejecutar una llamada hacia Gemini.
   * Si hay saldo disponible, resuelve síncronamente o de inmediato.
   * Si no, encola en estricto orden FIFO hasta que la recarga continua cubra el costo.
   */
  public async acquireToken(
    estimatedTokens: number = 250,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      const err = new Error('Operación cancelada por AbortSignal antes de adquirir token de cuota');
      err.name = 'AbortError';
      throw err;
    }

    // Si no hay nadie en espera y hay saldo suficiente en ambos buckets: pase inmediato (C8)
    if (this.queue.length === 0 && this.tryConsumeSync(estimatedTokens)) {
      return;
    }

    // De lo contrario, encolar en estricto orden FIFO
    return new Promise<void>((resolve, reject) => {
      const queueItem: QueuedItem = {
        requestedTokens: estimatedTokens,
        resolve,
        reject,
        abortSignal,
      };

      if (abortSignal) {
        const abortHandler = () => {
          const index = this.queue.indexOf(queueItem);
          if (index !== -1) {
            this.queue.splice(index, 1);
          }
          const abortErr = new Error('Llamada a Gemini cancelada por AbortSignal mientras esperaba cuota');
          abortErr.name = 'AbortError';
          reject(abortErr);
        };
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      this.queue.push(queueItem);
      this.scheduleDrain();
    });
  }

  /**
   * Programa el drenado de la cola FIFO en el momento exacto en que se estime
   * que los tokens necesarios hayan sido recargados.
   */
  private scheduleDrain(): void {
    if (this.drainTimer || this.queue.length === 0) return;

    this.refill();
    const nextItem = this.queue[0];
    if (!nextItem) return;

    // Calcular cuánto tiempo falta para cubrir RPM y TPM del siguiente item en cola
    const rpmNeeded = Math.max(0, 1 - this.rpmTokens);
    const msForRpm = rpmNeeded > 0 ? Math.ceil((rpmNeeded * 60000) / this.maxRPM) : 0;

    const tpmNeeded = Math.max(0, nextItem.requestedTokens - this.tpmTokens);
    const msForTpm = tpmNeeded > 0 ? Math.ceil((tpmNeeded * 60000) / this.maxTPM) : 0;

    const waitMs = Math.max(10, Math.max(msForRpm, msForTpm));

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainQueue();
    }, waitMs);
    this.drainTimer.unref?.();
  }

  /**
   * Despacha elementos de la cola en estricto orden FIFO mientras haya saldo disponible.
   */
  private drainQueue(): void {
    while (this.queue.length > 0) {
      const candidate = this.queue[0];
      if (candidate.abortSignal?.aborted) {
        this.queue.shift();
        continue;
      }

      if (this.tryConsumeSync(candidate.requestedTokens)) {
        this.queue.shift();
        candidate.resolve();
      } else {
        // No hay suficiente saldo para el elemento en la cabeza de la cola
        break;
      }
    }

    if (this.queue.length > 0) {
      this.scheduleDrain();
    }
  }

  /**
   * C7: Reconciliación post-inferencia con el consumo real devuelto por la API de Gemini.
   * Si se estimaron 300 tokens pero la respuesta solo gastó 140, se devuelven 160 tokens al bucket.
   */
  public reconcile(estimatedTokens: number, actualTokens: number): void {
    this.refill();
    if (actualTokens < estimatedTokens) {
      const refund = estimatedTokens - actualTokens;
      this.tpmTokens = Math.min(this.maxTPM, this.tpmTokens + refund);
      logger.debug(
        { estimatedTokens, actualTokens, refund, currentTpmTokens: Math.round(this.tpmTokens) },
        '⚖️ Saldo de TPM reconciliado con telemetría real de Gemini'
      );
      // Intentar drenar cola si había alguien esperando tokens
      if (this.queue.length > 0) {
        this.drainQueue();
      }
    } else if (actualTokens > estimatedTokens) {
      const extra = actualTokens - estimatedTokens;
      this.tpmTokens = Math.max(0, this.tpmTokens - extra);
      logger.debug(
        { estimatedTokens, actualTokens, extra, currentTpmTokens: Math.round(this.tpmTokens) },
        '⚖️ Saldo de TPM deducido por exceso de consumo real sobre estimación'
      );
    }
  }

  // Getters para telemetría y pruebas unitarias
  public getSnapshot(): {
    rpmTokens: number;
    tpmTokens: number;
    queueLength: number;
    maxRPM: number;
    maxTPM: number;
  } {
    this.refill();
    return {
      rpmTokens: this.rpmTokens,
      tpmTokens: this.tpmTokens,
      queueLength: this.queue.length,
      maxRPM: this.maxRPM,
      maxTPM: this.maxTPM,
    };
  }

  public getMetrics(): {
    availableRPM: number;
    availableTPM: number;
    queueLength: number;
  } {
    const snap = this.getSnapshot();
    return {
      availableRPM: snap.rpmTokens,
      availableTPM: snap.tpmTokens,
      queueLength: snap.queueLength,
    };
  }

  public reset(rpm?: number, tpm?: number): void {
    this.maxRPM = rpm ?? this.maxRPM;
    this.maxTPM = tpm ?? this.maxTPM;
    this.rpmTokens = this.maxRPM;
    this.tpmTokens = this.maxTPM;
    this.lastRefillTimestamp = Date.now();
    this.queue = [];
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }
}

export const llmRateLimiter = new LlmRateLimiter();
