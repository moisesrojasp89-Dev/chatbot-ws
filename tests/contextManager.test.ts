import { describe, it, expect, vi } from 'vitest';
import { contextManager } from '../src/harness/contextManager.js';
import { ContactRecord, ConversationRecord, MessageRecord } from '../src/types/states.js';
import { conversationRepository } from '../src/repositories/conversationRepository.js';

describe('Fase 3 — Context Manager & Sliding Window (Harness)', () => {
  const mockContact: ContactRecord = {
    id: '11111111-1111-1111-1111-111111111111',
    phone_number: '573001234567',
    profile_name: 'Santiago Ramirez',
    status: 'BOT_ACTIVE',
    opted_out: false,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  };

  const mockConversation: ConversationRecord = {
    id: '22222222-2222-2222-2222-222222222222',
    contact_id: mockContact.id,
    current_state: 'QUALIFYING',
    context_summary: 'Cliente interesado en automatizar su canal de ventas.',
    total_messages_count: 4,
    last_interaction_at: new Date(),
    closed_at: null,
  };

  it('debe estructurar el System Prompt con delimitadores XML (<role>, <rules>, <context>)', () => {
    const prompt = contextManager.buildSystemInstruction(mockContact, mockConversation);

    expect(prompt).toContain('<role>');
    expect(prompt).toContain('</role>');
    expect(prompt).toContain('<rules>');
    expect(prompt).toContain('</rules>');
    expect(prompt).toContain('<context>');
    expect(prompt).toContain('</context>');
    expect(prompt).toContain('Santiago Ramirez');
    expect(prompt).toContain('QUALIFYING');
    expect(prompt).toContain('Cliente interesado en automatizar su canal de ventas.');
  });

  describe('Regla #7: Anti-Alucinación de Identidad del Cliente', () => {
    it('debe inyectar "desconocido" si el contacto no tiene profile_name', () => {
      const anonymousContact: ContactRecord = {
        ...mockContact,
        profile_name: null,
      };

      const prompt = contextManager.buildSystemInstruction(anonymousContact, mockConversation);
      expect(prompt).toContain('Nombre Registrado del Cliente: desconocido');
      expect(prompt).not.toContain('573001234567'); // Prohibido usar el teléfono como nombre
    });

    it('debe inyectar "desconocido" si profile_name es "Cliente" genérico', () => {
      const genericContact: ContactRecord = {
        ...mockContact,
        profile_name: 'Cliente',
      };

      const prompt = contextManager.buildSystemInstruction(genericContact, mockConversation);
      expect(prompt).toContain('Nombre Registrado del Cliente: desconocido');
    });

    it('debe conservar el nombre real cuando es legítimo', () => {
      const validContact: ContactRecord = {
        ...mockContact,
        profile_name: 'Valentina Restrepo',
      };

      const prompt = contextManager.buildSystemInstruction(validContact, mockConversation);
      expect(prompt).toContain('Nombre Registrado del Cliente: Valentina Restrepo');
    });
  });

  describe('F3-C4: Ventana Deslizante (6 Mensajes) y Auto-Summarization', () => {
    it('debe mantener todos los mensajes en la ventana activa si son <= 6', async () => {
      const shortHistory: MessageRecord[] = [
        {
          id: 'm1',
          wamid: 'w1',
          conversation_id: mockConversation.id,
          direction: 'INBOUND',
          message_type: 'text',
          content: 'Hola',
          raw_payload: {},
          prompt_tokens: 0,
          completion_tokens: 0,
          latency_ms: 0,
          created_at: new Date(Date.now() - 5000),
        },
        {
          id: 'm2',
          wamid: 'w2',
          conversation_id: mockConversation.id,
          direction: 'OUTBOUND',
          message_type: 'text',
          content: '¡Hola! ¿Cómo estás?',
          raw_payload: {},
          prompt_tokens: 0,
          completion_tokens: 0,
          latency_ms: 0,
          created_at: new Date(Date.now() - 4000),
        },
      ];

      const result = await contextManager.prepareContext(
        mockContact,
        mockConversation,
        shortHistory,
        'Deseo saber de sus planes'
      );

      expect(result.summaryUpdated).toBe(false);
      // 2 del historial + 1 nuevo entrante
      expect(result.contents.length).toBe(3);
    });

    it('debe comprimir y actualizar context_summary cuando el historial supera los 6 turnos (F3-C4)', async () => {
      const spyUpdateSummary = vi
        .spyOn(conversationRepository, 'updateContextSummary')
        .mockResolvedValueOnce();

      // Generar 8 mensajes en el historial
      const longHistory: MessageRecord[] = Array.from({ length: 8 }, (_, i) => ({
        id: `msg-${i}`,
        wamid: `wamid-${i}`,
        conversation_id: mockConversation.id,
        direction: i % 2 === 0 ? ('INBOUND' as const) : ('OUTBOUND' as const),
        message_type: 'text',
        content: `Mensaje de prueba número ${i + 1}`,
        raw_payload: {},
        prompt_tokens: 0,
        completion_tokens: 0,
        latency_ms: 0,
        created_at: new Date(Date.now() - (10 - i) * 1000),
      }));

      const result = await contextManager.prepareContext(
        mockContact,
        mockConversation,
        longHistory,
        '¿Cuál es el siguiente paso?'
      );

      expect(result.summaryUpdated).toBe(true);
      expect(spyUpdateSummary).toHaveBeenCalledTimes(1);

      // La ventana activa debe contener exactamente los últimos 6 del historial + el mensaje entrante
      expect(result.contents.length).toBe(7);

      spyUpdateSummary.mockRestore();
    });
  });
});
