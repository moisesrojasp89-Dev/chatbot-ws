import crypto from 'node:crypto';
import { getMetaConfig } from '../providers/channels/meta/metaConfig.js';
import { logger } from './logger.js';

const SHA256_HEX_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Valida la firma HMAC SHA-256 enviada por Meta en el header `X-Hub-Signature-256`.
 * 
 * @param rawBody El cuerpo exacto de la petición HTTP en bytes o string crudo.
 * @param signatureHeader El valor del header 'x-hub-signature-256' (ej: 'sha256=abc123...').
 * @returns boolean indicando si la firma es matemáticamente legítima.
 */
export function validateMetaSignature(
  rawBody: string | Buffer | undefined,
  signatureHeader: string | undefined
): boolean {
  if (!rawBody || !signatureHeader) {
    logger.warn('Falta el cuerpo crudo de la petición o el encabezado de firma de Meta');
    return false;
  }

  try {
    const parts = signatureHeader.split('=');
    if (parts.length !== 2 || parts[0] !== 'sha256' || !SHA256_HEX_REGEX.test(parts[1])) {
      logger.warn('Formato inválido en encabezado x-hub-signature-256');
      return false;
    }

    const bodyBuffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf-8') : rawBody;

    // Obtener el digest directamente como Buffer de 32 bytes (sin pasar por string hex intermedio)
    const calculatedBuffer = crypto
      .createHmac('sha256', getMetaConfig().appSecret)
      .update(bodyBuffer)
      .digest();

    const expectedBuffer = Buffer.from(parts[1], 'hex');

    if (expectedBuffer.length !== calculatedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, calculatedBuffer);
  } catch (error) {
    logger.error({ error }, 'Error al validar la firma HMAC de Meta');
    return false;
  }
}

