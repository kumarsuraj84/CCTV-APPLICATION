'use server'

import { revalidatePath } from 'next/cache'
import { createUser, resetUserPassword, setUserAccess, updateUser } from '@/lib/admin/users'
import type { AdminCapability } from '@/lib/auth/capabilities'
import { requireAdministration } from '@/lib/auth/profile'
import { submittedValues } from '@/lib/forms/submitted-values'
import { createAdminClient } from '@/lib/supabase/admin'

export type CreateUserState = { error?: string; values?: Record<string, string>; created?: { email: string; oneTimePassword: string } }
export type PasswordState = { error?: string; oneTimePassword?: string }
export type SimpleState = { error?: string; ok?: boolean }

// P2-2: people are managed with an administrative role AND admin.users; access with admin.access. canManageRole (in the service)
// still decides which roles an actor may manage.
async function ctx(cap: AdminCapability = 'admin.users') {
  const p = await requireAdministration(cap)
  return { admin: createAdminClient(), actor: { id: p.id, orgId: p.org_id, role: p.role } }
}

export async function createUserAction(_prev: CreateUserState, formData: FormData): Promise<CreateUserState> {
  const { admin, actor } = await ctx()
  const email = String(formData.get('email') ?? '')
  const res = await createUser(admin, actor, {
    email,
    full_name: String(formData.get('full_name') ?? ''),
    role: String(formData.get('role') ?? 'user'),
    store_id: String(formData.get('store_id') ?? '') || null,
  })
  revalidatePath('/admin/users')
  return res.ok ? { created: { email, oneTimePassword: res.oneTimePassword } } : { error: res.error, values: submittedValues(formData, ['full_name', 'email', 'role', 'store_id']) }
}

export async function setActiveAction(userId: string, isActive: boolean): Promise<SimpleState> {
  const { admin, actor } = await ctx()
  const res = await updateUser(admin, actor, userId, { is_active: isActive })
  revalidatePath('/admin/users')
  return res.ok ? { ok: true } : { error: res.error }
}

export async function setRoleAction(userId: string, role: string): Promise<SimpleState> {
  const { admin, actor } = await ctx()
  const res = await updateUser(admin, actor, userId, { role })
  revalidatePath('/admin/users')
  return res.ok ? { ok: true } : { error: res.error }
}

export async function resetPasswordAction(userId: string): Promise<PasswordState> {
  const { admin, actor } = await ctx()
  const res = await resetUserPassword(admin, actor, userId)
  revalidatePath('/admin/users')
  return res.ok ? { oneTimePassword: res.oneTimePassword } : { error: res.error }
}

export async function saveAccessAction(userId: string, input: { storeIds: string[]; zones: string[]; cameraIds: string[] }): Promise<SimpleState> {
  const { admin, actor } = await ctx('admin.access')
  const res = await setUserAccess(admin, actor, userId, input)
  revalidatePath(`/admin/users/${userId}/access`)
  return res.ok ? { ok: true } : { error: res.error }
}
