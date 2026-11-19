import {
  ChannelSendError,
  ChannelSendRequest,
  ChannelSendResult,
  ChannelSender,
} from '../channelTypes.js';
import { getMetaConfig, MetaConfigError } from './metaConfig.js';
import { MetaGraphApiError, whatsappClient } from './whatsappClient.js';

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

export class MetaChannelSender implements ChannelSender {
  public readonly channel = 'whatsapp';

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
