import { defineConfig } from 'vitest/config'

// Explicit same-installation acceptance after each native full batch.
export default defineConfig({ test: { include: ['tests/data-root-installed.probe.ts'], fileParallelism: false, testTimeout: 1800000, hookTimeout: 30000 } })
