import { describe, expect, it } from 'vitest'
import { configHasTotp, totpSuiteMode, TOTP_SKIP_REASON } from '../helpers/totp'

// P3-1 review I-6: the end-to-end tests of the second factor must not vanish quietly. With TOTP available they run.
// Release 1 clean-ups (re-review R-2): when supabase/config.toml switches TOTP on, a plain `npm run test:integration` FAILS if the auth
// server the tests reach does not offer it (the stack was not restarted) — required by default. Only MULTI_FACTOR_TEST=skip skips on
// purpose; without TOTP in the config they skip with the reason printed (or fail with MULTI_FACTOR_TEST=required, or in CI).

describe('when the authenticator-app tests run', () => {
  it('run whenever the auth server offers TOTP', () => {
    expect(totpSuiteMode({}, true, true)).toBe('run')
    expect(totpSuiteMode({ MULTI_FACTOR_TEST: 'required' }, true, false)).toBe('run')
    expect(totpSuiteMode({ MULTI_FACTOR_TEST: 'skip' }, true, true)).toBe('run')
  })
  it('fail loudly by default when the config switches TOTP on but the auth server does not offer it (the stack was not restarted)', () => {
    expect(totpSuiteMode({}, false, true)).toBe('fail')
    expect(totpSuiteMode({ MULTI_FACTOR_TEST: 'required' }, false, true)).toBe('fail')
  })
  it('fail when they are required (MULTI_FACTOR_TEST=required, or CI) and TOTP is not available', () => {
    expect(totpSuiteMode({ MULTI_FACTOR_TEST: 'required' }, false, false)).toBe('fail')
    expect(totpSuiteMode({ MULTI_FACTOR_TEST: 'REQUIRED' }, false, false)).toBe('fail')
    expect(totpSuiteMode({ CI: 'true' }, false, false)).toBe('fail')
  })
  it('skip only on purpose (MULTI_FACTOR_TEST=skip) or when the config has no TOTP, with a reason that says how to make them run', () => {
    expect(totpSuiteMode({ MULTI_FACTOR_TEST: 'skip' }, false, true)).toBe('skip')
    expect(totpSuiteMode({}, false, false)).toBe('skip')
    expect(TOTP_SKIP_REASON).toMatch(/MULTI_FACTOR_TEST=skip/)
    expect(TOTP_SKIP_REASON).toMatch(/db:stop/)
  })
  it('reads the switch from supabase/config.toml ([auth.mfa.totp] enroll_enabled), which is on in this repository', () => {
    expect(configHasTotp()).toBe(true)
    expect(configHasTotp('[auth.mfa.totp]\nenroll_enabled = false\nverify_enabled = true\n')).toBe(false)
    expect(configHasTotp('[auth.mfa.totp]\n# comment\nenroll_enabled = true\n[auth.mfa.phone]\nenroll_enabled = false\n')).toBe(true)
    expect(configHasTotp('[auth.mfa.phone]\nenroll_enabled = true\n')).toBe(false)
  })
})
