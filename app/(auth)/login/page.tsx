import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth/profile'
import { safeNext } from '@/lib/auth/safe-next'
import { BRAND } from '@/lib/brand'
import { FormAlert } from '@/components/ui/form-alert'
import { AuthCard } from '../AuthCard'
import { LoginForm } from './LoginForm'

export const metadata = { title: 'Sign in' }

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams
  const next = safeNext(sp.next)
  // A person who is already signed in goes straight on. (The proxy does not do this, so a signed-in but deactivated person can still see the form.)
  if (await getCurrentProfile()) redirect(next)
  return (
    <AuthCard
      title={`Sign in to ${BRAND.name}`}
      description={BRAND.subtitle}
      footer={
        <Link href="/forgot-password" className="rounded-sm font-medium text-primary underline-offset-4 hover:underline">
          Forgot your password?
        </Link>
      }
    >
      {sp.error === 'link' && <FormAlert className="mb-5">That link has expired. Ask for a new one.</FormAlert>}
      <LoginForm next={next} />
    </AuthCard>
  )
}
