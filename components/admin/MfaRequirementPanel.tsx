'use client'

import { useActionState } from 'react'
import { setMfaRequirementAction, type MfaSwitchState } from '@/lib/actions/admin/security'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

// Final fix Y (final review A I-1, B I-1): whether two-step sign-in is required in this organisation, and the owner-only switch.
// Production refuses to start (and the Health page fails) while it is off without a recorded reason.
export type MfaRequirement = { enforced: boolean; reason: string | null; offAt: string | null }

export function MfaRequirementPanel({ state, offAtText }: { state: MfaRequirement; offAtText: string | null }) {
  const [result, action, pending] = useActionState<MfaSwitchState, FormData>(setMfaRequirementAction, {})
  return (
    <section aria-labelledby="mfa-requirement" className="space-y-3 rounded-xl border bg-card p-4">
      <h2 id="mfa-requirement" className="font-medium">Two-step sign-in</h2>
      {state.enforced ? (
        <p className="text-sm">Required for administrators, super administrators and everyone who may download recordings.</p>
      ) : state.reason ? (
        <p className="text-sm" role="status">
          Switched off on purpose{offAtText ? ` since ${offAtText}` : ''}. Reason: <span className="font-medium">{state.reason}</span>
        </p>
      ) : (
        <p className="text-sm text-destructive" role="status">
          Not required, and no reason is recorded. A production server does not start like this.
        </p>
      )}
      <form action={action} className="space-y-3">
        {state.enforced ? (
          <>
            <input type="hidden" name="enforced" value="off" />
            <div className="space-y-1.5">
              <Label htmlFor="mfa-reason">Why it must be switched off (kept in the audit log)</Label>
              <textarea id="mfa-reason" name="reason" required minLength={10} maxLength={500} rows={2}
                className="w-full rounded-md border bg-background px-3 py-2 text-base sm:text-sm" />
            </div>
            <Button type="submit" variant="outline" disabled={pending}>Switch off with this reason</Button>
          </>
        ) : (
          <>
            <input type="hidden" name="enforced" value="on" />
            <p className="text-sm text-muted-foreground">
              Before you switch it on, make sure every administrator has set up an authenticator app (People page); anyone who has not
              is asked to set one up at their next sign-in.
            </p>
            <Button type="submit" disabled={pending}>Require two-step sign-in</Button>
          </>
        )}
        {result.error && <p role="alert" className="text-sm text-destructive">{result.error}</p>}
        {result.ok && <p role="status" className="text-sm">Saved.</p>}
      </form>
    </section>
  )
}
