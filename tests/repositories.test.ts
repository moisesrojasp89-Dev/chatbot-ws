import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '../src/providers/database/dbClient.js';
import { contactRepository } from '../src/repositories/contactRepository.js';
import { conversationRepository } from '../src/repositories/conversationRepository.js';
import { messageRepository } from '../src/repositories/messageRepository.js';
import { leadRepository } from '../src/repositories/leadRepository.js';
import { handoffRepository } from '../src/repositories/handoffRepository.js';
import { auditRepository } from '../src/repositories/auditRepository.js';

describe('Fase 2: Repositorios y Gestión de Datos', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('ContactRepository', () => {
    it('findOrCreate debe usar COALESCE para no sobrescribir nombres existentes con null (F2-C4)', async () => {
      const mockContact = {
        id: '11111111-1111-1111-1111-111111111111',
        phone_number: '573001234567',
        profile_name: 'Carlos R',
        status: 'BOT_ACTIVE',
      };

      const querySpy = vi.spyOn(db, 'query').mockResolvedValueOnce({
        rows: [mockContact],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      });

      const contact = await contactRepository.findOrCreate('573001234567', 'Carlos R');

      expect(querySpy).toHaveBeenCalled();
      const sqlCalled = querySpy.mock.calls[0][0];
      expect(sqlCalled).toContain('COALESCE(EXCLUDED.profile_name, contacts.profile_name)');
      expect(contact.phone_number).toBe('573001234567');
      expect(contact.profile_name).toBe('Carlos R');
    });
  });

  describe('ConversationRepository', () => {
    it('getOrCreateActiveSession debe cerrar primero las sesiones expiradas por inactividad >30m (F2-C2)', async () => {
      const contactId = '11111111-1111-1111-1111-111111111111';
      const mockActiveConv = {
        id: '22222222-2222-2222-2222-222222222222',
        contact_id: contactId,
        current_state: 'QUALIFYING',
      };

      const querySpy = vi
        .spyOn(db, 'query')
        // 1. UPDATE para cerrar expiradas
        .mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] })
        // 2. SELECT para buscar activa
        .mockResolvedValueOnce({ rows: [mockActiveConv], rowCount: 1, command: 'SELECT', oid: 0, fields: [] });

      const session = await conversationRepository.getOrCreateActiveSession(contactId);

      expect(querySpy).toHaveBeenCalledTimes(2);
      // Primer query debe cerrar sesiones expiradas
      const closeSql = querySpy.mock.calls[0][0];
      expect(closeSql).toContain("current_state = 'CLOSED'");
      expect(closeSql).toContain("INTERVAL '30 minutes'");

      // Segundo query busca la activa
      expect(session.id).toBe(mockActiveConv.id);
      expect(session.current_state).toBe('QUALIFYING');
    });

    it('transitionState debe actualizar el estado FSM atómicamente', async () => {
      const convId = '22222222-2222-2222-2222-222222222222';
      const querySpy = vi.spyOn(db, 'query').mockResolvedValueOnce({
        rows: [{ id: convId, current_state: 'CATALOG_QUERY' }],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      });

      const updated = await conversationRepository.transitionState(convId, 'CATALOG_QUERY', 'Interés en producto X');
      expect(querySpy).toHaveBeenCalled();
      expect(updated?.current_state).toBe('CATALOG_QUERY');
    });
  });

  describe('MessageRepository (F2-C5: Patrón A sin doble INSERT)', () => {
    it('updateProcessedMessage debe actualizar contenido y métricas del mensaje wamid', async () => {
      const wamid = 'wamid.HBgLTEST123==';
      const querySpy = vi.spyOn(db, 'query').mockResolvedValueOnce({
        rows: [{ id: 'msg-uuid-1', wamid, content: 'Hola, deseo cotizar', prompt_tokens: 150 }],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      });

      const result = await messageRepository.updateProcessedMessage(wamid, {
        content: 'Hola, deseo cotizar',
        promptTokens: 150,
      });

      expect(querySpy).toHaveBeenCalled();
      const sql = querySpy.mock.calls[0][0];
      expect(sql).toContain('UPDATE public.messages');
      expect(result?.content).toBe('Hola, deseo cotizar');
    });

    it('getSlidingContextWindow debe solicitar los últimos 6 mensajes en orden cronológico', async () => {
      const convId = '22222222-2222-2222-2222-222222222222';
      const mockMessages = [
        { id: '1', content: 'Mensaje 1', created_at: new Date() },
        { id: '2', content: 'Mensaje 2', created_at: new Date() },
      ];

      const querySpy = vi.spyOn(db, 'query').mockResolvedValueOnce({
        rows: mockMessages,
        rowCount: 2,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const window = await messageRepository.getSlidingContextWindow(convId, 6);
      expect(querySpy).toHaveBeenCalled();
      const sql = querySpy.mock.calls[0][0];
      expect(sql).toContain('ORDER BY created_at ASC');
      expect(sql).toContain('LIMIT $2');
      expect(window.length).toBe(2);
    });
  });

  describe('LeadRepository (C1: Trazabilidad con conversation_id)', () => {
    it('createLead debe vincular contact_id y conversation_id', async () => {
      const contactId = '11111111-1111-1111-1111-111111111111';
      const convId = '22222222-2222-2222-2222-222222222222';

      const querySpy = vi.spyOn(db, 'query').mockResolvedValueOnce({
        rows: [{ id: 'lead-1', contact_id: contactId, conversation_id: convId, product_interest: 'Plan Pro' }],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      });

      const lead = await leadRepository.createLead({
        contactId,
        conversationId: convId,
        productInterest: 'Plan Pro',
        estimatedBudget: 500,
        qualificationStage: 'HOT',
      });

      expect(querySpy).toHaveBeenCalled();
      expect(lead.conversation_id).toBe(convId);
      expect(lead.product_interest).toBe('Plan Pro');
    });
  });

  describe('HandoffRepository (C6: Detección de Timeout)', () => {
    it('getPendingHandoffsOlderThan debe consultar sesiones PENDING que superen el intervalo', async () => {
      const querySpy = vi.spyOn(db, 'query').mockResolvedValueOnce({
        rows: [{ id: 'handoff-1', status: 'PENDING', trigger_reason: 'USER_REQUEST' }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const pending = await handoffRepository.getPendingHandoffsOlderThan(15);
      expect(querySpy).toHaveBeenCalled();
      const sql = querySpy.mock.calls[0][0];
      expect(sql).toContain("status = 'PENDING'");
      expect(sql).toContain("INTERVAL");
      expect(pending.length).toBe(1);
    });
  });

  describe('AuditRepository (M1: Registro Append-Only)', () => {
    it('logEvent debe insertar evento en audit_log', async () => {
      const querySpy = vi.spyOn(db, 'query').mockResolvedValueOnce({
        rows: [{ id: 'audit-1', event_type: 'TOOL_CALL', actor: 'BOT' }],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      });

      const record = await auditRepository.logEvent('conv-1', 'TOOL_CALL', 'BOT', { tool: 'searchCatalog' });
      expect(querySpy).toHaveBeenCalled();
      expect(record.event_type).toBe('TOOL_CALL');
    });
  });
});
