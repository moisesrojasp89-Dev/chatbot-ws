import { CatalogItem } from './types.js';

export interface CatalogQuery {
  text?: string;
  category?: string;
  attributes?: Record<string, unknown>;
  limit?: number;
}

export interface CatalogProvider {
  search(query: CatalogQuery): CatalogItem[];
  get(id: string): CatalogItem | null;
}

/**
 * Proveedor de catálogo en memoria a partir de un pack JSON.
 * Búsqueda simple y determinista: texto, categoría y atributos exactos.
 */
export class JsonCatalogProvider implements CatalogProvider {
  private readonly items: CatalogItem[];

  constructor(items: CatalogItem[]) {
    this.items = [...items];
  }

  public search(query: CatalogQuery): CatalogItem[] {
    const text = (query.text ?? '').toLowerCase().trim();
    const category = (query.category ?? '').toLowerCase().trim();
    const limit = Math.max(1, Math.min(query.limit ?? 5, 20));

    const matches = this.items.filter((item) => {
      if (category && item.category.toLowerCase() !== category) return false;

      if (query.attributes) {
        for (const [key, value] of Object.entries(query.attributes)) {
          if (item.attributes[key] !== value) return false;
        }
      }

      if (!text) return true;

      const haystack = [
        item.name,
        item.category,
        item.description ?? '',
        ...Object.values(item.attributes).map((value) => String(value)),
      ]
        .join(' ')
        .toLowerCase();

      return text.split(/\s+/).every((token) => haystack.includes(token));
    });

    return matches
      .sort((a, b) => Number(b.stock) - Number(a.stock) || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  public get(id: string): CatalogItem | null {
    return this.items.find((item) => item.id === id) ?? null;
  }
}
