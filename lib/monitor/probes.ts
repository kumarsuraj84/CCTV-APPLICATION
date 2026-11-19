import { NvrClient, NvrError } from '@/lib/nvr/client'
import { icmpCheck, tcpCheck } from '@/lib/probes'
import { rtspDescribe } from '@/lib/rtsp/describe'
import { checkTarget, type TargetPurpose } from '@/lib/security/targets'
import type { Probes } from '@/lib/monitor/types'

// The real network checks of the worker, camera discovery, "Find cameras for all" and the NVR connection test. P2-6 (SO-4): each one
// first asks lib/security/targets.ts whether host:port is a registered endpoint (the loaders register what they read from the
// database) and connects to the address it answers with (a pinned name never resolves again on the way). A refusal opens nothing.

const target = (host: string, port: number | null, purpose: TargetPurpose) => checkTarget({ host, port, purpose })

/** An NVR client that asks first; the same two reads the checks and discovery use. */
function guardedNvr(ep: Parameters<Probes['nvr']>[0], opts?: { timeoutMs?: number }): ReturnType<Probes['nvr']> {
  let client: Promise<NvrClient> | undefined
  let made: NvrClient | undefined
  const ready = () =>
    (client ??= target(ep.host, ep.port, 'nvr_http').then((t) => {
      if (!t.ok) throw new NvrError('unreachable', 'address not allowed', 'refused_target', false)
      return (made = new NvrClient({ ...ep, host: t.address }, { timeoutMs: opts?.timeoutMs }))
    }))
  return {
    channelStatus: async () => (await ready()).channelStatus(),
    channels: async () => (await ready()).channels(),
    loginProven: () => made?.loginProven() === true,
  }
}

export const realProbes: Probes = {
  tcp: async (host, port, timeoutMs) => {
    const t = await target(host, port, 'device_tcp')
    return t.ok ? tcpCheck(t.address, port, timeoutMs) : { ok: false, error: t.error }
  },
  icmp: async (host, timeoutMs) => {
    const t = await target(host, null, 'device_icmp')
    return t.ok ? icmpCheck(t.address, timeoutMs) : { ok: false, error: t.error }
  },
  // Only the status code leaves this module; the trace stays behind.
  rtsp: async (r) => {
    const t = await target(r.host, r.port, 'nvr_rtsp')
    if (!t.ok) return { code: 0, authSent: false }
    const a = await rtspDescribe({ ...r, host: t.address })
    return { code: a.code, authSent: a.authSent }
  },
  nvr: (ep, opts) => guardedNvr(ep, opts),
}
