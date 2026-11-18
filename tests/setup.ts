import { assertTestDatabase } from '../src/utils/databaseGuard.js';
import { env } from '../src/config/env.js';

// Auditor 5A: Validar que los tests corran exclusivamente contra el proyecto dedicado
assertTestDatabase(env.DATABASE_URL, 'Vitest Test Suite');
