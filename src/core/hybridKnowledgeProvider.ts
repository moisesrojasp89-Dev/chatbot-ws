import { EmbeddingProvider } from '../providers/embeddings/embeddingClient.js';
import {
  JsonKnowledgeProvider,
  KnowledgeDocument,
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
} from './knowledgeProvider.js';
import { logger } from '../utils/logger.js';

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Híbrido léxico + vectorial. Si no hay embeddings configurados o fallan,
 * conserva el resultado léxico. El vectorial solo rerankea; nunca inventa docs.
 */
export class HybridKnowledgeProvider {
  private readonly lexical: JsonKnowledgeProvider;
  private readonly documents: KnowledgeDocument[];
  private readonly embedder: EmbeddingProvider | null;
  private vectors: Map<string, number[]> | null = null;
  private initializing: Promise<void> | null = null;

  constructor(
    documents: KnowledgeDocument[],
    options: KnowledgeSearchOptions = {},
    embedder: EmbeddingProvider | null = null
  ) {
    this.documents = [...documents];
    this.lexical = new JsonKnowledgeProvider(documents, options);
    this.embedder = embedder;
  }

  private async ensureVectors(): Promise<void> {
    if (this.vectors || !this.embedder || this.documents.length === 0) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      const vectors = await this.embedder!.embed(
        this.documents.map((document) => `${document.title}\n${document.content}`)
      );
      this.vectors = new Map(
        this.documents.map((document, index) => [document.id, vectors[index]])
      );
    })();

    try {
      await this.initializing;
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : 'unknown' },
        'Embeddings de conocimiento fallaron; se usa RAG léxico'
      );
      this.vectors = null;
    } finally {
      this.initializing = null;
    }
  }

  public async search(query: string, limit = 3): Promise<KnowledgeSearchResult> {
    const lexical = this.lexical.search(query, limit);
    if (!this.embedder) return lexical;

    await this.ensureVectors();
    if (!this.vectors) return lexical;

    try {
      const [queryVector] = await this.embedder.embed([query]);
      if (!queryVector) return lexical;

      const lexicalIds = new Set(lexical.documents.map((document) => document.id));
      const ranked = this.documents
        .map((document) => {
          const vector = this.vectors!.get(document.id);
          const vectorScore = vector ? cosine(queryVector, vector) : 0;
          const lexicalBoost = lexicalIds.has(document.id)
            ? document.id === lexical.documents[0]?.id
              ? 1
              : 0.8
            : 0;
          return { document, score: 0.5 * lexicalBoost + 0.5 * Math.max(0, vectorScore) };
        })
        .filter(({ score }) => score >= 0.3)
        .sort((a, b) => b.score - a.score);

      const top = ranked[0]?.score ?? 0;
      const found = lexical.found || top >= 0.3;

      return {
        found,
        confidence: Math.round(Math.max(lexical.confidence, top) * 100) / 100,
        documents: found
          ? ranked.slice(0, Math.min(Math.max(limit, 1), 5)).map(({ document }) => document)
          : [],
      };
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : 'unknown' },
        'Embeddings de consulta fallaron; se usa RAG léxico'
      );
      return lexical;
    }
  }
}
