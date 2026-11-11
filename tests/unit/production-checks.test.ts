import { describe, expect, it, vi } from 'vitest'
import { mfaHealthCheck, productionConfigFindings, securityStartupProblems, type MfaOverviewRow } from '@/lib/security/production-checks'

// Final fix Y (final review A I-1, B I-1 and B minor 3): what a production installation must not start with, in its own file (the
// existing self-checks call it with one line). Development: nothing is asked and nothing is refused.

const prodWeb = {
  DRISHTI_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://drishti.example.test', NEXT_PUBLIC_STREAM_GATEWAY_URL: '/',
}
const org = (o: Partial<MfaOverviewRow> = {}): MfaOverviewRow => ({ org_id: '11111111-1111-4111-8111-111111111111', enforced: true, opted_out: false, reason: null, off_at: null, ...o })

describe('production configuration (B minor 3)', () => {
  it('the web app needs its https address, a policy that blocks, and a video address over TLS', () => {
    expect(productionConfigFindings('web', prodWeb).problems).toEqual([])
    expect(productionConfigFindings('web', { ...prodWeb, NEXT_PUBLIC_APP_URL: '' }).problems.join(' ')).toMatch(/NEXT_PUBLIC_APP_URL is not set/)
    expect(productionConfigFindings('web', { ...prodWeb, NEXT_PUBLIC_APP_URL: 'http://drishti.example.test' }).problems.join(' ')).toMatch(/https/)
    expect(productionConfigFindings('web', { ...prodWeb, NEXT_PUBLIC_APP_URL: 'not a url' }).problems.join(' ')).toMatch(/NEXT_PUBLIC_APP_URL/)
    expect(productionConfigFindings('web', { ...prodWeb, CSP_REPORT_ONLY: '1' }).problems.join(' ')).toMatch(/CSP_REPORT_ONLY/)
    expect(productionConfigFindings('web', { ...prodWeb, CSP_REPORT_ONLY: '0' }).problems).toEqual([])
    expect(productionConfigFindings('web', { ...prodWeb, NEXT_PUBLIC_STREAM_GATEWAY_URL: 'http://10.0.0.5:3412' }).problems.join(' ')).toMatch(/NEXT_PUBLIC_STREAM_GATEWAY_URL/)
    expect(productionConfigFindings('web', { ...prodWeb, NEXT_PUBLIC_STREAM_GATEWAY_URL: 'wss://drishti.example.test/g' }).problems).toEqual([])
    expect(productionConfigFindings('web', { ...prodWeb, NEXT_PUBLIC_STREAM_GATEWAY_URL: '' }).problems).toEqual([]) // the app's own address
  })

  it('the gateway listens on this computer only (the TLS proxy is the one listener on the network)', () => {
    const g = { DRISHTI_ENV: 'production' }
    for (const host of ['127.0.0.1', '::1']) expect(productionConfigFindings('gateway', { ...g, GATEWAY_HOST: host }).problems, host).toEqual([])
    for (const host of ['', '0.0.0.0', '10.0.0.5', 'localhost']) {
      expect(productionConfigFindings('gateway', { ...g, GATEWAY_HOST: host }).problems.join(' '), host).toMatch(/GATEWAY_HOST/)
    }
  })

  it('development: nothing', () => {
    expect(productionConfigFindings('web', {})).toEqual({ problems: [], warnings: [] })
    expect(productionConfigFindings('gateway', { GATEWAY_HOST: '0.0.0.0' })).toEqual({ problems: [], warnings: [] })
  })
})

describe('two-step sign-in at start-up (A I-1, B I-1)', () => {
  const deps = (rows: MfaOverviewRow[] | Error) => ({ mfaOverview: vi.fn(async () => { if (rows instanceof Error) throw rows; return rows }) })

  it('production refuses while an active organisation has it off without an audited opt-out; an opt-out is a warning', async () => {
    expect(await securityStartupProblems(prodWeb, deps([org()]))).toEqual({ problems: [], warnings: [] })
    const off = await securityStartupProblems(prodWeb, deps([org(), org({ org_id: '22222222-2222-4222-8222-222222222222', enforced: false })]))
    expect(off.problems.join(' ')).toMatch(/1 organisation.*two-step sign-in.*security_set_mfa/)
    const opted = await securityStartupProblems(prodWeb, deps([org({ enforced: false, opted_out: true, reason: 'Staged roll-out this week', off_at: '2026-11-11T05:00:00Z' })]))
    expect(opted.problems).toEqual([])
    expect(opted.warnings.join(' ')).toMatch(/switched off on purpose/)
  })

  it('production: an unreadable answer refuses (fail closed); the configuration problems come too', async () => {
    expect((await securityStartupProblems(prodWeb, deps(new Error('down')))).problems.join(' ')).toMatch(/could not be checked/)
    expect((await securityStartupProblems({ ...prodWeb, CSP_REPORT_ONLY: 'yes' }, deps([org()]))).problems.join(' ')).toMatch(/CSP_REPORT_ONLY/)
  })

  it('development: nothing is asked', async () => {
    const d = deps([org({ enforced: false })])
    expect(await securityStartupProblems({}, d)).toEqual({ problems: [], warnings: [] })
    expect(d.mfaOverview).not.toHaveBeenCalled()
  })
})

describe('the Health page check of two-step sign-in', () => {
  it('production: off without an opt-out fails, an opt-out warns, all on is ok; development: never fails', () => {
    expect(mfaHealthCheck({ mfa: { active: 2, enforced: 2, off: 0, opted_out: 0 } }, true).state).toBe('ok')
    const failed = mfaHealthCheck({ mfa: { active: 2, enforced: 1, off: 1, opted_out: 0 } }, true)
    expect(failed.state).toBe('failed')
    expect(failed.summary).toMatch(/1 organisation/)
    expect(mfaHealthCheck({ mfa: { active: 2, enforced: 1, off: 0, opted_out: 1 } }, true).state).toBe('warning')
    expect(mfaHealthCheck({ mfa: { active: 2, enforced: 0, off: 2, opted_out: 0 } }, false).state).toBe('ok')
    expect(mfaHealthCheck(null, true).state).toBe('unknown')
    expect(mfaHealthCheck({}, true).state).toBe('unknown')
    expect(mfaHealthCheck({ mfa: { active: 1, enforced: 1, off: 0, opted_out: 0 } }, true)).toMatchObject({ key: 'mfa', label: 'Two-step sign-in' })
  })
})
