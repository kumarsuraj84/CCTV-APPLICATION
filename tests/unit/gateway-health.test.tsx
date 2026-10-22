import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GatewayHealthPanel } from '@/components/admin/GatewayHealthPanel'
import type { GatewayHealth } from '@/lib/streams/gateway'
import { readGatewayHealth } from '@/lib/streams/gateway-health'

// P2-4 brief item 3: the Monitoring page shows the video gateway's health (open sessions, age of the last access check), read from its
// /g/health JSON on the server, plus the open video sessions of the organisation from the registry. No secrets in either.

const ok: GatewayHealth = { status: 'ok', registry: 'ok', openSessions: 12, lastValidationAgeSec: 4, validateEverySec: 15, failClosedAfterSec: 45 }
const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

describe('reading the gateway health', () => {
  it('reads the counts from /g/health of the configured gateway address', async () => {
    const seen: string[] = []
    const f = (async (u: string) => {
      seen.push(String(u))
      return new Response(JSON.stringify(ok), { status: 200 })
    }) as unknown as typeof fetch
    expect(await readGatewayHealth('http://localhost:3412', f)).toEqual({ ok: true, health: ok })
    expect(seen).toEqual(['http://localhost:3412/g/health'])
  })

  it('says "not answering" for no address, an error, a timeout or an answer of another shape', async () => {
    expect(await readGatewayHealth(null, answer(ok))).toEqual({ ok: false })
    expect(await readGatewayHealth('http://localhost:3412', answer(ok, 500))).toEqual({ ok: false })
    expect(await readGatewayHealth('http://localhost:3412', answer('ok'))).toEqual({ ok: false })
    expect(await readGatewayHealth('http://localhost:3412', answer({ ...ok, openSessions: '12' }))).toEqual({ ok: false })
    expect(await readGatewayHealth('http://localhost:3412', (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch)).toEqual({ ok: false })
    const hang = ((_u: string, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch
    expect(await readGatewayHealth('http://localhost:3412', hang, 50)).toEqual({ ok: false })
  })
})

describe('the Monitoring page panel', () => {
  it('shows the open videos, the organisation’s share and how old the last access check is', () => {
    const t = text(renderToStaticMarkup(<GatewayHealthPanel gateway={{ ok: true, health: ok }} orgOpen={3} />))
    expect(t).toContain('Video gateway')
    expect(t).toContain('Open videos 12')
    expect(t).toContain('In your organisation 3')
    expect(t).toContain('Last access check 4 seconds ago')
    expect(t).toContain('Open video is checked every 15 seconds')
  })

  it('warns plainly when access cannot be checked, and when the gateway does not answer', () => {
    const failing = text(renderToStaticMarkup(<GatewayHealthPanel gateway={{ ok: true, health: { ...ok, status: 'not_verifying', registry: 'failing', lastValidationAgeSec: 31 } }} orgOpen={null} />))
    expect(failing).toContain('The gateway cannot check access right now. Open video is closed 45 seconds after the last successful check.')
    expect(failing).toContain('In your organisation Could not be read')
    const down = text(renderToStaticMarkup(<GatewayHealthPanel gateway={{ ok: false }} orgOpen={0} />))
    expect(down).toContain('The video gateway is not answering.')
    expect(down).toContain('npm run gateway')
  })
})
