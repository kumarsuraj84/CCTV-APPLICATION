'use client'

import { useEffect, useRef } from 'react'
import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MSG_STILL_THERE } from '@/lib/live/presence'

/**
 * P4-L1 review round 1, I-2: shown on the Live screens after the person's idle limit without input. The video and its renewals and the
 * page's refresh have stopped; nothing more is asked of the server until "Continue watching".
 */
export function PresencePrompt({ onContinue }: { onContinue: () => void }) {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    button.current?.focus()
  }, [])
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
      <div role="alertdialog" aria-modal="true" aria-labelledby="presence-title" aria-describedby="presence-text" className="w-full max-w-sm space-y-3 rounded-xl border bg-card p-5 text-foreground shadow-lg">
        <h2 id="presence-title" className="text-base font-semibold">{MSG_STILL_THERE}</h2>
        <p id="presence-text" className="text-sm text-muted-foreground">
          The video is paused because nobody has used this screen for a while. If your sign-in has ended meanwhile, you will be asked to sign in again.
        </p>
        <Button ref={button} type="button" onClick={onContinue}>
          <Play aria-hidden="true" /> Continue watching
        </Button>
      </div>
    </div>
  )
}
