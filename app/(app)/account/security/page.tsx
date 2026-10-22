import Link from 'next/link'
import { LogOut, ShieldCheck, ShieldOff } from 'lucide-react'
import { signOutEverywhereSelfAction } from '@/lib/actions/mfa'
import { requireProfile } from '@/lib/auth/profile'
import { sessionPolicy } from '@/lib/auth/session-policy'
import { isAdminRole, ROLE_LABELS } from '@/lib/admin/roles'
import { FreshAuthNotice } from '@/components/auth/FreshAuthNotice'
import { formatDateTime } from '@/lib/time'
import { twoStepSummary } from '@/lib/admin/sessions'
import { createAdminClient } from '@/lib/supabase/admin'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/button'
import { RemoveFactorButton } from './RemoveFactorButton'

export const metadata = { title: 'Security' }

// P3-1: the person's own sign-in security — two-step sign-in (set up, remove where allowed), this sign-in's times and limits, and
// signing out everywhere.
export default async function SecurityPage() {
  const me = await requireProfile()
  const summary = me.session?.hasFactor ? await twoStepSummary(createAdminClient(), me.org_id).catch(() => null) : null
  const own = summary?.get(me.id)
  const mine = own?.enrolledAt ? { enrolledAt: own.enrolledAt, enrolledIp: own.enrolledIp } : null
  const s = me.session
  const p = sessionPolicy()
  const required = !!s && s.mfaEnforced && s.privileged
  const idle = isAdminRole(me.role) ? p.idleMinutesAdmin : p.idleMinutes
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Security" description="How you sign in to CityKart Drishti." breadcrumbs={[{ label: 'Home', href: '/home' }, { label: 'Security' }]} />

      <section aria-labelledby="two-step" className="space-y-3 rounded-xl border bg-card p-4">
        <h2 id="two-step" className="flex items-center gap-2 font-semibold">
          {s?.hasFactor ? <ShieldCheck aria-hidden="true" className="size-5 text-success-strong" /> : <ShieldOff aria-hidden="true" className="size-5 text-muted-foreground" />}
          Two-step sign-in: {s?.hasFactor ? 'on' : 'off'}
        </h2>
        <p className="text-sm text-muted-foreground">
          {s?.hasFactor
            ? 'Every sign-in asks for a code from the authenticator app on your phone as well as your password.'
            : required
              ? 'It is required for your account.'
              : 'Optional for your account. With it, a stolen password alone is not enough to sign in as you.'}
        </p>
        {s?.hasFactor && mine && (
          // Review I-4: the person sees when and from where their app was set up; an administrator sees the same on the Users page.
          <p className="text-sm" translate="no">
            Set up {formatDateTime(mine.enrolledAt)} IST{mine.enrolledIp ? ` from ${mine.enrolledIp}` : ''}. If that was not you, ask a super administrator to reset it now.
          </p>
        )}
        {s?.hasFactor ? (
          required ? (
            <p className="text-sm">It is required for your account, so it cannot be removed here. If you have a new phone, ask a super administrator to reset it.</p>
          ) : (
            <>
              <FreshAuthNotice session={s} what="Removing two-step sign-in" />
              <RemoveFactorButton />
            </>
          )
        ) : (
          <Link href="/mfa/enrol?next=%2Faccount%2Fsecurity" className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]">
            Set up two-step sign-in
          </Link>
        )}
      </section>

      <section aria-labelledby="this-sign-in" className="space-y-2 rounded-xl border bg-card p-4 text-sm">
        <h2 id="this-sign-in" className="font-semibold">This sign-in</h2>
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Signed in as</dt>
          <dd translate="no">{me.email} · {ROLE_LABELS[me.role]}</dd>
          <dt className="text-muted-foreground">Signed in at</dt>
          <dd translate="no">{s?.signedInAt ? `${formatDateTime(new Date(s.signedInAt * 1000))} IST` : '—'}</dd>
          <dt className="text-muted-foreground">Ends</dt>
          <dd>after {idle >= 60 ? `${idle / 60} ${idle === 60 ? 'hour' : 'hours'}` : `${idle} minutes`} without use, and {p.maxHours} hours after signing in at the latest</dd>
        </dl>
      </section>

      <section aria-labelledby="everywhere" className="space-y-3 rounded-xl border bg-card p-4">
        <h2 id="everywhere" className="font-semibold">Sign out everywhere</h2>
        <p className="text-sm text-muted-foreground">Ends your sign-in on every computer and phone, this one too. Use it if you signed in on a shared computer and forgot to sign out.</p>
        <form action={signOutEverywhereSelfAction}>
          <Button type="submit" variant="outline">
            <LogOut aria-hidden="true" />
            Sign out everywhere
          </Button>
        </form>
      </section>
    </div>
  )
}
