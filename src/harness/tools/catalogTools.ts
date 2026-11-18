import { logger } from '../../utils/logger.js';

export interface ProductItem {
  id: string;
  name: string;
  category: string;
  priceUSD: number;
  billingPeriod: 'monthly' | 'one-time' | 'annual';
  description: string;
  features: string[];
  stockAvailable: boolean;
}

/**
 * Catálogo maestro oficial de productos y servicios empresariales de Chatbot WS.
 * Es la ÚNICA fuente de verdad autorizada para precios y especificaciones.
 */
export const OFFICIAL_CATALOG: ProductItem[] = [
  {
    id: 'plan-starter',
    name: 'Plan Starter',
    category: 'planes',
    priceUSD: 49,
    billingPeriod: 'monthly',
    description: 'Ideal para pequeños comercios y profesionales independientes.',
    features: [
      '1 número oficial de WhatsApp',
      'Hasta 1,000 conversaciones activas/mes',
      'Respuestas automáticas inmediatas con IA',
      'Horarios de atención configurables',
    ],
    stockAvailable: true,
  },
  {
    id: 'plan-pro',
    name: 'Plan Pro',
    category: 'planes',
    priceUSD: 149,
    billingPeriod: 'monthly',
    description: 'Para empresas en crecimiento que requieren escalamiento humano y CRM.',
    features: [
      'Hasta 3 números oficiales de WhatsApp',
      'Hasta 10,000 conversaciones activas/mes',
      'Panel multi-agente para asesores humanos (Handoff)',
      'Captura y calificación automática de leads',
      'Integración con HubSpot y Google Sheets',
    ],
    stockAvailable: true,
  },
  {
    id: 'plan-enterprise',
    name: 'Plan Enterprise',
    category: 'planes',
    priceUSD: 399,
    billingPeriod: 'monthly',
    description: 'Solución corporativa de alta disponibilidad para grandes operaciones.',
    features: [
      'Números y agentes humanos ilimitados',
      'Conversaciones ilimitadas',
      'SLA garantizado de 99.9% de uptime',
      'Despliegue en infraestructura dedicada',
      'Soporte telefónico 24/7 y Account Manager asignado',
    ],
    stockAvailable: true,
  },
  {
    id: 'servicio-setup',
    name: 'Setup y Onboarding VIP',
    category: 'servicios',
    priceUSD: 250,
    billingPeriod: 'one-time',
    description: 'Servicio llave en mano de configuración, verificación de Meta y diseño de flujos.',
    features: [
      'Verificación oficial del negocio ante Meta',
      'Carga y estructuración del catálogo de productos',
      'Capacitación técnica de 2 horas al equipo de ventas',
    ],
    stockAvailable: true,
  },
];

export interface SearchCatalogParams {
  query: string;
  category?: string;
}

export interface CatalogSearchResult {
  totalResults: number;
  products: ProductItem[];
  verifiedPriceQuote: string;
}

/**
 * Consulta el catálogo de productos y servicios autorizados.
 */
export function searchProductCatalog(params: SearchCatalogParams): CatalogSearchResult {
  const q = (params.query || '').toLowerCase().trim();
  const cat = (params.category || '').toLowerCase().trim();

  logger.info({ query: q, category: cat }, '🔍 Ejecutando Tool: searchProductCatalog');

  const filtered = OFFICIAL_CATALOG.filter((item) => {
    const matchesQuery =
      !q ||
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.features.some((f) => f.toLowerCase().includes(q));

    const matchesCategory = !cat || item.category.toLowerCase().includes(cat);

    return matchesQuery && matchesCategory;
  });

  const quoteSummary = filtered
    .map(
      (p) =>
        `• *${p.name}*: $${p.priceUSD} USD (${p.billingPeriod === 'monthly' ? 'mensual' : 'pago único'}). ${p.description}`
    )
    .join('\n');

  return {
    totalResults: filtered.length,
    products: filtered,
    verifiedPriceQuote: quoteSummary || 'No se encontraron productos coincidentes en el catálogo oficial.',
  };
}
