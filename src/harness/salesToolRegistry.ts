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

  const catalog = new JsonCatalogProvider(pack.catalog, {
    synonyms: pack.search?.synonyms,
    minScore: pack.search?.minScore,
  });

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
    name: 'quote_vehicle',
    description: 'Cotiza un vehículo del catálogo sin aprobar crédito.',
    effect: 'catalog',
    parameters: {
      type: 'object',
      properties: {
        vehicleId: { type: 'string' },
        paymentMethod: { type: 'string', enum: ['cash', 'finance'] },
      },
      required: ['vehicleId'],
    },
    inputSchema: z.object({
      vehicleId: z.string().min(1),
      paymentMethod: z.enum(['cash', 'finance']).default('cash'),
    }),
    execute: (input) => {
      const vehicle = catalog.get(input.vehicleId);
      if (!vehicle) throw new Error('Vehículo no encontrado en el catálogo');
      return {
        vehicleId: vehicle.id,
        name: vehicle.name,
        price: vehicle.price,
        currency: vehicle.currency,
        paymentMethod: input.paymentMethod,
        available: vehicle.stock,
        priceIncludesTax: pack.profile.policies.priceIncludesTax === true,
        note:
          input.paymentMethod === 'finance'
            ? 'Cotización informativa; no representa aprobación de crédito.'
            : 'Precio sujeto a disponibilidad y confirmación del asesor.',
      };
    },
  });

  registry.register({
    name: 'schedule_test_drive',
    description: 'Solicita una cita de test drive; requiere confirmación humana.',
    effect: 'lead',
    parameters: {
      type: 'object',
      properties: {
        vehicleId: { type: 'string' },
        preferredDate: { type: 'string' },
        preferredTime: { type: 'string' },
        location: { type: 'string' },
        hasLicense: { type: 'boolean' },
      },
      required: ['preferredDate', 'preferredTime', 'location', 'hasLicense'],
    },
    inputSchema: z.object({
      vehicleId: z.string().optional(),
      preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      preferredTime: z.string().regex(/^\d{2}:\d{2}$/),
      location: z.string().min(1),
      hasLicense: z.boolean(),
    }),
    leadArgs: (input) => ({
      productInterest: `Solicitud de test drive${input.vehicleId ? `: ${input.vehicleId}` : ''}`,
      customerCity: input.location,
      notes: `Test drive ${input.preferredDate} ${input.preferredTime}; licencia=${input.hasLicense}`,
    }),
    execute: (input, context) => {
      if (!input.hasLicense) {
        throw new Error('El test drive requiere licencia de conducir vigente');
      }
      if (input.vehicleId && !catalog.get(input.vehicleId)) {
        throw new Error('Vehículo no encontrado en el catálogo');
      }
      return createQualifiedLead(
        {
          contactId: context.contactId ?? '',
          conversationId: context.conversationId ?? '',
          productInterest: `Solicitud de test drive${input.vehicleId ? `: ${input.vehicleId}` : ''}`,
          customerCity: input.location,
          notes: `Test drive ${input.preferredDate} ${input.preferredTime}; licencia=${input.hasLicense}`,
        },
        { defer: context.deferSideEffects }
      );
    },
  });

  registry.register({
    name: 'capture_trade_in',
    description: 'Registra un vehículo de permuta sujeto a inspección.',
    effect: 'lead',
    parameters: {
      type: 'object',
      properties: {
        make: { type: 'string' },
        model: { type: 'string' },
        year: { type: 'number' },
        mileageKm: { type: 'number' },
        conditionNotes: { type: 'string' },
      },
      required: ['make', 'model', 'year', 'mileageKm'],
    },
    inputSchema: z.object({
      make: z.string().min(1),
      model: z.string().min(1),
      year: z.number().int().min(1950).max(2100),
      mileageKm: z.number().int().nonnegative(),
      conditionNotes: z.string().optional(),
    }),
    leadArgs: (input) => ({
      productInterest: `Permuta: ${input.make} ${input.model} ${input.year}`,
      notes: `Kilometraje: ${input.mileageKm}. ${input.conditionNotes ?? ''}`.trim(),
    }),
    execute: (input, context) =>
      createQualifiedLead(
        {
          contactId: context.contactId ?? '',
          conversationId: context.conversationId ?? '',
          productInterest: `Permuta: ${input.make} ${input.model} ${input.year}`,
          notes: `Kilometraje: ${input.mileageKm}. ${input.conditionNotes ?? ''}`.trim(),
        },
        { defer: context.deferSideEffects }
      ),
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
