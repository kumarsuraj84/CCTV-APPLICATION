import type { RegistryClient } from '@/lib/streams/registry'

// P2-4 (decision D-3, brief item 4): a timer inside a response that keeps checking ONE media session with the same SQL the gateway
// uses (media_sessions_still_valid). The fast-playback route uses it now; the export download (P4) will reuse it. When the session is
// no longer allowed, or the registry has not answered for `failClosedAfterMs`, `onEnd` is called once and the watch stops.

export type SessionWatch = { stop: () => void }

export function watchSession(o: {
  registry: RegistryClient
  sid: string
  everyMs: number
  failClosedAfterMs: number
  /** Called once with the registry's reason, or `cannot_verify`. */
  onEnd: (reason: string) => void
  now?: () => number
}): SessionWatch {
  const now = o.now ?? Date.now
  let lastGood = now()
  let stopped = false
  let running = false
  const stop = () => {
    stopped = true
    clearInterval(timer)
  }
  const end = (reason: string) => {
    if (stopped) return
    stop()
    o.onEnd(reason)
  }
  const timer = setInterval(() => {
    if (stopped || running) return
    running = true
    const askedAt = now()
    o.registry.stillValid([o.sid]).then(
      (invalid) => {
        running = false
        const why = invalid.get(o.sid)
        if (why !== undefined) return end(why)
        lastGood = askedAt
      },
      () => {
        running = false
        if (now() - lastGood >= o.failClosedAfterMs) end('cannot_verify')
      },
    )
  }, o.everyMs)
  timer.unref?.()
  return { stop }
}
