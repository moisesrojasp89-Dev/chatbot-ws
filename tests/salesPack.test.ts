import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonCatalogProvider } from '../src/core/catalogProvider.js';
import { loadBusinessPack } from '../src/core/businessProfile.js';
import { buildSalesToolRegistry } from '../src/harness/salesToolRegistry.js';
import { contextManager } from '../src/harness/contextManager.js';
import { JsonKnowledgeProvider } from '../src/core/knowledgeProvider.js';
import {
  ToolInputError,
  ToolNotFoundError,
  ToolRegistry,
} from '../src/core/toolRegistry.js';

const packPath = path.join(process.cwd(), 'packs', 'automotive', 'pack.json');
const tempFiles: string[] = [];

afterEach(async () => {
  for (const file of tempFiles.splice(0)) {
    await fs.rm(file, { force: true });
  }
});

describe('Sales Pack base', () => {
  it('carga y valida el pack automotriz de ejemplo', async () => {
    const pack = await loadBusinessPack(packPath);

    expect(pack.profile).toMatchObject({
      id: 'automotive-demo',
      vertical: 'automotive',
      language: 'es',
    });
    expect(pack.catalog).toHaveLength(3);
    expect(pack.prompt?.rules.length).toBeGreaterThan(0);
  });

  it('rechaza un pack inválido', async () => {
    const invalidPath = path.join(process.cwd(), '.tmp_invalid_pack.json');
    tempFiles.push(invalidPath);
    await fs.writeFile(invalidPath, JSON.stringify({ profile: { id: 'x' } }), 'utf8');

    await expect(loadBusinessPack(invalidPath)).rejects.toThrow();
  });

  it('busca por texto, categoría y atributos exactos', async () => {
    const pack = await loadBusinessPack(packPath);
    const catalog = new JsonCatalogProvider(pack.catalog);

    expect(catalog.search({ text: 'RAV4' }).items.map((item) => item.id)).toEqual(['suv-001']);
    expect(catalog.search({ category: 'sedan' }).items.map((item) => item.id)).toEqual(['sedan-001']);
    const automaticCaracas = catalog.search({
      attributes: { transmission: 'automatic', location: 'Caracas' },
    });
    expect(automaticCaracas.items.map((item) => item.id)).toEqual(['suv-001']);
    expect(automaticCaracas.total).toBe(1);

    const withOutOfStock = catalog.search({
      attributes: { transmission: 'automatic', location: 'Caracas' },
      includeOutOfStock: true,
    });
    expect(withOutOfStock.items.map((item) => item.id)).toEqual(['suv-001', 'pickup-001']);
    expect(withOutOfStock.total).toBe(2);
    expect(catalog.get('no-existe')).toBeNull();
  });

  it('respeta el límite y prioriza stock disponible', async () => {
    const pack = await loadBusinessPack(packPath);
    const catalog = new JsonCatalogProvider(pack.catalog);

    const results = catalog.search({ limit: 2 });
    expect(results.items).toHaveLength(2);
    expect(results.total).toBe(2);
    expect(results.items.every((item) => item.stock)).toBe(true);
  });

  it('registra tools, las expone al LLM y ejecuta con validación', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: 'Devuelve el texto recibido',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      inputSchema: z.object({ text: z.string().min(1) }),
      execute: ({ text }, context) => ({ text, channel: context.channel }),
    });

    expect(registry.has('echo')).toBe(true);
    expect(registry.list()[0].function.name).toBe('echo');
    await expect(registry.execute('echo', { text: 'hola' }, { channel: 'telegram' })).resolves.toEqual({
      text: 'hola',
      channel: 'telegram',
    });
    await expect(registry.execute('echo', { text: '' })).rejects.toBeInstanceOf(ToolInputError);
    await expect(registry.execute('missing', {})).rejects.toBeInstanceOf(ToolNotFoundError);
  });

  it('rechaza tools duplicadas', () => {
    const registry = new ToolRegistry();
    const definition = {
      name: 'dup',
      description: 'x',
      parameters: { type: 'object', properties: {} } as const,
      inputSchema: z.object({}),
      execute: () => null,
    };

    registry.register(definition);
    expect(() => registry.register(definition)).toThrow(/duplicada/);
  });
  it('rechaza JSON malformado y rutas fuera del directorio permitido', async () => {
    const malformedPath = path.join(process.cwd(), '.tmp_malformed_pack.json');
    tempFiles.push(malformedPath);
    await fs.writeFile(malformedPath, '{ no-json', 'utf8');

    await expect(loadBusinessPack(malformedPath)).rejects.toThrow(/JSON válido/);
    await expect(loadBusinessPack('../outside-pack.json')).rejects.toThrow(/directorio permitido/);
  });
  it('construye el registry del pack y ejecuta search_inventory', async () => {
    const pack = await loadBusinessPack(packPath);
    const registry = buildSalesToolRegistry(pack);
    const names = registry.list().map((tool) => tool.function.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'search_inventory',
        'get_catalog_item',
        'quote_vehicle',
        'schedule_test_drive',
        'capture_trade_in',
        'capture_lead',
        'handoff_to_advisor',
      ])
    );

    const result = (await registry.execute('search_inventory', { text: 'RAV4' })) as {
      total: number;
      items: Array<{ id: string }>;
    };
    expect(result.total).toBe(1);
    expect(result.items[0].id).toBe('suv-001');
  });

  it('inyecta perfil, reglas y canal en el system prompt del pack', async () => {
    const pack = await loadBusinessPack(packPath);
    const prompt = contextManager.buildSystemInstruction(
      { profile_name: 'Ana' } as never,
      { current_state: 'IDLE', context_summary: '' } as never,
      pack,
      'telegram'
    );

    expect(prompt).toContain('Automotriz Demo');
    expect(prompt).toContain('automotive');
    expect(prompt).toContain('No inventar precio');
    expect(prompt).toContain('<channel>telegram</channel>');
  });
  it('cotiza, agenda test drive y captura permuta con lead diferido', async () => {
    const pack = await loadBusinessPack(packPath);
    const registry = buildSalesToolRegistry(pack);

    const quote = (await registry.execute('quote_vehicle', {
      vehicleId: 'suv-001',
      paymentMethod: 'finance',
    })) as { price: number; paymentMethod: string; note: string };
    expect(quote.price).toBe(28500);
    expect(quote.paymentMethod).toBe('finance');
    expect(quote.note).toContain('no representa aprobación');

    const testDrive = await registry.execute(
      'schedule_test_drive',
      {
        vehicleId: 'suv-001',
        preferredDate: '2026-12-01',
        preferredTime: '10:30',
        location: 'Caracas',
        hasLicense: true,
      },
      { contactId: 'c1', conversationId: 'conv1', deferSideEffects: true }
    );
    expect(testDrive).toMatchObject({ success: true, leadId: 'staged-lead' });

    await expect(
      registry.execute('schedule_test_drive', {
        preferredDate: '2026-12-01',
        preferredTime: '10:30',
        location: 'Caracas',
        hasLicense: false,
      })
    ).rejects.toThrow(/licencia/);

    const tradeIn = await registry.execute(
      'capture_trade_in',
      { make: 'Honda', model: 'CR-V', year: 2019, mileageKm: 80000 },
      { contactId: 'c1', conversationId: 'conv1', deferSideEffects: true }
    );
    expect(tradeIn).toMatchObject({ success: true, leadId: 'staged-lead' });
  });
  it('encuentra por sinónimos y tolera typos, distinguiendo no-match', async () => {
    const pack = await loadBusinessPack(packPath);
    const catalog = new JsonCatalogProvider(pack.catalog, {
      synonyms: pack.search?.synonyms,
      minScore: pack.search?.minScore,
    });

    const pickup = catalog.search({ text: 'camioneta', includeOutOfStock: true });
    expect(pickup.found).toBe(true);
    expect(pickup.items.map((item) => item.id)).toContain('pickup-001');

    const typo = catalog.search({ text: 'RAV-4' });
    expect(typo.found).toBe(true);
    expect(typo.items[0].id).toBe('suv-001');
    expect(typo.alternatives.map((item) => item.id)).not.toContain('suv-001');

    const noMatch = catalog.search({ text: 'helicoptero' });
    expect(noMatch.found).toBe(false);
    expect(noMatch.items).toEqual([]);
  });

  it('devuelve found/confidence/alternativas desde search_inventory', async () => {
    const pack = await loadBusinessPack(packPath);
    const registry = buildSalesToolRegistry(pack);

    const result = (await registry.execute('search_inventory', { text: 'coche automático' })) as {
      found: boolean;
      confidence: number;
      items: Array<{ id: string }>;
    };
    expect(result.found).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.items.length).toBeGreaterThan(0);
  });
  it('recupera conocimiento del pack y distingue no-match', async () => {
    const pack = await loadBusinessPack(packPath);
    const knowledge = new JsonKnowledgeProvider(pack.knowledge);

    const financing = knowledge.search('¿Cómo funciona el financiamiento?');
    expect(financing.found).toBe(true);
    expect(financing.documents[0].id).toBe('financing');

    const warranty = knowledge.search('¿Qué garantía tiene el vehículo?');
    expect(warranty.found).toBe(true);
    expect(warranty.documents[0].id).toBe('warranty');

    expect(knowledge.search('color favorito').found).toBe(false);
    expect(knowledge.search('vehículo', 1).documents.length).toBeLessThanOrEqual(1);
  });

  it('expone search_knowledge en el registry del pack', async () => {
    const pack = await loadBusinessPack(packPath);
    const registry = buildSalesToolRegistry(pack);
    const result = (await registry.execute('search_knowledge', {
      query: 'requisitos para test drive',
    })) as { found: boolean; documents: Array<{ id: string }> };

    expect(result.found).toBe(true);
    expect(result.documents[0].id).toBe('test-drive');
  });
});
