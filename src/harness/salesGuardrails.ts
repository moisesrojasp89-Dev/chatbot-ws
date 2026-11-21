import { logger } from '../utils/logger.js';

export type SalesViolationCode =
  | 'CREDIT_PROMISE'
  | 'UNVERIFIED_AVAILABILITY'
  | 'UNCONFIRMED_TEST_DRIVE'
  | 'UNAUTHORIZED_DISCOUNT'
  | 'UNVERIFIED_PRICE';

export interface SalesPolicyContext {
  catalogToolExecuted: boolean;
  leadToolExecuted: boolean;
  handoffToolExecuted: boolean;
  allowedPrices?: number[];
}

export interface SalesPolicyResult {
  passed: boolean;
  violationReason?: SalesViolationCode;
  sanitizedResponse?: string;
}

const CREDIT_PROMISE_PATTERNS = [
  /cr[eé]dito\s+(?:est[aá]\s+)?(?:aprobado|preaprobado|garantizado)/i,
  /aprobaci[oó]n\s+(?:garantizada|inmediata|segura|asegurada)/i,
  /sin\s+requisitos/i,
  /100\s*%\s*(?:aprobado|garantizado)/i,
];

const TEST_DRIVE_CONFIRM_PATTERNS = [
  /test\s*drive\s+(?:est[aá]\s+)?(?:confirmado|reservado|agendado)/i,
  /(?:cita|prueba)\s+(?:confirmada|reservada|agendada)\s+(?:para|del)\s+test\s*drive/i,
];

const DISCOUNT_PATTERN = /\b(?:descuento|rebaja|promoci[oó]n)\b/i;
const DISCOUNT_VALUE_PATTERN = /\d+\s*%|\$\s*[\d.,]+/;
const AVAILABILITY_PATTERN = /(?:disponible|en stock|[uú]ltima unidad|[uú]ltimas unidades)/i;
const NEGATED_AVAILABILITY_PATTERN = /no\s+(?:est[aá]|se\s+encuentra)\s+disponible/i;

function parseMoney(raw: string): number | null {
  const numeric = raw.replace(/[^\d.,]/g, '');
  if (!numeric) return null;

  const hasComma = numeric.includes(',');
  const hasDot = numeric.includes('.');
  let normalized = numeric;

  if (hasComma && hasDot) {
    normalized = numeric.replace(/,/g, '');
  } else if (hasComma) {
    const decimals = numeric.split(',').pop()?.length ?? 0;
    normalized = decimals === 3 ? numeric.replace(/,/g, '') : numeric.replace(',', '.');
  } else if (hasDot) {
    const decimals = numeric.split('.').pop()?.length ?? 0;
    normalized = decimals === 3 ? numeric.replace(/\./g, '') : numeric;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function extractMonetaryValues(text: string): number[] {
  const matches = text.match(/(?:\$|USD|COP|MXN|€)\s*[\d.,]+|\d[\d.,]*\s*(?:USD|COP|MXN|d[oó]lares|pesos|euros)/gi) ?? [];
  return matches
    .map(parseMoney)
    .filter((value): value is number => value !== null);
}

/**
 * Guardrail determinista de ventas. No reemplaza al LLM: bloquea afirmaciones
 * que no estén respaldadas por una tool/ catálogo y devuelve una respuesta segura.
 */
export function checkSalesPolicy(
  botResponse: string,
  context: SalesPolicyContext
): SalesPolicyResult {
  for (const pattern of CREDIT_PROMISE_PATTERNS) {
    if (pattern.test(botResponse)) {
      logger.warn({ violation: 'CREDIT_PROMISE' }, '🛑 Guardrail de ventas: promesa de crédito');
      return {
        passed: false,
        violationReason: 'CREDIT_PROMISE',
        sanitizedResponse:
          'La aprobación del crédito la confirma un asesor con la documentación del cliente. No puedo garantizarla por este canal. ¿Deseas que te contacte un asesor?',
      };
    }
  }

  for (const pattern of TEST_DRIVE_CONFIRM_PATTERNS) {
    if (pattern.test(botResponse) && !context.leadToolExecuted) {
      logger.warn({ violation: 'UNCONFIRMED_TEST_DRIVE' }, '🛑 Guardrail de ventas: test drive confirmado sin registro');
      return {
        passed: false,
        violationReason: 'UNCONFIRMED_TEST_DRIVE',
        sanitizedResponse:
          'Tu solicitud de test drive queda registrada, pero la cita se confirma cuando un asesor valide disponibilidad y licencia. ¿Te contacto con un asesor?',
      };
    }
  }

  if (
    DISCOUNT_PATTERN.test(botResponse) &&
    DISCOUNT_VALUE_PATTERN.test(botResponse) &&
    !context.catalogToolExecuted
  ) {
    logger.warn({ violation: 'UNAUTHORIZED_DISCOUNT' }, '🛑 Guardrail de ventas: descuento sin catálogo');
    return {
      passed: false,
      violationReason: 'UNAUTHORIZED_DISCOUNT',
      sanitizedResponse:
        'Los descuentos y promociones los autoriza un asesor comercial. Puedo ayudarte con el precio de lista y pasarte con alguien que revise tu caso.',
    };
  }

  if (
    AVAILABILITY_PATTERN.test(botResponse) &&
    !NEGATED_AVAILABILITY_PATTERN.test(botResponse) &&
    !context.catalogToolExecuted
  ) {
    logger.warn({ violation: 'UNVERIFIED_AVAILABILITY' }, '🛑 Guardrail de ventas: disponibilidad sin catálogo');
    return {
      passed: false,
      violationReason: 'UNVERIFIED_AVAILABILITY',
      sanitizedResponse:
        'Déjame verificar la disponibilidad real en el inventario antes de confirmarte un vehículo. ¿Qué modelo te interesa?',
    };
  }

  const prices = extractMonetaryValues(botResponse);
  if (prices.length > 0 && !context.catalogToolExecuted) {
    logger.warn({ violation: 'UNVERIFIED_PRICE' }, '🛑 Guardrail de ventas: monto sin consultar catálogo');
    return {
      passed: false,
      violationReason: 'UNVERIFIED_PRICE',
      sanitizedResponse:
        'Déjame verificar el precio exacto en el catálogo antes de darte una cifra. ¿Me confirmas el modelo y la versión que te interesan?',
    };
  }

  if (context.allowedPrices && context.allowedPrices.length > 0) {
    const allowed = new Set(context.allowedPrices.map((price) => Math.round(price)));
    const unverified = prices.find((price) => !allowed.has(Math.round(price)));

    if (unverified !== undefined) {
      logger.warn({ violation: 'UNVERIFIED_PRICE', value: unverified }, '🛑 Guardrail de ventas: precio fuera de catálogo');
      return {
        passed: false,
        violationReason: 'UNVERIFIED_PRICE',
        sanitizedResponse:
          'Déjame verificar el precio exacto en el catálogo antes de darte una cifra. ¿Me confirmas el modelo y la versión que te interesan?',
      };
    }
  }

  return { passed: true };
}
