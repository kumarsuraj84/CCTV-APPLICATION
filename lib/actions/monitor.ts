'use server'

import { revalidatePath } from 'next/cache'
import { requireProfile } from '@/lib/auth/profile'
import { canRunChecks } from '@/lib/admin/roles'
import { requestCheckNow } from '@/lib/monitor/check-now'
import { rateLimit } from '@/lib/rate-limit'
import { createAdminClient } from '@/lib/supabase/admin'

export type CheckNowState = { ok?: boolean; message?: string; error?: string }

/** Asks the checker to run everything now. Operators, administrators and platform owners only; the role is checked before anything else. */
export async function requestCheckNowAction(): Promise<CheckNowState> {
  const p = await requireProfile()
  if (!canRunChecks(p.role)) return { error: 'You are not allowed to start a check.' }
  const { limited } = await rateLimit(`checknow:${p.id}`, 3, 60_000)
  if (limited) return { error: 'Please wait a minute before asking again.' }
  const res = await requestCheckNow(createAdminClient(), { id: p.id, orgId: p.org_id, role: p.role })
  revalidatePath('/home')
  revalidatePath('/admin/monitoring')
  if (!res.ok) return { error: res.error }
  return { ok: true, message: res.alreadyOnTheWay ? 'A check is already on its way. New results appear within a minute.' : 'Check requested. New results appear within a minute.' }
}
