import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/**/*.e2e.ts'],
    testTimeout: 15_000,
    ...(process.env.DSH_PHALANX_VALIDATION_MAX_WORKERS === '2' ? { maxWorkers: 2 } : {}),
  },
})
