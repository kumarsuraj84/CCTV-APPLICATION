'use client'

import { Loader2 } from 'lucide-react'
import { useActionState } from 'react'
import { changePassword, type FormState } from '@/lib/actions/auth'
import { PASSWORD_HELP } from '@/lib/validation/password'
import { Button } from '@/components/ui/button'
import { FormAlert } from '@/components/ui/form-alert'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'

// The logic is unchanged (lib/actions/auth.ts changePassword: caller checked first, password rules, the forced-change flag cleared by
// the server only after the change succeeded).
export function ChangePasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(changePassword, {})
  const error = state.error ? ' password-error' : ''
  return (
    <form action={action} className="flex flex-col gap-5" aria-busy={pending}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">New password</Label>
        <PasswordInput id="password" name="password" autoComplete="new-password" required className="h-11" aria-describedby={`password-help${error}`} />
        <p id="password-help" className="text-xs text-muted-foreground">{PASSWORD_HELP}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="confirm">Type it again</Label>
        <PasswordInput id="confirm" name="confirm" autoComplete="new-password" required className="h-11" aria-describedby={error.trim() || undefined} />
      </div>
      <div aria-live="polite" className="empty:sr-only">{state.error && <FormAlert id="password-error">{state.error}</FormAlert>}</div>
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
        {pending ? 'Saving…' : 'Save password'}
      </Button>
    </form>
  )
}
