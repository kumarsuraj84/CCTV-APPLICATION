import type { RemuxAdapter, RemuxStart } from '@/lib/streams/remux'
import { MSG_NO_FFMPEG } from '@/lib/streams/vod'

// P4-L2: a stand-in for the remux step (ffmpeg is not installed on the development PC). It treats the NVR's bytes as if they were already a
// fragmented MP4 and passes them on, with the same contract as the real adapter: the answer comes once the first byte exists, the end
// (or a cancel, or the signal) ends the NVR transfer, and onExit runs exactly once. Other modes: not set up, a format it does not
// understand, a failure before the first byte.

export type FakeRemuxMode = 'copy' | 'missing' | 'format' | 'fail'

export function fakeRemux(mode: FakeRemuxMode = 'copy'): RemuxAdapter & { starts: RemuxStart[]; running: () => number } {
  const starts: RemuxStart[] = []
  let running = 0
  return {
    name: `fake-${mode}`,
    starts,
    running: () => running,
    async check() {
      return mode === 'missing' ? { ok: false, error: MSG_NO_FFMPEG } : { ok: true }
    },
    async start(o) {
      starts.push(o)
      if (mode !== 'copy') {
        o.abortSource()
        o.onExit?.()
        return { ok: false, reason: mode === 'missing' ? 'missing' : mode === 'format' ? 'format' : 'failed' }
      }
      running++
      let ended = false
      const end = () => {
        if (ended) return
        ended = true
        running--
        o.abortSource()
        o.onExit?.()
      }
      const reader = o.source.getReader()
      const first = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (first.done) {
        end()
        return { ok: false, reason: 'failed' }
      }
      const onAbort = () => {
        void reader.cancel().catch(() => {})
        end()
      }
      o.signal?.addEventListener('abort', onAbort, { once: true })
      let sentFirst = false
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (!sentFirst) {
            sentFirst = true
            c.enqueue(first.value)
            return
          }
          try {
            const next = await reader.read()
            if (next.done) {
              c.close()
              end()
            } else c.enqueue(next.value)
          } catch {
            c.error(new Error('The conversion stopped.'))
            end()
          }
        },
        cancel() {
          void reader.cancel().catch(() => {})
          end()
        },
      })
      return { ok: true, body }
    },
  }
}
