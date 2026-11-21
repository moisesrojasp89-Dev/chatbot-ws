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
  it('descarga el binario de un media vía getFile sin exponer el token', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/a.jpg' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from('img-bytes'), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        })
      );

    const media = await telegramChannelSender.downloadMedia({ kind: 'image', fileId: 'f1' });

    expect(media.mimeType).toBe('image/jpeg');
    expect(media.buffer.toString()).toBe('img-bytes');
    expect(media.fileName).toBe('a.jpg');
  });
  it('no filtra el token si falla la descarga de media', async () => {
    const token = 'test_bot_token';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error(`fallo https://api.telegram.org/bot${token}/getFile`)
    );

    const error = await telegramChannelSender
      .downloadMedia({ kind: 'image', fileId: 'f1' })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Telegram media download failed');
    expect((error as Error).message).not.toContain(token);
  });
  it('envía una imagen por URL pública como sendPhoto', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await telegramChannelSender.sendMedia({
      accountId: 'bot',
      recipientId: '12345',
      mediaUrl: 'https://example.com/vehiculo.jpg',
      mediaType: 'image',
      caption: 'Toyota RAV4',
    });

    expect(result.externalMessageId).toBe('tg:out:12345:77');
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toContain('/sendPhoto');
    expect(String(init?.body)).toContain('https://example.com/vehiculo.jpg');
  });
});
