import { describe, expect, it } from 'vitest'
import { FakeAdapter, desiredSettings } from '@/lib/jobs/fake-adapter'
import { FakeClock, makePlan } from '@/lib/jobs/testing'

const T = { target_id: 'ap1', location_id: 'store-1' }

function setup(latency = 0) {
  const clock = new FakeClock()
  const fake = new FakeAdapter({ clock, latency_ms: latency })
  fake.addDevice('ap1', 'store-1', { 'ssid.staff.ssid': 'CK-Staff', 'ssid.staff.security': 'wpa2-psk', 'ssid.staff.passphrase_ref': 'vault:wifi/staff/v6' })
  return { clock, fake, plan: makePlan() }
}

describe('desiredSettings', () => {
  it('flattens the plan parameters under the first setting path', () => {
    expect(desiredSettings(makePlan())).toEqual({ 'ssid.staff.ssid': 'CK-Staff', 'ssid.staff.security': 'wpa2-psk', 'ssid.staff.passphrase_ref': 'vault:wifi/staff/v7' })
  })
})

describe('FakeAdapter', () => {
  it('applies a plan, and the same idempotency key never applies twice (duplicate delivery)', async () => {
    const { fake, plan } = setup()
    expect(await fake.apply(T, plan, 'job-1:h')).toEqual({ delivered: true, outcome: 'applied', message: expect.any(String) })
    fake.drift('ap1', 'ssid.staff.passphrase_ref', 'vault:old')
    expect(await fake.apply(T, plan, 'job-1:h')).toMatchObject({ delivered: true, outcome: 'applied' })
    expect(fake.executions('ap1')).toBe(1)
    expect(fake.config('ap1')['ssid.staff.passphrase_ref']).toBe('vault:old')
  })

  it('records every execution with the payload hash it executed', async () => {
    const { fake, plan } = setup()
    await fake.apply(T, plan, 'job-1:h')
    expect(fake.applyLog).toEqual([{ target_id: 'ap1', idempotency_key: 'job-1:h', payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/), at: expect.any(Number) }])
  })

  it('verify compares desired with observed settings', async () => {
    const { fake, plan } = setup()
    expect((await fake.verify(T, plan)).outcome).toBe('mismatch')
    await fake.apply(T, plan, 'k')
    const v = await fake.verify(T, plan)
    expect(v.outcome).toBe('match')
    expect(v.expected).toEqual(v.observed)
  })

  it('state drift after verification is visible to the next verification', async () => {
    const { fake, plan } = setup()
    await fake.apply(T, plan, 'k')
    fake.drift('ap1', 'ssid.staff.security', 'open')
    const v = await fake.verify(T, plan)
    expect(v.outcome).toBe('mismatch')
    expect(v.observed['ssid.staff.security']).toBe('open')
  })

  it('a lost response applies the change but the hub hears nothing (lost acknowledgement)', async () => {
    const { fake, plan } = setup()
    fake.inject({ target_id: 'ap1', step: 'apply', mode: 'lost_response' })
    expect(await fake.apply(T, plan, 'k')).toEqual({ delivered: false, reason: 'lost_response' })
    expect(await fake.reconcile(T, 'k')).toEqual({ reachable: true, state: 'applied' })
  })

  it('a lost result: the device confirmed receipt and applied, then the answer was lost', async () => {
    const { fake, plan } = setup()
    fake.inject({ target_id: 'ap1', step: 'apply', mode: 'lost_result' })
    expect(await fake.apply(T, plan, 'k')).toEqual({ delivered: false, reason: 'lost_response', acknowledged: true })
    expect(await fake.reconcile(T, 'k')).toEqual({ reachable: true, state: 'applied' })
  })

  it('a lost request does not apply; reconcile says not_applied', async () => {
    const { fake, plan } = setup()
    fake.inject({ target_id: 'ap1', step: 'apply', mode: 'lost_request' })
    expect(await fake.apply(T, plan, 'k')).toEqual({ delivered: false, reason: 'timeout' })
    expect(await fake.reconcile(T, 'k')).toEqual({ reachable: true, state: 'not_applied' })
    expect(fake.executions('ap1')).toBe(0)
  })

  it('faults are used up after the given number of times', async () => {
    const { fake, plan } = setup()
    fake.inject({ target_id: 'ap1', step: 'apply', mode: 'fail', times: 1 })
    expect(await fake.apply(T, plan, 'k1')).toMatchObject({ delivered: true, outcome: 'failed' })
    // The journal remembers the failure for that key; a new key runs normally.
    expect(await fake.apply(T, plan, 'k1')).toMatchObject({ delivered: true, outcome: 'failed' })
    expect(await fake.apply(T, plan, 'k2')).toMatchObject({ outcome: 'applied' })
    expect(await fake.reconcile(T, 'k1')).toEqual({ reachable: true, state: 'not_applied' })
  })

  it('partial application changes some settings only and is journalled as partial', async () => {
    const { fake, plan } = setup()
    fake.inject({ target_id: 'ap1', step: 'apply', mode: 'partial' })
    expect(await fake.apply(T, plan, 'k')).toMatchObject({ delivered: true, outcome: 'partial' })
    expect(await fake.reconcile(T, 'k')).toEqual({ reachable: true, state: 'partial' })
    expect((await fake.verify(T, plan)).outcome).toBe('mismatch')
  })

  it('a device can claim success without changing anything (only verification catches it)', async () => {
    const { fake, plan } = setup()
    fake.inject({ target_id: 'ap1', step: 'apply', mode: 'false_success' })
    expect(await fake.apply(T, plan, 'k')).toMatchObject({ delivered: true, outcome: 'applied' })
    expect((await fake.verify(T, plan)).outcome).toBe('mismatch')
  })

  it('offline devices are unreachable for every operation', async () => {
    const { fake, plan } = setup()
    fake.setOnline('ap1', false)
    expect(fake.isOnline('ap1')).toBe(false)
    expect(await fake.apply(T, plan, 'k')).toEqual({ delivered: false, reason: 'unreachable' })
    expect(await fake.reconcile(T, 'k')).toEqual({ reachable: false })
    expect((await fake.verify(T, plan)).outcome).toBe('inconclusive')
    expect((await fake.snapshot(T)).status).toBe('failed')
    fake.setOnline('ap1', true)
    expect(await fake.apply(T, plan, 'k')).toMatchObject({ delivered: true })
  })

  it('reconcile can be made to answer unknown', async () => {
    const { fake } = setup()
    fake.inject({ target_id: 'ap1', step: 'reconcile', mode: 'unknown' })
    expect(await fake.reconcile(T, 'k')).toEqual({ reachable: true, state: 'unknown' })
  })

  it('snapshot and rollback restore the earlier configuration', async () => {
    const { fake, plan } = setup()
    const before = fake.config('ap1')
    const snap = await fake.snapshot(T)
    expect(snap.status).toBe('taken')
    await fake.apply(T, plan, 'k')
    if (snap.status !== 'taken') return
    expect(await fake.rollback(T, snap.ref)).toEqual({ status: 'restored' })
    expect(fake.config('ap1')).toEqual(before)
  })

  it('unsupported operations say so (per device) instead of pretending', async () => {
    const { fake, plan } = setup()
    fake.setUnsupported('ap1', ['snapshot', 'verify', 'rollback', 'stop'])
    expect(await fake.snapshot(T)).toEqual({ status: 'unsupported' })
    expect((await fake.verify(T, plan)).outcome).toBe('unsupported')
    expect(await fake.rollback(T, 'x')).toEqual({ status: 'unsupported' })
    expect(await fake.stop(T, 'k')).toEqual({ status: 'unsupported' })
  })

  it('latency moves the injected clock, never real time', async () => {
    const { fake, plan, clock } = setup(1500)
    const t0 = clock.now()
    await fake.apply(T, plan, 'k')
    expect(clock.now()).toBe(t0 + 1500)
  })

  it('preflight reports injected issues and the impact', async () => {
    const { fake, plan } = setup()
    fake.setPreflightIssues('ap1', [{ code: 'fw', message: 'Firmware too old.', severity: 'blocking' }])
    const p = await fake.preflight(T, plan)
    expect(p.issues).toHaveLength(1)
    expect(p.impact).toMatchObject({ reconnect_required: true })
  })

  it('verification of secrets shows only references, never values', async () => {
    const { fake } = setup()
    const plan = makePlan({ params: { passphrase: 'hunter2' } })
    await fake.apply(T, plan, 'k')
    const v = await fake.verify(T, plan)
    expect(JSON.stringify(v)).not.toContain('hunter2')
  })
})
