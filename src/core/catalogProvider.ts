import { CatalogItem } from './types.js';

export interface CatalogQuery {
  text?: string;
  category?: string;
  attributes?: Record<string, unknown>;
  limit?: number;
  includeOutOfStock?: boolean;
}

export interface CatalogSearchResult {
  items: CatalogItem[];
  total: number;
}

export interface CatalogProvider {
  search(query: CatalogQuery): CatalogSearchResult;
  get(id: string): CatalogItem | null;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Proveedor de catálogo en memoria a partir de un pack JSON.
 * Búsqueda determinista: texto, categoría y atributos (comparación por string).
 * Por defecto excluye ítems sin stock; el llamador puede incluir agotados.
 */
export class JsonCatalogProvider implements CatalogProvider {
  private readonly items: CatalogItem[];

  constructor(items: CatalogItem[]) {
    this.items = [...items];
  }

  public search(query: CatalogQuery): CatalogSearchResult {
    const text = normalize(query.text ?? '');
    const category = normalize(query.category ?? '');
    const limit = Math.min(Math.max(query.limit ?? 5, 1), 20);

    const matches = this.items.filter((item) => {
      if (!query.includeOutOfStock && !item.stock) return false;
      if (category && normalize(item.category) !== category) return false;

      if (query.attributes) {
        for (const [key, value] of Object.entries(query.attributes)) {
          if (String(item.attributes[key]) !== String(value)) return false;
        }
      }

      if (!text) return true;

      const haystack = normalize(
        [
          item.name,
          item.category,
          item.description ?? '',
          ...Object.values(item.attributes).map((value) => String(value)),
        ].join(' ')
      );

      return text.split(/\s+/).every((token) => haystack.includes(token));
    });

    const sorted = matches.sort(
      (a, b) => Number(b.stock) - Number(a.stock) || a.name.localeCompare(b.name)
    );

    return { items: sorted.slice(0, limit), total: sorted.length };
  }

  public get(id: string): CatalogItem | null {
    return this.items.find((item) => item.id === id) ?? null;
  }
}
