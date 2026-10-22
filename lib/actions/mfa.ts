'use server'

// Server Actions of two-step sign-in and "Confirm it's you" (P3-1 brief item 1). Each one checks the caller first: a signed-in, active
// person (getCurrentProfile); these steps are themselves part of signing in, so they do not ask for the code they are collecting.
// They return plain results (never throw to the client); the services are in lib/auth/mfa.ts.
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { getCurrentProfile } from '@/lib/auth/profile'
import { requireFreshProfile } from '@/lib/auth/fresh'
import { getClientIp } from '@/lib/rate-limit'
import { safeNext } from '@/lib/auth/safe-next'
import { confirmEnrolment, confirmIdentity, removeOwnFactor, startEnrolment, verifySignInCode } from '@/lib/auth/mfa'
import { recordAuthEvent } from '@/lib/auth/auth-events'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revokeMediaSessions } from '@/lib/streams/registry'

export type CodeState = { error?: string }
export type EnrolStart = { ok: true; factorId: string; qrCode: string; secret: string } | { ok: false; error: string }
export type SimpleResult = { ok: true } | { ok: false; error: string }
export type ConfirmState = { error?: string; done?: boolean }

async function me() {
  const profile = await getCurrentProfile()
  if (!profile) redirect('/login')
  return profile
}

/**
 * Review I-4: setting up an authenticator app binds the account to that phone, so it needs a fresh sign-in (the password within the
 * last few minutes, or "Confirm it's you"): a stolen session alone cannot bind an attacker's phone.
 */
export async function startEnrolmentAction(): Promise<EnrolStart> {
  const g = await requireFreshProfile()
  if (!g.ok) return { ok: false, error: g.error }
  return startEnrolment(await createClient(), g.profile)
}

export async function confirmEnrolmentAction(factorId: string, code: string): Promise<SimpleResult> {
  const profile = await me()
  const res = await confirmEnrolment(await createClient(), profile, factorId, code, { ip: await getClientIp() })
  if (res.ok) revalidatePath('/', 'layout')
  return res
}

/** The sign-in step: the code, then on to `next`. */
export async function verifyCodeAction(_prev: CodeState, formData: FormData): Promise<CodeState> {
  const profile = await me()
  const res = await verifySignInCode(await createClient(), profile, formData.get('code'), { ip: await getClientIp() })
  if (!res.ok) return { error: res.error }
  redirect(safeNext(String(formData.get('next') ?? '')))
}

/** "Confirm it's you": a code (with an authenticator app) or the password; then back to `next`, or "done" for a separate tab. */
export async function confirmIdentityAction(_prev: ConfirmState, formData: FormData): Promise<ConfirmState> {
  const profile = await me()
  const res = await confirmIdentity(await createClient(), profile, { code: formData.get('code'), password: formData.get('password') }, undefined, { ip: await getClientIp() })
  if (!res.ok) return { error: res.error }
  const next = String(formData.get('next') ?? '')
  if (next) redirect(safeNext(next))
  return { done: true }
}

export async function removeOwnFactorAction(): Promise<SimpleResult> {
  const g = await requireFreshProfile()
  if (!g.ok) return { ok: false, error: g.error }
  const res = await removeOwnFactor(await createClient(), g.profile)
  if (res.ok) revalidatePath('/account/security')
  return res
}

/** Ends every sign-in of the person themself (all computers and phones), then the sign-in page. */
export async function signOutEverywhereSelfAction(): Promise<void> {
  const profile = await me()
  const supabase = await createClient()
  await recordAuthEvent({ event: 'sign_out_everywhere', userId: profile.id, actorId: profile.id })
  await supabase.auth.signOut({ scope: 'global' })
  // Review M-3: and every open video of theirs.
  await revokeMediaSessions(createAdminClient(), profile.org_id, profile.id, 'signed_out_everywhere')
  redirect('/login')
}
