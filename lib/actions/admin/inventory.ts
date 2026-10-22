'use server'

import { revalidatePath } from 'next/cache'
import { requireFreshAdministration } from '@/lib/auth/fresh'
import type { CurrentProfile } from '@/lib/auth/profile'
import { importDevices, type ImportResult } from '@/lib/import/apply'
import { parseDevicesCsv } from '@/lib/import/devices-csv'
import type { RowError } from '@/lib/import/stores-csv'
import { createDevice, deleteDevice, updateDevice } from '@/lib/inventory/devices'
import { submittedValues } from '@/lib/forms/submitted-values'
import { archiveInventory, restoreInventory, type ArchiveKind } from '@/lib/inventory/archive'
import { refusalFor } from '@/lib/rate-limit-shared'
import { localGo2rtc } from '@/lib/streams/local-go2rtc'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

/**
 * `values` carries the submitted non-secret fields back after an error, so the form keeps what was typed. `warning`: saved, but worth a
 * look (review M-2: an NVR address another location's NVR also has).
 */
export type FormResult = { error?: string; ok?: boolean; warning?: string; values?: Record<string, string> }
export type ImportState = { result?: ImportResult; parseErrors?: RowError[]; error?: string }

// P2-2: devices, archiving and imports need an administrative role AND admin.inventory (the services still check the role as authority).
// P3-1 review I-3: every one of them is a change, so each goes through the one fresh-sign-in guard (requireFreshAdministration).
async function ctx(p: CurrentProfile) {
  // P2-6 (D-11): every administration action counts against the shared administration limit.
  const slow = await refusalFor('admin_action', p.id)
  return { admin: createAdminClient(), actor: { id: p.id, orgId: p.org_id, role: p.role }, slow }
}

const text = (f: FormData, k: string) => String(f.get(k) ?? '')
const DEVICE_FIELDS = ['name', 'type', 'store_id', 'ip', 'tcp_port', 'notes']

const num = (f: FormData, k: string) => (text(f, k).trim() === '' ? undefined : Number(text(f, k)))

function deviceInput(f: FormData) {
  return {
    name: text(f, 'name'), type: text(f, 'type'), store_id: text(f, 'store_id') || null, ip: text(f, 'ip'),
    tcp_port: num(f, 'tcp_port'), notes: text(f, 'notes'), enabled: f.get('enabled') === 'on',
  }
}

export async function saveDeviceAction(_prev: FormResult, formData: FormData): Promise<FormResult> {
  const g = await requireFreshAdministration('admin.inventory')
  if (!g.ok) return { error: g.error, values: submittedValues(formData, DEVICE_FIELDS, ['enabled']) }
  const { admin, actor, slow } = await ctx(g.profile)
  if (slow) return { error: slow }
  const id = text(formData, 'id')
  const res = id ? await updateDevice(admin, actor, id, deviceInput(formData)) : await createDevice(admin, actor, deviceInput(formData))
  revalidatePath('/admin/devices')
  return res.ok ? { ok: true } : { error: res.error, values: submittedValues(formData, DEVICE_FIELDS, ['enabled']) }
}

export async function deleteDeviceAction(deviceId: string): Promise<FormResult> {
  const g = await requireFreshAdministration('admin.inventory')
  if (!g.ok) return { error: g.error }
  const { admin, actor, slow } = await ctx(g.profile)
  if (slow) return { error: slow }
  const res = await deleteDevice(admin, actor, deviceId)
  revalidatePath('/admin/devices')
  return res.ok ? { ok: true } : { error: res.error }
}

/** P2-5b: archive / restore a location, NVR, camera, asset, cluster or region (the screens arrive with P2-5c). */
export async function archiveInventoryAction(kind: ArchiveKind, id: string): Promise<FormResult> {
  const g = await requireFreshAdministration('admin.inventory')
  if (!g.ok) return { error: g.error }
  const p = g.profile
  const slow = await refusalFor('admin_action', p.id)
  if (slow) return { error: slow }
  const res = await archiveInventory({ admin: createAdminClient(), rls: await createClient(), go2rtc: localGo2rtc() }, { id: p.id, orgId: p.org_id, role: p.role }, kind, String(id))
  revalidatePath('/admin/locations')
  return res.ok ? { ok: true } : { error: res.error }
}

export async function restoreInventoryAction(kind: ArchiveKind, id: string): Promise<FormResult> {
  const g = await requireFreshAdministration('admin.inventory')
  if (!g.ok) return { error: g.error }
  const p = g.profile
  const slow = await refusalFor('admin_action', p.id)
  if (slow) return { error: slow }
  const res = await restoreInventory({ admin: createAdminClient(), rls: await createClient() }, { id: p.id, orgId: p.org_id, role: p.role }, kind, String(id))
  revalidatePath('/admin/locations')
  return res.ok ? { ok: true } : { error: res.error }
}

const MAX_FILE_BYTES = 5 * 1024 * 1024

async function readFile(formData: FormData): Promise<string | null> {
  const f = formData.get('file')
  if (!(f instanceof File) || f.size === 0 || f.size > MAX_FILE_BYTES) return null
  return f.text()
}

export async function importDevicesAction(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const g = await requireFreshAdministration('admin.inventory')
  if (!g.ok) return { error: g.error }
  const { admin, actor, slow } = await ctx(g.profile)
  if (slow) return { error: slow }
  const body = await readFile(formData)
  if (body === null) return { error: 'Choose a CSV file smaller than 5 MB.' }
  const parsed = parseDevicesCsv(body)
  const result = await importDevices(admin, actor, parsed.rows)
  revalidatePath('/admin/devices')
  return { result, parseErrors: parsed.errors }
}
