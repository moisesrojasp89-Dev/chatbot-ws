import { env } from '../../../config/env.js';
import { getMetaConfig } from './metaConfig.js';
import { logger } from '../../../utils/logger.js';

export interface SendMessageResponse {
  messaging_product: string;
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
}

/**
 * Error estructurado emitido ante respuestas anómalas de Meta Graph API.
 * Distingue entre:
 * - isSystemicAuth: Errores sistémicos de credenciales o cuenta (401, o códigos 190, 131031, 131042, 131005, 133010).
 * - isTransient: 5xx, 429, rate limit por par (131056), caídas de red o timeouts (status 0).
 * - No transitorio (4xx de cliente): Ventana 24h cerrada (131047), plantilla no aprobada, número inválido (131026).
 *
 * NOTA DE RIESGO RESIDUAL ACEPTADO (Arquitectura Meta Cloud API):
 * Meta WhatsApp Cloud API no ofrece soporte para idempotency keys en el endpoint /messages.
 * Si un mensaje es aceptado por la infraestructura de Meta pero la conexión se corta o el AbortSignal (15s)
 * aborta antes de recibir el HTTP 200 con el wamid, el reintento posterior podría provocar un envío duplicado.
 * Este riesgo residual es un límite intrínseco documentado del proveedor Meta.
 */
export class MetaGraphApiError extends Error {
  public readonly status: number;
  public readonly errorBody: string;
  public readonly errorCode?: number;
  public readonly isTransient: boolean;
  public readonly isSystemicAuth: boolean;

  constructor(status: number, errorBody: string) {
    super(`Meta Graph API error ${status}: ${errorBody}`);
    this.name = 'MetaGraphApiError';
    this.status = status;
    this.errorBody = errorBody;

    let parsedCode: number | undefined;
    try {
      const parsed = JSON.parse(errorBody);
      parsedCode = parsed?.error?.code;
    } catch {
      // Payload no estructurado en JSON
    }
    this.errorCode = parsedCode;

    // Errores sistémicos de credenciales o cuenta:
    // 401: Unauthorized
    // 190: OAuthException (token vencido o revocado)
    // 131031: Cuenta bloqueada (Account has been locked)
    // 131042: Problema de elegibilidad comercial o método de pago
    // 131005: Acceso denegado a la cuenta de WhatsApp Business
    // 133010: Número de teléfono no registrado o no verificado
    const systemicCodes = new Set([190, 131031, 131042, 131005, 133010]);
    this.isSystemicAuth = status === 401 || (parsedCode !== undefined && systemicCodes.has(parsedCode));

    // Errores transitorios: caídas de Meta (5xx), rate limit (429), timeouts/red (status 0), o rate limit por par (131056)
    this.isTransient = status >= 500 || status === 429 || status === 0 || parsedCode === 131056;
  }
}

export class WhatsAppClient {
  private readonly baseUrl = 'https://graph.facebook.com/v21.0';

  /**
   * Envía un mensaje de texto saliente a un contacto de WhatsApp a través de Meta Graph API.
   * Con timeout HTTP de 15s (claramente menor que el lease de 2 minutos del reaper).
   */
  public async sendTextMessage(
    phoneNumberId: string,
    to: string,
    text: string
  ): Promise<string> {
    const url = `${this.baseUrl}/${phoneNumberId}/messages`;
    const { accessToken } = getMetaConfig();

    // En entorno de pruebas con token mock, simular wamid para no requerir red externa
    if (
      env.NODE_ENV === 'test' &&
      (accessToken.startsWith('test_') ||
        accessToken.includes('TEST_TOKEN') ||
        accessToken.startsWith('EAAB_TEST_'))
    ) {
      const mockWamid = `wamid.HBgL_OUTBOUND_${Date.now()}_${Math.random().toString(36).slice(2, 7)}==`;
      logger.debug({ to, mockWamid }, '[MOCK] Mensaje saliente simulado en entorno de test');
      return mockWamid;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15000), // Timeout HTTP de 15 segundos
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: {
            preview_url: false,
            body: text,
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(
          { status: response.status, errorBody, to, phoneNumberId },
          '❌ Error al despachar mensaje a Meta WhatsApp Cloud API'
        );
        throw new MetaGraphApiError(response.status, errorBody);
      }

      const data = (await response.json()) as SendMessageResponse;
      const wamid = data.messages?.[0]?.id;
      if (!wamid) {
        throw new Error('Meta Graph API no retornó wamid en la respuesta');
      }

      logger.info({ to, wamid }, '📤 Mensaje saliente despachado exitosamente vía Meta Graph API');
      return wamid;
    } catch (error) {
      if (error instanceof MetaGraphApiError) {
        throw error;
      }
      const isTimeout =
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError');
      const message = isTimeout
        ? 'Meta API Request Timeout (15s abort)'
        : (error instanceof Error ? error.message : String(error));

      logger.error({ error: message, to }, 'Fallo en la comunicación con Meta Graph API');
      throw new MetaGraphApiError(0, message);
    }
  }

  /**
   * Envía media por URL pública. Meta descarga la URL; no acepta rutas locales.
   */
  public async sendMediaMessage(
    phoneNumberId: string,
    to: string,
    mediaType: 'image' | 'document' | 'video' | 'audio',
    mediaUrl: string,
    caption?: string
  ): Promise<string> {
    const url = `${this.baseUrl}/${phoneNumberId}/messages`;
    const { accessToken } = getMetaConfig();

    if (
      env.NODE_ENV === 'test' &&
      (accessToken.startsWith('test_') ||
        accessToken.includes('TEST_TOKEN') ||
        accessToken.startsWith('EAAB_TEST_'))
    ) {
      return `wamid.HBgL_MEDIA_${Date.now()}_${Math.random().toString(36).slice(2, 7)}==`;
    }

    const mediaPayload: Record<string, unknown> = { link: mediaUrl };
    if (caption && mediaType !== 'audio') mediaPayload.caption = caption;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: mediaType,
          [mediaType]: mediaPayload,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(
          { status: response.status, errorBody, to, phoneNumberId },
          '❌ Error al despachar media a Meta WhatsApp Cloud API'
        );
        throw new MetaGraphApiError(response.status, errorBody);
      }

      const data = (await response.json()) as SendMessageResponse;
      const wamid = data.messages?.[0]?.id;
      if (!wamid) throw new Error('Meta Graph API no retornó wamid en la respuesta');
      return wamid;
    } catch (error) {
      if (error instanceof MetaGraphApiError) throw error;
      const isTimeout =
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError');
      const message = isTimeout
        ? 'Meta API Request Timeout (15s abort)'
        : error instanceof Error
          ? error.message
          : String(error);
      throw new MetaGraphApiError(0, message);
    }
  }

  /**
   * Envía el indicador "typing..." a la API de Meta para simular presencia humana activa.
   */
  public async sendTypingIndicator(phoneNumberId: string, to: string): Promise<void> {
    if (env.NODE_ENV === 'test') {
      logger.debug({ to }, '[MOCK] Indicador typing simulado en test');
      return;
    }

    const { accessToken } = getMetaConfig();

    try {
      const url = `${this.baseUrl}/${phoneNumberId}/messages`;
      await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000), // 5s timeout para typing indicator
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          status: 'typing',
        }),
      });
    } catch (err) {
      logger.debug({ err, to }, 'Aviso: No se pudo emitir typing indicator a Meta (no crítico)');
    }
  }
}

export const whatsappClient = new WhatsAppClient();
