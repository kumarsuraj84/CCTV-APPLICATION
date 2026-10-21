import { NvrClient } from '@/lib/nvr/client'
import { icmpCheck, tcpCheck } from '@/lib/probes'
import { rtspDescribe } from '@/lib/rtsp/describe'
import type { Probes } from '@/lib/monitor/types'

export const realProbes: Probes = {
  tcp: tcpCheck,
  icmp: icmpCheck,
  // Only the status code leaves this module; the trace stays behind.
  rtsp: async (t) => ({ code: (await rtspDescribe(t)).code }),
  nvr: (ep, opts) => new NvrClient(ep, { timeoutMs: opts?.timeoutMs }),
}
