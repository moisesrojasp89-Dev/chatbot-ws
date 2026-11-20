import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { ChannelAdapter, NormalizedMedia } from '../providers/channels/channelTypes.js';
import { logger } from '../utils/logger.js';

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
};

export interface StoredMedia {
  relativePath: string;
  mimeType: string;
  size: number;
  sha256: string;
}

/**
 * Descarga y guarda media fuera de la base de datos.
 *
 * - Deshabilitado por `MEDIA_STORAGE_ENABLED=false`.
 * - Nombre por hash de contenido (idempotente entre reintentos).
 * - Sin path traversal: todo queda bajo MEDIA_STORAGE_DIR/<channel>/.
 * - No loguea URLs, tokens ni nombres originales.
 */
export async function storeMedia(
  channel: string,
  media: NormalizedMedia,
  adapter: ChannelAdapter
): Promise<StoredMedia | null> {
  if (env.MEDIA_STORAGE_ENABLED !== 'true') return null;
  if (!adapter.downloadMedia) return null;

  const downloaded = await adapter.downloadMedia(media);
  if (downloaded.buffer.length === 0) {
    throw new Error('Media vacío');
  }
  if (downloaded.buffer.length > env.MEDIA_MAX_BYTES) {
    throw new Error(`Media excede el límite de ${env.MEDIA_MAX_BYTES} bytes`);
  }

  const baseDir = path.resolve(env.MEDIA_STORAGE_DIR);
  const safeChannel = channel.replace(/[^a-z0-9_-]/gi, '_').toLowerCase() || 'unknown';
  const extension =
    MIME_EXTENSIONS[downloaded.mimeType] ??
    (path.extname(downloaded.fileName ?? '').toLowerCase().match(/^\.[a-z0-9]{1,10}$/)?.[0] ?? '.bin');

  const sha256 = crypto.createHash('sha256').update(downloaded.buffer).digest('hex');
  const dir = path.join(baseDir, safeChannel);
  const fullPath = path.join(dir, `${sha256}${extension}`);

  if (!fullPath.startsWith(`${baseDir}${path.sep}`)) {
    throw new Error('Ruta de media inválida');
  }

  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(fullPath, downloaded.buffer, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const relativePath = path.relative(baseDir, fullPath);
  logger.info(
    { channel: safeChannel, mimeType: downloaded.mimeType, size: downloaded.buffer.length },
    '📎 Media descargado y almacenado'
  );

  return {
    relativePath,
    mimeType: downloaded.mimeType,
    size: downloaded.buffer.length,
    sha256,
  };
}
/**
 * Borra binarios más antiguos que `olderThanDays` (mtime). Best-effort: un
 * archivo ilegible no detiene la purga. No sigue symlinks.
 */
export async function purgeMediaFiles(olderThanDays: number): Promise<number> {
  const baseDir = path.resolve(env.MEDIA_STORAGE_DIR);
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  let channels: import('node:fs').Dirent[];
  try {
    channels = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }

  for (const entry of channels) {
    if (!entry.isDirectory()) continue;
    const channelDir = path.join(baseDir, entry.name);
    if (!channelDir.startsWith(`${baseDir}${path.sep}`)) continue;

    let files: import('node:fs').Dirent[];
    try {
      files = await fs.readdir(channelDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile()) continue;
      const fullPath = path.join(channelDir, file.name);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(fullPath);
          deleted++;
        }
      } catch {
        // best-effort
      }
    }
  }

  if (deleted > 0) logger.info({ deleted, olderThanDays }, '🧹 Binarios de media purgados por retención');
  return deleted;
}