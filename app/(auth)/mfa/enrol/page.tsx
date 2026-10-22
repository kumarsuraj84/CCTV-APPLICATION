import { LogOut } from 'lucide-react'
import { redirect } from 'next/navigation'
import { signOut } from '@/lib/actions/auth'
import { getCurrentProfile, mfaGateOf } from '@/lib/auth/profile'
import { safeNext } from '@/lib/auth/safe-next'
import { Button } from '@/components/ui/button'
import { FreshAuthNotice } from '@/components/auth/FreshAuthNotice'
import { AuthCard } from '../../AuthCard'
import { EnrolForm } from './EnrolForm'

export const metadata = { title: 'Set up two-step sign-in' }

// P3-1: setting up an authenticator app. Required (and the only way on) for administrators while multi-factor is switched on; anybody
// else may do it from the Security page.
export default async function MfaEnrolPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next)
  const profile = await getCurrentProfile()
  if (!profile) redirect(`/login?next=${encodeURIComponent(next)}`)
  if (mfaGateOf(profile) === 'challenge') redirect(`/mfa?next=${encodeURIComponent(next)}`)
  if (profile.session?.hasFactor) redirect('/account/security')
  const required = mfaGateOf(profile) === 'enrol'
  return (
    <AuthCard
      title="Set up two-step sign-in"
      description={required ? 'Your account needs a code from an authenticator app as well as your password.' : 'Add a code from an authenticator app to your sign-in.'}
      footer={
        <form action={signOut}>
          <Button type="submit" variant="outline">
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </form>
      }
    >
      {/* Review I-4: setting up an app needs a fresh sign-in (the password within the last few minutes). */}
      <FreshAuthNotice session={profile.session} what="Setting up an authenticator app" />
      <EnrolForm next={next} />
    </AuthCard>
  )
}
