import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 150_000,
    hookTimeout: 150_000,
  },
})
