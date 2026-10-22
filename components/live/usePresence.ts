'use client'

import { useCallback, useEffect, useState } from 'react'
import { installInputTracker, lastInputAt, onRealInput } from '@/components/layout/input-tracker'

/**
 * P4-L1 review round 1, I-2: false once nobody has touched the keyboard, mouse or screen for `idleMs` (the person's idle limit); then
 * the Live screens stop renewing their tokens and refreshing, and ask "Are you still there?". It stays false until `resume()` (the
 * "Continue watching" button), so the prompt does not vanish because of a stray pointer move. `idleMs` null: never pauses.
 */
export function usePresence(idleMs: number | null): { present: boolean; resume: () => void } {
  const [present, setPresent] = useState(true)
  useEffect(() => {
    if (!idleMs || !present) return
    installInputTracker()
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      const left = idleMs - (Date.now() - lastInputAt())
      if (left <= 0) setPresent(false)
      else timer = setTimeout(check, Math.min(left + 50, 60_000))
    }
    check()
    const off = onRealInput(() => {
      clearTimeout(timer)
      check()
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [idleMs, present])
  const resume = useCallback(() => setPresent(true), [])
  return { present, resume }
}
