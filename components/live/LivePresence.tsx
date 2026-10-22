'use client'

import { useRouter } from 'next/navigation'
import { createContext, useContext, type ReactNode } from 'react'
import { AutoRefresh } from '@/components/monitor/AutoRefresh'
import { PresencePrompt } from './PresencePrompt'
import { usePresence } from './usePresence'

// P4-L1 review round 1, I-2: the Live screens (landing and walls) pause by themselves after the person's idle limit without input:
// no 60 s refresh, no token renewal (the wall reads `useLivePresent()`), and "Are you still there?". The proxy no longer counts those
// background requests as activity either (lib/auth/input-activity.ts), so an unattended screen lets the sign-in end at its idle limit.

const Present = createContext(true)
export const useLivePresent = (): boolean => useContext(Present)

export function LivePresence({ idleMs, refreshMs, children }: { idleMs: number | null; refreshMs: number; children: ReactNode }) {
  const router = useRouter()
  const { present, resume } = usePresence(idleMs)
  return (
    <Present.Provider value={present}>
      {present && <AutoRefresh busy={false} everyMs={refreshMs} />}
      {children}
      {!present && (
        <PresencePrompt
          onContinue={() => {
            resume()
            router.refresh()
          }}
        />
      )}
    </Present.Provider>
  )
}
