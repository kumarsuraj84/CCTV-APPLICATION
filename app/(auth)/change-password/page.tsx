import { redirect } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth/profile'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChangePasswordForm } from './ChangePasswordForm'

export const metadata = { title: 'Choose a password' }

export default async function ChangePasswordPage() {
  const profile = await getCurrentProfile()
  if (!profile) redirect('/login')
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Choose your own password</CardTitle>
          <p className="text-sm text-muted-foreground">
            {profile.must_reset_password ? 'You need to do this once before you can use the app.' : 'Choose a new password.'}
          </p>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
    </main>
  )
}
