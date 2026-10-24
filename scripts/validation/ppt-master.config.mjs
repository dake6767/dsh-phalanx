import { defineConfig } from 'vitest/config'

// Explicit real-service acceptance. Missing inputs fail; regular CI never selects it.
export default defineConfig({ test: { include: ['tests/ppt-master.probe.ts'], fileParallelism: false, testTimeout: 1_800_000, hookTimeout: 300_000 } })
