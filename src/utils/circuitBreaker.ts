import { CONSTANTS } from '../config/constants.js';
import { logger } from './logger.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenSuccesses?: number;
}

/**
 * Error tipado emitido cuando el Circuit Breaker rechaza una petición
 * para evitar llamadas de red innecesarias (B1, I5).
 */
export class CircuitOpenError extends Error {
  public readonly retryAfterMs: number;

  constructor(
    message: string = 'CIRCUIT_BREAKER_OPEN: Circuit is OPEN, requests rejected',
    retryAfterMs: number = 30000
  ) {
    super(message);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount: number = 0;
  private consecutiveSuccesses: number = 0;
  private openUntil: number = 0; // B3: Timestamp absoluto hasta el cual el circuito permanece OPEN
  private halfOpenProbeInProgress: boolean = false; // Guarda de sonda única en HALF_OPEN (I15)

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenSuccesses: number;

  constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? CONSTANTS.CIRCUIT_BREAKER.FAILURE_THRESHOLD;
    this.resetTimeoutMs = options?.resetTimeoutMs ?? CONSTANTS.CIRCUIT_BREAKER.RESET_TIMEOUT_MS;
    this.halfOpenSuccesses = options?.halfOpenSuccesses ?? CONSTANTS.CIRCUIT_BREAKER.HALF_OPEN_SUCCESSES;
  }

  public getState(): CircuitState {
    this.checkStateTransition();
    return this.state;
  }

  public getFailureCount(): number {
    return this.failureCount;
  }

  public getOpenUntil(): number {
    return this.openUntil;
  }

  /**
   * Ejecuta una acción asíncrona envuelta por el Circuit Breaker.
   * - B1: Si está OPEN, rechaza con CircuitOpenError tipado con retryAfterMs exacto (I5).
   * - I14/I5: shouldTrip tri-estado (true = falla, false = éxito, 'neutral' = no altera).
   * - I15: En HALF_OPEN, solo permite 1 sonda concurrente; llamadas concurrentes
   *   reciben CircuitOpenError y se difieren sin quemar reintentos.
   */
  public async execute<T>(
    action: () => Promise<T>,
    shouldTrip?: (error: unknown) => boolean | 'neutral'
  ): Promise<T> {
    this.checkStateTransition();

    if (this.state === 'OPEN') {
      const remainingMs = Math.max(0, this.openUntil - Date.now());
      logger.warn(
        { state: this.state, openUntil: this.openUntil, remainingMs },
        '🛑 Circuit Breaker en estado OPEN: Solicitud rechazada sin llamada de red'
      );
      throw new CircuitOpenError(
        'CIRCUIT_BREAKER_OPEN: Circuit is OPEN, requests rejected',
        remainingMs
      );
    }

    let isCanaryProbe = false;
    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenProbeInProgress) {
        logger.debug('Sonda canary ya en vuelo en HALF_OPEN: Solicitud concurrente diferida con CircuitOpenError');
        throw new CircuitOpenError(
          'CIRCUIT_BREAKER_HALF_OPEN_BUSY: Canary probe already in flight',
          3000
        );
      }
      this.halfOpenProbeInProgress = true;
      isCanaryProbe = true;
    }

    try {
      const result = await action();
      this.onSuccess();
      return result;
    } catch (error) {
      const evaluation = shouldTrip ? shouldTrip(error) : true;
      if (evaluation === true) {
        this.onFailure(error);
      } else if (evaluation === false) {
        // Error no transitorio (ej: 400 Bad Request de cliente que demuestra que el endpoint responde)
        logger.debug({ error }, 'Aviso: Error no transitorio recibido (servicio vivo), registrando éxito en Circuit Breaker');
        this.onSuccess();
      } else {
        // 'neutral': Ni suma fallo ni cuenta como éxito (ej: cuota diaria agotada o auth en HALF_OPEN)
        logger.debug({ error }, 'Aviso: Error neutral en Circuit Breaker (no cuenta como éxito en HALF_OPEN)');
      }
      throw error;
    } finally {
      if (isCanaryProbe) {
        this.halfOpenProbeInProgress = false; // Liberado siempre en el finally (I15)
      }
    }
  }

  private checkStateTransition(): void {
    if (this.state === 'OPEN' && Date.now() >= this.openUntil) {
      this.state = 'HALF_OPEN';
      this.consecutiveSuccesses = 0;
      this.halfOpenProbeInProgress = false;
      logger.info(
        { resetTimeoutMs: this.resetTimeoutMs },
        '🟡 Circuit Breaker pasó de OPEN a HALF_OPEN para verificar recuperación del servicio'
      );
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.halfOpenSuccesses) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.consecutiveSuccesses = 0;
        this.openUntil = 0;
        this.halfOpenProbeInProgress = false;
        logger.info('🟢 Circuit Breaker completamente recuperado: Estado pasa a CLOSED');
      }
    } else if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  private onFailure(error: unknown): void {
    // B3: Si ya está en OPEN, no reescribir openUntil para evitar acortar pausas forzadas (ej: trip(600000))
    if (this.state === 'OPEN') return;

    if (this.state === 'HALF_OPEN') {
      logger.warn(
        { error },
        '🚨 Fallo durante estado HALF_OPEN: Circuit Breaker reabierto a OPEN'
      );
      this.open();
    } else if (this.state === 'CLOSED') {
      this.failureCount += 1;
      if (this.failureCount >= this.failureThreshold) {
        logger.error(
          { failureCount: this.failureCount, threshold: this.failureThreshold, error },
          '🚨 Umbral de fallos superado: Circuit Breaker pasa a OPEN (aislando llamadas de red)'
        );
        this.open();
      }
    }
  }

  /**
   * Pasa el circuito a OPEN por un tiempo específico en milisegundos.
   * Elimina la aritmética errónea sobre lastFailureTime y fija openUntil absoluto (B3).
   */
  public open(ms: number = this.resetTimeoutMs): void {
    this.state = 'OPEN';
    this.openUntil = Date.now() + ms;
    this.consecutiveSuccesses = 0;
    this.halfOpenProbeInProgress = false;
  }

  public trip(customResetTimeoutMs?: number): void {
    const ms = customResetTimeoutMs ?? this.resetTimeoutMs;
    this.open(ms);
    logger.error({ customResetTimeoutMs: ms }, '🚨 Circuit Breaker forzado inmediatamente a estado OPEN (trip)');
  }

  public recordFailure(error?: unknown): void {
    this.onFailure(error);
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.consecutiveSuccesses = 0;
    this.openUntil = 0;
    this.halfOpenProbeInProgress = false;
    logger.debug('Circuit Breaker reiniciado manualmente a CLOSED');
  }
}

// Instancia singleton para el despacho saliente del canal activo
/** Breaker del canal de salida (agnóstico al proveedor). */
export const channelCircuitBreaker = new CircuitBreaker();

/** @deprecated Alias de compatibilidad; usar channelCircuitBreaker. */
export const metaCircuitBreaker = channelCircuitBreaker;
