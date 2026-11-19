import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import {
  FunctionCallPart,
  LlmCompletionResult,
  LlmContentMessage,
  LlmTool,
} from './llmTypes.js';
import { llmRateLimiter } from './llmRateLimiter.js';

/**
 * Declaración neutra de tools en JSON Schema (formato de function calling
 * compatible con la especificación de Chat Completions de OpenAI).
 */
export const OFFICIAL_TOOLS: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'searchProductCatalog',
      description:
        'Consulta el catálogo maestro oficial de productos y servicios con precios reales garantizados y disponibilidad.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Término de búsqueda del producto, plan o servicio',
          },
          category: {
            type: 'string',
            description: 'Categoría opcional (planes, servicios)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createQualifiedLead',
      description:
        'Registra formalmente un lead comercial en la base de datos cuando el cliente manifiesta intención de compra o contratación.',
      parameters: {
        type: 'object',
        properties: {
          productInterest: {
            type: 'string',
            description: 'Nombre del producto o plan en el que el cliente mostró interés',
          },
          customerEmail: {
            type: 'string',
            description: 'Correo electrónico de contacto proporcionado por el cliente',
          },
          customerCity: {
            type: 'string',
            description: 'Ciudad de residencia o ubicación del negocio del cliente',
          },
          estimatedBudget: {
            type: 'number',
            description: 'Presupuesto estimado en USD si fue mencionado',
          },
          notes: {
            type: 'string',
            description: 'Detalles adicionales o requerimientos clave expresados por el prospecto',
          },
        },
        required: ['productInterest'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'requestHumanHandoff',
      description:
        'Transfiere de inmediato la conversación a un asesor humano cuando el cliente lo pide expresamente o presenta un caso fuera de alcance.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            enum: ['USER_REQUEST', 'FRUSTRATION', 'TOOL_FAILURE', 'OUT_OF_SCOPE'],
            description: 'Causa que detona el escalamiento humano',
          },
          briefing: {
            type: 'string',
            description: 'Resumen ejecutivo de lo conversado para que el asesor humano tome el control sin fricción',
          },
        },
        required: ['briefing'],
      },
    },
  },
];

export type LlmErrorType =
  | 'TRANSIENT_RATE_LIMIT' // 429 por minuto (reintento con backoff corto)
  | 'DAILY_QUOTA_EXHAUSTED' // Cuota diaria / facturación agotada (pausa larga y alerta crítica)
  | 'AUTH_OR_CONFIG_ERROR' // 401, 403, 400 credencial inválida, modelo inexistente
  | 'FATAL_PAYLOAD_ERROR' // 400 Bad request, prompt inválido (fallo terminal)
  | 'NETWORK_OR_TIMEOUT'; // Timeout, AbortError, 5xx, ECONNRESET (reintento transitorio)

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

/**
 * Parsea el cuerpo del error (incluyendo JSON embebido en error.message) para
 * inspeccionar la respuesta del proveedor LLM sin acoplarse a un SDK concreto.
 */
export function parseErrorPayload(error: any): {
  code?: number;
  status?: string | number;
  message: string;
  details: any[];
} {
  let message = String(error?.message || '');
  let code =
    typeof error?.code === 'number'
      ? error.code
      : typeof error?.status === 'number'
        ? error.status
        : undefined;
  let status = error?.status || error?.statusCode || error?.code;
  let details: any[] = Array.isArray(error?.details) ? [...error.details] : [];

  // Extraer JSON embebido en el mensaje de error si está presente
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
 * Extrae el retardo recomendado de reintento si el proveedor lo informa
 * (header Retry-After expuesto por el cliente o RetryInfo en el payload).
 */
export function extractLlmRetryDelaySeconds(error: any): number | undefined {
  const direct = Number(error?.retryAfterSeconds);
  if (Number.isFinite(direct) && direct > 0) return Math.ceil(direct);

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
  const name = String(error?.name || '');
  const { code, status, message, details } = parseErrorPayload(error);

  // 1. Credenciales o configuración inválida (401, 403, 400 con credencial inválida, 404 modelo no encontrado)
  const isKeyInvalid =
    message.includes('api_key_invalid') ||
    message.includes('invalid_api_key') ||
    message.includes('incorrect api key') ||
    message.includes('api key not valid') ||
    message.includes('api key expired') ||
    message.includes('unauthorized') ||
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
    ((code === 400 || status === 400 || status === 'INVALID_ARGUMENT') && isKeyInvalid)
  ) {
    return 'AUTH_OR_CONFIG_ERROR';
  }

  // Modelo inexistente (404)
  if (
    code === 404 ||
    status === 404 ||
    status === 'NOT_FOUND' ||
    (message.includes('model') &&
      (message.includes('not found') ||
        message.includes('does not exist') ||
        message.includes('unknown model')))
  ) {
    return 'AUTH_OR_CONFIG_ERROR';
  }

  // 2. Discriminación de cuota diaria / facturación agotada vs 429 por minuto
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
    message.includes('daily quota') ||
    message.includes('insufficient_quota') ||
    message.includes('exceeded your current quota')
  ) {
    return 'DAILY_QUOTA_EXHAUSTED';
  }

  // 429 genérico: límite transitorio por minuto
  if (
    code === 429 ||
    status === 429 ||
    status === 'RESOURCE_EXHAUSTED' ||
    message.includes('rate limit') ||
    message.includes('resource_exhausted') ||
    message.includes('too many requests') ||
    message.includes('quota exceeded')
  ) {
    return 'TRANSIENT_RATE_LIMIT';
  }

  // 3. Fallos de red, timeouts o 5xx
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

/**
 * Cliente LLM genérico para APIs compatibles con el estándar Chat Completions
 * (OpenAI, Groq, OpenRouter, DeepSeek, Together, vLLM, Ollama, etc.).
 *
 * El proveedor y el modelo NO están hardcodeados: se resuelven desde
 * LLM_BASE_URL, LLM_MODEL y LLM_API_KEY.
 */
export class LlmClient {
  public readonly modelName: string;
  public readonly baseUrl: string;
  public readonly defaultTimeoutMs = 20000; // 20s (menor al lease del inbound)

  constructor() {
    this.modelName = env.LLM_MODEL;
    this.baseUrl = env.LLM_BASE_URL.replace(/\/+$/, '');
  }

  /**
   * Convierte el contrato interno (mensajes con parts) al formato Chat Completions.
   * Los ids de tool_calls se generan de forma determinista y se emparejan por nombre
   * con los functionResponse posteriores.
   */
  private buildMessages(systemInstruction: string, contents: LlmContentMessage[]): OpenAiMessage[] {
    const messages: OpenAiMessage[] = [{ role: 'system', content: systemInstruction }];
    const pendingCallIds = new Map<string, string[]>();
    let callSeq = 0;

    for (const message of contents) {
      const texts = message.parts
        .map((part) => part.text)
        .filter((text): text is string => typeof text === 'string' && text.length > 0);
      const calls = message.parts
        .map((part) => part.functionCall)
        .filter((call): call is FunctionCallPart => Boolean(call));
      const responses = message.parts
        .map((part) => part.functionResponse)
        .filter((response): response is NonNullable<typeof response> => Boolean(response));

      if (message.role === 'assistant') {
        if (calls.length > 0) {
          const toolCalls: OpenAiToolCall[] = calls.map((call) => {
            const id = `call_${++callSeq}`;
            const queue = pendingCallIds.get(call.name) ?? [];
            queue.push(id);
            pendingCallIds.set(call.name, queue);
            return {
              id,
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args ?? {}),
              },
            };
          });
          messages.push({
            role: 'assistant',
            content: texts.length > 0 ? texts.join('\n') : null,
            tool_calls: toolCalls,
          });
        } else if (texts.length > 0) {
          messages.push({ role: 'assistant', content: texts.join('\n') });
        }
        continue;
      }

      if (texts.length > 0) {
        messages.push({ role: 'user', content: texts.join('\n') });
      }

      for (const response of responses) {
        const queue = pendingCallIds.get(response.name);
        const toolCallId = queue && queue.length > 0 ? queue.shift()! : `call_${++callSeq}`;
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify(response.response ?? {}),
        });
      }
    }

    return messages;
  }

  private static parseToolArguments(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }
    return {};
  }

  private static extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (part && typeof part === 'object' ? (part as { text?: string }).text : undefined))
        .filter((text): text is string => Boolean(text))
        .join('\n');
    }
    return '';
  }

  /**
   * Ejecuta un turno de inferencia contra el proveedor configurado.
   * Aplica micro-mensajes (max_tokens 180, temperature 0.2), timeout duro por
   * AbortSignal, rate limiter dual RPM/TPM y reconciliación de tokens.
   */
  public async generateTurn(
    systemInstruction: string,
    contents: LlmContentMessage[],
    timeoutMs: number = this.defaultTimeoutMs,
    parentSignal?: AbortSignal
  ): Promise<LlmCompletionResult> {
    const startTime = Date.now();
    const abortController = new AbortController();
    let timedOut = false;

    const abortError = (message: string): Error => {
      const err = new Error(message);
      err.name = 'AbortError';
      return err;
    };

    if (parentSignal) {
      if (parentSignal.aborted) {
        throw abortError('LLM turn aborted before call (service shutdown)');
      }
      parentSignal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);
    timer.unref?.();

    const maxOutputTokens = 180;
    const promptCharCount = systemInstruction.length + JSON.stringify(contents).length;
    const estimatedTokens = Math.ceil(promptCharCount / 4) + maxOutputTokens;

    await llmRateLimiter.acquireToken(estimatedTokens, abortController.signal);

    const payload = {
      model: this.modelName,
      messages: this.buildMessages(systemInstruction, contents),
      tools: OFFICIAL_TOOLS,
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: maxOutputTokens,
    };

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.LLM_API_KEY}`,
        },
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        const apiError = new Error(
          `LLM API ${response.status} ${response.statusText}: ${bodyText.slice(0, 600)}`
        ) as Error & {
          status?: number;
          code?: number;
          body?: string;
          retryAfterSeconds?: number;
        };
        apiError.name = 'LlmApiError';
        apiError.status = response.status;
        apiError.code = response.status;
        apiError.body = bodyText;

        const retryAfter = Number(response.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          apiError.retryAfterSeconds = retryAfter;
        }
        throw apiError;
      }

      const data = (await response.json()) as any;
      const choice = data?.choices?.[0];
      const message = choice?.message ?? {};
      const text = LlmClient.extractText(message.content);

      const rawToolCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const functionCalls: FunctionCallPart[] = rawToolCalls
        .filter((tc) => typeof tc?.function?.name === 'string' && tc.function.name.length > 0)
        .map((tc) => ({
          name: tc.function.name as string,
          args: LlmClient.parseToolArguments(tc.function.arguments),
        }));

      const usage = data?.usage ?? {};
      const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
      const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
      const actualTokens = promptTokens + completionTokens;

      llmRateLimiter.reconcile(estimatedTokens, actualTokens);

      const latencyMs = Date.now() - startTime;
      const finishReason = choice?.finish_reason;

      logger.info(
        {
          model: this.modelName,
          providerHost: new URL(this.baseUrl).host,
          latencyMs,
          promptTokens,
          completionTokens,
          actualTokens,
          finishReason,
          hasFunctionCalls: functionCalls.length > 0,
        },
        '🤖 Inferencia LLM completada'
      );

      return {
        text,
        functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
        promptTokens,
        completionTokens,
        latencyMs,
        finishReason,
      };
    } catch (error: any) {
      // Si la llamada falló antes de obtener respuesta, reembolsar los tokens reservados
      llmRateLimiter.reconcile(estimatedTokens, 0);

      const latencyMs = Date.now() - startTime;

      if (parentSignal?.aborted && !timedOut) {
        const abort = abortError('LLM turn aborted (service shutdown)');
        logger.warn({ latencyMs }, '⏹️ Inferencia LLM cancelada por apagado del servidor');
        throw abort;
      }

      if (timedOut) {
        const timeoutErr = new Error(`LLM API Request Timeout (${timeoutMs}ms)`);
        timeoutErr.name = 'TimeoutError';
        logger.error({ error: timeoutErr, latencyMs }, '❌ Timeout durante la llamada al proveedor LLM');
        throw timeoutErr;
      }

      logger.error({ error, latencyMs }, '❌ Error durante la llamada al proveedor LLM');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const llmClient = new LlmClient();
