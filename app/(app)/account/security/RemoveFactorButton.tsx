'use client'

import { useState, useTransition } from 'react'
import { removeOwnFactorAction } from '@/lib/actions/mfa'
import { Button } from '@/components/ui/button'
import { FormAlert } from '@/components/ui/form-alert'

/** Removing one's own authenticator app (needs a fresh sign-in; refused where it is required). Asks once before doing it. */
export function RemoveFactorButton() {
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const remove = () =>
    start(async () => {
      const r = await removeOwnFactorAction()
      if (r.ok) window.location.reload()
      else setError(r.error)
    })
  return (
    <div className="space-y-2">
      {asking ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">Remove two-step sign-in from your account?</span>
          <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={remove}>Remove</Button>
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setAsking(false)}>Cancel</Button>
        </div>
      ) : (
        <Button type="button" variant="outline" onClick={() => { setError(null); setAsking(true) }}>Remove two-step sign-in…</Button>
      )}
      <div aria-live="polite" className="empty:sr-only">{error && <FormAlert>{error}</FormAlert>}</div>
    </div>
  )
}
