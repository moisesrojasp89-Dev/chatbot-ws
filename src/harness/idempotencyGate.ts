import { db } from '../providers/database/dbClient.js';
import { logger } from '../utils/logger.js';

interface CachedMessage {
  processedAt: number;
  content: string;
  status: 'PENDING_PROCESSING' | 'COMPLETED';
}

export class IdempotencyGate {
  private memoryCache: Map<string, CachedMessage> = new Map();
  private ttlMs: number = 15 * 60 * 1000; // 15 minutos en memoria

  constructor() {
    // I2: Evicción periódica de memoria cada 5 minutos para prevenir memory leaks
    setInterval(() => this.evictExpired(), 5 * 60 * 1000).unref();
  }

  /**
   * I2: Elimina entradas de caché que hayan superado el TTL de 15 minutos.
   */
  private evictExpired(): void {
    const now = Date.now();
    for (const [wamid, entry] of this.memoryCache.entries()) {
      if (now - entry.processedAt > this.ttlMs) {
        this.memoryCache.delete(wamid);
      }
    }
  }

  /**
   * Determina si un mensaje de WhatsApp (wamid) ya fue recibido o procesado.
   * C3: La DB es la fuente de verdad primaria; la memoria es fast-path cache.
   * I3: conversationId es opcional/nullable (en Fase 1 opera sin conversación creada).
   * 
   * @param wamid Identificador único emitido por Meta
   * @param conversationId ID opcional de conversación asociada
   * @returns true si el mensaje YA FUE PROCESADO (duplicado), false si es NUEVO
   */
  public async isAlreadyProcessed(wamid: string, conversationId?: string): Promise<boolean> {
    // 1. Fast-path: Comprobación instantánea en memoria
    if (this.memoryCache.has(wamid)) {
      logger.debug({ wamid }, 'Mensaje duplicado interceptado en fast-path de memoria');
      return true;
    }

    // 2. Fuente de verdad atómica: INSERT ... ON CONFLICT DO NOTHING en PostgreSQL
    try {
      const isDbHealthy = await db.isHealthy();
      if (isDbHealthy) {
        // I3: conversation_id nullable para permitir deduplicación atómica en DB desde Fase 1
        const convId = conversationId || null;
        const query = `
          INSERT INTO public.messages (wamid, conversation_id, direction, content, message_type)
          VALUES ($1, $2, 'INBOUND', 'PENDING_PROCESSING', 'system')
          ON CONFLICT (wamid) DO NOTHING
          RETURNING id;
        `;
        const result = await db.query(query, [wamid, convId]);

        // Si rowCount === 0, significa que el wamid ya existía en la base de datos
        if (result.rowCount === 0) {
          this.memoryCache.set(wamid, {
            processedAt: Date.now(),
            content: 'DUPLICATE',
            status: 'COMPLETED',
          });
          logger.warn({ wamid }, 'Mensaje duplicado interceptado en base de datos PostgreSQL');
          return true;
        }
      }
    } catch (error) {
      logger.warn({ error, wamid }, 'Fallo al verificar idempotencia en DB. Usando cache de memoria.');
    }

    // Registrar en cache fast-path como mensaje nuevo en procesamiento
    this.memoryCache.set(wamid, {
      processedAt: Date.now(),
      content: 'PENDING_PROCESSING',
      status: 'PENDING_PROCESSING',
    });

    return false; // Mensaje nuevo y legítimo
  }

  /**
   * O1: Actualiza el registro con el contenido real del mensaje una vez procesado por el worker.
   */
  public async updateMessageContent(wamid: string, content: string, messageType: string = 'text'): Promise<void> {
    // Actualizar en memoria
    const cached = this.memoryCache.get(wamid);
    if (cached) {
      cached.content = content;
      cached.status = 'COMPLETED';
    }

    // Actualizar en base de datos si está conectada
    try {
      const isDbHealthy = await db.isHealthy();
      if (isDbHealthy) {
        const query = `
          UPDATE public.messages
          SET content = $1, message_type = $2
          WHERE wamid = $3;
        `;
        await db.query(query, [content, messageType, wamid]);
        logger.debug({ wamid }, 'Registro de mensaje actualizado en DB tras procesamiento (O1)');
      }
    } catch (error) {
      logger.error({ error, wamid }, 'Error al actualizar contenido real del mensaje en DB');
    }
  }

  /**
   * Resetea el cache de memoria (útil para tests).
   */
  public reset(): void {
    this.memoryCache.clear();
  }

  /**
   * Auditor 5B: Registra inmediatamente un wamid como procesado en el fast-path de memoria.
   */
  public recordMessageProcessed(wamid: string): void {
    this.memoryCache.set(wamid, {
      processedAt: Date.now(),
      content: 'RECORDED',
      status: 'COMPLETED',
    });
  }
}

export const idempotencyGate = new IdempotencyGate();
