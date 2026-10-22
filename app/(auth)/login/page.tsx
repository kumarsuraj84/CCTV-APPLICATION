import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth/profile'
import { safeNext } from '@/lib/auth/safe-next'
import { BRAND } from '@/lib/brand'
import { FormAlert } from '@/components/ui/form-alert'
import { AuthCard } from '../AuthCard'
import { LoginForm } from './LoginForm'

export const metadata = { title: 'Sign in' }

// P3-1 (session hygiene): proxy.ts sends a person whose sign-in ended here with the reason.
const ENDED: Record<string, string> = {
  idle: 'You were signed out because the app was not used for a while. Sign in again to carry on.',
  expired: 'Your sign-in had reached its time limit. Sign in again to carry on.',
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; reason?: string }> }) {
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
      {sp.reason && ENDED[sp.reason] && <FormAlert tone="success" className="mb-5">{ENDED[sp.reason]}</FormAlert>}
      <LoginForm next={next} />
    </AuthCard>
  )
}
