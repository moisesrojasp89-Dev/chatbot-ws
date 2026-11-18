import { CONSTANTS } from '../config/constants.js';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Limitador de tasa defensivo (Token Bucket) en memoria por número telefónico.
 * Protege contra ataques de spam y agotamiento de saldo de IA (10 msg/min).
 */
export class RateLimiter {
  private buckets: Map<string, TokenBucket> = new Map();
  private maxTokens: number;
  private refillIntervalMs: number;

  constructor(
    maxTokens: number = CONSTANTS.RATE_LIMIT.MAX_TOKENS,
    refillIntervalMs: number = CONSTANTS.RATE_LIMIT.REFILL_INTERVAL_MS
  ) {
    this.maxTokens = maxTokens;
    this.refillIntervalMs = refillIntervalMs;

    // I5: Auto-limpieza de entradas inactivas cada 30 minutos
    setInterval(() => this.cleanup(), 30 * 60 * 1000).unref();
  }

  /**
   * Evalúa si un número telefónico ha excedido el límite permitido.
   * @param phoneNumber Número en formato E.164
   * @returns true si el usuario DEBE ser limitado (bloqueado), false si la petición puede proceder.
   */
  public isRateLimited(phoneNumber: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(phoneNumber);

    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastRefill: now };
      this.buckets.set(phoneNumber, bucket);
    } else {
      // Calcular tokens acumulados desde la última recarga
      const elapsed = now - bucket.lastRefill;
      const tokensToAdd = (elapsed / this.refillIntervalMs) * this.maxTokens;
      if (tokensToAdd > 0) {
        bucket.tokens = Math.min(this.maxTokens, bucket.tokens + tokensToAdd);
        bucket.lastRefill = now;
      }
    }

    // Si tiene al menos 1 token disponible, lo consume y permite el paso
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return false; // No limitado
    }

    return true; // Limitado (excedió la cuota)
  }

  /**
   * Limpia registros antiguos para evitar acumulación infinita de memoria.
   */
  public cleanup(maxAgeMs: number = 3600000): void {
    const now = Date.now();
    for (const [phone, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > maxAgeMs) {
        this.buckets.delete(phone);
      }
    }
  }

  /**
   * Resetea el almacenamiento (útil para tests unitarios).
   */
  public reset(): void {
    this.buckets.clear();
  }
}

export const phoneRateLimiter = new RateLimiter();
