import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { buildApp, setShuttingDown } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/providers/database/dbClient.js';
import { inboundRepository } from '../src/repositories/inboundRepository.js';
import { inboundDispatcher } from '../src/services/inboundDispatcher.js';
import { outboxRepository } from '../src/repositories/outboxRepository.js';
import { contactRepository } from '../src/repositories/contactRepository.js';
import { conversationRepository } from '../src/repositories/conversationRepository.js';
import { agentEngine } from '../src/harness/agentEngine.js';

describe('Fase 5B: Inbound Durable (I18) & Pipeline de Concurrencia', { timeout: 30000 }, () => {
  let app: FastifyInstance;

  function generateValidSignature(payloadString: string): string {
    const hash = crypto
      .createHmac('sha256', env.META_APP_SECRET)
      .update(payloadString)
      .digest('hex');
    return `sha256=${hash}`;
  }

  beforeEach(async () => {
    setShuttingDown(false);
    inboundDispatcher.resume();
    app = await buildApp();

    try {
      await db.query(`DELETE FROM public.inbound_events;`);
      await db.query(`DELETE FROM public.outbox_messages;`);
      await db.query(`DELETE FROM public.messages;`);
      await db.query(`DELETE FROM public.handoff_sessions;`);
      await db.query(`DELETE FROM public.leads;`);
      await db.query(`DELETE FROM public.conversations;`);
      await db.query(`DELETE FROM public.contacts;`);
    } catch {}
  });

  afterEach(async () => {
    setShuttingDown(false);
    inboundDispatcher.resume();
    vi.restoreAllMocks();
    try {
      await db.query(`DELETE FROM public.inbound_events;`);
      await db.query(`DELETE FROM public.outbox_messages;`);
      await db.query(`DELETE FROM public.messages;`);
      await db.query(`DELETE FROM public.handoff_sessions;`);
      await db.query(`DELETE FROM public.leads;`);
      await db.query(`DELETE FROM public.conversations;`);
      await db.query(`DELETE FROM public.contacts;`);
    } catch {}
  });

  describe('Criterio 1 (I18 / T5): El ACK persiste antes de responder', () => {
    const mockPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '123456789',
                  phone_number_id: 'PHONE_TEST_5B',
                },
                contacts: [{ profile: { name: 'Maria Lopez' }, wa_id: '5511988881111' }],
                messages: [
                  {
                    from: '5511988881111',
                    id: 'wamid.HBgL_INBOUND_5B_TEST_1==',
                    timestamp: '1789920000',
                    type: 'text',
                    text: { body: 'Hola, deseo cotizar el servicio' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    it('T5: debe persistir en inbound_events antes de emitir 200 OK y NO llamar al LLM en el ACK', async () => {
      const spyLLM = vi.spyOn(agentEngine, 'processMessage');
      const payloadStr = JSON.stringify(mockPayload);
      const signature = generateValidSignature(payloadStr);

      const res = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
        },
        payload: payloadStr,
      });

      // 1. Acuse de recibo inmediato
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'ok' });

      // 2. Comprobar que el mensaje fue persistido duraderamente en PostgreSQL
      const wamid = 'wamid.HBgL_INBOUND_5B_TEST_1==';
      const eventRes = await db.query(`SELECT * FROM public.inbound_events WHERE wamid = $1;`, [wamid]);
      expect(eventRes.rows.length).toBe(1);
      expect(['PENDING', 'PROCESSING']).toContain(eventRes.rows[0].status);
      expect(eventRes.rows[0].sender_phone).toBe('5511988881111');
      expect(eventRes.rows[0].phone_number_id).toBe('PHONE_TEST_5B');

      // 3. Comprobar que el camino del ACK HTTP NO llamó al LLM
      expect(spyLLM).not.toHaveBeenCalled();
    });

    it('T5: debe responder 500 si falla la persistencia en DB (forzando a Meta a reintentar)', async () => {
      vi.spyOn(inboundRepository, 'persistInboundEvent').mockRejectedValueOnce(
        new Error('DB connection timeout')
      );

      const payloadStr = JSON.stringify(mockPayload);
      const signature = generateValidSignature(payloadStr);

      const res = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
        },
        payload: payloadStr,
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'Database persistence error' });
    });

    it('T5: un wamid repetido debe responder 200 OK sin duplicar la fila en DB (ON CONFLICT DO NOTHING)', async () => {
      const payloadStr = JSON.stringify(mockPayload);
      const signature = generateValidSignature(payloadStr);

      // Primer envío
      const res1 = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
        payload: payloadStr,
      });
      expect(res1.statusCode).toBe(200);

      // Segundo envío con el mismo payload / wamid
      const res2 = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
        payload: payloadStr,
      });
      expect(res2.statusCode).toBe(200);

      // Sigue existiendo exactamente 1 fila en DB
      const wamid = 'wamid.HBgL_INBOUND_5B_TEST_1==';
      const eventRes = await db.query(`SELECT COUNT(*)::int as count FROM public.inbound_events WHERE wamid = $1;`, [wamid]);
      expect(eventRes.rows[0].count).toBe(1);
    });
  });

  describe('Criterio 2 (T3 / T4: Cabeza por remitente y concurrencia multi-worker)', () => {
    it('T3: debe permitir concurrencia determinista entre workers con FOR UPDATE OF i SKIP LOCKED', async () => {
      // Encolar 4 eventos para 4 usuarios distintos
      const phones = ['5511911110001', '5511911110002', '5511911110003', '5511911110004'];
      await Promise.all(
        phones.map((phone, idx) =>
          inboundRepository.persistInboundEvent({
            wamid: `wamid.CONCURRENT_${idx}_${Date.now()}`,
            phoneNumberId: 'PHONE_CONCURRENT',
            senderPhone: phone,
            payload: { text: `Mensaje ${idx + 1}` },
          })
        )
      );

      const c1 = await db.getClient();
      const c2 = await db.getClient();

      try {
        await c1.query('BEGIN');
        // c1 reclama 2 eventos reteniendo el bloqueo en transacción abierta
        const a = await inboundRepository.claimPendingBatch(2, c1);
        expect(a.length).toBe(2);

        // c2 reclama concurrentemente: debe responder inmediatamente saltando los bloqueados por c1
        const b = await Promise.race([
          inboundRepository.claimPendingBatch(2, c2),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('bloqueado')), 2000)),
        ]);

        expect(b.length).toBe(2);
        const allIds = new Set([...a, ...b].map((e) => e.id));
        expect(allIds.size).toBe(4); // Conjuntos estrictamente disjuntos

        await c1.query('ROLLBACK');
      } finally {
        await c1.query('ROLLBACK').catch(() => {});
        c1.release();
        c2.release();
      }
    });

    it('T4: Secuencia estricta de cabeza por remitente: A bloquea a B; release/retryFailed mantiene bloqueo; markDone(A) desbloquea a B; otro phone_number_id no se bloquea', async () => {
      const senderPhone = `55119999${Math.floor(10000 + Math.random() * 90000)}`;
      const phoneId = `PHONE_HEAD_${Date.now()}`;

      // Encolar A y luego B para el mismo usuario con separación temporal estricta
      const evA = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.SEQ_A_${Date.now()}`,
        phoneNumberId: phoneId,
        senderPhone,
        payload: { message: { text: { body: 'A' } } },
      }))!;
      await new Promise((r) => setTimeout(r, 20));
      const evB = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.SEQ_B_${Date.now()}`,
        phoneNumberId: phoneId,
        senderPhone,
        payload: { message: { text: { body: 'B' } } },
      }))!;

      // 1. Claim devuelve solo A
      const claim1 = await inboundRepository.claimPendingBatch(10);
      expect(claim1.map((e) => e.id)).toContain(evA.id);
      expect(claim1.map((e) => e.id)).not.toContain(evB.id);

      const lockTokenA = claim1.find((e) => e.id === evA.id)!.lock_token!;

      // 2. Segundo claim devuelve vacío para este usuario (A en PROCESSING bloquea a B)
      const claim2 = await inboundRepository.claimPendingBatch(10);
      expect(claim2.map((e) => e.id)).not.toContain(evB.id);

      // 3. Tras retryFailed(A, backoff > 0), el claim sigue bloqueando a B (A en backoff bloquea a B)
      await inboundRepository.retryFailed(evA.id, lockTokenA, 'Transient LLM error', 60);
      const claim3 = await inboundRepository.claimPendingBatch(10);
      expect(claim3.map((e) => e.id)).not.toContain(evA.id);
      expect(claim3.map((e) => e.id)).not.toContain(evB.id);

      // T4: Evento de OTRO phone_number_id para el mismo número no queda bloqueado por el backoff del primer phone_number_id
      const evOtherChannel = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.SEQ_OTHER_PHONEID_${Date.now()}`,
        phoneNumberId: 'PHONE_OTHER_CHANNEL',
        senderPhone,
        payload: { message: { text: { body: 'Mensaje de canal alternativo' } } },
      }))!;
      const claimOther = await inboundRepository.claimPendingBatch(10);
      expect(claimOther.map((e) => e.id)).toContain(evOtherChannel.id);

      // Simular que vence el backoff de A y reclamarlo
      await db.query(`UPDATE public.inbound_events SET next_retry_at = NOW() WHERE id = $1;`, [evA.id]);
      const claimAEligible = await inboundRepository.claimPendingBatch(10);
      const newLockTokenA = claimAEligible.find((e) => e.id === evA.id)!.lock_token!;

      // 4. Tras markDone(A), el siguiente claim devuelve B
      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        await inboundRepository.markDone(evA.id, newLockTokenA, client);
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const claim4 = await inboundRepository.claimPendingBatch(10);
      expect(claim4.map((e) => e.id)).toContain(evB.id);

      // 5. Simetría con terminalFailed: encolar C y D; C fallido desbloquea a D
      const senderPhoneCD = `55119998${Math.floor(10000 + Math.random() * 90000)}`;
      const evC = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.SEQ_C_${Date.now()}`,
        phoneNumberId: phoneId,
        senderPhone: senderPhoneCD,
        payload: { message: { text: { body: 'C' } } },
      }))!;
      await new Promise((r) => setTimeout(r, 20));
      const evD = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.SEQ_D_${Date.now()}`,
        phoneNumberId: phoneId,
        senderPhone: senderPhoneCD,
        payload: { message: { text: { body: 'D' } } },
      }))!;

      const claimC = await inboundRepository.claimPendingBatch(10);
      expect(claimC.map((e) => e.id)).toContain(evC.id);
      expect(claimC.map((e) => e.id)).not.toContain(evD.id);
      const lockTokenC = claimC.find((e) => e.id === evC.id)!.lock_token!;

      await inboundRepository.terminalFailed(evC.id, lockTokenC, 'Error fatal');
      const claimD = await inboundRepository.claimPendingBatch(10);
      expect(claimD.map((e) => e.id)).toContain(evD.id);
    });
  });

  describe('Criterio 3: Una sola transacción para el resultado y Fencing Token (T1 / T2)', () => {
    it('T1: Fencing Token: si el lease es robado durante la inferencia LLM, markDone falla y la transacción hace ROLLBACK completo', async () => {
      const senderPhone = `55119999${Math.floor(10000 + Math.random() * 90000)}`;
      const contact = await contactRepository.findOrCreate(senderPhone, 'Fence User');
      const conversation = await conversationRepository.getOrCreateActiveSession(contact.id);

      const ev = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.FENCE_TEST_${Date.now()}`,
        phoneNumberId: 'PHONE_FENCE',
        senderPhone,
        payload: { message: { text: { body: 'Mensaje con lease robado en vuelo' } } },
      }))!;

      const claimed = await inboundRepository.claimPendingBatch(10);
      const claimedEv = claimed.find((e) => e.id === ev.id)!;
      expect(claimedEv).toBeDefined();

      const stolenToken = crypto.randomUUID();

      // T1: Robar el lock_token DENTRO del mock de processMessage (después de extendLease, antes del commit)
      vi.spyOn(agentEngine, 'processMessage').mockImplementationOnce(async () => {
        await db.query(
          `UPDATE public.inbound_events SET lock_token = $1 WHERE id = $2;`,
          [stolenToken, claimedEv.id]
        );
        return {
          replyText: 'Respuesta que nunca debe ser confirmada',
          catalogToolExecuted: false,
          leadToolExecuted: false,
          handoffToolExecuted: false,
          promptTokens: 10,
          completionTokens: 20,
          totalLatencyMs: 100,
        };
      });

      // Ejecutar procesamiento con el lock_token original
      await inboundDispatcher.processSingleEvent(claimedEv);

      // Verificación de atomicidad total por ROLLBACK:
      // 1. NO hay mensajes en messages
      const msgRes = await db.query(
        `SELECT * FROM public.messages WHERE conversation_id = $1;`,
        [conversation.id]
      );
      expect(msgRes.rows.length).toBe(0);

      // 2. NO hay mensajes en outbox_messages
      const outboxRes = await db.query(
        `SELECT * FROM public.outbox_messages WHERE recipient_phone = $1;`,
        [senderPhone]
      );
      expect(outboxRes.rows.length).toBe(0);

      // 3. El evento en BD permanece con el token robado (no fue sobreescrito)
      const evCheck = await db.query(
        `SELECT status, lock_token FROM public.inbound_events WHERE id = $1;`,
        [ev.id]
      );
      expect(evCheck.rows[0].status).toBe('PROCESSING');
      expect(evCheck.rows[0].lock_token).toBe(stolenToken);
    });

    it('T2: Los efectos secundarios de tools (leads) se revierten completamente si la transacción falla', async () => {
      const senderPhone = `55119999${Math.floor(10000 + Math.random() * 90000)}`;
      const contact = await contactRepository.findOrCreate(senderPhone, 'Lead User');
      const conv = await conversationRepository.getOrCreateActiveSession(contact.id);
      const initialState = conv.current_state; // IDLE

      const ev = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.LEAD_ROLLBACK_${Date.now()}`,
        phoneNumberId: 'PHONE_LEAD',
        senderPhone,
        payload: { message: { text: { body: 'Quiero comprar el plan Pro' } } },
      }))!;

      const claimed = await inboundRepository.claimPendingBatch(10);
      const claimedEv = claimed.find((e) => e.id === ev.id)!;

      // Simular que el LLM solicitó crear un lead diferido
      vi.spyOn(agentEngine, 'processMessage').mockResolvedValueOnce({
        replyText: 'Excelente, he registrado tu solicitud para el Plan Pro.',
        catalogToolExecuted: false,
        leadToolExecuted: true,
        handoffToolExecuted: false,
        pendingLead: {
          contactId: contact.id,
          conversationId: conv.id,
          productInterest: 'Plan Pro',
          customerEmail: 'pro@test.com',
        },
        promptTokens: 50,
        completionTokens: 25,
        totalLatencyMs: 150,
      });

      // Forzar fallo entre la creación del lead y el commit (en enqueueMessage)
      vi.spyOn(outboxRepository, 'enqueueMessage').mockRejectedValueOnce(
        new Error('Fallo simulado forzado para verificar rollback de lead')
      );

      await inboundDispatcher.processSingleEvent(claimedEv);

      // T2: 1. Verificar que NO quedó ningún lead creado en public.leads
      const leadCheck = await db.query(
        `SELECT * FROM public.leads WHERE contact_id = $1 AND product_interest = 'Plan Pro';`,
        [contact.id]
      );
      expect(leadCheck.rows.length).toBe(0);

      // T2: 2. Verificar que la conversación permanece en su estado inicial (IDLE)
      const convCheck = await conversationRepository.findById(conv.id);
      expect(convCheck?.current_state).toBe(initialState);

      // T2: 3. Verificar que no hay fila en messages
      const msgCheck = await db.query(`SELECT * FROM public.messages WHERE conversation_id = $1;`, [conv.id]);
      expect(msgCheck.rows.length).toBe(0);

      // T2: 4. Verificar que no hay fila en outbox
      const outboxCheck = await db.query(`SELECT * FROM public.outbox_messages WHERE conversation_id = $1;`, [conv.id]);
      expect(outboxCheck.rows.length).toBe(0);

      // T2: 5. Verificar que el evento quedó PENDING y retry_count = 1
      const evCheck = await db.query(`SELECT status, retry_count, last_error FROM public.inbound_events WHERE id = $1;`, [ev.id]);
      expect(evCheck.rows[0].status).toBe('PENDING');
      expect(evCheck.rows[0].retry_count).toBe(1);
    });
  });

  describe('Criterio 4: Apagado y Readiness Probe (/ready) (B6 / I1)', () => {
    it('/ready debe responder 200 OK en operación normal, 503 si el worker está pausado y 503 en apagado', async () => {
      // 1. En operación normal
      const res1 = await app.inject({ method: 'GET', url: '/ready' });
      expect(res1.statusCode).toBe(200);
      expect(JSON.parse(res1.body)).toEqual({ status: 'ready', database: 'connected' });

      // 2. I1: Si el inboundDispatcher está pausado preventivamente tras alerta crítica
      inboundDispatcher.pause(60000);
      const resPause = await app.inject({ method: 'GET', url: '/ready' });
      expect(resPause.statusCode).toBe(503);
      expect(JSON.parse(resPause.body)).toEqual({ status: 'paused', reason: 'INBOUND_WORKER_PAUSED' });

      inboundDispatcher.resume();
      const resResume = await app.inject({ method: 'GET', url: '/ready' });
      expect(resResume.statusCode).toBe(200);

      // 3. Al iniciar el apagado
      setShuttingDown(true);
      const res2 = await app.inject({ method: 'GET', url: '/ready' });
      expect(res2.statusCode).toBe(503);
      expect(JSON.parse(res2.body)).toEqual({ status: 'shutting_down' });
    });

    it('inboundDispatcher.stop() drena tareas en vuelo limpiamente', async () => {
      inboundDispatcher.start();
      await inboundDispatcher.stop(2000);
      // No lanza errores y se detiene limpiamente
    });

    it('B6: Un turno LLM en vuelo al llamar stop() termina con el evento en PENDING, retry_count sin cambio, dentro del presupuesto', async () => {
      const senderPhone = `55119999${Math.floor(10000 + Math.random() * 90000)}`;
      const ev = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.SHUTDOWN_INFLIGHT_${Date.now()}`,
        phoneNumberId: 'PHONE_SHUTDOWN',
        senderPhone,
        payload: { message: { text: { body: 'Mensaje largo en vuelo' } } },
      }))!;

      const claimed = await inboundRepository.claimPendingBatch(10);
      const claimedEv = claimed.find((e) => e.id === ev.id)!;
      expect(claimedEv).toBeDefined();

      // Mockear LLM para que simule una inferencia en vuelo y escuche la señal de aborto
      vi.spyOn(agentEngine, 'processMessage').mockImplementationOnce(async (_c, _conv, _text, options) => {
        return new Promise((resolve, reject) => {
          if (options?.abortSignal?.aborted) {
            const err = new Error('AbortError: Service shutdown requested');
            err.name = 'AbortError';
            return reject(err);
          }
          const timer = setTimeout(() => resolve({ replyText: 'Tardío', catalogToolExecuted: false, leadToolExecuted: false, handoffToolExecuted: false, promptTokens: 0, completionTokens: 0, totalLatencyMs: 500 }), 1000);
          options?.abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('AbortError: Service shutdown requested');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      // Iniciar procesamiento en background
      const processPromise = inboundDispatcher.processSingleEvent(claimedEv);

      // Mientras está en vuelo, llamar stop() para abortar la llamada
      await new Promise((resolve) => setTimeout(resolve, 50));
      await inboundDispatcher.stop(2000);
      await processPromise;

      // El evento debe haber sido liberado a PENDING con retry_count = 0 (sin quemar reintentos por shutdown)
      const check = await db.query(`SELECT status, lock_token, retry_count FROM public.inbound_events WHERE id = $1;`, [ev.id]);
      expect(check.rows[0].status).toBe('PENDING');
      expect(check.rows[0].lock_token).toBeNull();
      expect(check.rows[0].retry_count).toBe(0);
    });

    it('C2: AbortError sin orden de apagado del servidor debe quemar un reintento (retry_count = 1)', async () => {
      const senderPhone = `55119999${Math.floor(10000 + Math.random() * 90000)}`;
      const ev = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.ABORT_NO_SHUTDOWN_${Date.now()}`,
        phoneNumberId: 'PHONE_ABORT_TEST',
        senderPhone,
        payload: { message: { text: { body: 'Mensaje con timeout interno de SDK' } } },
      }))!;

      const claimed = await inboundRepository.claimPendingBatch(10);
      const claimedEv = claimed.find((e) => e.id === ev.id)!;
      expect(claimedEv).toBeDefined();

      // Simular que el cliente LLM lanza AbortError (ej: fetch timeout interno) SIN que el servidor esté apagándose
      vi.spyOn(agentEngine, 'processMessage').mockImplementationOnce(async () => {
        const timeoutErr = new Error('The operation was aborted due to client timeout');
        timeoutErr.name = 'AbortError';
        throw timeoutErr;
      });

      await inboundDispatcher.processSingleEvent(claimedEv);

      // El evento debe haber quemado un reintento (retry_count = 1) y quedar en PENDING con last_error
      const check = await db.query(`SELECT status, lock_token, retry_count, last_error FROM public.inbound_events WHERE id = $1;`, [ev.id]);
      expect(check.rows[0].status).toBe('PENDING');
      expect(check.rows[0].lock_token).toBeNull();
      expect(check.rows[0].retry_count).toBe(1);
      expect(check.rows[0].last_error).toContain('The operation was aborted');
    });

    it('Auditor 5B: recupera mediante el reaper un evento inbound colgado en PROCESSING tras apagado abrupto', async () => {
      const senderPhone = '5511999997777';
      const ev = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.REAPER_SHUTDOWN_${Date.now()}`,
        phoneNumberId: 'PHONE_REAPER',
        senderPhone,
        payload: { message: { text: { body: 'Evento interrumpido por SIGKILL' } } },
      }))!;

      // Simular que el worker estaba procesando y murió abruptamente (lease expirado)
      const fakeToken = crypto.randomUUID();
      await db.query(
        `UPDATE public.inbound_events
         SET status = 'PROCESSING',
             lock_token = $1,
             locked_at = NOW() - INTERVAL '60 seconds'
         WHERE id = $2;`,
        [fakeToken, ev.id]
      );

      // El reaper se ejecuta y debe rescatar el evento sin perderlo
      const { reapedCount } = await inboundRepository.reapOrphaned(30);
      expect(reapedCount).toBeGreaterThanOrEqual(1);

      const check = await db.query(
        `SELECT status, lock_token, locked_at, retry_count FROM public.inbound_events WHERE id = $1;`,
        [ev.id]
      );
      expect(check.rows[0].status).toBe('PENDING');
      expect(check.rows[0].lock_token).toBeNull();
      expect(check.rows[0].locked_at).toBeNull();
      expect(check.rows[0].retry_count).toBe(1);
    });
  });

  describe('Auditor 5B (B1, B4, B5, T7): Manejo de Fallas LLM, Efectos Secundarios y LGPD', () => {
    it('B1: Fallo terminal de LLM tras MAX_RETRIES encola mensaje de fallback al usuario y transiciona a FAILED', async () => {
      const senderPhone = `55119999${Math.floor(10000 + Math.random() * 90000)}`;
      const contact = await contactRepository.findOrCreate(senderPhone, 'Fallback User');
      await conversationRepository.getOrCreateActiveSession(contact.id);

      const ev = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.LLM_FAIL_${Date.now()}`,
        phoneNumberId: 'PHONE_FALLBACK',
        senderPhone,
        payload: { message: { text: { body: 'Mensaje que provocará fallo terminal' } } },
      }))!;

      // Simular que ya está en su último reintento (retry_count = 2)
      await db.query(`UPDATE public.inbound_events SET retry_count = 2 WHERE id = $1;`, [ev.id]);

      const claimed = await inboundRepository.claimPendingBatch(10);
      const claimedEv = claimed.find((e) => e.id === ev.id)!;
      expect(claimedEv).toBeDefined();

      // Simular fallo transitorio del proveedor LLM
      vi.spyOn(agentEngine, 'processMessage').mockRejectedValueOnce(
        new Error('503 Service Unavailable (Overloaded)')
      );

      await inboundDispatcher.processSingleEvent(claimedEv);

      // Debe transicionar a FAILED y encolar mensaje de disculpa en outbox_messages
      const evCheck = await db.query(`SELECT status, retry_count, last_error FROM public.inbound_events WHERE id = $1;`, [ev.id]);
      expect(evCheck.rows[0].status).toBe('FAILED');
      expect(evCheck.rows[0].last_error).toContain('503 Service Unavailable');

      const outboxCheck = await db.query(`SELECT content, recipient_phone FROM public.outbox_messages WHERE recipient_phone = $1;`, [senderPhone]);
      expect(outboxCheck.rows.length).toBe(1);
      expect(outboxCheck.rows[0].content).toContain('dificultades técnicas');
      expect(outboxCheck.rows[0].recipient_phone).toBe(senderPhone);
    });

    it('B4: Mock de LLM que devuelve texto vacío no marca el evento como DONE sin outbox (se trata como error reintentable)', async () => {
      const senderPhone = `55119999${Math.floor(10000 + Math.random() * 90000)}`;
      const ev = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.EMPTY_LLM_${Date.now()}`,
        phoneNumberId: 'PHONE_EMPTY',
        senderPhone,
        payload: { message: { text: { body: 'Pregunta del usuario' } } },
      }))!;

      const claimed = await inboundRepository.claimPendingBatch(10);
      const claimedEv = claimed.find((e) => e.id === ev.id)!;

      // Mock LLM devolviendo texto vacío sin handoff
      vi.spyOn(agentEngine, 'processMessage').mockResolvedValueOnce({
        replyText: '',
        catalogToolExecuted: false,
        leadToolExecuted: false,
        handoffToolExecuted: false,
        promptTokens: 10,
        completionTokens: 0,
        totalLatencyMs: 50,
      });

      await inboundDispatcher.processSingleEvent(claimedEv);

      // El evento NO debe quedar en DONE sin respuesta
      const check = await db.query(`SELECT status, retry_count, last_error FROM public.inbound_events WHERE id = $1;`, [ev.id]);
      expect(check.rows[0].status).toBe('PENDING');
      expect(check.rows[0].retry_count).toBe(1);
      expect(check.rows[0].last_error).toContain('EMPTY_LLM_RESPONSE');

      // No se envió nada a outbox
      const outboxCheck = await db.query(`SELECT * FROM public.outbox_messages WHERE recipient_phone = $1;`, [senderPhone]);
      expect(outboxCheck.rows.length).toBe(0);
    });

    it('C5: Handoff sin texto del LLM debe encolar un aviso estándar de traspaso en outbox', async () => {
      const senderPhone = `55119999${Math.floor(10000 + Math.random() * 90000)}`;
      const ev = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.HANDOFF_EMPTY_${Date.now()}`,
        phoneNumberId: 'PHONE_HANDOFF_EMPTY',
        senderPhone,
        payload: { message: { text: { body: 'Necesito hablar con un humano por favor' } } },
      }))!;

      const claimed = await inboundRepository.claimPendingBatch(10);
      const claimedEv = claimed.find((e) => e.id === ev.id)!;
      expect(claimedEv).toBeDefined();

      // Mockear LLM que solicita handoff pero NO genera replyText
      vi.spyOn(agentEngine, 'processMessage').mockImplementationOnce(async (c, conv) => {
        return {
          replyText: '', // Texto vacío
          catalogToolExecuted: false,
          leadToolExecuted: false,
          handoffToolExecuted: true,
          pendingHandoff: {
            contactId: c.id,
            conversationId: conv.id,
            reason: 'USER_REQUEST',
            briefing: 'El usuario solicita asesor humano',
          },
          promptTokens: 50,
          completionTokens: 20,
          totalLatencyMs: 300,
        };
      });

      await inboundDispatcher.processSingleEvent(claimedEv);

      // Evento queda en DONE
      const check = await db.query(`SELECT status FROM public.inbound_events WHERE id = $1;`, [ev.id]);
      expect(check.rows[0].status).toBe('DONE');

      // Outbox tiene el mensaje estándar de traspaso
      const outbox = await db.query(`SELECT * FROM public.outbox_messages WHERE recipient_phone = $1;`, [senderPhone]);
      expect(outbox.rows.length).toBe(1);
      expect(outbox.rows[0].content).toContain('Te estamos transfiriendo con un asesor humano');
    });

    it('B5: Dos eventos viejos del mismo remitente generan exactamente 1 handoff y 1 mensaje en outbox', async () => {
      const stalePhone = `55119999${Math.floor(10000 + Math.random() * 90000)}`;
      const spyLLM = vi.spyOn(agentEngine, 'processMessage');

      // Crear 2 eventos creados hace 45 minutos del mismo remitente
      const ev1 = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.STALE_1_${Date.now()}`,
        phoneNumberId: 'PHONE_STALE',
        senderPhone: stalePhone,
        payload: { message: { text: { body: 'Consulta vieja 1' } } },
      }))!;
      const ev2 = (await inboundRepository.persistInboundEvent({
        wamid: `wamid.STALE_2_${Date.now()}`,
        phoneNumberId: 'PHONE_STALE',
        senderPhone: stalePhone,
        payload: { message: { text: { body: 'Consulta vieja 2' } } },
      }))!;

      // Forzar created_at y next_retry_at a hace 46 min para ev1 y 45 min para ev2 (orden determinista)
      await db.query(
        `UPDATE public.inbound_events SET created_at = NOW() - INTERVAL '46 minutes', next_retry_at = NOW() - INTERVAL '46 minutes' WHERE id = $1;`,
        [ev1.id]
      );
      await db.query(
        `UPDATE public.inbound_events SET created_at = NOW() - INTERVAL '45 minutes', next_retry_at = NOW() - INTERVAL '45 minutes' WHERE id = $1;`,
        [ev2.id]
      );

      // Reclamar y procesar el primer evento
      const batch1 = await inboundRepository.claimPendingBatch(10);
      const claimed1 = batch1.find((e) => e.id === ev1.id)!;
      await inboundDispatcher.processSingleEvent(claimed1);

      // Reclamar y procesar el segundo evento
      const batch2 = await inboundRepository.claimPendingBatch(10);
      const claimed2 = batch2.find((e) => e.id === ev2.id)!;
      await inboundDispatcher.processSingleEvent(claimed2);

      // Comprobar que NO se llamó al LLM
      expect(spyLLM).not.toHaveBeenCalled();

      // B5: Exactamente 1 sesión de handoff
      const handoffCheck = await db.query(`
        SELECT hs.* FROM public.handoff_sessions hs
        JOIN public.conversations c ON c.id = hs.conversation_id
        JOIN public.contacts ct ON ct.id = c.contact_id
        WHERE ct.phone_number = $1;
      `, [stalePhone]);
      expect(handoffCheck.rows.length).toBe(1);
      expect(handoffCheck.rows[0].trigger_reason).toBe('SYSTEM_DELAY');

      // B5: Exactamente 1 mensaje de disculpa en outbox_messages
      const outboxCheck = await db.query(`SELECT * FROM public.outbox_messages WHERE recipient_phone = $1;`, [stalePhone]);
      expect(outboxCheck.rows.length).toBe(1);

      // Ambos eventos quedaron como DONE
      const eventsCheck = await db.query(`SELECT status FROM public.inbound_events WHERE id IN ($1, $2);`, [ev1.id, ev2.id]);
      expect(eventsCheck.rows.every((r: any) => r.status === 'DONE')).toBe(true);
    });

    it('T7: Evento FAILED por poison pill en reaper genera alerta y encola fallback en outbox', async () => {
      const poisonWamid = `wamid.POISON_PILL_${Date.now()}`;
      const senderPhone = '5511999990003';
      await db.query(`
        INSERT INTO public.inbound_events (
          wamid, phone_number_id, sender_phone, payload, status, retry_count, locked_at
        )
        VALUES ($1, 'PHONE_POISON', $2, '{}'::jsonb, 'PROCESSING', 2, NOW() - INTERVAL '60 seconds');
      `, [poisonWamid, senderPhone]);

      // Ejecutar el reaper del dispatcher
      await inboundDispatcher.runReaper();

      // 1. Estado en DB pasa a FAILED con retry_count = 3
      const check = await db.query(`SELECT status, retry_count, last_error FROM public.inbound_events WHERE wamid = $1;`, [poisonWamid]);
      expect(check.rows[0].status).toBe('FAILED');
      expect(check.rows[0].retry_count).toBe(3);
      expect(check.rows[0].last_error).toContain('Poison pill');

      // 2. T7: Se encoló un mensaje de fallback al usuario en outbox_messages
      const outboxCheck = await db.query(
        `SELECT * FROM public.outbox_messages WHERE recipient_phone = $1;`,
        [senderPhone]
      );
      expect(outboxCheck.rows.length).toBe(1);
      expect(outboxCheck.rows[0].content).toContain('dificultad técnica');
    });

    it('Auditor 5B: Purga de eventos DONE según política de retención LGPD', async () => {
      const oldWamid = `wamid.LGPD_OLD_${Date.now()}`;
      const recentWamid = `wamid.LGPD_RECENT_${Date.now()}`;

      // Insertar evento DONE antiguo (> 7 días)
      await db.query(`
        INSERT INTO public.inbound_events (wamid, phone_number_id, sender_phone, payload, status, created_at, processed_at)
        VALUES ($1, 'PHONE_LGPD', '5511999990001', '{}'::jsonb, 'DONE', NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days');
      `, [oldWamid]);

      // Insertar evento DONE reciente (< 7 días)
      await db.query(`
        INSERT INTO public.inbound_events (wamid, phone_number_id, sender_phone, payload, status, created_at, processed_at)
        VALUES ($1, 'PHONE_LGPD', '5511999990002', '{}'::jsonb, 'DONE', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days');
      `, [recentWamid]);

      // Purgar con ventana de 7 días
      const purged = await inboundRepository.purgeProcessedEvents(7);
      expect(purged.inbound).toBeGreaterThanOrEqual(1);

      // El evento antiguo debe haber sido eliminado (Minimización de PII cruda)
      const oldCheck = await db.query(`SELECT id FROM public.inbound_events WHERE wamid = $1;`, [oldWamid]);
      expect(oldCheck.rows.length).toBe(0);

      // El evento reciente debe permanecer intacto
      const recentCheck = await db.query(`SELECT id FROM public.inbound_events WHERE wamid = $1;`, [recentWamid]);
      expect(recentCheck.rows.length).toBe(1);
    });
  });
});
