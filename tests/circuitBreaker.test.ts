import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker, channelCircuitBreaker, getChannelCircuitBreaker } from '../src/utils/circuitBreaker.js';

describe('Fase 4: Circuit Breaker de Red (Meta Graph API)', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 50, // 50ms para pruebas unitarias ultra rápidas
      halfOpenSuccesses: 2,
    });
  });

  it('debe iniciar en estado CLOSED con 0 fallos', () => {
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(0);
  });

  it('debe ejecutar acciones exitosas y mantener el estado CLOSED', async () => {
    const action = vi.fn().mockResolvedValue('ok');
    const result = await breaker.execute(action);

    expect(result).toBe('ok');
    expect(action).toHaveBeenCalledTimes(1);
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(0);
  });

  it('debe transicionar a OPEN al alcanzar el umbral de fallos consecutivos', async () => {
    const failingAction = vi.fn().mockRejectedValue(new Error('Network error 503'));

    // Fallos 1 y 2: sigue en CLOSED
    await expect(breaker.execute(failingAction)).rejects.toThrow('Network error 503');
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(1);

    await expect(breaker.execute(failingAction)).rejects.toThrow('Network error 503');
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(2);

    // Fallo 3: alcanza threshold (3) -> pasa a OPEN
    await expect(breaker.execute(failingAction)).rejects.toThrow('Network error 503');
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.getFailureCount()).toBe(3);
  });

  it('debe rechazar solicitudes inmediatamente en estado OPEN sin ejecutar la acción', async () => {
    const failingAction = vi.fn().mockRejectedValue(new Error('Network error 503'));
    const protectedAction = vi.fn().mockResolvedValue('ok');

    // Forzar 3 fallos para abrir circuito
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failingAction)).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('OPEN');

    // Intentar ejecutar cuando está OPEN
    await expect(breaker.execute(protectedAction)).rejects.toThrow(
      'CIRCUIT_BREAKER_OPEN: Circuit is OPEN, requests rejected'
    );
    expect(protectedAction).not.toHaveBeenCalled();
  });

  it('debe pasar a HALF_OPEN tras transcurrir resetTimeoutMs y volver a CLOSED tras éxitos', async () => {
    const failingAction = vi.fn().mockRejectedValue(new Error('Service down'));
    const successAction = vi.fn().mockResolvedValue('success');

    // Abrir circuito
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failingAction)).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('OPEN');

    // Esperar periodo de enfriamiento (55ms > 50ms)
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Estado debe pasar a HALF_OPEN
    expect(breaker.getState()).toBe('HALF_OPEN');

    // Éxito 1 en HALF_OPEN
    const res1 = await breaker.execute(successAction);
    expect(res1).toBe('success');
    expect(breaker.getState()).toBe('HALF_OPEN');

    // Éxito 2 en HALF_OPEN (alcanza halfOpenSuccesses = 2) -> transiciona a CLOSED
    const res2 = await breaker.execute(successAction);
    expect(res2).toBe('success');
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(0);
  });

  it('debe volver inmediatamente a OPEN si ocurre un fallo durante HALF_OPEN', async () => {
    const failingAction = vi.fn().mockRejectedValue(new Error('Flaky failure'));

    // Abrir circuito
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failingAction)).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('OPEN');

    // Esperar enfriamiento
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(breaker.getState()).toBe('HALF_OPEN');

    // Fallo durante HALF_OPEN
    await expect(breaker.execute(failingAction)).rejects.toThrow('Flaky failure');
    expect(breaker.getState()).toBe('OPEN');
  });

  it('debe permitir reinicio manual mediante reset()', async () => {
    const failingAction = vi.fn().mockRejectedValue(new Error('Error'));
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failingAction)).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('OPEN');

    breaker.reset();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(0);
  });

  it('I14: no debe contabilizar fallos ni abrir circuito si shouldTrip devuelve false (errores 4xx)', async () => {
    const clientErrorAction = vi.fn().mockRejectedValue({ status: 400, isTransient: false });
    const shouldTrip = (err: unknown) => (err as { isTransient?: boolean })?.isTransient ?? true;

    // Ejecutar 5 veces un error no transitorio (4xx)
    for (let i = 0; i < 5; i++) {
      await expect(breaker.execute(clientErrorAction, shouldTrip)).rejects.toBeDefined();
    }

    // El circuito debe permanecer CLOSED y con 0 fallos contabilizados
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(0);
  });

  it('Auditor 5A: un error 4xx (no transitorio) durante HALF_OPEN cuenta como servicio vivo e incrementa éxitos hacia CLOSED', async () => {
    const failingAction = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));
    const clientErrorAction = vi.fn().mockRejectedValue({ status: 400, isTransient: false });
    const shouldTrip = (err: unknown) => (err as { isTransient?: boolean })?.isTransient ?? true;

    // 1. Abrir circuito (3 fallos transitorios)
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failingAction, shouldTrip)).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('OPEN');

    // 2. Esperar reset timeout para transicionar a HALF_OPEN
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(breaker.getState()).toBe('HALF_OPEN');

    // 3. Sonda 1 en HALF_OPEN recibe un error 4xx de cliente (Meta vivo)
    await expect(breaker.execute(clientErrorAction, shouldTrip)).rejects.toBeDefined();
    // Suma 1 éxito (halfOpenSuccesses es 2), sigue en HALF_OPEN
    expect(breaker.getState()).toBe('HALF_OPEN');

    // 4. Sonda 2 en HALF_OPEN recibe otro 4xx de cliente -> alcanza 2 éxitos y transiciona a CLOSED
    await expect(breaker.execute(clientErrorAction, shouldTrip)).rejects.toBeDefined();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(0);
  });

  it('Auditor 5A: un error 4xx en estado CLOSED reinicia la racha de fallos consecutivos', async () => {
    const failingAction = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));
    const clientErrorAction = vi.fn().mockRejectedValue({ status: 400, isTransient: false });
    const shouldTrip = (err: unknown) => (err as { isTransient?: boolean })?.isTransient ?? true;

    // 2 fallos transitorios
    await expect(breaker.execute(failingAction, shouldTrip)).rejects.toThrow();
    await expect(breaker.execute(failingAction, shouldTrip)).rejects.toThrow();
    expect(breaker.getFailureCount()).toBe(2);

    // Ocurre un 4xx (demuestra que Meta respondió)
    await expect(breaker.execute(clientErrorAction, shouldTrip)).rejects.toBeDefined();

    // Racha de fallos reiniciada a 0
    expect(breaker.getFailureCount()).toBe(0);
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('B3: trip(600000) no se deshace con fallos en vuelo posteriores (persistencia de openUntil)', async () => {
    const cb = new CircuitBreaker({ resetTimeoutMs: 50 }); // 50ms reset timeout normal
    cb.trip(600000); // 10 minutos forzados
    expect(cb.getState()).toBe('OPEN');
    const initialOpenUntil = cb.getOpenUntil();
    expect(initialOpenUntil).toBeGreaterThan(Date.now() + 500000);

    // Llega un fallo en vuelo posterior
    cb.recordFailure(new Error('In-flight failure'));

    // B3: No debe reescribir openUntil acortando la pausa
    expect(cb.getOpenUntil()).toBe(initialOpenUntil);

    // Simular paso del tiempo normal (más de los 50ms de resetTimeoutMs)
    await new Promise((resolve) => setTimeout(resolve, 70));

    // El estado DEBE seguir OPEN porque no ha alcanzado los 10 minutos
    expect(cb.getState()).toBe('OPEN');
  });

  it('I5: CircuitOpenError incluye retryAfterMs dinámico y soporta resultado tri-estado neutral', async () => {
    const cb = new CircuitBreaker({ resetTimeoutMs: 5000 });
    cb.trip(10000);

    try {
      await cb.execute(async () => 'ok');
      expect.fail('Debería haber lanzado CircuitOpenError');
    } catch (err: any) {
      expect(err.name).toBe('CircuitOpenError');
      expect(err.retryAfterMs).toBeGreaterThan(0);
      expect(err.retryAfterMs).toBeLessThanOrEqual(10000);
    }
  });
});


describe('Breaker aislado por canal', () => {
  it('abrir el breaker de Telegram no afecta a WhatsApp', async () => {
    const telegramBreaker = getChannelCircuitBreaker('telegram');
    expect(telegramBreaker).not.toBe(channelCircuitBreaker);

    for (let i = 0; i < 10; i++) {
      await telegramBreaker
        .execute(async () => {
          throw new Error('503 Service Unavailable');
        })
        .catch(() => {});
    }

    expect(telegramBreaker.getState()).toBe('OPEN');
    expect(channelCircuitBreaker.getState()).toBe('CLOSED');
    telegramBreaker.reset();
  });
});