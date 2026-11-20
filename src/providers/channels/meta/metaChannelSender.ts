import crypto from 'node:crypto';
import {
  ChannelAdapter,
  ChannelSendError,
  ChannelSendRequest,
  ChannelSendResult,
  NormalizedInboundMessage,
  NormalizedStatusEvent,
  ParsedInbound,
} from '../channelTypes.js';
import { validateMetaSignature } from '../../../utils/crypto.js';
import { MetaStatus, MetaWebhookPayload } from '../../../types/meta.js';
import { getMetaConfig, MetaConfigError } from './metaConfig.js';
import { MetaGraphApiError, whatsappClient } from './whatsappClient.js';

function isoFromUnixSeconds(timestamp?: string, fallback: Date = new Date()): string {
  const seconds = timestamp ? Number(timestamp) : Number.NaN;
  const valid = Number.isFinite(seconds) && Math.abs(seconds) <= 8.64e12;
  return valid ? new Date(seconds * 1000).toISOString() : fallback.toISOString();
}

function normalizeStatus(status: MetaStatus): NormalizedStatusEvent {
  return {
    channel: 'whatsapp',
    externalMessageId: status.id,
    status: status.status,
    occurredAt: isoFromUnixSeconds(status.timestamp, new Date(0)),
    errors: status.errors,
  };
}

/**
 * Traduce los errores propietarios de Meta a la taxonomía común de canales.
 * El núcleo nunca ve `MetaGraphApiError`.
 */
function mapMetaError(error: unknown): ChannelSendError {
  if (error instanceof ChannelSendError) return error;

  // Credenciales incompletas = fallo de configuración, no de red.
  if (error instanceof MetaConfigError) {
    return new ChannelSendError('SYSTEMIC_AUTH', error.message, { cause: error });
  }

  if (error instanceof MetaGraphApiError) {
    const status = error.status;
    if (error.isSystemicAuth) {
      return new ChannelSendError('SYSTEMIC_AUTH', error.message, { cause: error, status });
    }
    if (!error.isTransient) {
      return new ChannelSendError('FATAL', error.message, { cause: error, status });
    }
    const kind = status === 0 ? 'NETWORK' : status === 429 ? 'RATE_LIMIT' : 'TRANSIENT';
    return new ChannelSendError(kind, error.message, { cause: error, status });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ChannelSendError('TRANSIENT', message, { cause: error });
}

export class MetaChannelSender implements ChannelAdapter {
  public readonly channel = 'whatsapp';
  public readonly webhookPath = '/webhook';
  public readonly rawBody = true;

  public verifyWebhookChallenge(query: Record<string, unknown>): { ok: boolean; challenge?: string } {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (typeof token !== 'string') return { ok: false };

    const expected = getMetaConfig().verifyToken;
    const valid = crypto.timingSafeEqual(
      crypto.createHash('sha256').update(token).digest(),
      crypto.createHash('sha256').update(expected).digest()
    );

    if (mode === 'subscribe' && valid) {
      return { ok: true, challenge: typeof challenge === 'string' ? challenge : '' };
    }
    return { ok: false };
  }

  public verifyInbound(request: unknown): boolean {
    const { rawBody, signature } = (request ?? {}) as {
      rawBody?: string | Buffer;
      signature?: string;
    };
    return validateMetaSignature(rawBody, signature);
  }

  public parseInbound(payload: unknown): ParsedInbound {
    const meta = payload as MetaWebhookPayload;
    const messages: NormalizedInboundMessage[] = [];
    const statuses: NormalizedStatusEvent[] = [];

    if (!meta || meta.object !== 'whatsapp_business_account' || !Array.isArray(meta.entry)) {
      return { messages, statuses };
    }

    for (const entry of meta.entry) {
      if (!entry || !Array.isArray(entry.changes)) continue;

      for (const change of entry.changes) {
        const value = change?.value;
        // Solo el producto WhatsApp; un payload autenticado pero raro se ignora sin lanzar.
        if (!value || value.messaging_product !== 'whatsapp') continue;

        // No usar fallback de canal: un metadata inválido debe descartarse en el controller.
        const accountId =
          typeof value.metadata?.phone_number_id === 'string' ? value.metadata.phone_number_id : '';

        const statusList = Array.isArray(value.statuses) ? value.statuses : [];
        for (const status of statusList) {
          if (!status || typeof status.id !== 'string' || !status.status) continue;
          statuses.push(normalizeStatus(status));
        }

        const messageList = Array.isArray(value.messages) ? value.messages : [];
        for (const message of messageList) {
          if (!message || typeof message.id !== 'string' || typeof message.from !== 'string') continue;

          const text =
            message.text?.body ??
            message.interactive?.button_reply?.title ??
            message.interactive?.list_reply?.title ??
            '';
          const senderName = value.contacts?.[0]?.profile?.name?.trim() || 'Cliente';

          messages.push({
            channel: this.channel,
            externalMessageId: message.id,
            externalAccountId: accountId,
            senderId: message.from,
            recipientId: message.from,
            senderName,
            occurredAt: isoFromUnixSeconds(message.timestamp),
            type: message.type ?? 'text',
            text,
            // Solo el mensaje original: el sobre completo ya vive en inbound_events.
            raw: message,
          });
        }
      }
    }

    return { messages, statuses };
  }

  public async sendText(request: ChannelSendRequest): Promise<ChannelSendResult> {
    try {
      // Valida configuración antes de la llamada y permite clasificarla como SYSTEMIC_AUTH.
      getMetaConfig();
      const externalMessageId = await whatsappClient.sendTextMessage(
        request.accountId,
        request.recipientId,
        request.text
      );
      return { externalMessageId };
    } catch (error) {
      throw mapMetaError(error);
    }
  }

  public async sendTyping(accountId: string, recipientId: string): Promise<void> {
    await whatsappClient.sendTypingIndicator(accountId, recipientId);
  }
}

export const metaChannelSender = new MetaChannelSender();
