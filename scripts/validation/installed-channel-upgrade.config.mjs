import { defineConfig } from 'vitest/config'

// Explicit ticket acceptance on an owned installed candidate; no implicit CI gate.
export default defineConfig({ test: { include: ['tests/installed-channel-upgrade.probe.ts'], fileParallelism: false, testTimeout: 2400000 } })
