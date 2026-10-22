'use server'

import { revalidatePath } from 'next/cache'
import { holds } from '@/lib/auth/capabilities'
import { requireProfile } from '@/lib/auth/profile'
import { MSG_CHECK_NOT_ALLOWED, requestCheckNow } from '@/lib/monitor/check-now'
import { rateLimit } from '@/lib/rate-limit'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export type CheckNowState = { ok?: boolean; message?: string; error?: string }

/**
 * Asks the checker to run everything now. Needs it.monitoring.operate for the organisation or a whole location (P2-2): the summary is
 * checked first (nothing else happens without it), then the service asks the database as the person.
 */
export async function requestCheckNowAction(): Promise<CheckNowState> {
  const p = await requireProfile()
  if (!holds(p.capabilities, 'it.monitoring.operate')) return { error: MSG_CHECK_NOT_ALLOWED }
  const { limited } = await rateLimit(`checknow:${p.id}`, 3, 60_000)
  if (limited) return { error: 'Please wait a minute before asking again.' }
  const res = await requestCheckNow({ admin: createAdminClient(), rls: await createClient() }, { id: p.id, orgId: p.org_id, role: p.role })
  revalidatePath('/home')
  revalidatePath('/admin/monitoring')
  if (!res.ok) return { error: res.error }
  return { ok: true, message: res.alreadyOnTheWay ? 'A check is already on its way. New results appear within a minute.' : 'Check requested. New results appear within a minute.' }
}
