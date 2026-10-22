'use client'

import { ArrowRight, Loader2, Mail } from 'lucide-react'
import { useActionState } from 'react'
import { signIn, type FormState } from '@/lib/actions/auth'
import { Button } from '@/components/ui/button'
import { FormAlert } from '@/components/ui/form-alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'

// The sign-in logic is unchanged (lib/actions/auth.ts signIn: rate limit, same words for an unknown address or a wrong password,
// safe redirect to `next`). P3-0 only changes how the form looks and is announced.
export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signIn, {})
  const describedBy = state.error ? 'login-error' : undefined
  return (
    <form action={action} className="flex flex-col gap-5" aria-busy={pending}>
      <input type="hidden" name="next" value={next} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">E-mail</Label>
        <div className="relative">
          <Mail aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input id="email" name="email" type="email" autoComplete="username" inputMode="email" required placeholder="Your work e-mail" className="h-11 pl-9" aria-describedby={describedBy} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Password</Label>
        <PasswordInput id="password" name="password" autoComplete="current-password" required className="h-11" aria-describedby={describedBy} />
      </div>
      <div aria-live="polite" className="empty:sr-only">{state.error && <FormAlert id="login-error">{state.error}</FormAlert>}</div>
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
        {pending ? 'Signing in…' : 'Sign in'}
        {pending ? null : <ArrowRight aria-hidden="true" />}
      </Button>
    </form>
  )
}
