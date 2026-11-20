import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { sendOnCallAlert } from '../src/services/alertNotifier.js';

const baseAlert = {
  alert: 'CHANNEL_BACKLOG' as const,
  channel: 'telegram',
  pending: 7,
  threshold: 100,
  enabled: false,
  paused: true,
  breakerState: 'CLOSED',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Notificador de on-call', () => {
  it('es no-op si no hay ALERT_WEBHOOK_URL', async () => {
    const previous = env.ALERT_WEBHOOK_URL;
    env.ALERT_WEBHOOK_URL = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(sendOnCallAlert(baseAlert)).resolves.toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      env.ALERT_WEBHOOK_URL = previous;
    }
  });

  it('entrega la transición con texto y payload estructurado', async () => {
    const previous = env.ALERT_WEBHOOK_URL;
    env.ALERT_WEBHOOK_URL = 'https://hooks.example.test/alert';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(sendOnCallAlert(baseAlert)).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://hooks.example.test/alert');
      expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
      const body = JSON.parse(options.body as string);
      expect(body).toMatchObject(baseAlert);
      expect(body.text).toContain('telegram');
      expect(body.text).toContain('7 PENDING');
    } finally {
      env.ALERT_WEBHOOK_URL = previous;
    }
  });

  it('no lanza si el webhook falla', async () => {
    const previous = env.ALERT_WEBHOOK_URL;
    env.ALERT_WEBHOOK_URL = 'https://hooks.example.test/alert';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    try {
      await expect(sendOnCallAlert(baseAlert)).resolves.toBe(false);
    } finally {
      env.ALERT_WEBHOOK_URL = previous;
    }
  });
  it('devuelve false si el webhook responde no-2xx', async () => {
    const previous = env.ALERT_WEBHOOK_URL;
    env.ALERT_WEBHOOK_URL = 'https://hooks.example.test/alert';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    try {
      await expect(sendOnCallAlert(baseAlert)).resolves.toBe(false);
    } finally {
      env.ALERT_WEBHOOK_URL = previous;
    }
  });
});
