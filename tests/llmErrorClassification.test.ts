import { describe, it, expect } from 'vitest';
import {
  classifyLlmError,
  extractLlmRetryDelaySeconds,
} from '../src/providers/llm/llmClient.js';

/**
 * Construye un error equivalente al que produce el cliente HTTP genérico:
 * status numérico, mensaje con el body JSON del proveedor y, opcionalmente,
 * Retry-After.
 */
function apiError(status: number, body: unknown, retryAfterSeconds?: number): Error {
  const err = new Error(`LLM API ${status}: ${JSON.stringify(body)}`) as Error & {
    status?: number;
    code?: number;
    retryAfterSeconds?: number;
  };
  err.name = 'LlmApiError';
  err.status = status;
  err.code = status;
  if (retryAfterSeconds !== undefined) err.retryAfterSeconds = retryAfterSeconds;
  return err;
}

describe('B2: Clasificación de Errores del Proveedor LLM (API compatible OpenAI)', () => {
  it('Fixture 1: 429 por minuto con Retry-After debe ser TRANSIENT_RATE_LIMIT con retardo', () => {
    const err = apiError(
      429,
      {
        error: {
          message: 'Rate limit reached for requests per minute. Please try again in 24s.',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
        },
      },
      24
    );

    expect(classifyLlmError(err)).toBe('TRANSIENT_RATE_LIMIT');
    expect(extractLlmRetryDelaySeconds(err)).toBe(24);
  });

  it('Fixture 2: cuota diaria / facturación agotada debe ser DAILY_QUOTA_EXHAUSTED', () => {
    const err = apiError(429, {
      error: {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    });

    expect(classifyLlmError(err)).toBe('DAILY_QUOTA_EXHAUSTED');
  });

  it('Fixture 3: 401 por credencial inválida debe ser AUTH_OR_CONFIG_ERROR', () => {
    const err = apiError(401, {
      error: {
        message: 'Incorrect API key provided. You can find your API key at the dashboard.',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    });

    expect(classifyLlmError(err)).toBe('AUTH_OR_CONFIG_ERROR');
  });

  it('Fixture 4: 404 por modelo inexistente debe ser AUTH_OR_CONFIG_ERROR', () => {
    const err = apiError(404, {
      error: {
        message: 'The model `does-not-exist` does not exist or you do not have access to it.',
        type: 'invalid_request_error',
        code: 'model_not_found',
      },
    });

    expect(classifyLlmError(err)).toBe('AUTH_OR_CONFIG_ERROR');
  });

  it('Fixture 5: 503 / overloaded debe ser NETWORK_OR_TIMEOUT', () => {
    const err = apiError(503, {
      error: {
        message: 'The server is currently overloaded. Please try again later.',
        type: 'server_error',
      },
    });

    expect(classifyLlmError(err)).toBe('NETWORK_OR_TIMEOUT');
  });

  it('Fixture 6: 400 de payload inválido debe ser FATAL_PAYLOAD_ERROR', () => {
    const err = apiError(400, {
      error: {
        message: 'Invalid value for temperature: must be <= 2.',
        type: 'invalid_request_error',
      },
    });

    expect(classifyLlmError(err)).toBe('FATAL_PAYLOAD_ERROR');
  });

  it('Fixture 7: timeouts y errores de red locales deben ser NETWORK_OR_TIMEOUT', () => {
    const timeout = new Error('LLM API Request Timeout (20000ms)');
    timeout.name = 'TimeoutError';
    expect(classifyLlmError(timeout)).toBe('NETWORK_OR_TIMEOUT');

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classifyLlmError(abort)).toBe('NETWORK_OR_TIMEOUT');
  });
});
