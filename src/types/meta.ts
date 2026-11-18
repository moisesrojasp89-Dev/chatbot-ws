/**
 * Tipos oficiales para el Webhook de Meta WhatsApp Cloud API
 */

export interface MetaWebhookPayload {
  object: string;
  entry: MetaEntry[];
}

export interface MetaEntry {
  id: string;
  changes: MetaChange[];
}

export interface MetaChange {
  field: string;
  value: MetaValue;
}

export interface MetaValue {
  messaging_product: 'whatsapp';
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: MetaContact[];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
}

export interface MetaContact {
  profile: {
    name: string;
  };
  wa_id: string;
}

export interface MetaMessage {
  from: string; // Número de teléfono emisor (E.164)
  id: string;   // wamid único de WhatsApp
  timestamp: string;
  type: 'text' | 'interactive' | 'image' | 'audio' | 'document' | 'button' | 'location';
  text?: {
    body: string;
  };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: {
      id: string;
      title: string;
    };
    list_reply?: {
      id: string;
      title: string;
      description?: string;
    };
  };
}

export interface MetaStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  errors?: Array<{
    code: number;
    title: string;
  }>;
}

/**
 * Payload Interno Normalizado desacoplado de la API de Meta
 */
export interface NormalizedMessage {
  messageId: string; // wamid
  senderPhone: string;
  senderName: string;
  timestamp: number;
  type: 'text' | 'interactive' | 'media';
  text: string;
  interactiveId?: string;
}
