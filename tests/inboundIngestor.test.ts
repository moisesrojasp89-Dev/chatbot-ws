import { afterEach, describe, expect, it, vi } from 'vitest';
import { ingestParsedInbound } from '../src/services/inboundIngestor.js';
import { inboundRepository } from '../src/repositories/inboundRepository.js';
import { auditRepository } from '../src/repositories/auditRepository.js';
import { phoneRateLimiter } from '../src/middleware/rateLimiter.js';
import { ChannelAdapter, ParsedInbound } from '../src/providers/channels/channelTypes.js';

const adapter: ChannelAdapter = {
  channel: 'telegram',
  verifyInbound: () => true,
  parseInbound: () => ({ messages: [], statuses: [] }),
  rateLimitKey: (senderId) => `telegram:${senderId}`,
  sendText: async () => ({ externalMessageId: 'x' }),
  sendTyping: async () => undefined,
};

function parsedWith(overrides: Partial<ParsedInbound['messages'][number]> = {}): ParsedInbound {
  return {
    messages: [
      {
        channel: 'telegram',
        externalMessageId: 'tg:in:1',
        externalAccountId: 'telegram',
        senderId: '99',
        recipientId: '99',
        senderName: 'Test',
        occurredAt: new Date().toISOString(),
        type: 'text',
        text: 'hola',
        ...overrides,
      },
    ],
    statuses: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Ingestor genérico de inbound', () => {
  it('usa la clave de rate limit del adaptador y no persiste si está limitado', async () => {
    vi.spyOn(phoneRateLimiter, 'isRateLimited').mockReturnValue(true);
    vi.spyOn(auditRepository, 'logEvent').mockResolvedValue(undefined as never);
    const persist = vi.spyOn(inboundRepository, 'persistInboundEvent');

    const result = await ingestParsedInbound(adapter, parsedWith());

    expect(phoneRateLimiter.isRateLimited).toHaveBeenCalledWith('telegram:99');
    expect(persist).not.toHaveBeenCalled();
    expect(result.rateLimited).toBe(1);
  });

  it('audita y descarta C5 si falta el account id', async () => {
    vi.spyOn(phoneRateLimiter, 'isRateLimited').mockReturnValue(false);
    const audit = vi.spyOn(auditRepository, 'logEvent').mockResolvedValue(undefined as never);
    const persist = vi.spyOn(inboundRepository, 'persistInboundEvent');

    const result = await ingestParsedInbound(adapter, parsedWith({ externalAccountId: '' }));

    expect(persist).not.toHaveBeenCalled();
    expect(result.ignored).toBe(1);
    expect(audit).toHaveBeenCalledWith(null, 'MALFORMED_WEBHOOK_PAYLOAD', 'SYSTEM', expect.any(Object));
  });
  it('persiste el recipientId del sobre normalizado', async () => {
    vi.spyOn(phoneRateLimiter, 'isRateLimited').mockReturnValue(false);
    const persist = vi
      .spyOn(inboundRepository, 'persistInboundEvent')
      .mockResolvedValue({ id: 'ev-1' } as never);

    await ingestParsedInbound(adapter, parsedWith({ recipientId: '-100999' }));

    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ recipientId: '-100999' }));
  });
});
