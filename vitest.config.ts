import { configDefaults, defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    // Integration tests share one local database; run files one after another.
    fileParallelism: false,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // P5.4 fix round 3: the Windows lab suite (real access lists, junctions, the compiled service host) runs only on purpose, on the
    // production server: npm run test:windows-lab with DRISHTI_WINDOWS_LAB=1 (docs/drishti/runbooks/windows-services.md section 7).
    exclude: process.env.DRISHTI_WINDOWS_LAB === '1' ? configDefaults.exclude : [...configDefaults.exclude, 'tests/windows-lab/**'],
    setupFiles: ['tests/setup/env.ts', 'tests/setup/egress-guard.ts'],
    // Fails the run (after cleaning them) when a test leaves one of its test organisations behind.
    globalSetup: ['tests/setup/test-orgs-ledger.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
})
