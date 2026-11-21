import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonCatalogProvider } from '../src/core/catalogProvider.js';
import { loadBusinessPack } from '../src/core/businessProfile.js';
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

    expect(catalog.search({ text: 'RAV4' }).map((item) => item.id)).toEqual(['suv-001']);
    expect(catalog.search({ category: 'sedan' }).map((item) => item.id)).toEqual(['sedan-001']);
    expect(
      catalog.search({ attributes: { transmission: 'automatic', location: 'Caracas' } }).map(
        (item) => item.id
      )
    ).toEqual(['suv-001', 'pickup-001']);
    expect(catalog.get('no-existe')).toBeNull();
  });

  it('respeta el límite y prioriza stock disponible', async () => {
    const pack = await loadBusinessPack(packPath);
    const catalog = new JsonCatalogProvider(pack.catalog);

    const results = catalog.search({ limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0].stock).toBe(true);
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
});
