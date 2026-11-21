import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBusinessPack } from '../src/core/businessProfile.js';

describe('Pilot kit automotriz', () => {
  it('carga el pack de piloto con catálogo y conocimiento válidos', async () => {
    const pack = await loadBusinessPack(
      path.join(process.cwd(), 'pilot', 'automotive', 'pack.json')
    );

    expect(pack.profile.name).toBe('Automotriz Piloto');
    expect(pack.catalog).toHaveLength(12);
    expect(pack.knowledge).toHaveLength(5);
    expect(Object.keys(pack.search?.synonyms ?? {}).length).toBeGreaterThan(5);

    for (const vehicle of pack.catalog) {
      expect(vehicle.images[0]).toMatch(/^https:\/\//);
      expect(vehicle.attributes.make).toBeTruthy();
      expect(vehicle.attributes.model).toBeTruthy();
    }
  });
});
