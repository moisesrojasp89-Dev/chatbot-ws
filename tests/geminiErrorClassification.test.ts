import { describe, it, expect } from 'vitest';
import { ApiError } from '@google/genai';
import {
  classifyLlmError,
  extractLlmRetryDelaySeconds,
} from '../src/providers/llm/geminiClient.js';

describe('B2: Clasificación de Errores de Gemini API & Cuotas (@google/genai ApiError)', () => {
  it('Fixture 1: 429 real por minuto (Rate limit estándar) capturado de Google Cloud RPC debe ser TRANSIENT_RATE_LIMIT con retryDelay', () => {
    const real429WirePayload = JSON.stringify({
      error: {
        code: 429,
        message: 'Resource has been exhausted (e.g. check quota).',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RATE_LIMIT_EXCEEDED',
            domain: 'googleapis.com',
            metadata: {
              consumer: 'projects/103984729104',
              quota_limit: 'GenerateContentRequestsPerMinutePerProjectPerRegion',
              quota_limit_value: '15',
              service: 'generativelanguage.googleapis.com',
            },
          },
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
              {
                subject: 'project:103984729104',
                description:
                  "Quota exceeded for quota metric 'Generate Content API requests per minute' and limit 'GenerateContentRequestsPerMinutePerProjectPerRegion' of service 'generativelanguage.googleapis.com' for consumer 'project_number:103984729104'.",
                quotaId: 'GenerateContentRequestsPerMinutePerProjectPerRegion',
              },
            ],
          },
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '24s',
          },
        ],
      },
    });

    const error429Rpm = new ApiError({
      status: 429,
      message: real429WirePayload,
    });

    const type = classifyLlmError(error429Rpm);
    expect(type).toBe('TRANSIENT_RATE_LIMIT');

    const retryDelay = extractLlmRetryDelaySeconds(error429Rpm);
    expect(retryDelay).toBe(24);
  });

  it('Fixture 2: 429 cuota diaria agotada (PerDay) capturado de Google Cloud RPC debe ser DAILY_QUOTA_EXHAUSTED', () => {
    const real429DailyPayload = JSON.stringify({
      error: {
        code: 429,
        message: 'You exceeded your current quota, please check your plan and billing details.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RATE_LIMIT_EXCEEDED',
            domain: 'googleapis.com',
            metadata: {
              consumer: 'projects/103984729104',
              quota_limit: 'GenerateContentRequestsPerDayPerProject',
              quota_limit_value: '1500',
              service: 'generativelanguage.googleapis.com',
            },
          },
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
              {
                subject: 'project:103984729104',
                description:
                  "Quota exceeded for quota metric 'Generate Content API requests per day' and limit 'GenerateContentRequestsPerDayPerProject' of service 'generativelanguage.googleapis.com' for consumer 'project_number:103984729104'.",
                quotaId: 'GenerateContentRequestsPerDayPerProject',
              },
            ],
          },
        ],
      },
    });

    const errorDailyQuota = new ApiError({
      status: 429,
      message: real429DailyPayload,
    });

    const type = classifyLlmError(errorDailyQuota);
    expect(type).toBe('DAILY_QUOTA_EXHAUSTED');
  });

  it('Fixture 3: 400 real capturado de @google/genai con API_KEY_INVALID debe ser AUTH_OR_CONFIG_ERROR', () => {
    const real400KeyPayload = JSON.stringify({
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'API_KEY_INVALID',
            domain: 'googleapis.com',
            metadata: { service: 'generativelanguage.googleapis.com' },
          },
          {
            '@type': 'type.googleapis.com/google.rpc.LocalizedMessage',
            locale: 'en-US',
            message: 'API key not valid. Please pass a valid API key.',
          },
        ],
      },
    });

    const errorInvalidKey = new ApiError({
      status: 400,
      message: real400KeyPayload,
    });

    const type = classifyLlmError(errorInvalidKey);
    expect(type).toBe('AUTH_OR_CONFIG_ERROR');
  });

  it('Fixture 4: 404 modelo inexistente capturado de Google Cloud RPC debe ser AUTH_OR_CONFIG_ERROR', () => {
    const real404Payload = JSON.stringify({
      error: {
        code: 404,
        message:
          'models/gemini-invalid-model is not found for API version v1beta, or is not supported for generateContent.',
        status: 'NOT_FOUND',
      },
    });

    const errorModelNotFound = new ApiError({
      status: 404,
      message: real404Payload,
    });

    const type = classifyLlmError(errorModelNotFound);
    expect(type).toBe('AUTH_OR_CONFIG_ERROR');
  });

  it('Fixture 5: 503 service unavailable / overloaded capturado de Google Cloud RPC debe ser NETWORK_OR_TIMEOUT', () => {
    const real503Payload = JSON.stringify({
      error: {
        code: 503,
        message: 'The model is overloaded. Please try again later.',
        status: 'UNAVAILABLE',
      },
    });

    const errorOverloaded = new ApiError({
      status: 503,
      message: real503Payload,
    });

    const type = classifyLlmError(errorOverloaded);
    expect(type).toBe('NETWORK_OR_TIMEOUT');
  });
});
