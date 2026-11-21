import { z } from 'zod';
import { BusinessPack } from '../core/types.js';
import { JsonCatalogProvider } from '../core/catalogProvider.js';
import { ToolRegistry } from '../core/toolRegistry.js';
import { searchProductCatalog } from './tools/catalogTools.js';
import { createQualifiedLead } from './tools/leadTools.js';
import { requestHumanHandoff } from './tools/handoffTools.js';

const leadInput = z.object({
  productInterest: z.string().min(1),
  estimatedBudget: z.number().nonnegative().optional(),
  customerEmail: z.string().email().optional(),
  customerCity: z.string().min(1).optional(),
  notes: z.string().optional(),
});

const handoffInput = z.object({
  reason: z
    .enum(['USER_REQUEST', 'FRUSTRATION', 'TOOL_FAILURE', 'OUT_OF_SCOPE', 'SYSTEM_DELAY'])
    .optional(),
  briefing: z.string().min(1),
});

/**
 * Construye el registry por defecto o el del pack activo.
 * Las tools reales del pack automotriz se agregan en 4A.2.
 */
export function buildSalesToolRegistry(pack: BusinessPack | null): ToolRegistry {
  const registry = new ToolRegistry();

  if (!pack) {
    registry.register({
      name: 'searchProductCatalog',
      description: 'Consulta el catálogo de productos con precios y disponibilidad.',
      effect: 'catalog',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Término de búsqueda' },
          category: { type: 'string', description: 'Categoría opcional' },
        },
        required: ['query'],
      },
      inputSchema: z.object({ query: z.string(), category: z.string().optional() }),
      execute: (input) => searchProductCatalog(input),
    });

    registry.register({
      name: 'createQualifiedLead',
      description: 'Registra un lead calificado.',
      effect: 'lead',
      parameters: {
        type: 'object',
        properties: {
          productInterest: { type: 'string' },
          estimatedBudget: { type: 'number' },
          customerEmail: { type: 'string' },
          customerCity: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['productInterest'],
      },
      inputSchema: leadInput,
      execute: (input, context) =>
        createQualifiedLead(
          {
            ...input,
            contactId: context.contactId ?? '',
            conversationId: context.conversationId ?? '',
          },
          { defer: context.deferSideEffects }
        ),
    });

    registry.register({
      name: 'requestHumanHandoff',
      description: 'Escala la conversación a un asesor humano.',
      effect: 'handoff',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            enum: ['USER_REQUEST', 'FRUSTRATION', 'TOOL_FAILURE', 'OUT_OF_SCOPE', 'SYSTEM_DELAY'],
          },
          briefing: { type: 'string' },
        },
        required: ['briefing'],
      },
      inputSchema: handoffInput,
      execute: (input, context) =>
        requestHumanHandoff(
          {
            ...input,
            contactId: context.contactId ?? '',
            conversationId: context.conversationId ?? '',
          },
          { defer: context.deferSideEffects }
        ),
    });

    return registry;
  }

  const catalog = new JsonCatalogProvider(pack.catalog);

  registry.register({
    name: 'search_inventory',
    description: 'Busca vehículos en el catálogo del negocio.',
    effect: 'catalog',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        category: { type: 'string' },
        attributes: { type: 'object' },
        limit: { type: 'number' },
        includeOutOfStock: { type: 'boolean' },
      },
    },
    inputSchema: z.object({
      text: z.string().optional(),
      category: z.string().optional(),
      attributes: z.record(z.unknown()).optional(),
      limit: z.number().int().min(1).max(20).optional(),
      includeOutOfStock: z.boolean().optional(),
    }),
    execute: (input) => catalog.search(input),
  });

  registry.register({
    name: 'get_catalog_item',
    description: 'Obtiene la ficha completa de un ítem del catálogo.',
    effect: 'catalog',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    inputSchema: z.object({ id: z.string() }),
    execute: (input) => catalog.get(input.id),
  });

  registry.register({
    name: 'capture_lead',
    description: 'Registra los datos de contacto y calificación del cliente.',
    effect: 'lead',
    parameters: {
      type: 'object',
      properties: {
        productInterest: { type: 'string' },
        estimatedBudget: { type: 'number' },
        customerEmail: { type: 'string' },
        customerCity: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['productInterest'],
    },
    inputSchema: leadInput,
    execute: (input, context) =>
      createQualifiedLead(
        {
          ...input,
          contactId: context.contactId ?? '',
          conversationId: context.conversationId ?? '',
        },
        { defer: context.deferSideEffects }
      ),
  });

  registry.register({
    name: 'handoff_to_advisor',
    description: 'Escala a un asesor humano con contexto.',
    effect: 'handoff',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string' }, briefing: { type: 'string' } },
      required: ['briefing'],
    },
    inputSchema: handoffInput,
    execute: (input, context) =>
      requestHumanHandoff(
        {
          ...input,
          contactId: context.contactId ?? '',
          conversationId: context.conversationId ?? '',
        },
        { defer: context.deferSideEffects }
      ),
  });

  return registry;
}
