import crypto from 'node:crypto';
import { z } from 'zod';
import {
  ChannelAdapter,
  ChannelSendError,
  ChannelSendRequest,
  ChannelSendResult,
  NormalizedMedia,
  ParsedInbound,
} from '../channelTypes.js';
import { getTelegramConfig, TelegramConfigError } from './telegramConfig.js';
import { env } from '../../../config/env.js';

interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id?: number; file_path?: string };
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

const telegramUpdateSchema = z
  .object({
    update_id: z.number().int(),
    message: z
      .object({
        message_id: z.number().optional(),
        date: z.number().optional(),
        text: z.string().optional(),
        caption: z.string().optional(),
        photo: z
          .array(
            z.object({
              file_id: z.string(),
              width: z.number(),
              height: z.number(),
              file_size: z.number().optional(),
            })
          )
          .optional(),
        document: z
          .object({
            file_id: z.string(),
            mime_type: z.string().optional(),
            file_name: z.string().optional(),
          })
          .optional(),
        audio: z
          .object({
            file_id: z.string(),
            mime_type: z.string().optional(),
            file_name: z.string().optional(),
          })
          .optional(),
        voice: z
          .object({
            file_id: z.string(),
            mime_type: z.string().optional(),
          })
          .optional(),
        video: z
          .object({
            file_id: z.string(),
            mime_type: z.string().optional(),
            file_name: z.string().optional(),
          })
          .optional(),
        video_note: z.object({ file_id: z.string() }).optional(),
        sticker: z.object({ file_id: z.string(), emoji: z.string().optional() }).optional(),
        animation: z
          .object({
            file_id: z.string(),
            mime_type: z.string().optional(),
          })
          .optional(),

        chat: z
          .object({
            id: z.union([z.number(), z.string()]),
            type: z.enum(['private', 'group', 'supergroup', 'channel']).optional(),
          })
          .optional(),
        from: z
          .object({
            id: z.union([z.number(), z.string()]).optional(),
            first_name: z.string().optional(),
            last_name: z.string().optional(),
            username: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftHash = crypto.createHash('sha256').update(left).digest();
  const rightHash = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function mapTelegramError(
  status: number,
  body: TelegramApiResponse | null,
  fallbackMessage: string
): ChannelSendError {
  const description = body?.description || fallbackMessage;
  const retryAfter = body?.parameters?.retry_after;
  const message = `Telegram API ${status}: ${description}`;

  if (status === 401 || status === 403) {
    return new ChannelSendError('SYSTEMIC_AUTH', message, { status, retryAfterSeconds: retryAfter });
  }
  if (status === 429) {
    return new ChannelSendError('RATE_LIMIT', message, { status, retryAfterSeconds: retryAfter });
  }
  if (status >= 500) {
    return new ChannelSendError('TRANSIENT', message, { status, retryAfterSeconds: retryAfter });
  }
  return new ChannelSendError('FATAL', message, { status, retryAfterSeconds: retryAfter });
}

export class TelegramChannelSender implements ChannelAdapter {
  public readonly channel = 'telegram';
  public readonly webhookPath = '/webhook/telegram';
  public readonly rawBody = false;

  public rateLimitKey(senderId: string): string {
    return `telegram:${senderId}`;
  }

  public verifyInbound(request: unknown): boolean {
    const { webhookSecret } = getTelegramConfig();
    const headers = (request as { headers?: Record<string, string | string[] | undefined> })?.headers;
    const header = headers?.['x-telegram-bot-api-secret-token'];
    const provided = Array.isArray(header) ? header[0] : header;

    return typeof provided === 'string' && timingSafeStringEqual(provided, webhookSecret);
  }

  public parseInbound(payload: unknown): ParsedInbound {
    const parsed = telegramUpdateSchema.safeParse(payload);
    if (!parsed.success) {
      return { messages: [], statuses: [] };
    }

    const update = parsed.data;
    const message = update.message;
    const chatId = message?.chat?.id;

    let media: NormalizedMedia | undefined;
    const photo = message?.photo;
    if (photo && photo.length > 0) {
      const largest = photo.reduce((best, candidate) =>
        candidate.width * candidate.height > best.width * best.height ? candidate : best
      );
      media = {
        kind: 'image',
        fileId: largest.file_id,
        width: largest.width,
        height: largest.height,
      };
    } else if (message?.document && !message?.animation) {
      media = {
        kind: 'document',
        fileId: message.document.file_id,
        mimeType: message.document.mime_type,
        fileName: message.document.file_name,
      };
    } else if (message?.audio) {
      media = {
        kind: 'audio',
        fileId: message.audio.file_id,
        mimeType: message.audio.mime_type,
        fileName: message.audio.file_name,
      };
    } else if (message?.voice) {
      media = {
        kind: 'voice',
        fileId: message.voice.file_id,
        mimeType: message.voice.mime_type,
      };
    } else if (message?.video) {
      media = {
        kind: 'video',
        fileId: message.video.file_id,
        mimeType: message.video.mime_type,
        fileName: message.video.file_name,
      };
    } else if (message?.video_note) {
      media = { kind: 'video_note', fileId: message.video_note.file_id };
    } else if (message?.sticker) {
      media = { kind: 'sticker', fileId: message.sticker.file_id };
    } else if (message?.animation) {
      media = {
        kind: 'animation',
        fileId: message.animation.file_id,
        mimeType: message.animation.mime_type,
      };
    }

    const text = message?.text ?? message?.caption ?? '';
    const hasContent =
      typeof message?.text === 'string' || typeof message?.caption === 'string' || media !== undefined;

    if (chatId === undefined || !hasContent) {
      return { messages: [], statuses: [] };
    }

    const fromId = message?.from?.id;
    const senderId = fromId !== undefined ? String(fromId) : String(chatId);

    const senderName =
      [message?.from?.first_name, message?.from?.last_name].filter(Boolean).join(' ').trim() ||
      message?.from?.username ||
      'desconocido';

    const dateSeconds = message?.date;
    const dateValid =
      typeof dateSeconds === 'number' &&
      Number.isFinite(dateSeconds) &&
      Math.abs(dateSeconds) <= 8.64e12;

    return {
      messages: [
        {
          channel: this.channel,
          externalMessageId: `tg:in:${update.update_id}`,
          externalAccountId: 'telegram',
          senderId,
          recipientId: String(chatId),
          senderName,
          occurredAt: dateValid
            ? new Date(dateSeconds * 1000).toISOString()
            : new Date().toISOString(),
          type: media?.kind ?? 'text',
          text,
          media,
          // Solo el mensaje original: el update completo ya no se duplica en messages.raw_payload.
          raw: message,
        },
      ],
      statuses: [],
    };
  }

  public async downloadMedia(media: NormalizedMedia): Promise<{
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
  }> {
    try {
      const { botToken } = getTelegramConfig();
      const metaResponse = await fetch(
        `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(media.fileId)}`,
        { signal: AbortSignal.timeout(10000) }
      );
      const meta = (await metaResponse.json().catch(() => null)) as TelegramApiResponse | null;
      const filePath = meta?.result && 'file_path' in meta.result ? meta.result.file_path : undefined;

      if (!metaResponse.ok || !meta?.ok || typeof filePath !== 'string' || filePath.length === 0) {
        throw new ChannelSendError('TRANSIENT', 'Telegram getFile no devolvió un file_path utilizable');
      }
      if (filePath.includes('..')) {
        throw new ChannelSendError('FATAL', 'Telegram devolvió un file_path inválido');
      }

      const fileResponse = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`, {
        signal: AbortSignal.timeout(20000),
      });
      if (!fileResponse.ok) {
        throw new ChannelSendError('TRANSIENT', `Telegram file download HTTP ${fileResponse.status}`);
      }

      const contentLength = Number(fileResponse.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > env.MEDIA_MAX_BYTES) {
        throw new ChannelSendError('FATAL', 'Telegram media excede MEDIA_MAX_BYTES');
      }

      const buffer = Buffer.from(await fileResponse.arrayBuffer());
      const mimeType =
        media.mimeType || fileResponse.headers.get('content-type') || 'application/octet-stream';
      const fileName = media.fileName || filePath.split('/').pop();

      return { buffer, mimeType, fileName };
    } catch (error) {
      if (error instanceof ChannelSendError) throw error;
      // No propagar URLs que contienen el bot token.
      throw new ChannelSendError('NETWORK', 'Telegram media download failed');
    }
  }
  public async sendText(request: ChannelSendRequest): Promise<ChannelSendResult> {
    try {
      const { botToken } = getTelegramConfig();
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: request.recipientId,
          text: request.text,
        }),
        signal: AbortSignal.timeout(15000),
      });

      const body = (await response.json().catch(() => null)) as TelegramApiResponse | null;
      if (!response.ok) {
        throw mapTelegramError(response.status, body, 'Respuesta inválida de Telegram');
      }
      if (!body?.ok || typeof body.result?.message_id !== 'number') {
        // 200 malformado / ok sin message_id: no es un fallo permanente del mensaje.
        throw new ChannelSendError('TRANSIENT', 'Telegram devolvió 200 sin message_id utilizable', {
          status: response.status,
        });
      }

      return { externalMessageId: `tg:out:${request.recipientId}:${body.result.message_id}` };
    } catch (error) {
      if (error instanceof ChannelSendError) throw error;
      if (error instanceof TelegramConfigError) {
        throw new ChannelSendError('SYSTEMIC_AUTH', error.message, { cause: error });
      }
      // No propagar la URL de la API (contiene el bot token) en mensajes de error.
      throw new ChannelSendError('NETWORK', 'Telegram network error (request failed)');
    }
  }

  public async sendTyping(accountId: string, recipientId: string): Promise<void> {
    try {
      const { botToken } = getTelegramConfig();
      await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: recipientId, action: 'typing' }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Best-effort: el error puede contener la URL con token; no se propaga.
      throw new ChannelSendError('NETWORK', 'Telegram typing request failed');
    }
  }
}

export const telegramChannelSender = new TelegramChannelSender();
