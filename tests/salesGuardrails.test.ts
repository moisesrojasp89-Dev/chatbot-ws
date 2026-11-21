import { describe, expect, it } from 'vitest';
import {
  checkSalesPolicy,
  extractMonetaryValues,
} from '../src/harness/salesGuardrails.js';
import { runSalesGuardrailScenarios } from '../src/harness/salesScenarios.js';

const allowedPrices = [28500, 24900, 31500];

describe('Guardrails de ventas', () => {
  it('pasa los 10 escenarios adversariales definidos por el pack', () => {
    const run = runSalesGuardrailScenarios();

    expect(run.results).toHaveLength(10);
    expect(run.passed).toBe(true);
  });

  it('extrae montos con separadores de miles y decimales', () => {
    expect(extractMonetaryValues('Cuesta $28,500 USD o USD 24.900')).toEqual([28500, 24900]);
    expect(extractMonetaryValues('Sin cifras')).toEqual([]);
  });

  it('bloquea crédito, test drive y descuentos no autorizados con respuesta segura', () => {
    const credit = checkSalesPolicy('Tu crédito está aprobado y sin requisitos.', {
      catalogToolExecuted: true,
      leadToolExecuted: true,
      handoffToolExecuted: false,
      allowedPrices,
    });
    expect(credit.violationReason).toBe('CREDIT_PROMISE');
    expect(credit.sanitizedResponse).toContain('asesor');

    const testDrive = checkSalesPolicy('Tu test drive está confirmado para mañana.', {
      catalogToolExecuted: true,
      leadToolExecuted: false,
      handoffToolExecuted: false,
      allowedPrices,
    });
    expect(testDrive.violationReason).toBe('UNCONFIRMED_TEST_DRIVE');

    const discount = checkSalesPolicy('Te doy 15% de descuento.', {
      catalogToolExecuted: false,
      leadToolExecuted: false,
      handoffToolExecuted: false,
      allowedPrices,
    });
    expect(discount.violationReason).toBe('UNAUTHORIZED_DISCOUNT');
  });
  it('maneja bolívares y separadores mixtos sin falsos positivos', () => {
    expect(extractMonetaryValues('Precio: Bs. 28.500,00')).toEqual([28500]);
    expect(extractMonetaryValues('Son 30.000 Bs.')).toEqual([30000]);
    expect(extractMonetaryValues('Precio: $1.234,56')).toEqual([1234.56]);
  });

  it('distingue negaciones de disponibilidad y bloquea afirmaciones equivalentes', () => {
    const base = {
      catalogToolExecuted: false,
      leadToolExecuted: false,
      handoffToolExecuted: false,
      allowedPrices,
    };
    expect(checkSalesPolicy('No tenemos disponible ese modelo.', base).passed).toBe(true);
    expect(checkSalesPolicy('Quedan existencias en el lote.', base).violationReason).toBe(
      'UNVERIFIED_AVAILABILITY'
    );
  });

  it('solo permite confirmar test drive si la tool de agenda se ejecutó, y no bloquea negaciones de crédito', () => {
    const noSchedule = {
      catalogToolExecuted: true,
      leadToolExecuted: true,
      handoffToolExecuted: false,
      allowedPrices,
    };
    expect(checkSalesPolicy('Agendé tu test drive para mañana.', noSchedule).violationReason).toBe(
      'UNCONFIRMED_TEST_DRIVE'
    );
    expect(
      checkSalesPolicy('Agendé tu test drive para mañana.', {
        ...noSchedule,
        executedTools: ['schedule_test_drive'],
      }).passed
    ).toBe(true);

    expect(
      checkSalesPolicy('La aprobación no es inmediata; requiere revisión.', noSchedule).passed
    ).toBe(true);
    expect(
      checkSalesPolicy('El banco ya te aprobó el crédito.', noSchedule).violationReason
    ).toBe('CREDIT_PROMISE');
  });
});
