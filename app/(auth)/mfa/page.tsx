import { LogOut } from 'lucide-react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { signOut } from '@/lib/actions/auth'
import { getCurrentProfile, mfaGateOf } from '@/lib/auth/profile'
import { safeNext } from '@/lib/auth/safe-next'
import { Button } from '@/components/ui/button'
import { AuthCard } from '../AuthCard'
import { CodeForm } from './CodeForm'

export const metadata = { title: 'Two-step sign-in' }

// P3-1: the second step of signing in for a person with an authenticator app. Anyone else goes straight on.
export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next)
  const profile = await getCurrentProfile()
  if (!profile) redirect(`/login?next=${encodeURIComponent(next)}`)
  const gate = mfaGateOf(profile)
  if (gate === 'enrol') redirect(`/mfa/enrol?next=${encodeURIComponent(next)}`)
  if (gate === 'ok') redirect(next)
  if (gate === 'unknown') {
    // Review M-2: the sign-in facts could not be read just now; nothing goes on until they can (fail closed).
    return (
      <AuthCard title="Your sign-in could not be checked" description="This happens when the server is busy for a moment.">
        <div className="flex flex-col items-center gap-3">
          <Link href={`/mfa?next=${encodeURIComponent(next)}`} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted">Try again</Link>
          <form action={signOut}>
            <Button type="submit" variant="outline"><LogOut aria-hidden="true" />Sign out</Button>
          </form>
        </div>
      </AuthCard>
    )
  }
  return (
    <AuthCard
      title="Enter your code"
      description="Your account is protected with two-step sign-in."
      footer={
        <>
          <p className="max-w-sm text-center text-muted-foreground">Lost your phone? Ask a super administrator to reset your two-step sign-in.</p>
          <form action={signOut}>
            <Button type="submit" variant="outline">
              <LogOut aria-hidden="true" />
              Sign out
            </Button>
          </form>
        </>
      }
    >
      <CodeForm next={next} />
    </AuthCard>
  )
}
