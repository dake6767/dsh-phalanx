import { defineConfig } from 'vitest/config'

// Explicit credentialed facts probe, excluded from all regular quick and Linux inventories.
export default defineConfig({ test: { include: ['tests/office-facts.probe.ts'], fileParallelism: false, testTimeout: 1_200_000, hookTimeout: 300_000 } })
