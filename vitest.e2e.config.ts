import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['tests/support/postgres-setup.ts'],
    setupFiles: ['tests/support/postgres-cleanup.ts'],
    include: ['tests/**/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 150_000,
    hookTimeout: 150_000,
  },
})
