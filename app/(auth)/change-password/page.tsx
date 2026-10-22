import { LogOut } from 'lucide-react'
import { redirect } from 'next/navigation'
import { signOut } from '@/lib/actions/auth'
import { getCurrentProfile, mfaGateOf } from '@/lib/auth/profile'
import { Button } from '@/components/ui/button'
import { FreshAuthNotice } from '@/components/auth/FreshAuthNotice'
import { AuthCard } from '../AuthCard'
import { ChangePasswordForm } from './ChangePasswordForm'

export const metadata = { title: 'Choose a password' }

export default async function ChangePasswordPage() {
  const profile = await getCurrentProfile()
  if (!profile) redirect('/login')
  // P3-1: with an authenticator app the auth server changes a password only after the code (aal2), so ask for it first.
  if (mfaGateOf(profile) === 'challenge') redirect('/mfa?next=%2Fchange-password')
  return (
    <AuthCard
      title="Choose your own password"
      description={profile.must_reset_password ? 'You need to do this once before you can use the app.' : 'Choose a new password.'}
      footer={
        // The same sign-out as the app's top bar, for someone who is asked to choose a password but wants to leave instead.
        <form action={signOut}>
          <Button type="submit" variant="outline">
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </form>
      }
    >
      {/* Review M-10: changing a password one already has needs a fresh sign-in (not the forced first change). */}
      {!profile.must_reset_password && <FreshAuthNotice session={profile.session} what="Changing your password" />}
      <ChangePasswordForm />
    </AuthCard>
  )
}
