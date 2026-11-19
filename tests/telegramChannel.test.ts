import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleTelegramWebhook } from '../src/controllers/telegramWebhookController.js';
import { inboundRepository } from '../src/repositories/inboundRepository.js';
import { telegramChannelSender } from '../src/providers/channels/telegram/telegramChannelSender.js';

vi.mock('../src/providers/channels/telegram/telegramConfig.js', () => {
  class TelegramConfigError extends Error {}
  return {
    TelegramConfigError,
    getTelegramConfig: () => ({
      botToken: 'test_bot_token',
      webhookSecret: 'test_webhook_secret',
    }),
  };
});

function mockFetchResponse(status: number, body: unknown): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

function createReply() {
  return {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Canal Telegram: egress', () => {
  it('envía texto y devuelve el id externo con prefijo tg:', async () => {
    mockFetchResponse(200, { ok: true, result: { message_id: 55 } });

    await expect(
      telegramChannelSender.sendText({ accountId: 'telegram', recipientId: '99', text: 'hola' })
    ).resolves.toEqual({ externalMessageId: 'tg:out:99:55' });
  });

  it('mapea 401 a SYSTEMIC_AUTH', async () => {
    mockFetchResponse(401, { ok: false, error_code: 401, description: 'Unauthorized' });

    await expect(
      telegramChannelSender.sendText({ accountId: 'telegram', recipientId: '99', text: 'hola' })
    ).rejects.toMatchObject({ kind: 'SYSTEMIC_AUTH' });
  });

  it('mapea 429 a RATE_LIMIT y conserva retry_after', async () => {
    mockFetchResponse(429, {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 30 },
    });

    await expect(
      telegramChannelSender.sendText({ accountId: 'telegram', recipientId: '99', text: 'hola' })
    ).rejects.toMatchObject({ kind: 'RATE_LIMIT', retryAfterSeconds: 30 });
  });

  it('mapea 400 a FATAL', async () => {
    mockFetchResponse(400, { ok: false, error_code: 400, description: 'Bad Request' });

    await expect(
      telegramChannelSender.sendText({ accountId: 'telegram', recipientId: '99', text: 'hola' })
    ).rejects.toMatchObject({ kind: 'FATAL' });
  });

  it('mapea 5xx a TRANSIENT', async () => {
    mockFetchResponse(502, { ok: false, error_code: 502, description: 'Bad Gateway' });

    await expect(
      telegramChannelSender.sendText({ accountId: 'telegram', recipientId: '99', text: 'hola' })
    ).rejects.toMatchObject({ kind: 'TRANSIENT' });
  });
});

describe('Canal Telegram: ingress', () => {
  it('rechaza con 401 un secret token inválido', async () => {
    const persist = vi.spyOn(inboundRepository, 'persistInboundEvent');
    const reply = createReply();

    await handleTelegramWebhook(
      {
        headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
        body: { update_id: 1, message: { chat: { id: 99 }, text: 'hola' } },
        ip: '127.0.0.1',
      } as never,
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(persist).not.toHaveBeenCalled();
  });

  it('persiste el update como canal telegram y responde 200', async () => {
    const persist = vi
      .spyOn(inboundRepository, 'persistInboundEvent')
      .mockResolvedValueOnce({ id: 'event-1' } as never);
    const reply = createReply();

    await handleTelegramWebhook(
      {
        headers: { 'x-telegram-bot-api-secret-token': 'test_webhook_secret' },
        body: {
          update_id: 123,
          message: { date: 1700000000, chat: { id: 99 }, text: 'hola', from: { first_name: 'Ana' } },
        },
        ip: '127.0.0.1',
      } as never,
      reply as never
    );

    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'telegram',
        wamid: 'tg:in:123',
        phoneNumberId: 'telegram',
        senderPhone: '99',
      })
    );
    expect(reply.status).toHaveBeenCalledWith(200);
  });
  it('considera TRANSIENT un 200 sin message_id (no marca FAILED)', async () => {
    mockFetchResponse(200, { ok: true });

    await expect(
      telegramChannelSender.sendText({ accountId: 'telegram', recipientId: '99', text: 'hola' })
    ).rejects.toMatchObject({ kind: 'TRANSIENT' });
  });

  it('ignora con 200 un update malformado sin persistir', async () => {
    const persist = vi.spyOn(inboundRepository, 'persistInboundEvent');
    const reply = createReply();

    await handleTelegramWebhook(
      {
        headers: { 'x-telegram-bot-api-secret-token': 'test_webhook_secret' },
        body: {},
        ip: '127.0.0.1',
      } as never,
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(persist).not.toHaveBeenCalled();
  });
});
