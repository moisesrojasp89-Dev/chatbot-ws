import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Función utilitaria para enmascarar números telefónicos (PII) en los logs (B7).
 * Conserva únicamente los últimos 4 dígitos visibles (ej: +551199991234 -> ****1234).
 */
export function maskPhoneNumber(phone: string): string {
  if (!phone || typeof phone !== 'string') return '****';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  const suffix = digits.slice(-4);
  return `****${suffix}`;
}

const PHONE_KEYS = new Set([
  'phonenumber',
  'phone',
  'recipientphone',
  'recipient',
  'senderphone',
  'from',
  'to',
  'sender_phone',
  'recipient_phone',
]);

const TOKEN_KEYS = new Set([
  'token',
  'tokenreceived',
  'locktoken',
  'lock_token',
  'apikey',
  'api_key',
  'secret',
  'appsecret',
  'password',
  'authorization',
  'accesstoken',
  'bearer',
]);

const CONTENT_KEYS = new Set([
  'content',
  'text',
  'preview',
  'usermessagepreview',
  'botresponsepreview',
  'rawbody',
  'raw_payload',
  'body',
]);

const PG_SENSITIVE_KEYS = new Set([
  'query',
  'parameters',
  'detail',
  'where',
  'schema',
  'table',
  'column',
  'hint',
  'internalquery',
  'connectionstring',
]);

export function sanitizeLogValue(key: string, value: unknown, depth: number = 0): unknown {
  if (depth > 6) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value;

  const lowerKey = key.toLowerCase();

  // 1. Tokens y secretos
  if (TOKEN_KEYS.has(lowerKey)) {
    return '[REDACTED]';
  }

  // 2. Contenido de mensajes
  if (CONTENT_KEYS.has(lowerKey)) {
    return '[REDACTED]';
  }

  // 3. Detalles sensibles de errores de Postgres (detail, where, query, etc.)
  if (PG_SENSITIVE_KEYS.has(lowerKey)) {
    return '[REDACTED]';
  }

  // 4. Teléfonos en campos clave
  if (PHONE_KEYS.has(lowerKey) && typeof value === 'string') {
    return maskPhoneNumber(value);
  }

  if (typeof value === 'string') {
    // Sanitizar cadenas que contengan patrones de Bearer tokens
    let sanitized = value.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]');

    // Sanitizar tokens explícitos en strings (ej: token=secret123, lock_token=xyz)
    sanitized = sanitized.replace(/(?:lock_token|token|api_?key|password|secret)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]+)['"]?/gi, (match, p1) => {
      return match.replace(p1, '[REDACTED]');
    });

    // Sanitizar contenido de mensajes/cuerpo/payload en strings (B7)
    sanitized = sanitized.replace(/(?:cuerpo|body|text|content|payload)\s*[:=]?\s*["']([^"'\n]+)["']/gi, (match, p1) => {
      return match.replace(p1, '[REDACTED]');
    });
    sanitized = sanitized.replace(/(?:cuerpo|body|text|content|payload)\s*[:=]\s*['"]?([^"',}\n]+)['"]?/gi, (match, p1) => {
      return match.replace(p1, '[REDACTED]');
    });

    // Sanitizar números telefónicos en cadenas (ej: +5511999991234 o +573001234567) conservando solo últimos 4 dígitos (B7)
    // Se evita enmascarar identificadores numéricos puros (timestamps Unix de 10-13 dígitos) que no tienen formato de teléfono
    sanitized = sanitized.replace(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g, (match) => {
      const rawDigits = match.replace(/\D/g, '');
      // Descartar timestamps de Unix comunes (10 dígitos en segundos ~1.7e9 o 13 dígitos en ms ~1.7e12) si no tienen '+'
      if (!match.startsWith('+') && (rawDigits.length === 10 || rawDigits.length === 13) && (rawDigits.startsWith('17') || rawDigits.startsWith('18'))) {
        return match;
      }
      if (rawDigits.length >= 8 && rawDigits.length <= 15) {
        return `****${rawDigits.slice(-4)}`;
      }
      return match;
    });

    return sanitized;
  }

  if (value instanceof Error) {
    const errObj: Record<string, unknown> = {
      name: value.name,
      message: sanitizeLogValue('message', value.message, depth + 1),
      // B7: Sanitizar el stack trace para eliminar teléfonos, tokens y fragmentos de payload de la 1ª línea
      stack: value.stack ? (sanitizeLogValue('stack', value.stack, depth + 1) as string) : undefined,
    };
    for (const [k, v] of Object.entries(value)) {
      if (k === 'config' && typeof v === 'object' && v !== null) {
        errObj.config = { ...v, headers: '[REDACTED]' };
      } else if (k === 'response' && typeof v === 'object' && v !== null) {
        errObj.response = { status: (v as any).status, statusText: (v as any).statusText, data: '[REDACTED]' };
      } else {
        errObj[k] = sanitizeLogValue(k, v, depth + 1);
      }
    }
    return errObj;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(key, item, depth + 1));
  }

  if (typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.toLowerCase() === 'headers' && typeof v === 'object' && v !== null) {
        copy[k] = '[REDACTED]';
      } else {
        copy[k] = sanitizeLogValue(k, v, depth + 1);
      }
    }
    return copy;
  }

  return value;
}

export function getLoggerOptions(): pino.LoggerOptions {
  return {
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: {
      paths: [
        '*.token',
        '*.tokenReceived',
        '*.lockToken',
        '*.lock_token',
        '*.apiKey',
        '*.password',
        '*.content',
        '*.text',
        '*.preview',
        '*.userMessagePreview',
        '*.botResponsePreview',
        '*.rawBody',
        '*.query',
        '*.parameters',
        '*.detail',
        '*.where',
        'headers.authorization',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      log(object) {
        if (object && typeof object === 'object') {
          return sanitizeLogValue('root', object) as Record<string, unknown>;
        }
        return object;
      },
    },
    serializers: {
      err(err) {
        return sanitizeLogValue('err', err);
      },
      error(err) {
        return sanitizeLogValue('error', err);
      },
    },
  };
}

export const logger = pino(
  getLoggerOptions(),
  env.NODE_ENV !== 'production' && env.NODE_ENV !== 'test'
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      })
    : undefined
);
