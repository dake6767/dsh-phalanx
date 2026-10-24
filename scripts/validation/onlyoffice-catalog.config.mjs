import { defineConfig } from 'vitest/config'

// Explicit published-plugin acceptance. Missing inputs fail instead of skipping.
export default defineConfig({ test: { include: ['tests/onlyoffice-catalog.probe.ts'], fileParallelism: false, testTimeout: 1_800_000, hookTimeout: 300_000 } })
