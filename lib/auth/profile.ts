import { cache } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { readVerifiedUserId } from '@/lib/auth/verified-user'
import type { Role } from '@/lib/nav'
import { isAdminRole } from '@/lib/auth/roles'

export type CurrentProfile = {
  id: string
  org_id: string
  email: string
  full_name: string
  role: Role
  is_active: boolean
  must_reset_password: boolean
  store_id: string | null
}

const COLUMNS = 'id, org_id, email, full_name, role, is_active, must_reset_password, store_id'

/** The signed-in person's profile, or null. Uses the id the proxy verified, and checks the session itself when there is none. */
export const getCurrentProfile = cache(async (): Promise<CurrentProfile | null> => {
  const verified = readVerifiedUserId(await headers())
  const supabase = await createClient()
  let userId: string | null
  if (typeof verified === 'string') userId = verified
  else if (verified === null) return null
  else userId = (await supabase.auth.getUser()).data.user?.id ?? null
  if (!userId) return null
  const { data } = await supabase.from('profiles').select(COLUMNS).eq('id', userId).maybeSingle()
  return data && data.is_active ? (data as CurrentProfile) : null
})

/** For pages and actions that need a signed-in person who has already chosen their own password. */
export async function requireProfile(): Promise<CurrentProfile> {
  const profile = await getCurrentProfile()
  if (!profile) redirect('/login')
  if (profile.must_reset_password) redirect('/change-password')
  return profile
}

export async function requireAdmin(): Promise<CurrentProfile> {
  const profile = await requireProfile()
  if (!isAdminRole(profile.role)) redirect('/home')
  return profile
}
