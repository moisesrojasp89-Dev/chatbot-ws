import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/providers/database/dbClient.js';
import { inboundRepository } from '../src/repositories/inboundRepository.js';

function payload(text: string) {
  return { type: 'text', text, senderName: 'Test' };
}

beforeEach(async () => {
  await db.query('DELETE FROM public.inbound_events;');
});

afterEach(async () => {
  await db.query('DELETE FROM public.inbound_events;');
});

describe('Identidad inbound multicanal', () => {
  it('permite el mismo identificador externo en canales distintos y deduplica dentro del canal', async () => {
    const whatsapp = await inboundRepository.persistInboundEvent({
      wamid: 'shared-id-1',
      phoneNumberId: 'meta-phone',
      senderPhone: '57300',
      channel: 'whatsapp',
      payload: payload('hola whatsapp'),
    });
    const telegram = await inboundRepository.persistInboundEvent({
      wamid: 'shared-id-1',
      phoneNumberId: 'telegram',
      senderPhone: '99',
      channel: 'telegram',
      payload: payload('hola telegram'),
    });
    const duplicate = await inboundRepository.persistInboundEvent({
      wamid: 'shared-id-1',
      phoneNumberId: 'meta-phone',
      senderPhone: '57300',
      channel: 'whatsapp',
      payload: payload('duplicado'),
    });

    expect(whatsapp).not.toBeNull();
    expect(telegram).not.toBeNull();
    expect(duplicate).toBeNull();
  });

  it('no coalesce mensajes del mismo remitente entre canales distintos', async () => {
    await inboundRepository.persistInboundEvent({
      wamid: 'wa-coalesce-1',
      phoneNumberId: 'meta-phone',
      senderPhone: 'same-sender',
      channel: 'whatsapp',
      payload: payload('mensaje whatsapp'),
    });
    await inboundRepository.persistInboundEvent({
      wamid: 'tg-coalesce-1',
      phoneNumberId: 'telegram',
      senderPhone: 'same-sender',
      channel: 'telegram',
      payload: payload('mensaje telegram'),
    });

    const batches = await inboundRepository.claimNextBatchWithCoalescing(10);
    const whatsappBatch = batches.find((batch) => batch.primaryEvent.wamid === 'wa-coalesce-1');
    const telegramBatch = batches.find((batch) => batch.primaryEvent.wamid === 'tg-coalesce-1');

    expect(whatsappBatch).toBeDefined();
    expect(telegramBatch).toBeDefined();
    expect(whatsappBatch?.secondaryEvents.map((event) => event.wamid)).not.toContain('tg-coalesce-1');
    expect(telegramBatch?.secondaryEvents.map((event) => event.wamid)).not.toContain('wa-coalesce-1');
  });
  it('persiste el destinatario del grupo separado del remitente', async () => {
    const event = await inboundRepository.persistInboundEvent({
      wamid: 'tg:in:group-1',
      phoneNumberId: 'telegram',
      senderPhone: '777',
      recipientId: '-100123',
      channel: 'telegram',
      payload: { type: 'text', text: 'hola grupo', senderName: 'Ana' },
    });

    expect(event?.recipient_id).toBe('-100123');
    expect(event?.sender_phone).toBe('777');

    const claimed = await inboundRepository.claimPendingBatch(10);
    expect(claimed.find((row) => row.wamid === 'tg:in:group-1')?.recipient_id).toBe('-100123');
  });
  it('no coalesce el mismo remitente en dos grupos distintos', async () => {
    await inboundRepository.persistInboundEvent({
      wamid: 'tg:in:group-a',
      phoneNumberId: 'telegram',
      senderPhone: '777',
      recipientId: '-100A',
      channel: 'telegram',
      payload: { type: 'text', text: 'grupo A', senderName: 'Ana' },
    });
    await inboundRepository.persistInboundEvent({
      wamid: 'tg:in:group-b',
      phoneNumberId: 'telegram',
      senderPhone: '777',
      recipientId: '-100B',
      channel: 'telegram',
      payload: { type: 'text', text: 'grupo B', senderName: 'Ana' },
    });

    const batches = await inboundRepository.claimNextBatchWithCoalescing(10);
    const groupA = batches.find((batch) => batch.primaryEvent.wamid === 'tg:in:group-a');
    const groupB = batches.find((batch) => batch.primaryEvent.wamid === 'tg:in:group-b');

    expect(groupA?.primaryEvent.recipient_id).toBe('-100A');
    expect(groupB?.primaryEvent.recipient_id).toBe('-100B');
    expect(groupA?.secondaryEvents).toHaveLength(0);
    expect(groupB?.secondaryEvents).toHaveLength(0);
  });
});
