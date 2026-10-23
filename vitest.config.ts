import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    // Integration tests share one local database; run files one after another.
    fileParallelism: false,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup/env.ts', 'tests/setup/egress-guard.ts'],
    // Fails the run (after cleaning them) when a test leaves one of its test organisations behind.
    globalSetup: ['tests/setup/test-orgs-ledger.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
})
