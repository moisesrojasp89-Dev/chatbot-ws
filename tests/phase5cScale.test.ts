import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/providers/database/dbClient.js';
import { inboundRepository } from '../src/repositories/inboundRepository.js';
import { InboundDispatcher, inboundDispatcher } from '../src/services/inboundDispatcher.js';
import { LlmRateLimiter } from '../src/providers/llm/llmRateLimiter.js';
import { retentionService } from '../src/services/retentionService.js';
import { auditRepository } from '../src/repositories/auditRepository.js';

describe('Fase 5C: Escala, Sliding Worker Pool, Rate Limiter Dual & Coalescencia', { timeout: 30000 }, () => {
  let app: FastifyInstance;

  function generateValidSignature(payloadString: string): string {
    const hash = crypto
      .createHmac('sha256', env.META_APP_SECRET)
      .update(payloadString)
      .digest('hex');
    return `sha256=${hash}`;
  }

  beforeEach(async () => {
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
      await db.query(`DELETE FROM public.audit_log;`);
    } catch {}
  });

  afterEach(async () => {
    await inboundDispatcher.stop(1000);
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
      await db.query(`DELETE FROM public.audit_log;`);
    } catch {}
  });

  /**
   * C1: SQL Race Condition Test (EvalPlanQual Guard)
   * Dos clientes concurrentes compitiendo por el mismo evento PENDING.
   * El cliente A reclama el evento primero. Al evaluarse concurrentemente,
   * el cliente B NO debe sobrescribir el lock gracias a 'AND u.status = PENDING'.
   */
  it('C1: SQL Race Condition - Dos clientes concurrentes no provocan double-claim bajo EvalPlanQual', async () => {
    const wamid = `wamid.race_${Date.now()}`;
    await inboundRepository.persistInboundEvent({
      wamid,
      phoneNumberId: 'phone-test-c1',
      senderPhone: '+584129991111',
      payload: { message: { id: wamid, type: 'text', text: { body: 'Mensaje de carrera C1' } } },
    });

    const clientA = await db.getClient();
    const clientB = await db.getClient();

    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      // Cliente A reclama el evento dentro de su transacción, adquiriendo el lock exclusivo de fila
      const batchesA = await inboundRepository.claimNextBatchWithCoalescing(5, clientA);
      expect(batchesA.length).toBe(1);
      expect(batchesA[0].primaryEvent.wamid).toBe(wamid);

      // Carrera Real: Cliente B dispara la consulta concurrente mientras Cliente A mantiene la transacción abierta.
      // El UPDATE de Cliente B se bloquea en PostgreSQL esperando que A libere el lock de la fila.
      const claimPromiseB = inboundRepository.claimNextBatchWithCoalescing(5, clientB);

      // Breve pausa para garantizar que la consulta de B está en vuelo y bloqueada en el engine de Postgres
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Cliente A confirma su transacción, liberando el lock
      await clientA.query('COMMIT');

      // Cliente B se desbloquea; el mecanismo EvalPlanQual de PostgreSQL re-evalúa el WHERE del UPDATE.
      // Debido a 'AND u.status = PENDING', la condición es falsa y B actualiza 0 filas.
      const batchesB = await claimPromiseB;
      expect(batchesB.length).toBe(0);

      await clientB.query('COMMIT');

      // Verificar que el evento sigue en PROCESSING con el lockToken de A
      const res = await db.query(
        `SELECT status, lock_token FROM public.inbound_events WHERE wamid = $1`,
        [wamid]
      );
      expect(res.rows[0].status).toBe('PROCESSING');
      expect(res.rows[0].lock_token).toBe(batchesA[0].lockToken);
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  /**
   * C4: triggerImmediatePoll() post-stop no reclama nuevas filas
   */
  it('C4: triggerImmediatePoll() invocado tras stop() no reclama nuevas filas de la base de datos', async () => {
    const wamid = `wamid.poststop_${Date.now()}`;
    await inboundRepository.persistInboundEvent({
      wamid,
      phoneNumberId: 'phone-test-c4',
      senderPhone: '+584129992222',
      payload: { message: { id: wamid, type: 'text', text: { body: 'Mensaje post-stop' } } },
    });

    // Detener el dispatcher
    await inboundDispatcher.stop(1000);

    // Intentar disparar sondeo post-stop
    inboundDispatcher.triggerImmediatePoll();

    // Esperar un ciclo para verificar que ninguna fila fue tomada
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await db.query(
      `SELECT status, lock_token FROM public.inbound_events WHERE wamid = $1`,
      [wamid]
    );
    expect(res.rows[0].status).toBe('PENDING');
    expect(res.rows[0].lock_token).toBeNull();
  });

  /**
   * C3: stop(graceBudgetMs) con worker colgado se corta en el timeout vía Promise.race
   */
  it('C3: stop() con worker colgado corta su espera en el timeout exacto vía Promise.race', async () => {
    const customDispatcher = new InboundDispatcher();
    customDispatcher.start();

    // Inyectar un worker colgado artificial que nunca resuelve
    const hungPromise = new Promise<void>(() => {});
    (customDispatcher as any).activeWorkers.add(hungPromise);

    const start = Date.now();
    await customDispatcher.stop(150); // Presupuesto de 150ms
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(1000); // No debe quedarse colgado indefinidamente
    expect((customDispatcher as any).isRunning).toBe(false);
  });

  /**
   * C6 & C8: Rate Limiter Dual RPM/TPM - 50 solicitudes concurrentes sin race conditions ni double-spending
   */
  it('C6 & C8: Rate Limiter atiende 50 solicitudes concurrentes con reserva atómica continua', async () => {
    // Limiter con capacidad 60 RPM y 100,000 TPM
    const limiter = new LlmRateLimiter({ maxRPM: 60, maxTPM: 100000 });

    const promises = Array.from({ length: 50 }, () => limiter.acquireToken(100));
    const startAcquire = Date.now();
    await Promise.all(promises);
    const elapsed = Date.now() - startAcquire;

    // Como la capacidad inicial es 60 y pedimos 50, todas deben concederse inmediatamente
    expect(elapsed).toBeLessThan(500);

    const metrics = limiter.getMetrics();
    expect(metrics.queueLength).toBe(0);
    expect(metrics.availableRPM).toBeLessThanOrEqual(11); // 60 - 50 = 10 aprox (+ delta de refill)
    expect(metrics.availableTPM).toBeLessThanOrEqual(95100); // 100000 - 5000 = 95000 aprox
  });

  /**
   * C7: Reconciliación de telemetría de tokens (TPM) post-inferencia
   */
  it('C7: Reconciliación devuelve tokens no usados si la inferencia fue menor a la estimación', () => {
    const limiter = new LlmRateLimiter({ maxRPM: 60, maxTPM: 100000 });

    // Consumir 2000 tokens estimados
    limiter['tpmTokens'] = 98000;

    // Supongamos que la respuesta real usó solo 800 tokens (sobraron 1200)
    limiter.reconcile(2000, 800);
    expect(Math.round(limiter['tpmTokens'])).toBeCloseTo(99200, -1);

    // Supongamos ahora que consumió 1500 tokens cuando se estimaron 1000 (exceso de 500)
    limiter.reconcile(1000, 1500);
    expect(Math.round(limiter['tpmTokens'])).toBeCloseTo(98700, -1);
  });

  /**
   * C7 Error Path: Si la llamada a Gemini falla (error 5xx, timeout, abort), se reembolsan íntegramente los tokens de TPM reservados
   */
  it('C7 Error Path: Error en llamada LLM reembolsa al 100% los tokens de TPM reservados evitando fugas de cuota', () => {
    const limiter = new LlmRateLimiter({ maxRPM: 60, maxTPM: 100000 });
    // Deducir 3000 tokens
    limiter['tpmTokens'] = 97000;

    // En caso de error, actualTokens es 0 (fallo antes de respuesta)
    limiter.reconcile(3000, 0);

    expect(Math.round(limiter['tpmTokens'])).toBeCloseTo(100000, -1);
  });

  /**
   * C10: Coalescencia Estrictamente Contigua - Se detiene ante el primer mensaje no-texto (Texto -> Imagen -> Texto)
   */
  it('C10: Coalescencia respeta contigüidad estricta y se detiene ante mensaje no-texto', async () => {
    const sender = '+584129993333';
    const phoneId = 'phone-test-c10';

    // Insertar 3 mensajes en secuencia temporal
    const now = Date.now();
    await db.query(
      `INSERT INTO public.inbound_events (wamid, phone_number_id, sender_phone, payload, status, created_at)
       VALUES 
       ($1, $2, $3, $4::jsonb, 'PENDING', $5),
       ($6, $2, $3, $7::jsonb, 'PENDING', $8),
       ($9, $2, $3, $10::jsonb, 'PENDING', $11)`,
      [
        'wamid.seq1',
        phoneId,
        sender,
        JSON.stringify({ message: { id: 'wamid.seq1', type: 'text', text: { body: 'Hola' } } }),
        new Date(now),
        'wamid.seq2',
        JSON.stringify({ message: { id: 'wamid.seq2', type: 'image', image: { id: 'img123' } } }),
        new Date(now + 1000),
        'wamid.seq3',
        JSON.stringify({ message: { id: 'wamid.seq3', type: 'text', text: { body: '¿Qué precio tiene?' } } }),
        new Date(now + 2000),
      ]
    );

    // Primer claim: debe tomar 'wamid.seq1' y DETENERSE antes de la imagen
    const batch1 = await inboundRepository.claimNextBatchWithCoalescing(5);
    expect(batch1.length).toBe(1);
    expect(batch1[0].primaryEvent.wamid).toBe('wamid.seq1');
    expect(batch1[0].secondaryEvents.length).toBe(0); // NO coalesció seq3 porque seq2 es imagen

    // Marcar el primer batch como DONE
    await inboundRepository.markCoalescedBatchDone(
      batch1[0].primaryEvent.id,
      [],
      batch1[0].lockToken
    );

    // Segundo claim: debe tomar 'wamid.seq2' (la imagen sola)
    const batch2 = await inboundRepository.claimNextBatchWithCoalescing(5);
    expect(batch2.length).toBe(1);
    expect(batch2[0].primaryEvent.wamid).toBe('wamid.seq2');
    expect(batch2[0].secondaryEvents.length).toBe(0);

    // Marcar batch2 como DONE
    await inboundRepository.markCoalescedBatchDone(
      batch2[0].primaryEvent.id,
      [],
      batch2[0].lockToken
    );

    // Tercer claim: debe tomar 'wamid.seq3'
    const batch3 = await inboundRepository.claimNextBatchWithCoalescing(5);
    expect(batch3.length).toBe(1);
    expect(batch3[0].primaryEvent.wamid).toBe('wamid.seq3');
  });

  /**
   * C11: Retention Service - Purga continua LGPD y respeto de ventana temporal
   */
  it('C11: RetentionService purga eventos vencidos (DONE > 7d, FAILED > 90d) y conserva recientes', async () => {
    const oldDate8Days = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const recentDate2Days = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const oldDate95Days = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000);

    // Insertar registros inbound
    await db.query(
      `INSERT INTO public.inbound_events (wamid, phone_number_id, sender_phone, payload, status, created_at, processed_at)
       VALUES 
       ('wamid.exp_done', 'phone-p', '+1111', '{}', 'DONE', $1, $1),
       ('wamid.keep_done', 'phone-p', '+1111', '{}', 'DONE', $2, $2),
       ('wamid.exp_failed', 'phone-p', '+1111', '{}', 'FAILED', $3, NULL),
       ('wamid.keep_failed', 'phone-p', '+1111', '{}', 'FAILED', $2, NULL)`,
      [oldDate8Days, recentDate2Days, oldDate95Days]
    );

    // Ejecutar ciclo de purga
    const stats = await retentionService.runPurgeCycle();

    expect(stats.inboundDone).toBeGreaterThanOrEqual(1);
    expect(stats.inboundFailed).toBeGreaterThanOrEqual(1);

    // Verificar que los vencidos ya no existen
    const expDone = await db.query(`SELECT 1 FROM public.inbound_events WHERE wamid = 'wamid.exp_done'`);
    expect(expDone.rows.length).toBe(0);

    const expFailed = await db.query(`SELECT 1 FROM public.inbound_events WHERE wamid = 'wamid.exp_failed'`);
    expect(expFailed.rows.length).toBe(0);

    // Verificar que los recientes se mantienen
    const keepDone = await db.query(`SELECT 1 FROM public.inbound_events WHERE wamid = 'wamid.keep_done'`);
    expect(keepDone.rows.length).toBe(1);

    const keepFailed = await db.query(`SELECT 1 FROM public.inbound_events WHERE wamid = 'wamid.keep_failed'`);
    expect(keepFailed.rows.length).toBe(1);
  });

  /**
   * C5: Webhook Protection - Mensajes sin phone_number_id en metadata se descartan y auditan sin fallback global
   */
  it('C5: Webhook descarta y audita mensajes sin phone_number_id en metadata', async () => {
    const malformedPayload = {
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
                  // Falta phone_number_id
                  display_phone_number: '123456',
                },
                messages: [
                  {
                    from: '584120009999',
                    id: 'wamid.malformed_c5',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'Mensaje sin phone_number_id' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const raw = JSON.stringify(malformedPayload);
    const sig = generateValidSignature(raw);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sig,
      },
      payload: raw,
    });

    // SLA: Responde 200 a Meta pero descarta el procesamiento interno
    expect(res.statusCode).toBe(200);

    // Verificar que NO se insertó en inbound_events
    const eventRes = await db.query(
      `SELECT 1 FROM public.inbound_events WHERE wamid = 'wamid.malformed_c5'`
    );
    expect(eventRes.rows.length).toBe(0);

    // Verificar que se registró en audit_log como MALFORMED_WEBHOOK_PAYLOAD
    const auditRes = await db.query(
      `SELECT * FROM public.audit_log WHERE event_type = 'MALFORMED_WEBHOOK_PAYLOAD'`
    );
    expect(auditRes.rows.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * C13: GROUP BY y DISTINCT ON scopeados por (sender_phone, phone_number_id)
   * Si el mismo usuario escribe a dos tenants distintos, ambos mensajes se reclaman simultáneamente
   * sin serialización cruzada.
   */
  it('C13: Reclamo scopeado por (sender_phone, phone_number_id) previene serialización cruzada entre tenants', async () => {
    const sharedSender = '+584129998888';
    const tenant1 = 'phone-tenant-1';
    const tenant2 = 'phone-tenant-2';

    // Insertar un mensaje para el tenant 1
    await inboundRepository.persistInboundEvent({
      wamid: 'wamid.multi_t1',
      phoneNumberId: tenant1,
      senderPhone: sharedSender,
      payload: { message: { id: 'wamid.multi_t1', type: 'text', text: { body: 'Hola Negocio 1' } } },
    });

    // Insertar un mensaje para el tenant 2 del mismo usuario
    await inboundRepository.persistInboundEvent({
      wamid: 'wamid.multi_t2',
      phoneNumberId: tenant2,
      senderPhone: sharedSender,
      payload: { message: { id: 'wamid.multi_t2', type: 'text', text: { body: 'Hola Negocio 2' } } },
    });

    // Reclamar con límite >= 2
    const batches = await inboundRepository.claimNextBatchWithCoalescing(5);

    // Con el fix de C13, ambos lotes son candidatos válidos y se reclaman en el mismo ciclo
    expect(batches.length).toBe(2);

    const phoneIdsClaimed = batches.map((b) => b.primaryEvent.phone_number_id);
    expect(phoneIdsClaimed).toContain(tenant1);
    expect(phoneIdsClaimed).toContain(tenant2);
  });
});
