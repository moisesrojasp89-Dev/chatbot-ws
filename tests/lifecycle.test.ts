import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../src/providers/database/dbClient.js';
import { outboxRepository } from '../src/repositories/outboxRepository.js';
import { outboxDispatcher } from '../src/services/outboxDispatcher.js';
import { whatsappClient } from '../src/providers/channels/meta/whatsappClient.js';
import { metaCircuitBreaker } from '../src/utils/circuitBreaker.js';
import { typingCadence } from '../src/harness/typingCadence.js';
import { contactRepository } from '../src/repositories/contactRepository.js';
import { conversationRepository } from '../src/repositories/conversationRepository.js';

describe('Fase 4: Tests de Ciclo de Vida (Auditoría B1, B2, B3)', { timeout: 30000 }, () => {
  const testPhone = '5511777770003';
  let contactId: string;
  let conversationId: string;

  beforeEach(async () => {
    // Acelerar typingCadence a 0ms en pruebas de ciclo de vida
    vi.spyOn(typingCadence, 'simulateTyping').mockResolvedValue();

    metaCircuitBreaker.reset();
    outboxDispatcher.resume();

    try {
      await db.query(`DELETE FROM public.outbox_messages;`);
      await db.query(`DELETE FROM public.messages;`);
    } catch {}

    const contact = await contactRepository.findOrCreate(testPhone, 'Lifecycle User');
    contactId = contact.id;
    const conversation = await conversationRepository.getOrCreateActiveSession(contactId);
    conversationId = conversation.id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    metaCircuitBreaker.reset();
    outboxDispatcher.resume();

    try {
      await db.query(`DELETE FROM public.outbox_messages;`);
      await db.query(`DELETE FROM public.messages WHERE conversation_id = $1;`, [conversationId]);
      await db.query(`DELETE FROM public.conversations WHERE id = $1;`, [conversationId]);
      await db.query(`DELETE FROM public.contacts WHERE id = $1;`, [contactId]);
    } catch {
      // Ignorar errores de limpieza si se eliminaron en cascada
    }
  });

  // =========================================================================
  // TEST 1: Meta caído 60s -> Al recuperarse, 0 mensajes en FAILED y todos entregados (B1)
  // =========================================================================
  it('Ciclo de Vida 1: Meta caído con breaker OPEN no quema reintentos; al recuperarse, 0 en FAILED y todos entregados', async () => {
    // 1. Encolar 2 mensajes
    const msg1 = await outboxRepository.enqueueMessage({
      conversationId,
      phoneNumberId: 'phone_123',
      recipientPhone: testPhone,
      content: 'Mensaje A encolado antes de la caída',
    });
    const msg2 = await outboxRepository.enqueueMessage({
      conversationId,
      phoneNumberId: 'phone_123',
      recipientPhone: testPhone,
      content: 'Mensaje B encolado antes de la caída',
    });

    // 2. Forzar apertura del Circuit Breaker simulando 5 fallos transitorios de red
    const failingSend = vi.spyOn(whatsappClient, 'sendTextMessage').mockRejectedValue(
      new Error('503 Service Unavailable')
    );

    // Provocar 5 fallos para abrir circuito
    for (let i = 0; i < 5; i++) {
      await metaCircuitBreaker.execute(async () => {
        throw new Error('503 Service Unavailable');
      }).catch(() => {});
    }
    expect(metaCircuitBreaker.getState()).toBe('OPEN');

    // 3. El dispatcher intenta procesar el lote con el breaker OPEN
    const processedWhileOpen = await outboxDispatcher.processNextBatch();
    expect(processedWhileOpen).toBe(0);

    // 4. B1 Invariante: Ningún mensaje debe haberse quemado ni marcado como FAILED
    const checkMsg1 = await outboxRepository.findById(msg1.id);
    const checkMsg2 = await outboxRepository.findById(msg2.id);

    expect(checkMsg1?.status).toBe('PENDING');
    expect(checkMsg1?.retry_count).toBe(0); // CERO reintentos consumidos por rechazo del breaker
    expect(checkMsg2?.status).toBe('PENDING');
    expect(checkMsg2?.retry_count).toBe(0);

    // 5. Meta se recupera (simulamos reinicio y respuesta exitosa)
    failingSend.mockRestore();
    metaCircuitBreaker.reset(); // Breaker vuelve a CLOSED
    expect(metaCircuitBreaker.getState()).toBe('CLOSED');

    // Despachar mensajes ahora que Meta está en línea
    // Reestablecer next_retry_at a NOW() para no esperar delay del reset
    let processedAfterRecovery = 0;
    while ((await outboxDispatcher.processNextBatch()) > 0) {
      processedAfterRecovery++;
    }
    expect(processedAfterRecovery).toBe(2);

    // 6. Verificar que AMBOS mensajes están en SENT y CERO en FAILED
    const final1 = await outboxRepository.findById(msg1.id);
    const final2 = await outboxRepository.findById(msg2.id);

    expect(final1?.status).toBe('SENT');
    expect(final1?.wamid).toBeDefined();
    expect(final2?.status).toBe('SENT');
    expect(final2?.wamid).toBeDefined();

    const failedCount = await db.query(
      `SELECT COUNT(*) FROM public.outbox_messages WHERE recipient_phone = $1 AND status = 'FAILED';`,
      [testPhone]
    );
    expect(Number(failedCount.rows[0].count)).toBe(0);
  });

  // =========================================================================
  // TEST 2: Kill a mitad de batch -> El reaper recupera las filas en PROCESSING (B2)
  // =========================================================================
  it('Ciclo de Vida 2: Kill o crash a mitad de batch -> El reaper restaura las filas huérfanas en PROCESSING a PENDING', async () => {
    // 1. Encolar mensaje
    const msg = await outboxRepository.enqueueMessage({
      conversationId,
      phoneNumberId: 'phone_123',
      recipientPhone: testPhone,
      content: 'Mensaje huérfano por crash de contenedor',
    });

    // 2. Simular que un worker reclamó el mensaje con locked_at hace 3 minutos y murió (SIGKILL)
    await db.query(
      `
      UPDATE public.outbox_messages
      SET status = 'PROCESSING',
          locked_at = NOW() - INTERVAL '3 minutes'
      WHERE id = $1;
    `,
      [msg.id]
    );

    const crashedState = await outboxRepository.findById(msg.id);
    expect(crashedState?.status).toBe('PROCESSING');
    expect(crashedState?.locked_at).not.toBeNull();

    // 3. Ejecutar el Reaper con timeout de 2 minutos
    const reapedCount = await outboxRepository.reapStaleProcessing(2);
    expect(reapedCount).toBeGreaterThanOrEqual(1);

    // 4. B2 Invariante: La fila huérfana debe haber regresado a PENDING y locked_at es NULL
    const recovered = await outboxRepository.findById(msg.id);
    expect(recovered?.status).toBe('PENDING');
    expect(recovered?.locked_at).toBeNull();

    // 5. El nuevo worker activo puede reclamarla y procesarla exitosamente
    const processed = await outboxDispatcher.processNextBatch();
    expect(processed).toBeGreaterThanOrEqual(1);

    const finalState = await outboxRepository.findById(msg.id);
    expect(finalState?.status).toBe('SENT');
  });

  // =========================================================================
  // TEST 3: markSent lanza después del envío -> No se reenvía el mensaje ni se pisa con PENDING (B3)
  // =========================================================================
  it('Ciclo de Vida 3: Fallo en DB local tras envío a Meta -> No se revierte a PENDING ni se duplica el mensaje', async () => {
    // 1. Encolar mensaje
    const msg = await outboxRepository.enqueueMessage({
      conversationId,
      phoneNumberId: 'phone_123',
      recipientPhone: testPhone,
      content: 'Mensaje enviado a Meta con fallo de DB local posterior',
    });

    // Espiar whatsappClient para constatar cuántas veces se llama a la red
    const sendSpy = vi.spyOn(whatsappClient, 'sendTextMessage');

    // 2. Simular que markSent lanza un error de conexión a la base de datos
    const markSentSpy = vi.spyOn(outboxRepository, 'markSent').mockRejectedValueOnce(
      new Error('DB Connection pool timeout during markSent')
    );

    // 3. Ejecutar despacho
    await outboxDispatcher.processNextBatch();

    // 4. B3 Invariantes:
    // - El mensaje fue enviado a Meta exactamente 1 vez
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // - El catch de Fase 2 NUNCA debe haber llamado a markFailed ni regresado a PENDING
    const stateAfterCrash = await outboxRepository.findById(msg.id);
    // Permanece en PROCESSING (o el estado que tenía), NUNCA marcado como PENDING para re-envío duplicado
    expect(stateAfterCrash?.status).not.toBe('PENDING');

    markSentSpy.mockRestore();
    sendSpy.mockRestore();
  });

  // =========================================================================
  // TEST 4: Fallo en mensaje A libera inmediatamente mensaje B a PENDING (Auditor Point 4)
  // =========================================================================
  it('Ciclo de Vida 4: Fallo en mensaje A libera inmediatamente mensajes subsiguientes a PENDING sin penalización del reaper', async () => {
    // 1. Encolar 2 mensajes para el MISMO número
    const msgA = await outboxRepository.enqueueMessage({
      conversationId,
      phoneNumberId: 'phone_123',
      recipientPhone: testPhone,
      content: 'Mensaje A',
    });
    const msgB = await outboxRepository.enqueueMessage({
      conversationId,
      phoneNumberId: 'phone_123',
      recipientPhone: testPhone,
      content: 'Mensaje B',
    });

    // 2. Simular fallo transitorio en mensaje A
    const failingSend = vi.spyOn(whatsappClient, 'sendTextMessage').mockRejectedValueOnce(
      new Error('500 Internal Server Error')
    );

    // 3. Despachar lote
    await outboxDispatcher.processNextBatch();

    // 4. Invariante Auditor Point 4:
    // Mensaje A falló y está programado para reintento con backoff
    const checkA = await outboxRepository.findById(msgA.id);
    expect(checkA?.retry_count).toBe(1);

    // Mensaje B fue liberado INMEDIATAMENTE a PENDING:
    // NO debe haber quedado en PROCESSING ni tener retry_count incrementado
    const checkB = await outboxRepository.findById(msgB.id);
    expect(checkB?.status).toBe('PENDING');
    expect(checkB?.retry_count).toBe(0); // CERO reintentos consumidos
    expect(checkB?.locked_at).toBeNull();
    expect(checkB?.lock_token).toBeNull();

    failingSend.mockRestore();
  });

  // =========================================================================
  // TEST 5: Pre-Send Fencing con lock_token previene duplicados si el lease expira antes de Meta
  // =========================================================================
  it('Ciclo de Vida 5: Fencing con lock_token aborta el envío si el lease expiró antes de llamar a Meta (Pre-Send)', async () => {
    // 1. Encolar mensaje
    const msg = await outboxRepository.enqueueMessage({
      conversationId,
      phoneNumberId: 'phone_123',
      recipientPhone: testPhone,
      content: 'Mensaje con carrera de lease',
    });

    // Espiar whatsappClient para comprobar que la llamada irreversible NUNCA ocurre
    const sendSpy = vi.spyOn(whatsappClient, 'sendTextMessage');

    // 2. Simular que isLeaseValid retorna falso (el lease expiró o el reaper ya lo reasignó)
    const leaseSpy = vi.spyOn(outboxRepository, 'isLeaseValid').mockResolvedValueOnce(false);

    // 3. Ejecutar despacho
    const sentCount = await outboxDispatcher.processNextBatch();
    expect(sentCount).toBe(0);

    // 4. Invariante: WhatsApp API NUNCA fue contactada
    expect(sendSpy).not.toHaveBeenCalled();

    leaseSpy.mockRestore();
    sendSpy.mockRestore();
  });

  // =========================================================================
  // TEST 6: HALF_OPEN con 2 o más grupos: 0 reintentos consumidos (Auditor R1)
  // =========================================================================
  it('Ciclo de Vida 6: HALF_OPEN con 2 o más grupos concurrentes: 0 reintentos consumidos', async () => {
    const testPhone2 = '5511777770004';
    const contact2 = await contactRepository.findOrCreate(testPhone2, 'Concurrent User');
    const conversation2 = await conversationRepository.getOrCreateActiveSession(contact2.id);

    const msg1 = await outboxRepository.enqueueMessage({
      conversationId,
      phoneNumberId: 'phone_123',
      recipientPhone: testPhone,
      content: 'Mensaje Grupo 1 (Sonda Canary)',
    });
    const msg2 = await outboxRepository.enqueueMessage({
      conversationId: conversation2.id,
      phoneNumberId: 'phone_123',
      recipientPhone: testPhone2,
      content: 'Mensaje Grupo 2 (Concurrente en HALF_OPEN)',
    });

    // 1. Forzar estado HALF_OPEN en el Circuit Breaker
    const failingAction = vi.spyOn(whatsappClient, 'sendTextMessage').mockRejectedValue(new Error('503 Service Unavailable'));
    for (let i = 0; i < 5; i++) {
      try {
        await metaCircuitBreaker.execute(async () => {
          throw new Error('503 Service Unavailable');
        });
      } catch {}
    }
    expect(metaCircuitBreaker.getState()).toBe('OPEN');

    (metaCircuitBreaker as any).openUntil = Date.now() - 1;
    expect(metaCircuitBreaker.getState()).toBe('HALF_OPEN');

    // 2. Coordinación determinista: la sonda (msg1) retiene el Breaker mientras msg2 intenta entrar
    failingAction.mockRestore();

    // Mockear isLeaseValid para eliminar la latencia de red de Supabase y garantizar que ambos grupos ejecuten concurrentemente
    vi.spyOn(outboxRepository, 'isLeaseValid').mockResolvedValue(true);

    let probeStartedResolve!: () => void;
    const probeStarted = new Promise<void>((r) => { probeStartedResolve = r; });

    let allowProbeToFinishResolve!: () => void;
    const allowProbeToFinish = new Promise<void>((r) => { allowProbeToFinishResolve = r; });

    vi.spyOn(whatsappClient, 'sendTextMessage').mockImplementation(async (phoneId, recipient) => {
      if (recipient === testPhone) {
        probeStartedResolve();
        await allowProbeToFinish;
        return 'wamid.HBgL_CANARY_PROBE_OK';
      }
      return 'wamid.HBgL_SECOND_MSG_OK';
    });

    // 3. Ejecutar processNextBatch concurrentemente
    const batchPromise = outboxDispatcher.processNextBatch();

    // Esperar a que la sonda esté activamente dentro de execute()
    await probeStarted;

    // Dar tiempo holgado para que el grupo 2 intente execute y reciba CircuitOpenError (HALF_OPEN_BUSY)
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Permitir que la sonda concluya exitosamente
    allowProbeToFinishResolve();
    await batchPromise;

    // 4. Invariantes del Auditor (R1):
    // La sonda tuvo éxito y se marcó SENT
    const check1 = await outboxRepository.findById(msg1.id);
    expect(check1?.status).toBe('SENT');

    // El mensaje concurrente en HALF_OPEN recibió CircuitOpenError y se liberó a PENDING con 0 reintentos consumidos
    const check2 = await outboxRepository.findById(msg2.id);
    expect(check2?.status).toBe('PENDING');
    expect(check2?.retry_count).toBe(0);
  });

  // =========================================================================
  // TEST 7: Worker con lease perdido que llama a release o terminalFailed: no toca la fila (Auditor R3)
  // =========================================================================
  it('Ciclo de Vida 7: Worker con lease perdido que llama a release o terminalFailed: no toca la fila', async () => {
    // 1. Encolar mensaje y reclamar con Worker A
    const msg = await outboxRepository.enqueueMessage({
      conversationId,
      phoneNumberId: 'phone_123',
      recipientPhone: testPhone,
      content: 'Mensaje con carrera de worker zombi',
    });

    const [claimedA] = await outboxRepository.claimPendingBatch(1);
    const staleToken = claimedA.lock_token!;
    expect(staleToken).toBeDefined();

    // 2. Simular que Worker B o Reaper tomó la fila y le asignó un nuevo lock_token
    const newToken = 'a0000000-b111-c222-d333-e44444444444';
    await db.query(
      `UPDATE public.outbox_messages SET status = 'PROCESSING', lock_token = $1, last_error = 'Reassigned to Worker B' WHERE id = $2;`,
      [newToken, msg.id]
    );

    // 3. Worker A (zombi) intenta release con su staleToken
    const releaseResult = await outboxRepository.release(msg.id, staleToken, 10);
    expect(releaseResult).toBe(false);

    // Fila en BD sigue intacta con el token de Worker B
    let state = await outboxRepository.findById(msg.id);
    expect(state?.status).toBe('PROCESSING');
    expect(state?.lock_token).toBe(newToken);
    expect(state?.last_error).toBe('Reassigned to Worker B');

    // 4. Worker A (zombi) intenta terminalFailed con su staleToken
    const terminalResult = await outboxRepository.terminalFailed(msg.id, staleToken, 'Worker A fatal error');
    expect(terminalResult).toBeNull();

    // Fila en BD sigue intacta
    state = await outboxRepository.findById(msg.id);
    expect(state?.status).toBe('PROCESSING');
    expect(state?.lock_token).toBe(newToken);
    expect(state?.last_error).toBe('Reassigned to Worker B');
  });

  // =========================================================================
  // TEST 8: stop() durante un lote: espera y no deja filas en PROCESSING (Auditor R2)
  // =========================================================================
  it('Ciclo de Vida 8: stop() durante un lote: espera y no deja filas en PROCESSING', async () => {
    // 1. Encolar mensaje
    const msg = await outboxRepository.enqueueMessage({
      conversationId,
      phoneNumberId: 'phone_123',
      recipientPhone: testPhone,
      content: 'Mensaje despachándose durante stop()',
    });

    let sendStartedResolve!: () => void;
    const sendStarted = new Promise<void>((r) => { sendStartedResolve = r; });

    let allowSendToFinishResolve!: () => void;
    const allowSendToFinish = new Promise<void>((r) => { allowSendToFinishResolve = r; });

    // 2. Simular envío de WhatsApp que se mantiene en vuelo hasta nuestra señal
    vi.spyOn(whatsappClient, 'sendTextMessage').mockImplementation(async () => {
      sendStartedResolve();
      await allowSendToFinish;
      return 'wamid.HBgL_GRACEFUL_STOP_OK';
    });

    // 3. Iniciar dispatcher con daemon
    outboxDispatcher.start();

    // Esperar a que el despacho esté efectivamente en vuelo
    await sendStarted;

    // 4. Invocar stop() concurrentemente mientras el lote está en vuelo
    const stopPromise = outboxDispatcher.stop();

    // Liberar la llamada de red
    allowSendToFinishResolve();

    // Esperar a que stop() resuelva limpiamente
    await stopPromise;

    // 5. Invariante del Auditor (R2):
    // stop() esperó a inFlight. El mensaje terminó exitosamente y NO quedó huérfano en PROCESSING
    const check = await outboxRepository.findById(msg.id);
    expect(check?.status).toBe('SENT');
    expect(check?.wamid).toBe('wamid.HBgL_GRACEFUL_STOP_OK');

    const { rows } = await db.query(
      `SELECT count(*) FROM public.outbox_messages WHERE status = 'PROCESSING';`
    );
    expect(parseInt(rows[0].count, 10)).toBe(0);
  });
});
