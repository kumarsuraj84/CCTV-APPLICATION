import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentProfile, mfaGateOf } from '@/lib/auth/profile'
import { safeNext } from '@/lib/auth/safe-next'
import { sessionPolicy } from '@/lib/auth/session-policy'
import { AuthCard } from '../AuthCard'
import { ConfirmForm } from './ConfirmForm'

export const metadata = { title: 'Confirm it’s you' }

// P3-1 (D-10, fresh sign-in): changes of access, people and saved NVR passwords need a sign-in or code within the last few minutes.
// Opened from the notice on those pages, normally in a new tab (no `next`), so nothing typed on the page itself is lost.
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const raw = (await searchParams).next
  const next = raw ? safeNext(raw) : null
  const profile = await getCurrentProfile()
  if (!profile) redirect('/login')
  if (mfaGateOf(profile) === 'challenge') redirect(`/mfa?next=${encodeURIComponent(next ?? '/confirm')}`)
  const withCode = profile.session?.hasFactor === true
  const minutes = sessionPolicy().freshMinutes
  return (
    <AuthCard
      title="Confirm it’s you"
      description={`${withCode ? 'Enter a new code from your authenticator app' : 'Enter your password again'}. Changes to access, people and saved passwords are then allowed for ${minutes} minutes.`}
      footer={
        <Link href={next ?? '/home'} className="rounded-sm font-medium text-primary underline-offset-4 hover:underline">
          Not now
        </Link>
      }
    >
      <p className="mb-4 text-center text-sm" translate="no">{profile.email}</p>
      <ConfirmForm withCode={withCode} next={next} />
    </AuthCard>
  )
}
