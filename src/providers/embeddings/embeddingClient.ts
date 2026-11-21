import { env } from '../../config/env.js';

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export class EmbeddingNotConfiguredError extends Error {
  constructor() {
    super('Embeddings no configurados');
    this.name = 'EmbeddingNotConfiguredError';
  }
}

/**
 * Cliente de embeddings compatible con OpenAI (`POST /embeddings`).
 * No usa SDK; proveedor y modelo se resuelven por entorno.
 */
export class HttpEmbeddingClient implements EmbeddingProvider {
  public isConfigured(): boolean {
    return Boolean(env.EMBEDDINGS_BASE_URL && env.EMBEDDINGS_MODEL);
  }

  public async embed(texts: string[]): Promise<number[][]> {
    if (!this.isConfigured()) throw new EmbeddingNotConfiguredError();
    if (texts.length === 0) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const baseUrl = env.EMBEDDINGS_BASE_URL!.replace(/\/+$/, '');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (env.EMBEDDINGS_API_KEY) {
        headers.Authorization = `Bearer ${env.EMBEDDINGS_API_KEY}`;
      }

      const response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: env.EMBEDDINGS_MODEL, input: texts }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Embeddings HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        data?: Array<{ embedding?: unknown }>;
      };
      const vectors = payload.data?.map((item) => item.embedding);
      if (
        !vectors ||
        vectors.length !== texts.length ||
        vectors.some(
          (vector) =>
            !Array.isArray(vector) ||
            vector.length === 0 ||
            vector.some((value) => typeof value !== 'number')
        )
      ) {
        throw new Error('Respuesta de embeddings inválida');
      }

      return vectors as number[][];
    } finally {
      clearTimeout(timer);
    }
  }
}

export const embeddingClient = new HttpEmbeddingClient();
