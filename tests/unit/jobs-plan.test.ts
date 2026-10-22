import { describe, expect, it } from 'vitest'
import { payloadHash, validatePlan, PLAN_HASH_DOMAIN } from '@/lib/jobs/plan'
import { canonicalize, sha256Hex } from '@/lib/jobs/canonical'
import { FAKE_CAPABILITIES, makePlan, secretRef } from '@/lib/jobs/testing'
import type { Plan } from '@/lib/jobs/types'

const NOW = Date.parse('2026-11-02T04:30:00Z')
const opts = { now: NOW, adapters: { fake: FAKE_CAPABILITIES } }
const fields = (plan: Plan) => validatePlan(plan, opts).map((i) => i.field)

describe('payloadHash', () => {
  it('is the SHA-256 of the domain-tagged canonical JSON of the whole plan', () => {
    const plan = makePlan()
    expect(payloadHash(plan)).toBe(sha256Hex(`${PLAN_HASH_DOMAIN}\n${canonicalize(plan)}`))
    expect(payloadHash(plan)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not depend on key order', () => {
    const a = makePlan({ params: { ssid: 'CK-Staff', vlan: 20 } })
    const b = makePlan({ params: { vlan: 20, ssid: 'CK-Staff' } })
    const reordered = Object.fromEntries(Object.entries(b).reverse()) as unknown as Plan
    expect(payloadHash(a)).toBe(payloadHash(reordered))
  })

  it('changes when any execution field changes', () => {
    const base = payloadHash(makePlan())
    const variants: Partial<Plan>[] = [
      { kind: 'wifi.profile.remove' },
      { adapter: 'other' },
      { adapter_version: '1.0.1' },
      { artifact: { id: 'profile-staff', version: '8', sha256: 'a'.repeat(64) } },
      { artifact: { id: 'profile-staff', version: '7', sha256: 'b'.repeat(64) } },
      { params: { ssid: 'CK-Staff2', security: 'wpa2-psk', passphrase_ref: secretRef('vault:wifi/staff', 7) } },
      { params: { ssid: 'CK-Staff', security: 'wpa2-psk', passphrase_ref: secretRef('vault:wifi/staff', 8) } },
      { policy_version: 4 },
      { target_selector: { location_ids: ['store-2'] } },
      { base_version: { key: 'profile-staff', version: 8 } },
      { supersedes_key: null },
      { setting_paths: ['ssid.staff', 'radio'] },
      { conflict_policy: 'wait' },
      { schedule: { not_before: '2026-11-02T05:30:00Z', window: null } },
      { expires_at: '2026-11-10T04:30:00Z' },
      { canary: { mode: 'none' } },
      { batch: { batch_size: 3, global_concurrency: 2, per_location_concurrency: 1, block_location_on_unknown: true, batch_soak_ms: 0 } },
      { thresholds: { stop_after_failures: 3, stop_after_failure_pct: 50, pct_min_finished: 4, stop_after_consecutive_failures: 2 } },
      { max_attempts: 3 },
      { risk: 'high' },
      { requested_by: 'someone-else' },
    ]
    const seen = new Set([base])
    for (const v of variants) {
      const h = payloadHash(makePlan(v))
      expect(h, JSON.stringify(v)).not.toBe(base)
      seen.add(h)
    }
    expect(seen.size).toBe(variants.length + 1)
  })

  it('is the same for unicode-equivalent parameters', () => {
    expect(payloadHash(makePlan({ params: { ssid: 'Café' } }))).toBe(payloadHash(makePlan({ params: { ssid: 'Café' } })))
  })

  it('throws for a plan whose parameters are not plain JSON', () => {
    expect(() => payloadHash(makePlan({ params: { n: NaN } }))).toThrow()
  })
})

describe('validatePlan', () => {
  it('accepts the default plan', () => {
    expect(validatePlan(makePlan(), opts)).toEqual([])
  })

  it('refuses an unknown adapter or a kind the adapter does not perform', () => {
    expect(fields(makePlan({ adapter: 'nope' }))).toContain('adapter')
    expect(fields(makePlan({ kind: 'wifi.firmware.upgrade' }))).toContain('kind')
  })

  it('refuses an artifact without a proper SHA-256 or version', () => {
    expect(fields(makePlan({ artifact: { id: 'x', version: '1', sha256: 'XYZ' } }))).toContain('artifact.sha256')
    expect(fields(makePlan({ artifact: { id: '', version: '', sha256: 'a'.repeat(64) } }))).toEqual(expect.arrayContaining(['artifact.id', 'artifact.version']))
  })

  it('refuses parameters that are not plain JSON', () => {
    expect(fields(makePlan({ params: { n: Infinity } }))).toContain('params')
  })

  it('refuses times without an explicit zone and expiry not after the start', () => {
    expect(fields(makePlan({ expires_at: '2026-11-09T04:30:00' }))).toContain('expires_at')
    expect(fields(makePlan({ schedule: { not_before: '2026-11-02 04:30', window: null } }))).toContain('schedule.not_before')
    expect(fields(makePlan({ expires_at: '2026-11-02T04:30:00Z' }))).toContain('expires_at')
    expect(fields(makePlan({ expires_at: '2026-11-01T04:30:00Z', schedule: { not_before: '2026-10-31T04:30:00Z', window: null } }))).toContain('expires_at')
  })

  it('refuses a selector that targets nothing explicitly', () => {
    expect(fields(makePlan({ target_selector: {} }))).toContain('target_selector')
    expect(fields(makePlan({ target_selector: { organisation_wide: true, location_ids: ['store-1'] } }))).toContain('target_selector')
    expect(fields(makePlan({ target_selector: { organisation_wide: true } }))).toEqual([])
  })

  it('refuses bad batch, canary and threshold numbers', () => {
    const p = makePlan()
    expect(fields({ ...p, batch: { ...p.batch, batch_size: 0 } })).toContain('batch.batch_size')
    expect(fields({ ...p, batch: { ...p.batch, global_concurrency: 0 } })).toContain('batch.global_concurrency')
    expect(fields({ ...p, batch: { ...p.batch, per_location_concurrency: 1.5 } })).toContain('batch.per_location_concurrency')
    expect(fields({ ...p, batch: { ...p.batch, batch_soak_ms: -1 } })).toContain('batch.batch_soak_ms')
    expect(fields({ ...p, canary: { mode: 'first_n', count: 0, soak_ms: 0 } })).toContain('canary.count')
    expect(fields({ ...p, canary: { mode: 'per_location', per_location: 0, soak_ms: 0 } })).toContain('canary.per_location')
    expect(fields({ ...p, canary: { mode: 'explicit', target_ids: [], soak_ms: 0 } })).toContain('canary.target_ids')
    expect(fields({ ...p, thresholds: { ...p.thresholds, stop_after_failures: 0 } })).toContain('thresholds.stop_after_failures')
    expect(fields({ ...p, thresholds: { ...p.thresholds, stop_after_failure_pct: 101 } })).toContain('thresholds.stop_after_failure_pct')
    expect(fields({ ...p, thresholds: { ...p.thresholds, stop_after_consecutive_failures: 0 } })).toContain('thresholds.stop_after_consecutive_failures')
    expect(fields({ ...p, max_attempts: 0 })).toContain('max_attempts')
    expect(fields({ ...p, max_attempts: 6 })).toContain('max_attempts')
  })

  it('refuses empty or duplicate setting paths', () => {
    expect(fields(makePlan({ setting_paths: [] }))).toContain('setting_paths')
    expect(fields(makePlan({ setting_paths: ['a', 'a'] }))).toContain('setting_paths')
    expect(fields(makePlan({ setting_paths: ['a..b'] }))).toContain('setting_paths')
  })

  it('refuses a missing requester, a bad risk and a bad policy version', () => {
    expect(fields(makePlan({ requested_by: '' }))).toContain('requested_by')
    expect(fields(makePlan({ risk: 'extreme' as Plan['risk'] }))).toContain('risk')
    expect(fields(makePlan({ policy_version: -1 }))).toContain('policy_version')
  })

  it('refuses a malformed maintenance window', () => {
    expect(fields(makePlan({ schedule: { not_before: '2026-11-02T04:30:00Z', window: { kind: 'daily', time_zone: 'Mars/Base', start: '22:00', end: '06:00' } } }))).toContain('schedule.window')
  })
})
