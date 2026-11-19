import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { channelRegistry } from '../src/providers/channels/channelRegistry.js';
import { telegramChannelSender } from '../src/providers/channels/telegram/telegramChannelSender.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Contrato de canales en buildApp', () => {
  it('levanta solo-Telegram sin registrar las rutas de Meta', async () => {
    const previousChannels = env.CHANNELS_ENABLED;
    const previousToken = env.TELEGRAM_BOT_TOKEN;
    const previousSecret = env.TELEGRAM_WEBHOOK_SECRET;

    env.CHANNELS_ENABLED = 'telegram';
    env.TELEGRAM_BOT_TOKEN = 'test_bot_token';
    env.TELEGRAM_WEBHOOK_SECRET = 'test_webhook_secret';

    const app = await buildApp();
    try {
      const metaGet = await app.inject({ method: 'GET', url: '/webhook' });
      expect(metaGet.statusCode).toBe(404);
      const metaPost = await app.inject({ method: 'POST', url: '/webhook', payload: {} });
      expect(metaPost.statusCode).toBe(404);

      const telegram = await app.inject({
        method: 'POST',
        url: '/webhook/telegram',
        headers: { 'x-telegram-bot-api-secret-token': 'incorrecto' },
        payload: { update_id: 1 },
      });
      expect(telegram.statusCode).toBe(401);
    } finally {
      await app.close();
      env.CHANNELS_ENABLED = previousChannels;
      env.TELEGRAM_BOT_TOKEN = previousToken;
      env.TELEGRAM_WEBHOOK_SECRET = previousSecret;
    }
  });

  it('el registry expone el adaptador completo (verify/parse), no solo el sender', () => {
    const adapter = channelRegistry.getAdapter('telegram');
    expect(typeof adapter.verifyInbound).toBe('function');
    expect(typeof adapter.parseInbound).toBe('function');
    expect(typeof adapter.sendText).toBe('function');
  });

  it('no filtra el bot token si falla la red de Telegram', async () => {
    const previousToken = env.TELEGRAM_BOT_TOKEN;
    const previousSecret = env.TELEGRAM_WEBHOOK_SECRET;
    const token = 'super-secret-token-123';

    env.TELEGRAM_BOT_TOKEN = token;
    env.TELEGRAM_WEBHOOK_SECRET = 'test_webhook_secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error(`request failed https://api.telegram.org/bot${token}/sendMessage`))
    );

    try {
      const error = await telegramChannelSender
        .sendText({ accountId: 'telegram', recipientId: '99', text: 'hola' })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(token);
      expect((error as Error).message).toContain('Telegram network error');
    } finally {
      env.TELEGRAM_BOT_TOKEN = previousToken;
      env.TELEGRAM_WEBHOOK_SECRET = previousSecret;
    }
  });
  it('registra Meta y Telegram cuando ambos estan habilitados', async () => {
    const previousChannels = env.CHANNELS_ENABLED;
    const previousToken = env.TELEGRAM_BOT_TOKEN;
    const previousSecret = env.TELEGRAM_WEBHOOK_SECRET;

    env.CHANNELS_ENABLED = 'whatsapp,telegram';
    env.TELEGRAM_BOT_TOKEN = 'test_bot_token';
    env.TELEGRAM_WEBHOOK_SECRET = 'test_webhook_secret';

    const app = await buildApp();
    try {
      const challenge = await app.inject({
        method: 'GET',
        url: `/webhook?hub.mode=subscribe&hub.verify_token=${env.WEBHOOK_VERIFY_TOKEN}&hub.challenge=abc123`,
      });
      expect(challenge.statusCode).toBe(200);
      expect(challenge.body).toBe('abc123');

      const meta = await app.inject({
        method: 'POST',
        url: '/webhook',
        payload: { object: 'whatsapp_business_account', entry: [] },
      });
      expect(meta.statusCode).toBe(401);

      const telegram = await app.inject({
        method: 'POST',
        url: '/webhook/telegram',
        headers: { 'x-telegram-bot-api-secret-token': 'incorrecto' },
        payload: { update_id: 2 },
      });
      expect(telegram.statusCode).toBe(401);
    } finally {
      await app.close();
      env.CHANNELS_ENABLED = previousChannels;
      env.TELEGRAM_BOT_TOKEN = previousToken;
      env.TELEGRAM_WEBHOOK_SECRET = previousSecret;
    }
  });

  it('tolera canales duplicados en CHANNELS_ENABLED sin colisionar rutas', async () => {
    const previousChannels = env.CHANNELS_ENABLED;
    const previousToken = env.TELEGRAM_BOT_TOKEN;
    const previousSecret = env.TELEGRAM_WEBHOOK_SECRET;

    env.CHANNELS_ENABLED = 'telegram,telegram';
    env.TELEGRAM_BOT_TOKEN = 'test_bot_token';
    env.TELEGRAM_WEBHOOK_SECRET = 'test_webhook_secret';

    const app = await buildApp();
    try {
      expect(app.hasRoute({ method: 'POST', url: '/webhook/telegram' })).toBe(true);
    } finally {
      await app.close();
      env.CHANNELS_ENABLED = previousChannels;
      env.TELEGRAM_BOT_TOKEN = previousToken;
      env.TELEGRAM_WEBHOOK_SECRET = previousSecret;
    }
  });
});
