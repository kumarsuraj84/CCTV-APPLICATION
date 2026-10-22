import { cache } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { readVerifiedUserId } from '@/lib/auth/verified-user'
import type { Role } from '@/lib/nav'
import { isAdminRole } from '@/lib/admin/roles'
import { holdsAny, holdsOrgWide, readCapabilities, type AdminCapability, type Capabilities, type Capability } from '@/lib/auth/capabilities'
import { safeNext } from '@/lib/auth/safe-next'
import { mfaGate } from '@/lib/auth/session-policy'
import { readSessionStatus, type SessionStatus } from '@/lib/auth/session-status'

export type CurrentProfile = {
  id: string
  org_id: string
  email: string
  full_name: string
  role: Role
  is_active: boolean
  must_reset_password: boolean
  store_id: string | null
  /** What this person may do right now, read once per request from the database (P2-2; lib/auth/capabilities.ts). */
  capabilities: Capabilities
  /** P3-1: this session as the database reads it (multi-factor, sign-in times); null when it could not be read. */
  session: SessionStatus | null
}

// P2-5a: profiles.store_id is now location_id (the home location: information only); read under the old field name until P2-5b.
const COLUMNS = 'id, org_id, email, full_name, role, is_active, must_reset_password, store_id:location_id'

/**
 * The signed-in person's profile with their capability summary, or null. Uses the id the proxy verified, and checks the session itself
 * when there is none. Cached for the request, so the summary is read once however many gates ask.
 */
export const getCurrentProfile = cache(async (): Promise<CurrentProfile | null> => {
  const verified = readVerifiedUserId(await headers())
  const supabase = await createClient()
  let userId: string | null
  if (typeof verified === 'string') userId = verified
  else if (verified === null) return null
  else userId = (await supabase.auth.getUser()).data.user?.id ?? null
  if (!userId) return null
  const { data } = await supabase.from('profiles').select(COLUMNS).eq('id', userId).maybeSingle()
  if (!data || !data.is_active) return null
  const [capabilities, session] = await Promise.all([readCapabilities(supabase), readSessionStatus(supabase)])
  return { ...(data as Omit<CurrentProfile, 'capabilities' | 'session'>), capabilities, session }
})

/** Where the multi-factor gate sends this person (lib/auth/session-policy.ts mfaGate); `ok` when the facts could not be read. */
export const mfaGateOf = (profile: Pick<CurrentProfile, 'session'>) =>
  profile.session
    ? mfaGate({ enforced: profile.session.mfaEnforced, privileged: profile.session.privileged, aal2: profile.session.aal2, hasFactor: profile.session.hasFactor })
    : 'ok'

/** The page this request is for (set by proxy.ts), as a safe place to come back to. */
async function hereForNext(): Promise<string> {
  return encodeURIComponent(safeNext((await headers()).get('x-request-path') ?? ''))
}

/**
 * For pages and actions that need a signed-in person who has finished signing in: the code of their authenticator app when they have
 * one (P3-1, before anything else: the auth server refuses a password change without it), a password of their own, and an
 * authenticator app when one is required for them (multi-factor switched on, administrator or MFA capability; ruling D-10a).
 */
export async function requireProfile(): Promise<CurrentProfile> {
  const profile = await getCurrentProfile()
  if (!profile) redirect('/login')
  const gate = mfaGateOf(profile)
  if (gate === 'challenge') redirect(`/mfa?next=${await hereForNext()}`)
  if (profile.must_reset_password) redirect('/change-password')
  if (gate === 'enrol') redirect(`/mfa/enrol?next=${await hereForNext()}`)
  return profile
}

/**
 * Page gate: the person holds at least one of the capabilities, at any scope; everybody else is sent home (where the home page says
 * what they have). Not a per-resource decision: the page then reads through the person's own client, and each operation checks its
 * camera / location / asset in the database (lib/auth/resource.ts).
 */
export async function requireCapability(caps: Capability | readonly Capability[]): Promise<CurrentProfile> {
  const profile = await requireProfile()
  if (!holdsAny(profile.capabilities, typeof caps === 'string' ? [caps] : caps)) redirect('/home')
  return profile
}

/** Administrative authority (role admin / platform_owner) AND the admin capability for the whole organisation (P2-2 rule). */
export const mayAdminister = (profile: Pick<CurrentProfile, 'role' | 'capabilities'>, cap: AdminCapability): boolean =>
  isAdminRole(profile.role) && holdsOrgWide(profile.capabilities, cap)

/** Gate for the admin pages and admin actions. */
export async function requireAdministration(cap: AdminCapability): Promise<CurrentProfile> {
  const profile = await requireProfile()
  if (!mayAdminister(profile, cap)) redirect('/home')
  return profile
}
