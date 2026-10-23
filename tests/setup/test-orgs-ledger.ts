// P5.4 review round 1: a test run must leave no test organisation behind.
//
// Vitest global set-up (vitest.config.ts globalSetup). Before any test file runs it opens a ledger file for this run and passes its
// path to the test workers in DRISHTI_TEST_ORG_LEDGER; tests/setup/fixtures.ts createOrg() writes the id of every organisation it
// makes into it. After the last file, every organisation of the ledger that still exists is cleaned up with cleanupOrg() (the same
// clean-up the tests use) and the run FAILS, naming how many were left, so the test that forgot its clean-up is found and fixed.
// Only this run's own organisations are touched: another run of the suite at the same time (another builder) has its own ledger.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const LEDGER_ENV = 'DRISHTI_TEST_ORG_LEDGER'

export default function setup(): () => Promise<void> {
  const ledger = path.join(tmpdir(), `drishti-test-orgs-${process.pid}-${randomUUID().slice(0, 8)}.txt`)
  writeFileSync(ledger, '')
  process.env[LEDGER_ENV] = ledger
  return async () => {
    try {
      const ids = [...new Set(readFileSync(ledger, 'utf8').split(/\r?\n/).filter((l) => /^[0-9a-f-]{36}$/.test(l)))]
      if (ids.length === 0) return
      try {
        process.loadEnvFile(path.resolve(__dirname, '../../.env.local'))
      } catch {
        // As tests/setup/env.ts: whatever is already in process.env.
      }
      const { adminClient, cleanupOrg } = await import('./fixtures')
      const left: string[] = []
      for (let i = 0; i < ids.length; i += 100) {
        const { data, error } = await adminClient().from('organizations').select('id, slug').in('id', ids.slice(i, i + 100))
        if (error) throw new Error(`test organisations check: ${error.message}`)
        for (const o of data ?? []) if (o.slug.startsWith('test-')) left.push(o.id)
      }
      if (left.length === 0) return
      const failed: string[] = []
      for (const id of left) await cleanupOrg(id).catch((e: unknown) => failed.push(`${id}: ${e instanceof Error ? e.message : String(e)}`))
      throw new Error(
        `${left.length} test organisation(s) were left behind by this run (a test without its cleanupOrg); ` +
          (failed.length ? `${failed.length} could not be cleaned: ${failed.join('; ')}` : 'all of them are cleaned up now') +
          '. Find the test that made them and clean up in its afterAll.',
      )
    } finally {
      if (existsSync(ledger)) rmSync(ledger, { force: true })
    }
  }
}
