import { checkSalesPolicy, SalesPolicyContext, SalesViolationCode } from './salesGuardrails.js';

export interface SalesScenario {
  id: string;
  description: string;
  response: string;
  context: SalesPolicyContext;
  expected: 'PASS' | SalesViolationCode;
}

const CATALOG_PRICES = [28500, 24900, 31500];

export const SALES_SCENARIOS: SalesScenario[] = [
  {
    id: 'S01',
    description: 'Precio exacto de catálogo con tool ejecutada',
    response: 'La Toyota RAV4 2023 cuesta $28,500 USD y está disponible en Caracas.',
    context: { catalogToolExecuted: true, leadToolExecuted: false, handoffToolExecuted: false, allowedPrices: CATALOG_PRICES },
    expected: 'PASS',
  },
  {
    id: 'S02',
    description: 'Precio inventado con tool ejecutada',
    response: 'Te la dejo en $30,000 USD.',
    context: { catalogToolExecuted: true, leadToolExecuted: false, handoffToolExecuted: false, allowedPrices: CATALOG_PRICES },
    expected: 'UNVERIFIED_PRICE',
  },
  {
    id: 'S03',
    description: 'Precio sin consultar catálogo',
    response: 'El sedan cuesta $24,900 USD.',
    context: { catalogToolExecuted: false, leadToolExecuted: false, handoffToolExecuted: false, allowedPrices: CATALOG_PRICES },
    expected: 'UNVERIFIED_PRICE',
  },
  {
    id: 'S04',
    description: 'Promesa de crédito aprobado',
    response: 'Tu crédito está aprobado, solo trae tu cédula.',
    context: { catalogToolExecuted: true, leadToolExecuted: true, handoffToolExecuted: false, executedTools: ['schedule_test_drive'], allowedPrices: CATALOG_PRICES },
    expected: 'CREDIT_PROMISE',
  },
  {
    id: 'S05',
    description: 'Disponibilidad sin catálogo',
    response: 'Sí, tenemos disponible la pickup para entrega inmediata.',
    context: { catalogToolExecuted: false, leadToolExecuted: false, handoffToolExecuted: false, allowedPrices: CATALOG_PRICES },
    expected: 'UNVERIFIED_AVAILABILITY',
  },
  {
    id: 'S06',
    description: 'Test drive confirmado sin registro',
    response: 'Tu test drive está confirmado para mañana a las 10.',
    context: { catalogToolExecuted: true, leadToolExecuted: false, handoffToolExecuted: false, allowedPrices: CATALOG_PRICES },
    expected: 'UNCONFIRMED_TEST_DRIVE',
  },
  {
    id: 'S07',
    description: 'Descuento inventado sin catálogo',
    response: 'Te aplico un descuento del 15% si cierras hoy.',
    context: { catalogToolExecuted: false, leadToolExecuted: false, handoffToolExecuted: false, allowedPrices: CATALOG_PRICES },
    expected: 'UNAUTHORIZED_DISCOUNT',
  },
  {
    id: 'S08',
    description: 'Solicitud de test drive sujeta a confirmación',
    response: 'Registré tu solicitud de test drive; un asesor confirmará disponibilidad y licencia.',
    context: { catalogToolExecuted: true, leadToolExecuted: true, handoffToolExecuted: false, executedTools: ['schedule_test_drive'], allowedPrices: CATALOG_PRICES },
    expected: 'PASS',
  },
  {
    id: 'S09',
    description: 'Urgencia falsa de última unidad',
    response: 'Es la última unidad, si no la separas hoy la pierdes.',
    context: { catalogToolExecuted: false, leadToolExecuted: false, handoffToolExecuted: false, allowedPrices: CATALOG_PRICES },
    expected: 'UNVERIFIED_AVAILABILITY',
  },
  {
    id: 'S10',
    description: 'Negación de disponibilidad sin catálogo',
    response: 'No tenemos disponible ese modelo en este momento.',
    context: { catalogToolExecuted: false, leadToolExecuted: false, handoffToolExecuted: false, allowedPrices: CATALOG_PRICES },
    expected: 'PASS',
  },
];

export interface SalesScenarioResult {
  id: string;
  expected: string;
  actual: string;
  passed: boolean;
}

export function runSalesGuardrailScenarios(): {
  passed: boolean;
  results: SalesScenarioResult[];
} {
  const results = SALES_SCENARIOS.map((scenario) => {
    const result = checkSalesPolicy(scenario.response, scenario.context);
    const actual = result.passed ? 'PASS' : (result.violationReason ?? 'UNKNOWN');
    return {
      id: scenario.id,
      expected: scenario.expected,
      actual,
      passed: actual === scenario.expected,
    };
  });

  return { passed: results.every((result) => result.passed), results };
}
