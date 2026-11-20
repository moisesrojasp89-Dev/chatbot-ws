import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { metaChannelSender } from '../src/providers/channels/meta/metaChannelSender.js';
import { telegramChannelSender } from '../src/providers/channels/telegram/telegramChannelSender.js';
import { env } from '../src/config/env.js';

const metaPayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'entry-1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '57300', phone_number_id: 'pn-1' },
            contacts: [{ profile: { name: 'Ana' }, wa_id: '573001112233' }],
            messages: [
              {
                from: '573001112233',
                id: 'wamid.in.1',
                timestamp: '1700000000',
                type: 'text',
                text: { body: 'Hola desde Meta' },
              },
            ],
            statuses: [
              {
                id: 'wamid.out.1',
                status: 'delivered',
                timestamp: '1700000001',
                recipient_id: '573001112233',
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('Conformidad de adaptadores inbound', () => {
  it('normaliza mensajes y estados de Meta al sobre comun', () => {
    const parsed = metaChannelSender.parseInbound(metaPayload);

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({
      channel: 'whatsapp',
      externalMessageId: 'wamid.in.1',
      externalAccountId: 'pn-1',
      senderId: '573001112233',
      recipientId: '573001112233',
      senderName: 'Ana',
      type: 'text',
      text: 'Hola desde Meta',
    });
    expect(parsed.statuses).toHaveLength(1);
    expect(parsed.statuses[0]).toMatchObject({
      channel: 'whatsapp',
      externalMessageId: 'wamid.out.1',
      status: 'delivered',
    });
  });

  it('verifica la firma HMAC de Meta y rechaza una firma invalida', () => {
    const rawBody = JSON.stringify(metaPayload);
    const signature = `sha256=${crypto
      .createHmac('sha256', env.META_APP_SECRET as string)
      .update(rawBody)
      .digest('hex')}`;

    expect(metaChannelSender.verifyInbound({ rawBody, signature })).toBe(true);
    expect(metaChannelSender.verifyInbound({ rawBody, signature: 'sha256=deadbeef' })).toBe(false);
  });

  it('normaliza un update de Telegram con identidad por update_id', () => {
    const parsed = telegramChannelSender.parseInbound({
      update_id: 77,
      message: {
        message_id: 5,
        date: 1700000000,
        text: 'Hola desde Telegram',
        chat: { id: 99 },
        from: { first_name: 'Ana', last_name: 'Perez' },
      },
    });

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({
      channel: 'telegram',
      externalMessageId: 'tg:in:77',
      externalAccountId: 'telegram',
      senderId: '99',
      recipientId: '99',
      senderName: 'Ana Perez',
      type: 'text',
      text: 'Hola desde Telegram',
    });
    expect(parsed.statuses).toEqual([]);
  });
  it('tolera un payload autenticado malformado sin lanzar', () => {
    const parsed = metaChannelSender.parseInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'bad',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 12345 },
                messages: 'no-es-array',
                statuses: null,
              },
            },
          ],
        },
      ],
    });

    expect(parsed.messages).toEqual([]);
    expect(parsed.statuses).toEqual([]);
  });
  it('normaliza los errores de un status fallido', () => {
    const parsed = metaChannelSender.parseInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry-status',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '57300', phone_number_id: 'pn-1' },
                statuses: [
                  {
                    id: 'wamid.out.failed',
                    status: 'failed',
                    timestamp: '1700000002',
                    recipient_id: '573001112233',
                    errors: [{ code: 131026, title: 'Undeliverable' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(parsed.statuses[0]).toMatchObject({
      externalMessageId: 'wamid.out.failed',
      status: 'failed',
      errors: [{ code: 131026, title: 'Undeliverable' }],
    });
  });
  it('separa remitente y destinatario en un grupo de Telegram', () => {
    const parsed = telegramChannelSender.parseInbound({
      update_id: 88,
      message: {
        message_id: 9,
        date: 1700000000,
        text: 'Hola grupo',
        chat: { id: -100123, type: 'group' },
        from: { id: 777, first_name: 'Ana' },
      },
    });

    expect(parsed.messages[0]).toMatchObject({
      channel: 'telegram',
      externalMessageId: 'tg:in:88',
      senderId: '777',
      recipientId: '-100123',
      senderName: 'Ana',
      text: 'Hola grupo',
    });
  });
  it('normaliza una foto de Telegram con caption como imagen', () => {
    const parsed = telegramChannelSender.parseInbound({
      update_id: 91,
      message: {
        message_id: 11,
        date: 1700000000,
        caption: 'Mira esta foto',
        chat: { id: 99, type: 'private' },
        from: { id: 99, first_name: 'Ana' },
        photo: [
          { file_id: 'small', width: 90, height: 90 },
          { file_id: 'large', width: 1280, height: 720 },
        ],
      },
    });

    expect(parsed.messages[0]).toMatchObject({
      type: 'image',
      text: 'Mira esta foto',
      media: { kind: 'image', fileId: 'large', width: 1280, height: 720 },
    });
  });

  it('normaliza un documento de Telegram sin caption', () => {
    const parsed = telegramChannelSender.parseInbound({
      update_id: 92,
      message: {
        date: 1700000000,
        chat: { id: 99 },
        from: { id: 99 },
        document: { file_id: 'doc-1', mime_type: 'application/pdf', file_name: 'factura.pdf' },
      },
    });

    expect(parsed.messages[0]).toMatchObject({
      type: 'document',
      text: '',
      media: { kind: 'document', fileId: 'doc-1', fileName: 'factura.pdf' },
    });
  });
  it('normaliza audio, sticker y animation', () => {
    const audio = telegramChannelSender.parseInbound({
      update_id: 93,
      message: {
        date: 1700000000,
        chat: { id: 99 },
        from: { id: 99 },
        audio: { file_id: 'audio-1', mime_type: 'audio/ogg' },
      },
    });
    expect(audio.messages[0]).toMatchObject({
      type: 'audio',
      media: { kind: 'audio', fileId: 'audio-1', mimeType: 'audio/ogg' },
    });

    const sticker = telegramChannelSender.parseInbound({
      update_id: 94,
      message: { date: 1700000000, chat: { id: 99 }, from: { id: 99 }, sticker: { file_id: 'sticker-1' } },
    });
    expect(sticker.messages[0]).toMatchObject({ type: 'sticker', media: { fileId: 'sticker-1' } });

    const animation = telegramChannelSender.parseInbound({
      update_id: 95,
      message: {
        date: 1700000000,
        chat: { id: 99 },
        from: { id: 99 },
        animation: { file_id: 'anim-1', mime_type: 'video/mp4' },
        document: { file_id: 'anim-doc', mime_type: 'video/mp4' },
      },
    });
    expect(animation.messages[0]).toMatchObject({
      type: 'animation',
      media: { kind: 'animation', fileId: 'anim-1' },
    });
  });
});
