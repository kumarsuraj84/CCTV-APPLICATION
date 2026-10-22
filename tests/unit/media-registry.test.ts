import { describe, expect, it, vi } from 'vitest'
import { createRestRegistry, REGISTRY_TIMEOUT_MS, STILL_VALID_BATCH } from '@/lib/streams/registry'

// P2-4: the video gateway's registry client. It talks to PostgREST with the service key from the environment (D-14: one key until the
// per-service roles of P2-6). The key goes only into the request headers: never into a URL, an error, or a log line.

const KEY = 'service-key-that-must-never-leak-0123456789'
const URL_ = 'http://127.0.0.1:55321'
const SID = '5e0c1d2b-7a3f-4b9e-8c6d-1f2e3a4b5c6d'
const USER = '3f2b8c1e-5a47-4d0e-9b61-0c7d2e8a1f10'
const CAM = '9a1d4e7c-2b36-4f58-8e0a-6c5d3b2a1f09'

type Call = { url: string; init: RequestInit }
function fakeFetch(answer: (body: unknown, url: string) => { status?: number; json?: unknown; text?: string }) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const a = answer(JSON.parse(String(init?.body ?? 'null')), String(url))
    return new Response(a.text ?? JSON.stringify(a.json ?? null), { status: a.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

describe('REST registry client (the gateway)', () => {
  it('opens a session with the token’s person, camera, kind and stream, sending the key only as headers', async () => {
    const f = fakeFetch(() => ({ json: [{ ok: true, reason: null, kind: 'live', stream: `cam_${CAM}_sub`, expires_at: '2026-10-22T10:00:00Z' }] }))
    const r = createRestRegistry({ url: URL_, serviceKey: KEY, fetchImpl: f.fn })
    expect(await r.open(SID, { user: USER, camera: CAM, kind: 'live', stream: `cam_${CAM}_sub` })).toEqual({ ok: true, kind: 'live', stream: `cam_${CAM}_sub` })
    expect(f.calls).toHaveLength(1)
    const c = f.calls[0]
    expect(c.url).toBe(`${URL_}/rest/v1/rpc/media_session_open`)
    expect(c.url).not.toContain(KEY)
    expect(c.init.method).toBe('POST')
    const h = new Headers(c.init.headers)
    expect(h.get('apikey')).toBe(KEY)
    expect(h.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(String(c.init.body))).toEqual({ p_sid: SID, p_user: USER, p_camera: CAM, p_kind: 'live', p_stream: `cam_${CAM}_sub` })
    expect(c.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('passes a refusal on with its reason', async () => {
    const f = fakeFetch(() => ({ json: [{ ok: false, reason: 'mismatch', kind: null, stream: null, expires_at: null }] }))
    const r = createRestRegistry({ url: URL_, serviceKey: KEY, fetchImpl: f.fn })
    expect(await r.open(SID, { user: USER, camera: CAM, kind: 'live', stream: 'x' })).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('asks for many sessions in one call (in batches of at most 1000) and returns the invalid ones', async () => {
    const f = fakeFetch((body) => {
      const sids = (body as { p_sids: string[] }).p_sids
      return { json: sids.filter((_, i) => i % 100 === 0).map((sid) => ({ sid, reason: 'access_changed' })) }
    })
    const r = createRestRegistry({ url: URL_, serviceKey: KEY, fetchImpl: f.fn })
    const sids = Array.from({ length: 300 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const bad = await r.stillValid(sids)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].url).toBe(`${URL_}/rest/v1/rpc/media_sessions_still_valid`)
    expect([...bad.keys()]).toEqual([sids[0], sids[100], sids[200]])
    expect(await r.stillValid([])).toEqual(new Map())
    expect(f.calls).toHaveLength(1) // nothing to ask: no call
    expect(STILL_VALID_BATCH).toBe(1000)
    const many = Array.from({ length: 2500 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    await r.stillValid(many)
    expect(f.calls).toHaveLength(4)
  })

  it('throws a plain error without the key, the address or the answer text when the registry fails', async () => {
    for (const fail of [
      () => ({ status: 500, text: `{"message":"bad key ${KEY}"}` }),
      () => ({ status: 401, text: 'Invalid API key' }),
      () => ({ text: 'not json' }),
      () => ({ json: { not: 'an array' } }),
    ]) {
      const r = createRestRegistry({ url: URL_, serviceKey: KEY, fetchImpl: fakeFetch(fail).fn })
      const e = await r.stillValid([SID]).then(() => null, (x: Error) => x)
      expect(e).toBeInstanceOf(Error)
      expect(e!.message).not.toContain(KEY)
      expect(e!.message).not.toContain('127.0.0.1')
      expect(e!.message).not.toContain('Invalid API key')
    }
    const down = createRestRegistry({ url: URL_, serviceKey: KEY, fetchImpl: (async () => { throw new TypeError(`fetch failed ${URL_}`) }) as unknown as typeof fetch })
    const e = await down.open(SID, { user: USER, camera: CAM, kind: 'live', stream: 'x' }).then(() => null, (x: Error) => x)
    expect(e!.message).not.toContain('127.0.0.1')
  })

  it('gives up after its time limit (default 5 seconds)', async () => {
    expect(REGISTRY_TIMEOUT_MS).toBe(5000)
    const hang = (async (_u: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch
    const r = createRestRegistry({ url: URL_, serviceKey: KEY, fetchImpl: hang, timeoutMs: 50 })
    const started = Date.now()
    await expect(r.stillValid([SID])).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('closes a session (and never throws for it)', async () => {
    const f = fakeFetch(() => ({ json: true }))
    const r = createRestRegistry({ url: URL_, serviceKey: KEY, fetchImpl: f.fn })
    await r.close(SID)
    expect(f.calls[0].url).toBe(`${URL_}/rest/v1/rpc/media_session_close`)
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ p_sid: SID })
    const broken = createRestRegistry({ url: URL_, serviceKey: KEY, fetchImpl: fakeFetch(() => ({ status: 500, text: 'x' })).fn })
    await expect(broken.close(SID)).resolves.toBeUndefined()
  })

  it('refuses to be made without an http(s) address or a key', () => {
    expect(() => createRestRegistry({ url: '', serviceKey: KEY })).toThrow(/address/)
    expect(() => createRestRegistry({ url: 'ftp://x', serviceKey: KEY })).toThrow(/address/)
    expect(() => createRestRegistry({ url: URL_, serviceKey: '' })).toThrow(/key/)
    let message = ''
    try {
      createRestRegistry({ url: 'not a url', serviceKey: KEY })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).not.toContain(KEY)
  })
})
