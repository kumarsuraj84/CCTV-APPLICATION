'use client'

import { Loader2, Mail } from 'lucide-react'
import Link from 'next/link'
import { useActionState } from 'react'
import { forgotPassword, type FormState } from '@/lib/actions/auth'
import { Button } from '@/components/ui/button'
import { FormAlert } from '@/components/ui/form-alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// The logic is unchanged (lib/actions/auth.ts forgotPassword: rate limit, the same answer whether or not the address has an account).
export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(forgotPassword, {})
  const describedBy = state.error ? 'forgot-error' : undefined
  return (
    <form action={action} className="flex flex-col gap-5" aria-busy={pending}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">E-mail</Label>
        <div className="relative">
          <Mail aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" required placeholder="Your work e-mail" className="h-11 pl-9" aria-describedby={describedBy} />
        </div>
      </div>
      <div aria-live="polite" className="flex flex-col gap-2 empty:sr-only">
        {state.error && <FormAlert id="forgot-error">{state.error}</FormAlert>}
        {state.message && <FormAlert tone="success">{state.message}</FormAlert>}
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
        {pending ? 'Sending…' : 'Send the link'}
      </Button>
      <Link href="/login" className="self-center rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline">
        Back to sign in
      </Link>
    </form>
  )
}
