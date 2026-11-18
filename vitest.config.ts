import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 45000,
    hookTimeout: 45000,
    fileParallelism: false, // Ejecución secuencial suite por suite para aislamiento total en Supabase
    maxWorkers: 1,
    minWorkers: 1,
    sequence: {
      concurrent: false,
    },
    setupFiles: ['./tests/setup.ts'],
  },
});
