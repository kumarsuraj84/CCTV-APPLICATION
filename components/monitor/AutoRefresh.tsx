'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { FAST_REFRESH_MS, refreshDelayMs } from '@/lib/monitor/refresh-delay'

/**
 * Keeps a server-rendered page up to date by asking Next.js for a fresh render now and then. Nothing is shown. It only refreshes while the
 * tab is visible, one timer at a time (never stacked), and it stops when the page is closed. Back in view after a while away, it refreshes
 * once at once and carries on.
 */
export function AutoRefresh({ busy, everyMs }: { busy: boolean; /** A fixed pace instead of the Monitoring page's (P4-L1: the Live screens, 60 s). */ everyMs?: number }) {
  const router = useRouter()
  const openedAt = useRef<number | null>(null)
  const lastRefresh = useRef(0)

  useEffect(() => {
    openedAt.current = Date.now()
    lastRefresh.current = Date.now()
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
    function schedule() {
      clear()
      if (document.visibilityState !== 'visible') return
      const openedForMs = openedAt.current === null ? 0 : Date.now() - openedAt.current
      timer = setTimeout(tick, everyMs ?? refreshDelayMs({ busy, openedForMs }))
    }
    function tick() {
      lastRefresh.current = Date.now()
      router.refresh()
      schedule()
    }
    function onVisibility() {
      clear()
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastRefresh.current >= (everyMs ?? FAST_REFRESH_MS)) tick()
      else schedule()
    }
    document.addEventListener('visibilitychange', onVisibility)
    schedule()
    return () => {
      clear()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [router, busy, everyMs])

  return null
}
