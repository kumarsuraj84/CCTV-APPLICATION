'use server'

// Final fix Y (final review A I-1, B I-1): the owner-only switch of two-step sign-in for the organisation (the Health page). The caller
// first, through the one fresh-sign-in guard (a super administrator holds admin.users like every capability, ruling P-1), then the role,
// then the shared count; the database checks the actor again (security_set_mfa: an active super administrator of the organisation) and
// audits every change with the reason. Switching it off needs a reason of 10 to 500 characters.
import { revalidatePath } from 'next/cache'
import { requireFreshAdministration } from '@/lib/auth/fresh'
import { adminRefusalFor } from '@/lib/rate-limit-shared'
import { createAdminClient } from '@/lib/supabase/admin'

export type MfaSwitchState = { ok?: boolean; error?: string }
const MSG_MFA_OWNER_ONLY = 'Only a super administrator can change whether two-step sign-in is required.'
const MSG_MFA_REASON = 'Give the reason it stays off (10 to 500 characters); it is kept in the audit log.'

export async function setMfaRequirementAction(_prev: MfaSwitchState, formData: FormData): Promise<MfaSwitchState> {
  const g = await requireFreshAdministration('admin.users')
  if (!g.ok) return { error: g.error }
  const p = g.profile
  if (p.role !== 'platform_owner') return { error: MSG_MFA_OWNER_ONLY }
  const slow = await adminRefusalFor('users_change', p.id)
  if (slow) return { error: slow }
  const enforced = formData.get('enforced') === 'on'
  const reason = String(formData.get('reason') ?? '').trim()
  if (!enforced && (reason.length < 10 || reason.length > 500)) return { error: MSG_MFA_REASON }
  const { error } = await createAdminClient().rpc('security_set_mfa', { p_org: p.org_id, p_actor: p.id, p_enforced: enforced, p_reason: enforced ? null as unknown as string : reason })
  if (error) return { error: error.code === '42501' ? MSG_MFA_OWNER_ONLY : error.code === '22023' ? MSG_MFA_REASON : 'The setting could not be saved. Please try again.' }
  revalidatePath('/admin/health')
  return { ok: true }
}
