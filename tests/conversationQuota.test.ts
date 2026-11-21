import { describe, expect, it } from 'vitest';
import { evaluateConversationQuota } from '../src/services/conversationQuota.js';

const limits = { maxTurns: 40, maxTokens: 60000 };

describe('Cuota de conversación', () => {
  it('permite una conversación dentro de los límites', () => {
    const decision = evaluateConversationQuota({ messages: 10, tokens: 5000 }, limits);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it('permite el borde 39 y corta en 40 turnos', () => {
    expect(evaluateConversationQuota({ messages: 39, tokens: 1000 }, limits).allowed).toBe(true);
    const decision = evaluateConversationQuota({ messages: 40, tokens: 1000 }, limits);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('TURNS');
  });

  it('corta por tokens acumulados', () => {
    const decision = evaluateConversationQuota({ messages: 5, tokens: 60000 }, limits);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('TOKENS');
  });
});
