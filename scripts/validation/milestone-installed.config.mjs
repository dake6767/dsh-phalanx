import { defineConfig } from 'vitest/config'

// Explicit installed acceptance. The installation owner supplies the existing context.
export default defineConfig({ test: { include: ['tests/milestone-installed.probe.ts'], fileParallelism: false, testTimeout: 900_000, hookTimeout: 30_000 } })
