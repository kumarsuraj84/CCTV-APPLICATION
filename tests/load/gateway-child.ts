// P5.5 media-path load test: the REAL video gateway (lib/streams/gateway.ts) in a process of its own, so that its CPU time and memory are
// measured apart from the load generator. Started by tests/load/media-path.load.test.ts with `node --import tsx` (child_process.fork);
// it never reads .env files itself (the parent's environment is inherited) and prints no key, token or address.
//
// The registry is the production one: PostgREST with the gateway's own database role (video_gateway; in development the service key
// fallback of lib/supabase/service-clients.ts). Each registry call is timed here, so the report holds the cost of `media_session_open`
// (one per socket) and of `media_sessions_still_valid` (one per check for every open socket).
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import type { AddressInfo } from 'node:net'
import { createGateway, type GatewayEvent } from '@/lib/streams/gateway'
import { createRestRegistry, type RegistryClient } from '@/lib/streams/registry'
import { signStreamToken, verifyStreamToken } from '@/lib/streams/token'
import { requireServiceKey } from '@/lib/supabase/service-clients'

type Config = { go2rtcUrl: string; origin: string; hops: number; validateEveryMs?: number; maxSockets?: number }
type Msg = { type: 'report' } | { type: 'bench'; n: number } | { type: 'stop' }

const send = (m: unknown) => process.send?.(m)
const cfg = JSON.parse(process.env.LOAD_GATEWAY_CONFIG ?? '{}') as Config
const secret = process.env.LOAD_STREAM_SECRET ?? ''
const url = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || ''

const timings = { open: [] as number[], stillValid: [] as { ms: number; sessions: number }[], closes: 0 }
const events: Record<string, number> = {}
const real = createRestRegistry({ url, serviceKey: requireServiceKey('video_gateway') })
const registry: RegistryClient = {
  open: async (sid, expect) => {
    const t = performance.now()
    try {
      return await real.open(sid, expect)
    } finally {
      timings.open.push(performance.now() - t)
    }
  },
  stillValid: async (sids) => {
    const t = performance.now()
    try {
      return await real.stillValid(sids)
    } finally {
      timings.stillValid.push({ ms: performance.now() - t, sessions: sids.length })
    }
  },
  close: async (sid) => {
    timings.closes++
    return real.close(sid)
  },
}

const gateway = createGateway({
  go2rtcUrl: cfg.go2rtcUrl, secret, allowedOrigins: [cfg.origin], registry, trustedProxyHops: cfg.hops,
  ...(cfg.validateEveryMs ? { validateEveryMs: cfg.validateEveryMs } : {}),
  ...(cfg.maxSockets ? { maxSockets: cfg.maxSockets } : {}),
  log: (e: GatewayEvent) => void (events[e.outcome] = (events[e.outcome] ?? 0) + 1),
})

const loop = monitorEventLoopDelay({ resolution: 10 })
loop.enable()
let lastCpu = process.cpuUsage()
let lastAt = performance.now()
const sampler = setInterval(() => {
  const cpu = process.cpuUsage(lastCpu)
  const now = performance.now()
  const mem = process.memoryUsage()
  send({
    type: 'sample', at: Date.now(), cpuPctOfOneCore: ((cpu.user + cpu.system) / 1000 / (now - lastAt)) * 100, rssMb: mem.rss / 1048576,
    heapUsedMb: mem.heapUsed / 1048576, openSessions: gateway.health().openSessions, loopDelayP99Ms: loop.percentile(99) / 1e6,
  })
  lastCpu = process.cpuUsage()
  lastAt = now
  loop.reset()
}, 2000)

process.on('message', (m: Msg) => {
  if (m.type === 'report') send({ type: 'report', timings, events, health: gateway.health() })
  else if (m.type === 'bench') {
    // The cost of one token check (HMAC-SHA256 over the payload, constant-time compare, JSON parse and field checks), as the gateway
    // does it for every socket before anything else.
    const token = signStreamToken({ sid: '00000000-0000-4000-8000-000000000001', u: '00000000-0000-4000-8000-000000000002', c: '00000000-0000-4000-8000-000000000003', k: 'sub', exp: Math.floor(Date.now() / 1000) + 90 }, secret)
    for (let i = 0; i < 1000; i++) verifyStreamToken(token, Date.now(), secret) // warm-up
    const t = performance.now()
    let ok = 0
    for (let i = 0; i < m.n; i++) if (verifyStreamToken(token, Date.now(), secret)) ok++
    send({ type: 'bench', usPerVerify: ((performance.now() - t) * 1000) / m.n, ok })
  } else if (m.type === 'stop') {
    clearInterval(sampler)
    void gateway.shutdown(2000).then(() => process.exit(0))
  }
})
process.on('disconnect', () => process.exit(0))

gateway.listen(0, '127.0.0.1', () => send({ type: 'ready', port: (gateway.address() as AddressInfo).port }))
