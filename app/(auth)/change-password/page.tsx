import { LogOut } from 'lucide-react'
import { redirect } from 'next/navigation'
import { signOut } from '@/lib/actions/auth'
import { getCurrentProfile } from '@/lib/auth/profile'
import { Button } from '@/components/ui/button'
import { AuthCard } from '../AuthCard'
import { ChangePasswordForm } from './ChangePasswordForm'

export const metadata = { title: 'Choose a password' }

export default async function ChangePasswordPage() {
  const profile = await getCurrentProfile()
  if (!profile) redirect('/login')
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
      <ChangePasswordForm />
    </AuthCard>
  )
}
