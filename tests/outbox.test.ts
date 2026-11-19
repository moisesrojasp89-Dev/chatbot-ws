import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../src/providers/database/dbClient.js';
import { outboxRepository } from '../src/repositories/outboxRepository.js';
import { outboxDispatcher, OutboxDispatcher } from '../src/services/outboxDispatcher.js';
import { messageRepository } from '../src/repositories/messageRepository.js';
import { whatsappClient } from '../src/providers/channels/meta/whatsappClient.js';
import { contactRepository } from '../src/repositories/contactRepository.js';
import { conversationRepository } from '../src/repositories/conversationRepository.js';

describe('Fase 4: Transactional Outbox Pattern & Dispatcher', { timeout: 30000 }, () => {
  const testPhone = '5511999990001';
  let contactId: string;
  let conversationId: string;

  beforeEach(async () => {
    outboxDispatcher.resume();
    try {
      await db.query(`DELETE FROM public.outbox_messages;`);
      await db.query(`DELETE FROM public.messages;`);
    } catch {}

    // Crear contacto y conversación de prueba en PostgreSQL
    const contact = await contactRepository.findOrCreate(testPhone, 'Outbox Test User');
    contactId = contact.id;
    const conversation = await conversationRepository.getOrCreateActiveSession(contactId);
    conversationId = conversation.id;
  });

  afterEach(async () => {
    outboxDispatcher.resume();
    // Limpieza de datos creados en la prueba
    try {
      await db.query(`DELETE FROM public.outbox_messages;`);
      await db.query(`DELETE FROM public.messages WHERE conversation_id = $1;`, [conversationId]);
      await db.query(`DELETE FROM public.conversations WHERE id = $1;`, [conversationId]);
      await db.query(`DELETE FROM public.contacts WHERE id = $1;`, [contactId]);
    } catch {
      // Ignorar errores de limpieza si las entidades ya fueron borradas en cascada
    }
  });

  describe('OutboxRepository', () => {
    it('debe encolar un mensaje en outbox_messages con estado PENDING y telemetría completa (F4-C4)', async () => {
      const record = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: 'phone_test_123',
        recipientPhone: testPhone,
        messageType: 'text',
        content: 'Hola, este es un mensaje de prueba para Outbox',
        promptTokens: 42,
        completionTokens: 18,
        latencyMs: 310,
      });

      expect(record).toBeDefined();
      expect(record.id).toBeDefined();
      expect(record.status).toBe('PENDING');
      expect(record.retry_count).toBe(0);
      expect(record.max_retries).toBe(3);
      expect(record.prompt_tokens).toBe(42);
      expect(record.completion_tokens).toBe(18);
      expect(record.latency_ms).toBe(310);
      expect(record.recipient_phone).toBe(testPhone);
    });

    it('debe reclamar lotes pendientes atómicamente con SKIP LOCKED y marcar PROCESSING', async () => {
      // Encolar 2 mensajes
      const msg1 = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: 'phone_test_123',
        recipientPhone: testPhone,
        content: 'Mensaje 1',
      });
      const msg2 = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: 'phone_test_123',
        recipientPhone: '5511999990009',
        content: 'Mensaje 2',
      });

      // Reclamar lote
      const batch = await outboxRepository.claimPendingBatch(5);
      const claimedIds = batch.map((m) => m.id);

      expect(claimedIds).toContain(msg1.id);
      expect(claimedIds).toContain(msg2.id);

      // Verificar que en base de datos su estado cambió a PROCESSING
      const check1 = await outboxRepository.findById(msg1.id);
      expect(check1?.status).toBe('PROCESSING');

      // Un segundo reclamo concurrente no debe devolver los mensajes ya en PROCESSING
      const secondBatch = await outboxRepository.claimPendingBatch(5);
      const secondIds = secondBatch.map((m) => m.id);
      expect(secondIds).not.toContain(msg1.id);
      expect(secondIds).not.toContain(msg2.id);
    });

    it('debe marcar como SENT y persistir el wamid oficial', async () => {
      const record = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: 'phone_test_123',
        recipientPhone: testPhone,
        content: 'Mensaje a enviar',
      });

      // B3: Debe estar en PROCESSING para poder marcarse como SENT
      const [claimed] = await outboxRepository.claimPendingBatch(1);
      const updated = await outboxRepository.markSent(record.id, 'wamid.HBgL_TEST_SENT_123', claimed.lock_token!);

      expect(updated).not.toBeNull();
      expect(updated?.status).toBe('SENT');
      expect(updated?.wamid).toBe('wamid.HBgL_TEST_SENT_123');
      expect(updated?.sent_at).toBeDefined();
      expect(updated?.last_error).toBeNull();
    });

    it('debe incrementar retry_count y aplicar backoff en markFailed manteniendo PENDING si < max_retries', async () => {
      const record = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: 'phone_test_123',
        recipientPhone: testPhone,
        content: 'Mensaje con fallo transitorio',
      });

      // B3: Reclamar a PROCESSING antes de fallar
      const [claimed] = await outboxRepository.claimPendingBatch(1);
      const failed = await outboxRepository.markFailed(record.id, claimed.lock_token!, '503 Service Unavailable', 2);

      expect(failed).not.toBeNull();
      expect(failed?.status).toBe('PENDING'); // Sigue en PENDING para reintento
      expect(failed?.retry_count).toBe(1);
      expect(failed?.last_error).toBe('503 Service Unavailable');
    });

    it('debe transicionar a FAILED cuando retry_count alcanza max_retries', async () => {
      const record = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: 'phone_test_123',
        recipientPhone: testPhone,
        content: 'Mensaje con fallo persistente',
      });

      // Intento 1: claim -> fail
      const [c1] = await outboxRepository.claimPendingBatch(1);
      await outboxRepository.markFailed(record.id, c1.lock_token!, 'Error 1', 0);

      // Intento 2: reset timer -> claim -> fail
      await db.query(`UPDATE public.outbox_messages SET next_retry_at = NOW() WHERE id = $1;`, [record.id]);
      const [c2] = await outboxRepository.claimPendingBatch(1);
      await outboxRepository.markFailed(record.id, c2.lock_token!, 'Error 2', 0);

      // Intento 3 definitivo: reset timer -> claim -> fail terminal
      await db.query(`UPDATE public.outbox_messages SET next_retry_at = NOW() WHERE id = $1;`, [record.id]);
      const [c3] = await outboxRepository.claimPendingBatch(1);
      const finalFailed = await outboxRepository.markFailed(record.id, c3.lock_token!, 'Error 3 definitivo', 0);

      expect(finalFailed?.status).toBe('FAILED');
      expect(finalFailed?.retry_count).toBe(3);
      expect(finalFailed?.last_error).toBe('Error 3 definitivo');
    });
  });

  describe('OutboxDispatcher Service', () => {
    it('debe procesar un mensaje pendiente, despacharlo a Meta y guardar en messages (F4-C2)', async () => {
      // Encolar mensaje en outbox
      const outboxMsg = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: 'phone_test_123',
        recipientPhone: testPhone,
        content: 'Respuesta procesada por IA para el cliente',
        promptTokens: 50,
        completionTokens: 25,
        latencyMs: 400,
      });

      // Ejecutar lote con el dispatcher
      const processedCount = await outboxDispatcher.processNextBatch();
      expect(processedCount).toBeGreaterThanOrEqual(1);

      // Verificar que outbox_messages se actualizó a SENT
      const updatedOutbox = await outboxRepository.findById(outboxMsg.id);
      expect(updatedOutbox?.status).toBe('SENT');
      expect(updatedOutbox?.wamid).toBeDefined();

      // Verificar que el mensaje saliente se persistió en public.messages con delivery_status = 'sent'
      const wamid = updatedOutbox!.wamid!;
      const savedMessage = await messageRepository.findByWamid(wamid);
      expect(savedMessage).not.toBeNull();
      expect(savedMessage?.direction).toBe('OUTBOUND');
      expect(savedMessage?.content).toBe('Respuesta procesada por IA para el cliente');
      expect(savedMessage?.delivery_status).toBe('sent');
      expect(savedMessage?.prompt_tokens).toBe(50);
      expect(savedMessage?.completion_tokens).toBe(25);
    });

    it('debe manejar fallos de red en el dispatcher y programar reintento con backoff exponencial', async () => {
      // Encolar mensaje
      const outboxMsg = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: 'phone_test_123',
        recipientPhone: testPhone,
        content: 'Mensaje que fallará por red',
      });

      // Espiar y simular fallo temporal en whatsappClient
      const sendSpy = vi.spyOn(whatsappClient, 'sendTextMessage').mockRejectedValueOnce(
        new Error('500 Internal Server Error from Meta')
      );

      const processedCount = await outboxDispatcher.processNextBatch();
      expect(processedCount).toBe(0); // 0 despachos exitosos

      // Verificar que se incrementó el retry_count en outbox_messages
      const updatedOutbox = await outboxRepository.findById(outboxMsg.id);
      expect(updatedOutbox?.status).toBe('PENDING');
      expect(updatedOutbox?.retry_count).toBe(1);
      expect(updatedOutbox?.last_error).toContain('500 Internal Server Error');

      sendSpy.mockRestore();
    });

    it('debe respetar el arranque y parada limpia del daemon (start / stop)', () => {
      const customDispatcher = new OutboxDispatcher();
      expect(() => customDispatcher.start()).not.toThrow();
      // Segundo start debe advertir y no fallar
      expect(() => customDispatcher.start()).not.toThrow();
      expect(() => customDispatcher.stop()).not.toThrow();
    });

    it('Auditor 5A: Head-of-Line por Destinatario: como máximo 1 mensaje por destinatario por lote y concurrencia segura con dos claimers', async () => {
      const phoneA = '5511999990001';
      const phoneB = '5511999990002';

      // 1. Encolar 3 mensajes para Phone A y 2 para Phone B
      const msgA1 = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: 'phone_123',
        recipientPhone: phoneA,
        content: 'Msg A1 (cabeza A)',
      });
      const msgA2 = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: 'phone_123',
        recipientPhone: phoneA,
        content: 'Msg A2 (cola A)',
      });
      const msgA3 = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: 'phone_123',
        recipientPhone: phoneA,
        content: 'Msg A3 (cola A posterior)',
      });

      const msgB1 = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: 'phone_123',
        recipientPhone: phoneB,
        content: 'Msg B1 (cabeza B)',
      });
      const msgB2 = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: 'phone_123',
        recipientPhone: phoneB,
        content: 'Msg B2 (cola B)',
      });

      // 2. Claimer 1 reclama lote
      const batch1 = await outboxRepository.claimPendingBatch(10);
      // Debe reclamar EXACTAMENTE 2 mensajes: la cabeza de A y la cabeza de B
      expect(batch1.length).toBe(2);
      const claimedIds1 = batch1.map((m) => m.id);
      expect(claimedIds1).toContain(msgA1.id);
      expect(claimedIds1).toContain(msgB1.id);
      // Ningún mensaje posterior de A o B fue reclamado
      expect(claimedIds1).not.toContain(msgA2.id);
      expect(claimedIds1).not.toContain(msgA3.id);
      expect(claimedIds1).not.toContain(msgB2.id);

      // 3. Claimer 2 (concurrente) intenta reclamar mientras Claimer 1 tiene A1 y B1 en PROCESSING
      const batch2 = await outboxRepository.claimPendingBatch(10);
      // No debe reclamar NADA, porque A y B ya tienen un mensaje en PROCESSING
      expect(batch2.length).toBe(0);

      // 4. Claimer 1 completa A1 (marcado SENT)
      const tokenA1 = batch1.find((m) => m.id === msgA1.id)!.lock_token!;
      await outboxRepository.markSent(msgA1.id, 'wamid.A1_DONE', tokenA1);

      // 5. Ahora Claimer 2 intenta reclamar de nuevo
      const batch3 = await outboxRepository.claimPendingBatch(10);
      // Ahora sí: como A1 ya terminó, A2 se convierte en la nueva cabeza elegible de A
      expect(batch3.length).toBe(1);
      expect(batch3[0].id).toBe(msgA2.id);

      // 6. Si A2 falla y entra en backoff (PENDING pero next_retry_at en el futuro)
      const tokenA2 = batch3[0].lock_token!;
      await outboxRepository.markFailed(msgA2.id, tokenA2, 'Temporary network issue', 60);

      // 7. Claimer 1 intenta reclamar de nuevo:
      // ¿Puede A3 ser reclamado mientras A2 está en backoff?
      const batch4 = await outboxRepository.claimPendingBatch(10);
      // ¡NO! A3 está bloqueado porque A2 es más antiguo y sigue en PENDING
      expect(batch4.find((m) => m.id === msgA3.id)).toBeUndefined();

      // Limpieza de mensajes
      const tokenB1 = batch1.find((m) => m.id === msgB1.id)!.lock_token!;
      await outboxRepository.terminalFailed(msgB1.id, tokenB1, 'Cleanup');
      await db.query(`DELETE FROM public.outbox_messages WHERE id IN ($1, $2, $3, $4, $5);`, [
        msgA1.id, msgA2.id, msgA3.id, msgB1.id, msgB2.id,
      ]);
    });

    it('Auditor 5A: Concurrencia determinista de dos claimers con FOR UPDATE OF o SKIP LOCKED', async () => {
      // 1. Encolar mensajes para 4 destinatarios distintos
      const phones = ['5511999991111', '5511999992222', '5511999993333', '5511999994444'];
      const msgs = await Promise.all(
        phones.map((phone, idx) =>
          outboxRepository.enqueueMessage({
            conversationId,
            phoneNumberId: 'phone_123',
            recipientPhone: phone,
            content: `Test concurrente ${idx + 1}`,
          })
        )
      );

      const c1 = await db.getClient();
      const c2 = await db.getClient();

      try {
        await c1.query('BEGIN');
        // c1 reclama con limit 2 reteniendo el lock sin COMMIT
        const a = await outboxRepository.claimPendingBatch(2, c1);
        expect(a.length).toBe(2);

        // Claimer 2 intenta reclamar con limit 2 concurrentemente; debe responder de inmediato sin bloquearse (SKIP LOCKED)
        const b = await Promise.race([
          outboxRepository.claimPendingBatch(2, c2),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('bloqueado')), 2000)),
        ]);

        // Debe reclamar los 2 restantes y ser estrictamente disjunto
        expect(b.length).toBe(2);
        const setAll = new Set([...a, ...b].map((r) => r.id));
        expect(setAll.size).toBe(4);

        await c1.query('ROLLBACK');
      } finally {
        await c1.query('ROLLBACK').catch(() => {});
        c1.release();
        c2.release();
        await db.query(`DELETE FROM public.outbox_messages WHERE id = ANY($1::uuid[]);`, [msgs.map((m) => m.id)]);
      }
    });

    it('Auditor 5A: Secuencia estricta de cabeza por destinatario y aislamiento multi-tenant', async () => {
      const recipientPhone = '5511999998888';
      const phoneId1 = 'phone_tenant_1';
      const phoneId2 = 'phone_tenant_2';

      // 1. Encolar A y luego B para el mismo destinatario y mismo phone_number_id
      const msgA = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: phoneId1,
        recipientPhone,
        content: 'Mensaje A',
      });
      const msgB = await outboxRepository.enqueueMessage({
        conversationId,
        phoneNumberId: phoneId1,
        recipientPhone,
        content: 'Mensaje B',
      });

      try {
        // Paso 1: El claim devuelve solo A
        const claim1 = await outboxRepository.claimPendingBatch(10);
        const claim1Ids = claim1.map((m) => m.id);
        expect(claim1Ids).toContain(msgA.id);
        expect(claim1Ids).not.toContain(msgB.id);

        const lockTokenA = claim1.find((m) => m.id === msgA.id)!.lock_token!;

        // Paso 2: Un segundo claim devuelve vacío para este destinatario (A en vuelo / PROCESSING bloquea a B)
        const claim2 = await outboxRepository.claimPendingBatch(10);
        const claim2Ids = claim2.map((m) => m.id);
        expect(claim2Ids).not.toContain(msgB.id);

        // Paso 3: Tras release(A, delay > 0), el claim sigue devolviendo vacío (A en backoff bloquea a B)
        const released = await outboxRepository.release(msgA.id, lockTokenA, 60);
        expect(released).toBe(true);

        const claim3 = await outboxRepository.claimPendingBatch(10);
        const claim3Ids = claim3.map((m) => m.id);
        expect(claim3Ids).not.toContain(msgA.id); // A en backoff
        expect(claim3Ids).not.toContain(msgB.id); // B bloqueado por A en backoff

        // Para ejecutar markSent(A), simulamos que A cumple el backoff forzando su elegibilidad
        await db.query(`UPDATE public.outbox_messages SET next_retry_at = NOW() WHERE id = $1;`, [msgA.id]);
        const claimAEligible = await outboxRepository.claimPendingBatch(10);
        const claimAEligibleIds = claimAEligible.map((m) => m.id);
        expect(claimAEligibleIds).toContain(msgA.id);
        expect(claimAEligibleIds).not.toContain(msgB.id);
        const newLockTokenA = claimAEligible.find((m) => m.id === msgA.id)!.lock_token!;

        // Paso 4: Tras markSent(A), el claim devuelve B
        await outboxRepository.markSent(msgA.id, 'wamid_test_seq_A', newLockTokenA);
        const claim4 = await outboxRepository.claimPendingBatch(10);
        const claim4Ids = claim4.map((m) => m.id);
        expect(claim4Ids).toContain(msgB.id);

        // Caso multi-tenant: mismo destinatario, con dos phone_number_id distintos (no se bloquean entre sí)
        const msgTenant1 = await outboxRepository.enqueueMessage({
          conversationId,
          phoneNumberId: phoneId1,
          recipientPhone: '5511999997777',
          content: 'Mensaje Tenant 1',
        });
        const msgTenant2 = await outboxRepository.enqueueMessage({
          conversationId,
          phoneNumberId: phoneId2,
          recipientPhone: '5511999997777', // Mismo destinatario, distinto phone_number_id
          content: 'Mensaje Tenant 2',
        });

        // Caso terminalFailed(C): un mensaje marcado FAILED no bloquea al siguiente mensaje D (simetría con markSent)
        const msgC = await outboxRepository.enqueueMessage({
          conversationId,
          phoneNumberId: phoneId1,
          recipientPhone: '5511999996666',
          content: 'Mensaje C',
        });
        const msgD = await outboxRepository.enqueueMessage({
          conversationId,
          phoneNumberId: phoneId1,
          recipientPhone: '5511999996666',
          content: 'Mensaje D',
        });

        const claimC = await outboxRepository.claimPendingBatch(10);
        expect(claimC.map((m) => m.id)).toContain(msgC.id);
        expect(claimC.map((m) => m.id)).not.toContain(msgD.id);
        const lockTokenC = claimC.find((m) => m.id === msgC.id)!.lock_token!;

        // Se marca C como terminalFailed
        await outboxRepository.terminalFailed(msgC.id, lockTokenC, 'Error fatal simétrico a markSent');
        // El siguiente claim debe devolver D sin quedarse bloqueado
        const claimD = await outboxRepository.claimPendingBatch(10);
        expect(claimD.map((m) => m.id)).toContain(msgD.id);

        // Limpieza de mensajes C y D
        await db.query(`DELETE FROM public.outbox_messages WHERE id IN ($1, $2);`, [msgC.id, msgD.id]);

        // Limpieza de mensajes multi-tenant
        await db.query(`DELETE FROM public.outbox_messages WHERE id IN ($1, $2);`, [
          msgTenant1.id,
          msgTenant2.id,
        ]);
      } finally {
        await db.query(`DELETE FROM public.outbox_messages WHERE id IN ($1, $2);`, [msgA.id, msgB.id]);
      }
    });
  });
});
