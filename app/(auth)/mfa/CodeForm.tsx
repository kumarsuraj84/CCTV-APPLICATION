'use client'

import { Loader2 } from 'lucide-react'
import { useActionState } from 'react'
import { verifyCodeAction, type CodeState } from '@/lib/actions/mfa'
import { CodeField } from '@/components/auth/CodeField'
import { Button } from '@/components/ui/button'
import { FormAlert } from '@/components/ui/form-alert'

// The sign-in step (P3-1): the code of the person's authenticator app, then on to where they were going.
export function CodeForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<CodeState, FormData>(verifyCodeAction, {})
  return (
    <form action={action} className="flex flex-col gap-5" aria-busy={pending}>
      <input type="hidden" name="next" value={next} />
      <CodeField describedBy={state.error ? 'code-error' : 'code-help'} />
      <p id="code-help" className="-mt-3 text-xs text-muted-foreground">Open the authenticator app on your phone and type the code it shows for CityKart Drishti.</p>
      <div aria-live="polite" className="empty:sr-only">{state.error && <FormAlert id="code-error">{state.error}</FormAlert>}</div>
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
        {pending ? 'Checking…' : 'Continue'}
      </Button>
    </form>
  )
}
