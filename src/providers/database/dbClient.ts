import pg from 'pg';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

const { Pool } = pg;

export class DatabaseClient {
  private pool: pg.Pool | null = null;
  private connected: boolean = false;

  constructor() {
    try {
      const isRemote =
        env.DATABASE_URL.includes('supabase.co') ||
        env.DATABASE_URL.includes('pooler.supabase.com') ||
        env.DATABASE_URL.includes('sslmode=require');

      this.pool = new Pool({
        connectionString: env.DATABASE_URL,
        ssl: isRemote ? { rejectUnauthorized: false } : undefined,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 30000,
      });

      this.pool.on('error', (err) => {
        logger.error({ err }, 'Error inesperado en el pool de PostgreSQL');
      });
    } catch (error) {
      logger.warn({ error }, 'No se pudo instanciar el pool de PostgreSQL. Modo fallback activo.');
    }
  }

  /**
   * Ejecuta una consulta SQL parametrizada.
   */
  public async query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
    if (!this.pool) {
      throw new Error('PostgreSQL pool no está inicializado.');
    }
    return this.pool.query(text, params);
  }

  /**
   * Auditor 5A: Obtiene un cliente directo del pool para pruebas de concurrencia y transacciones manuales.
   */
  public async getClient(): Promise<pg.PoolClient> {
    if (!this.pool) {
      throw new Error('PostgreSQL pool no está inicializado.');
    }
    return this.pool.connect();
  }

  /**
   * Verifica el estado de salud de la conexión.
   */
  public async isHealthy(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      const res = await this.pool.query('SELECT 1 AS ok');
      return res.rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  /**
   * Ejecuta una función dentro de una transacción SQL atómica (S2).
   */
  public async withTransaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) {
      throw new Error('PostgreSQL pool no está inicializado.');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Cierre elegante del pool.
   */
  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }
}

export const db = new DatabaseClient();
