/**
 * Contrato neutro de canales de mensajería.
 *
 * El núcleo (harness, servicios, repositorios) solo depende de estos tipos y de
 * ChannelRegistry. Ningún SDK/cliente de un proveedor debe importarse desde aquí.
 */

export const DEFAULT_CHANNEL = 'whatsapp';

/** Normaliza el nombre de canal para evitar variantes ('WhatsApp ', 'TELEGRAM'). */
export function normalizeChannelName(value?: string | null): string {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized.length > 0 ? normalized : DEFAULT_CHANNEL;
}

export interface ChannelSendRequest {
  /** Identificador de la cuenta del negocio en el canal (phone_number_id en WhatsApp). */
  accountId: string;
  /** Identificador del destinatario en el canal (teléfono E.164, chat_id, etc.). */
  recipientId: string;
  text: string;
  /** Id del registro en outbox, útil para idempotencia del proveedor. */
  outboxId?: string;
}

export type OutboundMediaType = 'image' | 'document' | 'video' | 'audio';

export interface ChannelMediaRequest {
  accountId: string;
  recipientId: string;
  mediaUrl: string;
  mediaType: OutboundMediaType;
  caption?: string;
  outboxId?: string;
}

export interface ChannelSendResult {
  /** Id externo del mensaje aceptado por el proveedor (wamid en WhatsApp). */
  externalMessageId: string;
}

export type ChannelErrorKind =
  | 'SYSTEMIC_AUTH'
  | 'FATAL'
  | 'RATE_LIMIT'
  | 'TRANSIENT'
  | 'NETWORK';

export class ChannelSendError extends Error {
  public readonly kind: ChannelErrorKind;
  public readonly status?: number;
  public readonly retryAfterSeconds?: number;

  constructor(
    kind: ChannelErrorKind,
    message: string,
    options?: { cause?: unknown; status?: number; retryAfterSeconds?: number }
  ) {
    super(message);
    this.name = 'ChannelSendError';
    this.kind = kind;
    this.status = options?.status;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isTransientChannelError(error: unknown): boolean {
  return (
    error instanceof ChannelSendError &&
    (error.kind === 'RATE_LIMIT' || error.kind === 'TRANSIENT' || error.kind === 'NETWORK')
  );
}

export interface ChannelSender {
  readonly channel: string;
  sendText(request: ChannelSendRequest): Promise<ChannelSendResult>;
  /** Opcional: canales con soporte de media saliente por URL pública. */
  sendMedia?(request: ChannelMediaRequest): Promise<ChannelSendResult>;
  /** Opcional: solo canales que soportan indicador de escritura/presencia. */
  sendTyping?(accountId: string, recipientId: string): Promise<void>;
}

export interface NormalizedMedia {
  kind: string;
  fileId: string;
  mimeType?: string;
  fileName?: string;
  width?: number;
  height?: number;
}

export interface NormalizedInboundMessage {
  channel: string;
  externalMessageId: string;
  externalAccountId: string;
  senderId: string;
  /** Destinatario de la respuesta (chat/grupo); por defecto senderId. */
  recipientId: string;
  senderName: string;
  occurredAt: string;
  type: string;
  text?: string;
  media?: NormalizedMedia;
  raw?: unknown;
}

export interface NormalizedStatusEvent {
  channel: string;
  externalMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  occurredAt: string;
  errors?: unknown;
}

export interface ParsedInbound {
  messages: NormalizedInboundMessage[];
  statuses: NormalizedStatusEvent[];
}

/**
 * Contrato para canales entrantes (webhooks). El núcleo solo consume el sobre
 * normalizado; cada adaptador verifica y traduce su payload propietario.
 */
export interface ChannelAdapter extends ChannelSender {
  verifyInbound(request: unknown): boolean | Promise<boolean>;
  parseInbound(payload: unknown): ParsedInbound;
  /** Clave de rate limit por remitente; por defecto el propio senderId. */
  rateLimitKey?(senderId: string): string;
  /** Ruta HTTP del webhook; por defecto `/webhook/<channel>`. */
  webhookPath?: string;
  /** true si el canal requiere el cuerpo crudo (p. ej. HMAC de Meta). */
  rawBody?: boolean;
  /** Verificación GET de challenge (webhooks tipo Meta). */
  verifyWebhookChallenge?(query: Record<string, unknown>): { ok: boolean; challenge?: string };
  /** Descarga el binario de un media (sin exponer URLs/tokens al núcleo). */
  downloadMedia?(media: NormalizedMedia): Promise<{
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
  }>;
}
