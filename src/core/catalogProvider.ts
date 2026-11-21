import { CatalogItem } from './types.js';

export interface CatalogQuery {
  text?: string;
  category?: string;
  attributes?: Record<string, unknown>;
  limit?: number;
  includeOutOfStock?: boolean;
}

export interface CatalogSearchResult {
  found: boolean;
  confidence: number;
  items: CatalogItem[];
  alternatives: CatalogItem[];
  total: number;
}

export interface CatalogProvider {
  search(query: CatalogQuery): CatalogSearchResult;
  get(id: string): CatalogItem | null;
}

export interface CatalogSearchOptions {
  synonyms?: Record<string, string[]>;
  minScore?: number;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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
 * Catálogo en memoria con búsqueda semántica ligera:
 * sinónimos del pack, cobertura de tokens y fuzzy matching para typos.
 */
export class JsonCatalogProvider implements CatalogProvider {
  private readonly items: CatalogItem[];
  private readonly synonyms = new Map<string, string[]>();
  private readonly minScore: number;

  constructor(items: CatalogItem[], options: CatalogSearchOptions = {}) {
    this.items = [...items];
    this.minScore = options.minScore ?? 0.35;

    for (const [key, values] of Object.entries(options.synonyms ?? {})) {
      const normalizedKey = normalize(key);
      this.synonyms.set(
        normalizedKey,
        values.map((value) => normalize(value))
      );
    }
  }

  public search(query: CatalogQuery): CatalogSearchResult {
    const rawText = normalize(query.text ?? '');
    const queryTokens = rawText ? rawText.split(/\s+/).filter(Boolean) : [];
    const category = normalize(query.category ?? '');
    const limit = Math.min(Math.max(query.limit ?? 5, 1), 20);

    const filtered = this.items.filter((item) => {
      if (!query.includeOutOfStock && !item.stock) return false;
      if (category && normalize(item.category) !== category) return false;

      if (query.attributes) {
        for (const [key, value] of Object.entries(query.attributes)) {
          if (String(item.attributes[key]) !== String(value)) return false;
        }
      }
      return true;
    });

    const scored = filtered
      .map((item) => {
        const haystack = normalize(
          [
            item.name,
            item.category,
            item.description ?? '',
            ...Object.values(item.attributes).map((value) => String(value)),
          ].join(' ')
        );

        if (!rawText) return { item, score: 1 };
        if (haystack.includes(rawText)) return { item, score: 1 };

        const words = haystack.split(/\s+/).filter(Boolean);
        let total = 0;

        for (const token of queryTokens) {
          if (token.length <= 2) continue;
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

          total += best >= 0.72 ? best * 0.8 : 0;
        }

        return { item, score: total / Math.max(queryTokens.length, 1) };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || Number(b.item.stock) - Number(a.item.stock));

    const topScore = scored[0]?.score ?? 0;
    const found = rawText ? topScore >= this.minScore : scored.length > 0;

    const items = found ? scored.slice(0, limit).map(({ item }) => item) : [];
    const itemIds = new Set(items.map((item) => item.id));

    return {
      found,
      confidence: Math.round(topScore * 100) / 100,
      items,
      alternatives: scored
        .filter(({ item }) => !itemIds.has(item.id))
        .slice(0, 3)
        .map(({ item }) => item),
      total: scored.length,
    };
  }

  public get(id: string): CatalogItem | null {
    return this.items.find((item) => item.id === id) ?? null;
  }
}
