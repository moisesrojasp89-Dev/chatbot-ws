import { logger } from '../utils/logger.js';

/**
 * F3-C3: Regex determinista para detección estricta de montos monetarios en español y estándares internacionales.
 */
export const PRICE_PATTERN =
  /(?:\$|USD|COP|MXN|€)\s*[\d.,]+|\d+[\d.,]*\s*(?:pesos|dólares|dolares|euros|cop|usd|mxn)/gi;

/**
 * Patrones pre-inferencia de inyección de prompt (Jailbreaks).
 */
export const JAILBREAK_PATTERNS = [
  /ignore (?:all )?(?:previous|above) instructions/i,
  /olvida (?:todas )?las instrucciones (?:anteriores|previas)/i,
  /you are now (?:unrestricted|dan|jailbroken)/i,
  /ahora eres (?:libre|una ia sin restricciones|un hacker)/i,
  /(?:reveal|show|display) (?:your )?system prompt/i,
  /(?:muestra|revela|dime) tu (?:system prompt|prompt del sistema|instrucciones)/i,
  /act as an? (?:unfiltered|evil|jailbroken) ai/i,
  /actúa como una ia sin filtros/i,
  /modo dan/i,
  /bypass safety/i,
];

/**
 * Patrones post-inferencia de contenido restringido (Denylist Nivel 4).
 */
export const DENYLIST_PATTERNS = [
  // Consejos médicos o farmacológicos
  /(?:diagn[oó]stico m[eé]dico|te receto|toma este medicamento|dosis de amoxicilina|ibuprofeno cada)/i,
  // Consejos legales
  /(?:asesor[ií]a jur[ií]dica vinculante|te recomiendo demandar|inicia un juicio contra)/i,
  // Lenguaje inapropiado o denigrante
  /(?:hijo de puta|estafadores de mierda|malditos ladrones)/i,
];

/**
 * Temas fuera de alcance para un bot de ventas/atención.
 * Es una red determinista; el prompt también refuerza el alcance.
 */
export const OFF_TOPIC_PATTERNS = [
  /(?:receta|dosis|medicamento|diagn[oó]stico m[eé]dico)/i,
  /(?:demanda judicial|juicio|abogado|asesor[ií]a legal)/i,
  /(?:qui[eé]n gan[oó]|elecciones|presidente|pol[ií]tica partidista)/i,
  /(?:programar|programaci[oó]n|c[oó]digo fuente|python|javascript)/i,
  /(?:tarea escolar|matem[aá]ticas|ensayo|poema|chiste)/i,
  /(?:hor[oó]scopo|signo zodiacal|religi[oó]n)/i,
];
export interface GuardrailResult {
  passed: boolean;
  violationReason?: string;
  sanitizedResponse?: string;
}

export class GuardrailService {
  /**
   * Nivel 1: Filtro Pre-Inferencia contra ataques de Jailbreak y Prompt Injection.
   * Se ejecuta en < 1ms antes de llamar al LLM.
   */
  public checkPreInference(userMessage: string): GuardrailResult {
    for (const pattern of JAILBREAK_PATTERNS) {
      if (pattern.test(userMessage)) {
        logger.warn({ userMessagePreview: userMessage.slice(0, 30) }, '🚨 Guardrail Nivel 1 activado: Intento de Jailbreak detectado');
        return {
          passed: false,
          violationReason: 'JAILBREAK_ATTEMPT',
          sanitizedResponse:
            'Como asistente corporativo, solo puedo brindarte información verídica y asesoría sobre nuestros productos y servicios autorizados. ¿En qué puedo orientarte hoy?',
        };
      }
    }

    return { passed: true };
  }

  /**
   * Guardrail de alcance: impide que el bot se convierta en un asistente
   * general y queme tokens en temas ajenos al negocio.
   */
  public checkScope(userMessage: string, businessName: string, vertical?: string): GuardrailResult {
    for (const pattern of OFF_TOPIC_PATTERNS) {
      if (pattern.test(userMessage)) {
        logger.warn({ userMessagePreview: userMessage.slice(0, 30) }, '🚫 Guardrail de alcance: tema fuera del nicho');
        return {
          passed: false,
          violationReason: 'OUT_OF_SCOPE',
          sanitizedResponse: `Solo puedo ayudarte con consultas de ${businessName}${vertical ? ` (${vertical})` : ''}: productos, precios, disponibilidad, citas y atención. ¿Te ayudo con alguno de esos temas?`,
        };
      }
    }
    return { passed: true };
  }
  /**
   * Nivel 3: Grounding Lock Post-Inferencia.
   * Verifica deterministamente por código que si el bot menciona precios o montos,
   * haya invocado de forma verificada la herramienta `searchProductCatalog`.
   */
  public checkGroundingLock(
    botResponse: string,
    catalogToolExecuted: boolean
  ): GuardrailResult {
    const hasMonetaryValue = PRICE_PATTERN.test(botResponse);
    // Reiniciar lastIndex para evitar efectos secundarios en regex con flag global /g
    PRICE_PATTERN.lastIndex = 0;

    if (hasMonetaryValue && !catalogToolExecuted) {
      logger.warn(
        { botResponsePreview: botResponse.slice(0, 50) },
        '🛑 Guardrail Nivel 3 (Grounding Lock) activado: Modelo citó montos sin consultar el catálogo oficial'
      );
      return {
        passed: false,
        violationReason: 'UNGROUNDED_PRICE_MENTION',
        sanitizedResponse:
          'Con gusto puedo darte los precios actualizados. Por favor indícame exactamente qué producto o plan te interesa para verificarlo en nuestro catálogo oficial.',
      };
    }

    return { passed: true };
  }

  /**
   * Nivel 4: Denylist Post-Inferencia.
   * Bloquea consejos no autorizados (médicos, legales) o lenguaje impropio en la respuesta del bot.
   */
  public checkPostInferenceDenylist(botResponse: string): GuardrailResult {
    for (const pattern of DENYLIST_PATTERNS) {
      if (pattern.test(botResponse)) {
        logger.warn('⚠️ Guardrail Nivel 4 (Denylist) activado: Contenido restringido detectado en la respuesta generada');
        return {
          passed: false,
          violationReason: 'DENYLIST_CONTENT_DETECTED',
          sanitizedResponse:
            'Para brindarte una orientación adecuada y responsable sobre este tema, con gusto puedo transferir tu consulta a un asesor humano especializado.',
        };
      }
    }

    return { passed: true };
  }
}

export const guardrails = new GuardrailService();
