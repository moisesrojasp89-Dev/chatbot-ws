import { describe, expect, it } from 'vitest';
import { HybridKnowledgeProvider } from '../src/core/hybridKnowledgeProvider.js';
import { KnowledgeDocument } from '../src/core/knowledgeProvider.js';

const documents: KnowledgeDocument[] = [
  {
    id: 'financing',
    title: 'Financiamiento',
    content: 'El crédito requiere aprobación del banco.',
    tags: ['financiamiento', 'credito'],
  },
  {
    id: 'warranty',
    title: 'Garantía',
    content: 'La garantía de fábrica cubre el vehículo nuevo.',
    tags: ['garantia'],
  },
];

const fakeEmbedder = {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      return normalized.includes('crédito') || normalized.includes('credito') || normalized.includes('financiamiento')
        ? [1, 0]
        : [0, 1];
    });
  },
};

describe('RAG vectorial opcional', () => {
  it('usa embeddings para rerankear y mantiene el resultado léxico como respaldo', async () => {
    const provider = new HybridKnowledgeProvider(documents, {}, fakeEmbedder);
    const result = await provider.search('crédito');

    expect(result.found).toBe(true);
    expect(result.documents[0].id).toBe('financing');
  });

  it('sin embedder conserva el comportamiento léxico', async () => {
    const provider = new HybridKnowledgeProvider(documents);
    const result = await provider.search('garantía');

    expect(result.found).toBe(true);
    expect(result.documents[0].id).toBe('warranty');
  });
});
