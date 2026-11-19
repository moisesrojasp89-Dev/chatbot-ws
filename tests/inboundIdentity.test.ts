import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/providers/database/dbClient.js';
import { inboundRepository } from '../src/repositories/inboundRepository.js';

function payload(text: string) {
  return {
    message: { type: 'text', text: { body: text }, id: 'x', from: 'same' },
    metadata: { phone_number_id: 'p' },
  };
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
});
