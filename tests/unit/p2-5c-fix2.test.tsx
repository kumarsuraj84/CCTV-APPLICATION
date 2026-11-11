import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMemoryLimiter } from '../helpers/limiter-store'

// P2-5c-1 fix round 2 (Part A of .superpowers/sdd/drishti/p2-5c-2-review.md): A-N1 (a merge confirmation that could name one camera
// and merge another), A-N2 (the merge sentence's "linked" test), A-N3 (cycling passwords around the login back-off), and the small
// notes (preview rate limit). Pure logic and Server Actions with their services replaced; the database side is in
// tests/integration/p2-5c-fix2.test.ts.

const h = vi.hoisted(() => ({
  me: { id: '00000000-0000-4000-8000-0000000000a1', org_id: '00000000-0000-4000-8000-0000000000b1', role: 'admin' },
  merge: vi.fn(async (...args: [unknown, unknown, { keepId: string; duplicateId: string }]) => {
    void args
    return { ok: true, recorderId: null, channel: 2, groupsCopied: 0, duplicateCameraGrants: 0 }
  }),
  preview: vi.fn(async (_c: unknown, _a: unknown, i: { keepId: string; duplicateId: string }) => ({
    ok: true, keepId: i.keepId, duplicateId: i.duplicateId, keepName: `Keep ${i.keepId.slice(-1)}`, duplicateName: `Dup ${i.duplicateId.slice(-1)}`,
    duplicatePlace: 'JCL · Ground, channel 2', duplicateLinked: true, peopleLosing: 0,
  })),
}))
// P3-1 review I-3: the merge goes through the fresh-sign-in guard; this administrator signed in just now.
vi.mock('@/lib/auth/profile', () => ({ requireAdministration: async () => ({ ...h.me, session: { lastAuthAt: Math.floor(Date.now() / 1000) } }) }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }))
vi.mock('@/lib/streams/local-go2rtc', () => ({ localGo2rtc: () => ({}) }))
vi.mock('@/lib/inventory/mapping', () => ({ mergeCameras: h.merge, previewMerge: h.preview, remapCamera: vi.fn(), searchCameras: vi.fn() }))
vi.mock('@/lib/actions/admin/discover-all', () => ({ startDiscoverAllAction: async () => ({}), discoverAllStatusAction: async () => ({}) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const K = '00000000-0000-4000-8000-00000000000c'

describe('A-N1: the merge that is done is the merge that was confirmed', () => {
  // P2-6 (D-11): the shared rate limiter counts in memory here (never the database), with the database's semantics.
  beforeEach(() => { h.merge.mockClear(); h.preview.mockClear(); useMemoryLimiter() })
  afterEach(() => vi.useRealTimers())

  it('changing the chosen camera after the question opened closes it: nothing can be merged until the new choice is asked about', async () => {
    const { initialMergeConfirm, mergeConfirmReducer, mergeRequest } = await import('@/components/admin/inventory/merge-confirm-state')
    let s = mergeConfirmReducer(initialMergeConfirm, { type: 'choose', keepId: K, duplicateId: A })
    s = mergeConfirmReducer(s, { type: 'previewed', keepId: K, duplicateId: A, sentence: 'names A', confirmation: 'tok-A' })
    expect(mergeRequest(s)).toEqual({ keepId: K, duplicateId: A, confirmation: 'tok-A' })
    expect(s.pending?.sentence).toBe('names A')
    // The administrator picks B in the same list without pressing Cancel.
    s = mergeConfirmReducer(s, { type: 'choose', keepId: K, duplicateId: B })
    expect(s.pending).toBeNull()
    expect(mergeRequest(s)).toBeNull()
    // Back to A: still asked again (a confirmation is never revived).
    s = mergeConfirmReducer(s, { type: 'choose', keepId: K, duplicateId: A })
    expect(mergeRequest(s)).toBeNull()
  })

  it('a late answer about a camera that is no longer chosen is ignored; the question always names the camera that would be merged', async () => {
    const { initialMergeConfirm, mergeConfirmReducer, mergeRequest } = await import('@/components/admin/inventory/merge-confirm-state')
    let s = mergeConfirmReducer(initialMergeConfirm, { type: 'choose', keepId: K, duplicateId: B })
    s = mergeConfirmReducer(s, { type: 'previewed', keepId: K, duplicateId: A, sentence: 'names A', confirmation: 'tok-A' })
    expect(s.pending).toBeNull()
    expect(mergeRequest(s)).toBeNull()
    s = mergeConfirmReducer(s, { type: 'previewed', keepId: K, duplicateId: B, sentence: 'names B', confirmation: 'tok-B' })
    expect(s.pending).toMatchObject({ duplicateId: B, sentence: 'names B' })
    expect(mergeRequest(s)).toEqual({ keepId: K, duplicateId: B, confirmation: 'tok-B' })
    expect(mergeRequest(mergeConfirmReducer(s, { type: 'cancel' }))).toBeNull()
  })

  it('the merge action refuses ids other than the ones the confirmation was made for (and no confirmation, an old one, or another person\'s)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-22T10:00:00Z'))
    const { previewMergeAction, mergeCamerasAction } = await import('@/lib/actions/admin/locations')
    const { MSG_MERGE_CONFIRM_AGAIN } = await import('@/lib/inventory/merge-confirm')
    const p = await previewMergeAction({ keepId: K, duplicateId: A })
    expect(p).toMatchObject({ ok: true, keepId: K, duplicateId: A })
    const confirmation = p.ok ? p.confirmation : ''
    expect(confirmation).toMatch(/\S{20,}/)
    expect(await mergeCamerasAction({ keepId: K, duplicateId: B, confirmation })).toEqual({ error: MSG_MERGE_CONFIRM_AGAIN })
    expect(await mergeCamerasAction({ keepId: A, duplicateId: K, confirmation })).toEqual({ error: MSG_MERGE_CONFIRM_AGAIN })
    expect(await mergeCamerasAction({ keepId: K, duplicateId: A } as never)).toEqual({ error: MSG_MERGE_CONFIRM_AGAIN })
    expect(await mergeCamerasAction({ keepId: K, duplicateId: A, confirmation: `${confirmation}x` })).toEqual({ error: MSG_MERGE_CONFIRM_AGAIN })
    const other = h.me
    h.me = { ...other, id: '00000000-0000-4000-8000-0000000000a2' }
    expect(await mergeCamerasAction({ keepId: K, duplicateId: A, confirmation })).toEqual({ error: MSG_MERGE_CONFIRM_AGAIN })
    h.me = other
    vi.setSystemTime(new Date('2026-10-22T10:11:00Z'))
    expect(await mergeCamerasAction({ keepId: K, duplicateId: A, confirmation })).toEqual({ error: MSG_MERGE_CONFIRM_AGAIN })
    expect(h.merge).not.toHaveBeenCalled()
    vi.setSystemTime(new Date('2026-10-22T10:05:00Z'))
    expect(await mergeCamerasAction({ keepId: K.toUpperCase(), duplicateId: A, confirmation })).toMatchObject({ ok: true })
    expect(h.merge).toHaveBeenCalledTimes(1)
    expect(h.merge.mock.calls[0][2]).toEqual({ keepId: K, duplicateId: A })
    expect(MSG_MERGE_CONFIRM_AGAIN).toBe('The cameras chosen now are not the ones you confirmed, or the question is more than 10 minutes old. Press the merge button again and check the cameras it names.')
  })

  it('the merge preview is rate limited like the other previews', async () => {
    const { previewMergeAction } = await import('@/lib/actions/admin/locations')
    h.me = { ...h.me, id: '00000000-0000-4000-8000-0000000000a9' }
    const answers = []
    for (let i = 0; i < 31; i++) answers.push(await previewMergeAction({ keepId: K, duplicateId: A }))
    expect(answers.filter((r) => r.ok)).toHaveLength(30)
    expect(answers[30]).toEqual({ ok: false, error: 'Too many requests in a short time. Wait a minute and try again.' })
  })
})

describe('A-N2: the merge sentence', () => {
  it('says "takes over the NVR channel" only when the duplicate is linked, whatever its NVR is called', async () => {
    const { mergeSentence } = await import('@/lib/inventory/forms')
    const base = { keepId: K, duplicateId: A, keepName: 'A', duplicateName: 'B', peopleLosing: 0 }
    expect(mergeSentence({ ...base, duplicatePlace: 'JCL · not linked', duplicateLinked: false })).toBe(
      '“A” keeps its identity, access, groups and history; “B” (JCL · not linked) is archived. Nobody loses access through a grant on “B”.',
    )
    expect(mergeSentence({ ...base, duplicatePlace: 'JCL · NVR, channel 4 wing, channel 2', duplicateLinked: true })).toMatch(/takes over the NVR channel of “B”/)
    expect(mergeSentence({ ...base, keepName: 'A, channel 9', duplicatePlace: 'JCL · not linked', duplicateLinked: false })).not.toMatch(/takes over/)
    // The words of the place never decide it (the old code looked for ", channel " in them).
    expect(mergeSentence({ ...base, duplicatePlace: 'JCL · Gate, channel side', duplicateLinked: false })).not.toMatch(/takes over/)
  })
})

describe('A-N3: a new password does not get around the back-off for ever', () => {
  it('after 3 refused logins to one NVR within 30 minutes it is not asked again, whatever login is saved, until the window is over', async () => {
    // Final fix X (ruling NB-1): the same rule, now in the ONE shared back-off (lib/nvr/login-policy.ts, the database's nvr_login_gate).
    const { loginBlockMessage, MSG_LOGIN_BACKOFF, MSG_LOGIN_PAUSED, LOGIN_REFUSALS_ALLOWED, LOGIN_REFUSAL_WINDOW_SEC } = await import('@/lib/monitor/login-backoff')
    const { decideLogin, reportLogin } = await import('@/lib/nvr/login-policy')
    const { outcomeOfNvrError } = await import('@/lib/nvr/login-guard')
    const { NvrError } = await import('@/lib/nvr/client')
    type S = Parameters<typeof decideLogin>[0]
    expect([LOGIN_REFUSALS_ALLOWED, LOGIN_REFUSAL_WINDOW_SEC]).toEqual([3, 1800])
    const t0 = Date.parse('2026-10-22T10:00:00Z')
    let s: S
    const block = (pw: string, at: number) => {
      const r = decideLogin(s, pw, at, { claim: true })
      s = r.state
      return loginBlockMessage(r.gate)
    }
    const note = (pw: string, e: unknown, at: number) => (s = reportLogin(s, pw, pw, outcomeOfNvrError(e), at, { baseSec: 60, maxSec: 60 }).state)
    const refused = new NvrError('auth', 'refused')
    // Each wrong password waits out its own short back-off (60 s), then a new one is tried.
    expect(block('pw1', t0)).toBeNull()
    note('pw1', refused, t0)
    expect(block('pw1', t0 + 1000)).toBe(MSG_LOGIN_BACKOFF)
    expect(block('pw2', t0 + 1000)).toBeNull()
    note('pw2', refused, t0 + 2000)
    expect(block('pw3', t0 + 3000)).toBeNull()
    note('pw3', refused, t0 + 4000)
    expect(block('pw4', t0 + 5000)).toBe(MSG_LOGIN_PAUSED)
    expect(block('pw4', t0 + 10 * 60_000)).toBe(MSG_LOGIN_PAUSED)
    expect(block('pw4', t0 + 1800_000 + 1000)).toBeNull()
    // A non-login failure does not count (another NVR is another state).
    s = undefined
    for (const [pw, e] of [['a', new NvrError('unreachable', 'down')], ['b', new NvrError('timeout', 'slow')], ['c', new NvrError('unreachable', 'down')]] as const) {
      block(pw, t0)
      note(pw, e, t0)
    }
    expect(block('d', t0 + 1000)).toBeNull()
    expect(MSG_LOGIN_PAUSED).toBe('This NVR refused 3 logins in the last 30 minutes. To keep its account from being locked it is not asked again for a while, even with a new password. Check the user name and password on the NVR itself, then try again later.')
  })

  it('the "find cameras for all" page no longer promises that an account cannot be locked', async () => {
    const { DiscoverAll } = await import('@/components/admin/inventory/DiscoverAll')
    const html = renderToStaticMarkup(<DiscoverAll initial={null} counts={{ recorders: 3, switchedOff: 0, locationOff: 0, concurrency: 4 }} />)
    expect(html).not.toMatch(/cannot be locked/)
    expect(html).toContain('An NVR that refused a login a short while ago is not asked again until the wait is over, and one that refused several is left alone for longer, to protect its account.')
  })
})
