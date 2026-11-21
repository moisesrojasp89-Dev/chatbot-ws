export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  tags: string[];
  source?: string;
}

export interface KnowledgeSearchResult {
  found: boolean;
  confidence: number;
  documents: KnowledgeDocument[];
}

export interface KnowledgeSearchOptions {
  synonyms?: Record<string, string[]>;
  minScore?: number;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = temp;
    }
  }
  return previous[b.length];
}

function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

/**
 * RAG léxico por pack: recupera documentos de políticas/FAQ por tokens,
 * sinónimos y fuzzy matching. Las respuestas deben citar la fuente.
 */
export class JsonKnowledgeProvider {
  private readonly documents: KnowledgeDocument[];
  private readonly synonyms = new Map<string, string[]>();
  private readonly minScore: number;

  constructor(documents: KnowledgeDocument[], options: KnowledgeSearchOptions = {}) {
    this.documents = [...documents];
    this.minScore = options.minScore ?? 0.3;
    for (const [key, values] of Object.entries(options.synonyms ?? {})) {
      this.synonyms.set(
        normalize(key),
        values.map((value) => normalize(value))
      );
    }
  }

  public search(query: string, limit = 3): KnowledgeSearchResult {
    const rawText = normalize(query);
    if (!rawText || this.documents.length === 0) {
      return { found: false, confidence: 0, documents: [] };
    }

    const tokens = rawText.split(/\s+/).filter((token) => token.length > 2);
    const scored = this.documents
      .map((document) => {
        const haystack = normalize(
          [document.title, document.content, ...document.tags].join(' ')
        );
        if (haystack.includes(rawText)) return { document, score: 1 };

        const words = haystack.split(/\s+/).filter(Boolean);
        let total = 0;
        for (const token of tokens) {
          if (haystack.includes(token)) {
            total += 1;
            continue;
          }
          const expansions = this.synonyms.get(token) ?? [];
          if (expansions.some((expansion) => haystack.includes(expansion))) {
            total += 0.9;
            continue;
          }
          const best = words.reduce((max, word) => {
            if (Math.abs(word.length - token.length) > 2) return max;
            return Math.max(max, similarity(token, word));
          }, 0);
          total += best >= 0.75 ? best * 0.8 : 0;
        }
        return { document, score: total / Math.max(tokens.length, 1) };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    const topScore = scored[0]?.score ?? 0;
    const found = topScore >= this.minScore;

    return {
      found,
      confidence: Math.round(topScore * 100) / 100,
      documents: found
        ? scored
            .filter(({ score }) => score >= this.minScore)
            .slice(0, Math.min(Math.max(limit, 1), 5))
            .map(({ document }) => document)
        : [],
    };
  }
}
