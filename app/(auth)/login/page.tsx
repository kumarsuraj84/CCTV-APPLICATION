import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth/profile'
import { safeNext } from '@/lib/auth/safe-next'
import { BRAND } from '@/lib/brand'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LoginForm } from './LoginForm'

export const metadata = { title: 'Sign in' }

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams
  const next = safeNext(sp.next)
  // A person who is already signed in goes straight on. (The proxy does not do this, so a signed-in but deactivated person can still see the form.)
  if (await getCurrentProfile()) redirect(next)
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{BRAND.name}</CardTitle>
          <p className="text-sm text-muted-foreground">Sign in to continue.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {sp.error === 'link' && <p className="text-sm text-destructive">That link has expired. Ask for a new one.</p>}
          <LoginForm next={next} />
          <Link href="/forgot-password" className="block text-center text-sm text-muted-foreground underline">
            Forgot your password?
          </Link>
        </CardContent>
      </Card>
    </main>
  )
}
