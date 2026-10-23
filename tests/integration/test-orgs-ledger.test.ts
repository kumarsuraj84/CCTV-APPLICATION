// P5.4 review round 1: the run's test-organisation ledger (tests/setup/test-orgs-ledger.ts, vitest globalSetup) fails loudly when a
// test leaves an organisation behind, and cleans it. Driven here with a ledger of its own, so the run's real ledger is untouched.
import { afterEach, describe, expect, it } from 'vitest'
import setup, { LEDGER_ENV } from '../setup/test-orgs-ledger'
import { adminClient, cleanupOrg, createOrg } from '../setup/fixtures'

describe('test organisation ledger', () => {
  const runLedger = process.env[LEDGER_ENV]
  afterEach(() => {
    if (runLedger === undefined) delete process.env[LEDGER_ENV]
    else process.env[LEDGER_ENV] = runLedger
  })

  it('an organisation left behind fails the run and is cleaned up; one cleaned by its test passes', async () => {
    const teardown = setup()
    const forgotten = await createOrg()
    const tidy = await createOrg()
    await cleanupOrg(tidy)
    await expect(teardown()).rejects.toThrow(/^1 test organisation\(s\) were left behind .*all of them are cleaned up now/)
    expect((await adminClient().from('organizations').select('id').eq('id', forgotten)).data).toEqual([])

    const clean = setup()
    await cleanupOrg(await createOrg())
    await expect(clean()).resolves.toBeUndefined()
  })
})
