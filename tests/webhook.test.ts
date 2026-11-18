import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { phoneRateLimiter } from '../src/middleware/rateLimiter.js';
import { idempotencyGate } from '../src/harness/idempotencyGate.js';

describe('Fase 1: Webhook Gateway & Seguridad HMAC', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp();
    phoneRateLimiter.reset();
    idempotencyGate.reset();
  });

  it('GET /health debe retornar estado 200 OK', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.uptimeSeconds).toBeDefined();
  });

  describe('GET /webhook (Meta Challenge Verification)', () => {
    it('debe responder con el challenge si el verify_token es correcto', async () => {
      const challenge = 'test_challenge_code_12345';
      const response = await app.inject({
        method: 'GET',
        url: `/webhook?hub.mode=subscribe&hub.verify_token=${env.WEBHOOK_VERIFY_TOKEN}&hub.challenge=${challenge}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(challenge);
    });

    it('debe rechazar con 403 Forbidden si el verify_token es incorrecto', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/webhook?hub.mode=subscribe&hub.verify_token=token_falso_invalido&hub.challenge=test',
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Forbidden');
    });
  });

  describe('POST /webhook (Ingesta de Eventos & Validación HMAC)', () => {
    const mockPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '123456789',
                  phone_number_id: 'PHONE_NUMBER_ID',
                },
                contacts: [
                  {
                    profile: { name: 'Juan Perez' },
                    wa_id: '573001234567',
                  },
                ],
                messages: [
                  {
                    from: '573001234567',
                    id: 'wamid.HBgLMTIzNDU2Nw==',
                    timestamp: '1789665800',
                    type: 'text',
                    text: { body: 'Hola, deseo cotizar' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    function generateValidSignature(payloadString: string): string {
      const hash = crypto
        .createHmac('sha256', env.META_APP_SECRET)
        .update(payloadString)
        .digest('hex');
      return `sha256=${hash}`;
    }

    it('debe rechazar con 401 Unauthorized si la firma HMAC está ausente', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
        },
        payload: mockPayload,
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Unauthorized');
    });

    it('debe rechazar con 401 Unauthorized si la firma HMAC es errónea', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
        },
        payload: mockPayload,
      });

      expect(response.statusCode).toBe(401);
    });

    it('debe aceptar con 200 OK cuando la firma HMAC es matemáticamente legítima', async () => {
      const payloadString = JSON.stringify(mockPayload);
      const validSignature = generateValidSignature(payloadString);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': validSignature,
        },
        payload: payloadString,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
    });

    it('debe interceptar y deduplicar mensajes idénticos (Idempotencia por wamid)', async () => {
      const wamid = 'wamid.HBgLUNIQUE_TEST_MSG_1==';
      const duplicatePayload = JSON.parse(JSON.stringify(mockPayload));
      duplicatePayload.entry[0].changes[0].value.messages[0].id = wamid;

      const payloadString = JSON.stringify(duplicatePayload);
      const signature = generateValidSignature(payloadString);

      // Primer envío: Debe ser nuevo
      const firstResponse = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
        },
        payload: payloadString,
      });
      expect(firstResponse.statusCode).toBe(200);

      // Esperar a que el async worker registre en PostgreSQL remoto
      let isDuplicate = false;
      for (let i = 0; i < 25; i++) {
        isDuplicate = await idempotencyGate.isAlreadyProcessed(wamid);
        if (isDuplicate) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(isDuplicate).toBe(true);

      // Segundo envío: Sigue retornando 200 OK a Meta pero se descarta internamente
      const secondResponse = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
        },
        payload: payloadString,
      });
      expect(secondResponse.statusCode).toBe(200);
    });

    it('debe limitar a usuarios que envíen más de 10 mensajes en 1 minuto (Rate Limiting)', () => {
      const testPhone = '573119999999';

      // 10 mensajes permitidos
      for (let i = 0; i < 10; i++) {
        expect(phoneRateLimiter.isRateLimited(testPhone)).toBe(false);
      }

      // El mensaje número 11 debe ser limitado
      expect(phoneRateLimiter.isRateLimited(testPhone)).toBe(true);
    });
  });
});
