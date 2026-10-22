import { describe, expect, it } from 'vitest'
import { totpSuiteMode, TOTP_SKIP_REASON } from '../helpers/totp'

// P3-1 review I-6: the end-to-end tests of the second factor must not vanish quietly. With TOTP available they run; without it they
// FAIL when MULTI_FACTOR_TEST=required (the owner sets it once the stack has been restarted with TOTP on) and otherwise skip with
// the reason printed.

describe('when the authenticator-app tests run', () => {
  it('run whenever the auth server offers TOTP', () => {
    expect(totpSuiteMode({}, true)).toBe('run')
    expect(totpSuiteMode({ MULTI_FACTOR_TEST: 'required' }, true)).toBe('run')
  })
  it('fail loudly when they are required and TOTP is not available', () => {
    expect(totpSuiteMode({ MULTI_FACTOR_TEST: 'required' }, false)).toBe('fail')
    expect(totpSuiteMode({ MULTI_FACTOR_TEST: 'REQUIRED' }, false)).toBe('fail')
  })
  it('otherwise skip, with a reason that says how to make them run', () => {
    expect(totpSuiteMode({}, false)).toBe('skip')
    expect(TOTP_SKIP_REASON).toMatch(/MULTI_FACTOR_TEST=required/)
    expect(TOTP_SKIP_REASON).toMatch(/db:stop/)
  })
})
