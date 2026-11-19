import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelRegistry } from '../src/providers/channels/channelRegistry.js';
import { ChannelSendError, normalizeChannelName } from '../src/providers/channels/channelTypes.js';
import { metaChannelSender } from '../src/providers/channels/meta/metaChannelSender.js';
import { MetaGraphApiError, whatsappClient } from '../src/providers/channels/meta/whatsappClient.js';
import { outboxDispatcher } from '../src/services/outboxDispatcher.js';
import { outboxRepository } from '../src/repositories/outboxRepository.js';
import { OutboxRecord } from '../src/types/states.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Capa de canales: registro y traducción de errores', () => {
  it('resuelve el adaptador whatsapp y rechaza canales no registrados', () => {
    expect(channelRegistry.has('whatsapp')).toBe(true);
    expect(channelRegistry.get('whatsapp').channel).toBe('whatsapp');

    try {
      channelRegistry.get('telegram');
      throw new Error('Se esperaba ChannelSendError para un canal no registrado');
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelSendError);
      expect((error as ChannelSendError).kind).toBe('FATAL');
    }
  });

  it('devuelve el externalMessageId del proveedor', async () => {
    vi.spyOn(whatsappClient, 'sendTextMessage').mockResolvedValueOnce('wamid.EXTERNAL_OK_1');

    await expect(
      metaChannelSender.sendText({ accountId: '123', recipientId: '57300', text: 'hola' })
    ).resolves.toEqual({ externalMessageId: 'wamid.EXTERNAL_OK_1' });
  });

  it('traduce un 503 de Meta a TRANSIENT (reintentable)', async () => {
    vi.spyOn(whatsappClient, 'sendTextMessage').mockRejectedValueOnce(
      new MetaGraphApiError(503, '{"error":{"message":"service unavailable"}}')
    );

    await expect(
      metaChannelSender.sendText({ accountId: '123', recipientId: '57300', text: 'hola' })
    ).rejects.toMatchObject({ kind: 'TRANSIENT' });
  });

  it('traduce un 429 de Meta a RATE_LIMIT', async () => {
    vi.spyOn(whatsappClient, 'sendTextMessage').mockRejectedValueOnce(
      new MetaGraphApiError(429, '{"error":{"message":"rate limit"}}')
    );

    await expect(
      metaChannelSender.sendText({ accountId: '123', recipientId: '57300', text: 'hola' })
    ).rejects.toMatchObject({ kind: 'RATE_LIMIT' });
  });

  it('traduce un 401 de Meta a SYSTEMIC_AUTH', async () => {
    vi.spyOn(whatsappClient, 'sendTextMessage').mockRejectedValueOnce(
      new MetaGraphApiError(401, '{"error":{"code":190,"message":"token expired"}}')
    );

    await expect(
      metaChannelSender.sendText({ accountId: '123', recipientId: '57300', text: 'hola' })
    ).rejects.toMatchObject({ kind: 'SYSTEMIC_AUTH' });
  });

  it('traduce un 4xx de cliente (ventana 24h) a FATAL', async () => {
    vi.spyOn(whatsappClient, 'sendTextMessage').mockRejectedValueOnce(
      new MetaGraphApiError(400, '{"error":{"code":131047,"message":"re-engagement required"}}')
    );

    await expect(
      metaChannelSender.sendText({ accountId: '123', recipientId: '57300', text: 'hola' })
    ).rejects.toMatchObject({ kind: 'FATAL' });
  });
  it('normaliza variantes de nombre de canal', () => {
    expect(normalizeChannelName(' WhatsApp ')).toBe('whatsapp');
    expect(normalizeChannelName(undefined)).toBe('whatsapp');
    expect(normalizeChannelName('TELEGRAM')).toBe('telegram');
  });

  it('libera (no falla) un mensaje de canal deshabilitado sin llamar al proveedor', async () => {
    const release = vi.spyOn(outboxRepository, 'release').mockResolvedValue(undefined as never);
    const send = vi.spyOn(whatsappClient, 'sendTextMessage');
    const record = {
      id: 'outbox-disabled-channel',
      channel: 'telegram',
      phone_number_id: '123',
      recipient_phone: '57300',
      content: 'hola',
      lock_token: 'lock-token',
      retry_count: 0,
      max_retries: 3,
    } as OutboxRecord;

    const result = await (
      outboxDispatcher as unknown as { dispatchSingleMessage(r: OutboxRecord): Promise<string> }
    ).dispatchSingleMessage(record);

    expect(result).toBe('DEFERRED');
    expect(release).toHaveBeenCalledWith(record.id, 'lock-token', 300);
    expect(send).not.toHaveBeenCalled();
  });

  it('marca FAILED un canal no registrado (error de código/datos)', async () => {
    vi.spyOn(channelRegistry, 'isEnabled').mockReturnValue(true);
    vi.spyOn(channelRegistry, 'has').mockReturnValue(false);
    const terminal = vi.spyOn(outboxRepository, 'terminalFailed').mockResolvedValue(undefined as never);
    const send = vi.spyOn(whatsappClient, 'sendTextMessage');
    const record = {
      id: 'outbox-unknown-channel',
      channel: 'unknown-channel',
      phone_number_id: '123',
      recipient_phone: '57300',
      content: 'hola',
      lock_token: 'lock-token',
      retry_count: 0,
      max_retries: 3,
    } as OutboxRecord;

    const result = await (
      outboxDispatcher as unknown as { dispatchSingleMessage(r: OutboxRecord): Promise<string> }
    ).dispatchSingleMessage(record);

    expect(result).toBe('FAILED');
    expect(terminal).toHaveBeenCalledWith(
      record.id,
      'lock-token',
      expect.stringContaining('Canal no registrado')
    );
    expect(send).not.toHaveBeenCalled();
  });
});
