import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import {
  GeminiCompletionResult,
  GeminiContentMessage,
  ToolDefinition,
} from './geminiTypes.js';
import { llmRateLimiter } from './llmRateLimiter.js';

export const OFFICIAL_TOOLS_DECLARATIONS: ToolDefinition[] = [
  {
    functionDeclarations: [
      {
        name: 'searchProductCatalog',
        description:
          'Consulta el catálogo maestro oficial de productos y servicios con precios reales garantizados y disponibilidad.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'Término de búsqueda del producto, plan o servicio',
            },
            category: {
              type: 'STRING',
              description: 'Categoría opcional (planes, servicios)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'createQualifiedLead',
        description:
          'Registra formalmente un lead comercial en la base de datos cuando el cliente manifiesta intención de compra o contratación.',
        parameters: {
          type: 'OBJECT',
          properties: {
            productInterest: {
              type: 'STRING',
              description: 'Nombre del producto o plan en el que el cliente mostró interés',
            },
            customerEmail: {
              type: 'STRING',
              description: 'Correo electrónico de contacto proporcionado por el cliente',
            },
            customerCity: {
              type: 'STRING',
              description: 'Ciudad de residencia o ubicación del negocio del cliente',
            },
            estimatedBudget: {
              type: 'NUMBER',
              description: 'Presupuesto estimado en USD si fue mencionado',
            },
            notes: {
              type: 'STRING',
              description: 'Detalles adicionales o requerimientos clave expresados por el prospecto',
            },
          },
          required: ['productInterest'],
        },
      },
      {
        name: 'requestHumanHandoff',
        description:
          'Transfiere de inmediato la conversación a un asesor humano cuando el cliente lo pide expresamente o presenta un caso fuera de alcance.',
        parameters: {
          type: 'OBJECT',
          properties: {
            reason: {
              type: 'STRING',
              enum: ['USER_REQUEST', 'FRUSTRATION', 'TOOL_FAILURE', 'OUT_OF_SCOPE'],
              description: 'Causa que detona el escalamiento humano',
            },
            briefing: {
              type: 'STRING',
              description: 'Resumen ejecutivo de lo conversado para que el asesor humano tome el control sin fricción',
            },
          },
          required: ['briefing'],
        },
      },
    ],
  },
];

export type LlmErrorType =
  | 'TRANSIENT_RATE_LIMIT'    // 429 por minuto (reintento con backoff corto)
  | 'DAILY_QUOTA_EXHAUSTED'   // Cuota diaria agotada (pausa larga de 10m y alerta crítica)
  | 'AUTH_OR_CONFIG_ERROR'    // 401, 403, 400 API_KEY_INVALID, modelo inexistente
  | 'FATAL_PAYLOAD_ERROR'     // 400 Bad request, prompt inválido (fallo terminal)
  | 'NETWORK_OR_TIMEOUT';     // Timeout, AbortError, 5xx, ECONNRESET (reintento transitorio)

/**
 * Parsea el cuerpo del error (incluyendo JSON anidado en error.message)
 * para inspeccionar detalles RPC de Google Cloud / Gemini API (B2).
 */
export function parseErrorPayload(error: any): {
  code?: number;
  status?: string | number;
  message: string;
  details: any[];
} {
  let message = String(error?.message || '');
  let code = typeof error?.code === 'number' ? error.code : typeof error?.status === 'number' ? error.status : undefined;
  let status = error?.status || error?.statusCode || error?.code;
  let details: any[] = Array.isArray(error?.details) ? [...error.details] : [];

  // Extraer JSON embebido en mensaje de error si está presente
  const jsonMatch = message.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const root = parsed.error || parsed;
      if (root.code && typeof root.code === 'number') code = root.code;
      if (root.status) status = root.status;
      if (root.message) message = `${message} ${root.message}`;
      if (Array.isArray(root.details)) {
        details = [...details, ...root.details];
      }
    } catch {
      // Si no es JSON válido, continúa con el mensaje sin procesar
    }
  }

  return { code, status, message: message.toLowerCase(), details };
}

/**
 * Extrae el retardo recomendado de reintento (RetryInfo.retryDelay) si está presente (B2).
 */
export function extractLlmRetryDelaySeconds(error: any): number | undefined {
  const { details } = parseErrorPayload(error);
  for (const d of details) {
    if (d.retryDelay) {
      const match = String(d.retryDelay).match(/^([0-9.]+)/);
      if (match) {
        const val = parseFloat(match[1]);
        if (!isNaN(val) && val > 0) return Math.ceil(val);
      }
    }
  }
  return undefined;
}

export function classifyLlmError(error: any): LlmErrorType {
  if (!error) return 'FATAL_PAYLOAD_ERROR';
  const name = error.name || '';
  const { code, status, message, details } = parseErrorPayload(error);

  // 1. Credenciales o configuración inválida (401, 403, 400 con API_KEY_INVALID, 404 modelo no encontrado)
  const isApiKeyInvalid =
    message.includes('api_key_invalid') ||
    message.includes('api key not valid') ||
    message.includes('api key expired') ||
    details.some(
      (d) =>
        d.reason === 'API_KEY_INVALID' ||
        d.reason === 'API_KEY_EXPIRED' ||
        (typeof d.description === 'string' && d.description.toLowerCase().includes('api key'))
    );

  if (
    code === 401 ||
    status === 401 ||
    code === 403 ||
    status === 403 ||
    status === 'UNAUTHENTICATED' ||
    status === 'PERMISSION_DENIED' ||
    ((code === 400 || status === 400 || status === 'INVALID_ARGUMENT') && isApiKeyInvalid)
  ) {
    return 'AUTH_OR_CONFIG_ERROR';
  }

  // Modelo inexistente (404)
  if (
    code === 404 ||
    status === 404 ||
    status === 'NOT_FOUND' ||
    (message.includes('model') && (message.includes('not found') || message.includes('does not exist')))
  ) {
    return 'AUTH_OR_CONFIG_ERROR';
  }

  // 2. Discriminación de Cuota Diaria vs 429 por Minuto (B2)
  // Inspeccionar QuotaFailure.violations[].quotaId
  let hasDailyQuotaViolation = false;
  for (const d of details) {
    if (Array.isArray(d.violations)) {
      for (const v of d.violations) {
        const quotaId = String(v.quotaId || '');
        const desc = String(v.description || '').toLowerCase();
        if (
          quotaId.includes('PerDay') ||
          quotaId.includes('Daily') ||
          desc.includes('per day') ||
          desc.includes('daily')
        ) {
          hasDailyQuotaViolation = true;
          break;
        }
      }
    }
  }

  if (
    hasDailyQuotaViolation ||
    message.includes('daily limit') ||
    message.includes('perday') ||
    message.includes('per-day') ||
    message.includes('daily quota')
  ) {
    return 'DAILY_QUOTA_EXHAUSTED';
  }

  // Si es 429 o RESOURCE_EXHAUSTED sin cuota diaria: es un 429 transitorio por minuto (RPM)
  if (
    code === 429 ||
    status === 429 ||
    status === 'RESOURCE_EXHAUSTED' ||
    message.includes('rate limit') ||
    message.includes('resource_exhausted') ||
    message.includes('quota exceeded')
  ) {
    return 'TRANSIENT_RATE_LIMIT';
  }

  // 3. Fallos de red, timeouts o 503 Overloaded (B2, B6)
  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    code === 503 ||
    status === 503 ||
    status === 'UNAVAILABLE' ||
    message.includes('overloaded') ||
    message.includes('service unavailable') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('network') ||
    message.includes('fetch failed') ||
    (typeof code === 'number' && code >= 500 && code < 600) ||
    (typeof status === 'number' && status >= 500 && status < 600) ||
    status === 'DEADLINE_EXCEEDED'
  ) {
    return 'NETWORK_OR_TIMEOUT';
  }

  // 4. Bad request u otro error de formato cliente
  return 'FATAL_PAYLOAD_ERROR';
}

export function isTransientLlmError(error: any): boolean {
  const type = classifyLlmError(error);
  return type === 'TRANSIENT_RATE_LIMIT' || type === 'NETWORK_OR_TIMEOUT';
}

export class GeminiClient {
  private ai: GoogleGenAI;
  public readonly modelName = 'gemini-2.5-flash';
  public readonly defaultTimeoutMs = 20000; // 20s timeout (claramente menor al lease de 45s del inbound)

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }

  /**
   * Ejecuta una llamada de inferencia a Gemini 2.5 Flash aplicando F3-C6 (maxOutputTokens: 180, temperature: 0.2)
   * cancelando la petición HTTP a nivel de socket mediante AbortSignal y httpOptions.timeout.
   * En Gemini 2.5 Flash, thinkingConfig.thinkingBudget = 0 evita que los tokens de razonamiento agoten maxOutputTokens (B4).
   */
  public async generateTurn(
    systemInstruction: string,
    contents: GeminiContentMessage[],
    timeoutMs: number = this.defaultTimeoutMs,
    parentSignal?: AbortSignal
  ): Promise<GeminiCompletionResult> {
    const startTime = Date.now();
    const abortController = new AbortController();

    if (parentSignal) {
      if (parentSignal.aborted) {
        const err = new Error('Gemini API Turn Deadline Exceeded before call');
        err.name = 'AbortError';
        throw err;
      }
      parentSignal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const timer = setTimeout(() => {
      const timeoutErr = new Error(`Gemini API Request Timeout (${timeoutMs}ms abort)`);
      timeoutErr.name = 'TimeoutError';
      abortController.abort(timeoutErr);
    }, timeoutMs);
    timer.unref?.();

    const maxOutputTokens = 180;
    const promptCharCount = systemInstruction.length + JSON.stringify(contents).length;
    const estimatedTokens = Math.ceil(promptCharCount / 4) + maxOutputTokens;

    // C7 & C8: Adquisición atómica síncrona / cola FIFO en rate limiter dual (RPM/TPM)
    await llmRateLimiter.acquireToken(estimatedTokens, abortController.signal);

    try {
      // Configuración estricta según TDD v2.1 y F3-C6 pasando abortSignal y httpOptions
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: contents as any,
        config: {
          systemInstruction,
          temperature: 0.2, // Grounding estricto
          maxOutputTokens, // F3-C6: Fuerza micro-mensajes concisos
          thinkingConfig: { thinkingBudget: 0 }, // B4: Evita que el razonamiento por defecto consuma el presupuesto de salida
          tools: OFFICIAL_TOOLS_DECLARATIONS as any,
          abortSignal: abortController.signal,
          httpOptions: { timeout: timeoutMs + 3000 }, // C2: Mayor que timer local para que timer local aborte primero
        } as any,
      });

      const latencyMs = Date.now() - startTime;
      const text = response.text || '';
      const finishReason = (response as any)?.candidates?.[0]?.finishReason;

      // Extracción de llamadas a funciones si el modelo decidió invocar herramientas
      const functionCalls = response.functionCalls
        ?.filter((fc): fc is typeof fc & { name: string } => typeof fc.name === 'string' && fc.name.length > 0)
        .map((fc) => ({
          name: fc.name,
          args: (fc.args as Record<string, unknown>) || {},
        }));

      const usage = response.usageMetadata;
      const promptTokens = usage?.promptTokenCount || 0;
      const completionTokens = usage?.candidatesTokenCount || 0;
      const actualTokens = promptTokens + completionTokens;

      // C7: Reconciliación post-inferencia con el consumo real devuelto por Gemini
      llmRateLimiter.reconcile(estimatedTokens, actualTokens);

      logger.info(
        {
          model: this.modelName,
          latencyMs,
          promptTokens,
          completionTokens,
          actualTokens,
          finishReason,
          hasFunctionCalls: Boolean(functionCalls && functionCalls.length > 0),
        },
        '🤖 Inferencia Gemini 2.5 Flash completada'
      );

      return {
        text,
        functionCalls,
        promptTokens,
        completionTokens,
        latencyMs,
        finishReason,
      };
    } catch (error: any) {
      // C7 Error Path: Si la llamada falló antes de obtener respuesta, reembolsar íntegramente los tokens de TPM reservados
      llmRateLimiter.reconcile(estimatedTokens, 0);

      const latencyMs = Date.now() - startTime;
      if (abortController.signal.aborted) {
        const timeoutErr = new Error(`Gemini API Request Timeout / Aborted (${timeoutMs}ms)`);
        timeoutErr.name = 'TimeoutError';
        logger.error({ error: timeoutErr, latencyMs }, '❌ Timeout / Abort durante la llamada a Gemini API');
        throw timeoutErr;
      }
      logger.error({ error, latencyMs }, '❌ Error durante la llamada a Gemini API');
      throw error;
    } finally {
      clearTimeout(timer!);
    }
  }
}

export const geminiClient = new GeminiClient();

