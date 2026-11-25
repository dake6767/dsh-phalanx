import { totalmem } from 'node:os'
import { defineConfig } from 'vitest/config'
import { resolveValidationMaxWorkers } from './scripts/fast-check-policy.mjs'

const resolvedWorkers = resolveValidationMaxWorkers(process.env.DSH_PHALANX_VALIDATION_MAX_WORKERS, totalmem())
const maxWorkers = resolvedWorkers === 'default' ? undefined : Number(resolvedWorkers)

export default defineConfig({
  test: {
    globalSetup: ['tests/support/postgres-setup.ts'],
    setupFiles: ['tests/support/postgres-cleanup.ts'],
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/**/*.e2e.ts'],
    testTimeout: 15_000,
    maxConcurrency: 4,
    ...(maxWorkers !== undefined ? { maxWorkers } : {}),
  },
})
