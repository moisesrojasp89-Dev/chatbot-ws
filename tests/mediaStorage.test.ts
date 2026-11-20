import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { ChannelAdapter } from '../src/providers/channels/channelTypes.js';
import { purgeMediaFiles, storeMedia } from '../src/services/mediaStorage.js';

const tempDir = path.join(process.cwd(), '.tmp_media_test');
const previousDir = env.MEDIA_STORAGE_DIR;
const previousEnabled = env.MEDIA_STORAGE_ENABLED;
const previousMax = env.MEDIA_MAX_BYTES;

const adapter: ChannelAdapter = {
  channel: 'telegram',
  verifyInbound: () => true,
  parseInbound: () => ({ messages: [], statuses: [] }),
  sendText: async () => ({ externalMessageId: 'x' }),
  downloadMedia: async () => ({
    buffer: Buffer.from('hello'),
    mimeType: 'image/png',
    fileName: 'foto.png',
  }),
};

afterEach(async () => {
  env.MEDIA_STORAGE_DIR = previousDir;
  env.MEDIA_STORAGE_ENABLED = previousEnabled;
  env.MEDIA_MAX_BYTES = previousMax;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('Pipeline de media', () => {
  it('almacena el binario por hash bajo el canal y es idempotente', async () => {
    env.MEDIA_STORAGE_ENABLED = 'true';
    env.MEDIA_STORAGE_DIR = tempDir;
    env.MEDIA_MAX_BYTES = 1024;

    const first = await storeMedia('telegram', { kind: 'image', fileId: 'f1' }, adapter);
    const second = await storeMedia('telegram', { kind: 'image', fileId: 'f1' }, adapter);

    expect(first).not.toBeNull();
    expect(first?.relativePath).toContain('telegram');
    expect(first?.size).toBe(5);
    expect(first?.sha256).toHaveLength(64);
    expect(second?.relativePath).toBe(first?.relativePath);

    const stored = await fs.readFile(path.join(tempDir, first!.relativePath));
    expect(stored.toString()).toBe('hello');
  });

  it('es no-op si MEDIA_STORAGE_ENABLED=false', async () => {
    env.MEDIA_STORAGE_ENABLED = 'false';
    await expect(storeMedia('telegram', { kind: 'image', fileId: 'f1' }, adapter)).resolves.toBeNull();
  });

  it('rechaza media que excede MEDIA_MAX_BYTES', async () => {
    env.MEDIA_STORAGE_ENABLED = 'true';
    env.MEDIA_STORAGE_DIR = tempDir;
    env.MEDIA_MAX_BYTES = 3;

    await expect(storeMedia('telegram', { kind: 'image', fileId: 'f1' }, adapter)).rejects.toThrow(
      /excede/
    );
  });
  it('purga binarios anteriores a la retención y conserva los recientes', async () => {
    env.MEDIA_STORAGE_ENABLED = 'true';
    env.MEDIA_STORAGE_DIR = tempDir;
    env.MEDIA_MAX_BYTES = 1024;

    const stored = await storeMedia('telegram', { kind: 'image', fileId: 'old' }, adapter);
    const oldPath = path.join(tempDir, stored!.relativePath);
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldPath, oldDate, oldDate);

    const adapterNew: ChannelAdapter = { ...adapter, downloadMedia: async () => ({ buffer: Buffer.from('world'), mimeType: 'image/png' }) };
    const recent = await storeMedia('telegram', { kind: 'image', fileId: 'new' }, adapterNew);
    const recentPath = path.join(tempDir, recent!.relativePath);

    const deleted = await purgeMediaFiles(7);

    expect(deleted).toBe(1);
    await expect(fs.access(oldPath)).rejects.toThrow();
    await expect(fs.access(recentPath)).resolves.toBeUndefined();
  });

  it('sanitiza el nombre del canal sin salir del directorio base', async () => {
    env.MEDIA_STORAGE_ENABLED = 'true';
    env.MEDIA_STORAGE_DIR = tempDir;
    env.MEDIA_MAX_BYTES = 1024;

    const stored = await storeMedia('../evil', { kind: 'image', fileId: 'f1' }, adapter);

    expect(stored?.relativePath).not.toContain('..');
    expect(path.isAbsolute(stored!.relativePath)).toBe(false);
  });
});
