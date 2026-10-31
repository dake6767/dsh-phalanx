import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['tests/support/postgres-setup.ts'],
    setupFiles: ['tests/support/postgres-cleanup.ts'],
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/**/*.e2e.ts'],
    testTimeout: 15_000,
    ...(['1', '2'].includes(process.env.DSH_PHALANX_VALIDATION_MAX_WORKERS ?? '')
      ? { maxWorkers: Number(process.env.DSH_PHALANX_VALIDATION_MAX_WORKERS) }
      : {}),
  },
})
