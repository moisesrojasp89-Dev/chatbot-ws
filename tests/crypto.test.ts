import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { validateMetaSignature } from '../src/utils/crypto.js';
import { env } from '../src/config/env.js';

describe('Blindaje Criptográfico HMAC-SHA256 (validateMetaSignature)', () => {
  const samplePayload = JSON.stringify({ event: 'ping', timestamp: 1761600000 });

  function makeSignature(body: string, secret: string = env.META_APP_SECRET): string {
    const hash = crypto.createHmac('sha256', secret).update(body).digest('hex');
    return `sha256=${hash}`;
  }

  it('debe validar exitosamente cuando el cuerpo y la firma coinciden', () => {
    const signature = makeSignature(samplePayload);
    expect(validateMetaSignature(samplePayload, signature)).toBe(true);
  });

  it('debe soportar rawBody provisto tanto como string como Buffer', () => {
    const signature = makeSignature(samplePayload);
    const bufferPayload = Buffer.from(samplePayload, 'utf-8');
    expect(validateMetaSignature(bufferPayload, signature)).toBe(true);
  });

  it('debe rechazar si falta el rawBody o el signatureHeader', () => {
    const signature = makeSignature(samplePayload);
    expect(validateMetaSignature(undefined, signature)).toBe(false);
    expect(validateMetaSignature(samplePayload, undefined)).toBe(false);
    expect(validateMetaSignature('', signature)).toBe(false);
    expect(validateMetaSignature(samplePayload, '')).toBe(false);
  });

  it('debe rechazar si el prefijo no es sha256=', () => {
    const hash = crypto.createHmac('sha256', env.META_APP_SECRET).update(samplePayload).digest('hex');
    expect(validateMetaSignature(samplePayload, `sha1=${hash}`)).toBe(false);
    expect(validateMetaSignature(samplePayload, hash)).toBe(false);
  });

  it('debe rechazar firmas con longitud o caracteres no hexadecimales (blindaje contra maleabilidad)', () => {
    const validHash = crypto.createHmac('sha256', env.META_APP_SECRET).update(samplePayload).digest('hex');
    
    // Hash con caracteres no hex al final (maleabilidad en Buffer.from)
    expect(validateMetaSignature(samplePayload, `sha256=${validHash}ZZZ`)).toBe(false);

    // Hash truncado
    expect(validateMetaSignature(samplePayload, `sha256=deadbeef`)).toBe(false);

    // Hash con caracteres inválidos intercalados
    const invalidHex = validHash.slice(0, 60) + 'GGGG';
    expect(validateMetaSignature(samplePayload, `sha256=${invalidHex}`)).toBe(false);
  });

  it('debe rechazar firmas legítimas pero calculadas con otro secret', () => {
    const invalidSignature = makeSignature(samplePayload, 'wrong_secret_123456');
    expect(validateMetaSignature(samplePayload, invalidSignature)).toBe(false);
  });

  it('debe rechazar si el cuerpo fue alterado mínimamente (tampering)', () => {
    const signature = makeSignature(samplePayload);
    const tamperedPayload = samplePayload + ' ';
    expect(validateMetaSignature(tamperedPayload, signature)).toBe(false);
  });
});
