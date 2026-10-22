'use client'

import { Loader2 } from 'lucide-react'
import { useActionState } from 'react'
import { confirmIdentityAction, type ConfirmState } from '@/lib/actions/mfa'
import { CodeField } from '@/components/auth/CodeField'
import { Button } from '@/components/ui/button'
import { FormAlert } from '@/components/ui/form-alert'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'

// "Confirm it's you" (P3-1, fresh sign-in): the code of the authenticator app, or the password when there is none.
export function ConfirmForm({ withCode, next }: { withCode: boolean; next: string | null }) {
  const [state, action, pending] = useActionState<ConfirmState, FormData>(confirmIdentityAction, {})
  if (state.done) {
    return (
      <div aria-live="polite">
        <FormAlert tone="success">Confirmed. You can close this tab and carry on where you were; your changes there are still waiting.</FormAlert>
      </div>
    )
  }
  return (
    <form action={action} className="flex flex-col gap-5" aria-busy={pending}>
      {next && <input type="hidden" name="next" value={next} />}
      {withCode ? (
        <CodeField describedBy={state.error ? 'confirm-error' : undefined} />
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Your password</Label>
          <PasswordInput id="password" name="password" autoComplete="current-password" required autoFocus className="h-11" aria-describedby={state.error ? 'confirm-error' : undefined} />
        </div>
      )}
      <div aria-live="polite" className="empty:sr-only">{state.error && <FormAlert id="confirm-error">{state.error}</FormAlert>}</div>
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
        {pending ? 'Checking…' : 'Confirm'}
      </Button>
    </form>
  )
}
