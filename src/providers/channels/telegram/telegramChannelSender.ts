import crypto from 'node:crypto';
import { z } from 'zod';
import {
  ChannelAdapter,
  ChannelSendError,
  ChannelSendRequest,
  ChannelSendResult,
  ParsedInbound,
} from '../channelTypes.js';
import { getTelegramConfig, TelegramConfigError } from './telegramConfig.js';

interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id?: number };
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
        chat: z.object({ id: z.union([z.number(), z.string()]) }).optional(),
        from: z
          .object({
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
    const text = message?.text;

    if (chatId === undefined || typeof text !== 'string') {
      return { messages: [], statuses: [] };
    }

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
          senderId: String(chatId),
          senderName,
          occurredAt: dateValid
            ? new Date(dateSeconds * 1000).toISOString()
            : new Date().toISOString(),
          type: 'text',
          text,
          // Solo el mensaje original: el update completo ya no se duplica en messages.raw_payload.
          raw: message,
        },
      ],
      statuses: [],
    };
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
