'use server'

import { revalidatePath } from 'next/cache'
import { requireAdministration } from '@/lib/auth/profile'
import { importDevices, importStores, type ImportResult } from '@/lib/import/apply'
import { parseDevicesCsv } from '@/lib/import/devices-csv'
import { parseStoresCsv, type RowError } from '@/lib/import/stores-csv'
import { createDevice, deleteDevice, updateDevice } from '@/lib/inventory/devices'
import { submittedValues } from '@/lib/forms/submitted-values'
import { archiveInventory, restoreInventory, type ArchiveKind } from '@/lib/inventory/archive'
import { createStore, deleteStore, updateStore } from '@/lib/inventory/stores'
import { localGo2rtc } from '@/lib/streams/local-go2rtc'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

/**
 * `values` carries the submitted non-secret fields back after an error, so the form keeps what was typed. `warning`: saved, but worth a
 * look (review M-2: an NVR address another store's NVR also has).
 */
export type FormResult = { error?: string; ok?: boolean; warning?: string; values?: Record<string, string> }
export type ImportState = { result?: ImportResult; parseErrors?: RowError[]; error?: string }

// P2-2: stores, devices and imports need an administrative role AND admin.inventory (the services still check the role as authority).
async function ctx() {
  const p = await requireAdministration('admin.inventory')
  return { admin: createAdminClient(), actor: { id: p.id, orgId: p.org_id, role: p.role } }
}

const text = (f: FormData, k: string) => String(f.get(k) ?? '')
const STORE_FIELDS = ['name', 'code', 'city', 'zone', 'state', 'address', 'ip', 'rtsp_port', 'http_port', 'nvr_user', 'channels']
const DEVICE_FIELDS = ['name', 'type', 'store_id', 'ip', 'tcp_port', 'notes']

const num = (f: FormData, k: string) => (text(f, k).trim() === '' ? undefined : Number(text(f, k)))

function storeInput(f: FormData) {
  return {
    code: text(f, 'code') || null, name: text(f, 'name'), city: text(f, 'city'), zone: text(f, 'zone'), state: text(f, 'state'), address: text(f, 'address'),
    ip: text(f, 'ip'), rtsp_port: num(f, 'rtsp_port'), http_port: num(f, 'http_port'),
    nvr_user: text(f, 'nvr_user'), nvr_password: text(f, 'nvr_password') || null,
    channels: num(f, 'channels'), is_active: f.get('is_active') === 'on',
  }
}

export async function saveStoreAction(_prev: FormResult, formData: FormData): Promise<FormResult> {
  const { admin, actor } = await ctx()
  const id = text(formData, 'id')
  const res = id ? await updateStore(admin, actor, id, storeInput(formData)) : await createStore(admin, actor, storeInput(formData))
  revalidatePath('/admin/stores')
  if (!res.ok) return { error: res.error, values: submittedValues(formData, STORE_FIELDS, ['is_active']) }
  return res.warning ? { ok: true, warning: res.warning } : { ok: true }
}

export async function deleteStoreAction(storeId: string): Promise<FormResult> {
  const { admin, actor } = await ctx()
  const res = await deleteStore(admin, actor, storeId)
  revalidatePath('/admin/stores')
  return res.ok ? { ok: true } : { error: res.error }
}

function deviceInput(f: FormData) {
  return {
    name: text(f, 'name'), type: text(f, 'type'), store_id: text(f, 'store_id') || null, ip: text(f, 'ip'),
    tcp_port: num(f, 'tcp_port'), notes: text(f, 'notes'), enabled: f.get('enabled') === 'on',
  }
}

export async function saveDeviceAction(_prev: FormResult, formData: FormData): Promise<FormResult> {
  const { admin, actor } = await ctx()
  const id = text(formData, 'id')
  const res = id ? await updateDevice(admin, actor, id, deviceInput(formData)) : await createDevice(admin, actor, deviceInput(formData))
  revalidatePath('/admin/devices')
  return res.ok ? { ok: true } : { error: res.error, values: submittedValues(formData, DEVICE_FIELDS, ['enabled']) }
}

export async function deleteDeviceAction(deviceId: string): Promise<FormResult> {
  const { admin, actor } = await ctx()
  const res = await deleteDevice(admin, actor, deviceId)
  revalidatePath('/admin/devices')
  return res.ok ? { ok: true } : { error: res.error }
}

/** P2-5b: archive / restore a location, NVR, camera, asset, cluster or region (the screens arrive with P2-5c). */
export async function archiveInventoryAction(kind: ArchiveKind, id: string): Promise<FormResult> {
  const p = await requireAdministration('admin.inventory')
  const res = await archiveInventory({ admin: createAdminClient(), rls: await createClient(), go2rtc: localGo2rtc() }, { id: p.id, orgId: p.org_id, role: p.role }, kind, String(id))
  revalidatePath('/admin/stores')
  return res.ok ? { ok: true } : { error: res.error }
}

export async function restoreInventoryAction(kind: ArchiveKind, id: string): Promise<FormResult> {
  const p = await requireAdministration('admin.inventory')
  const res = await restoreInventory({ admin: createAdminClient(), rls: await createClient() }, { id: p.id, orgId: p.org_id, role: p.role }, kind, String(id))
  revalidatePath('/admin/stores')
  return res.ok ? { ok: true } : { error: res.error }
}

const MAX_FILE_BYTES = 5 * 1024 * 1024

async function readFile(formData: FormData): Promise<string | null> {
  const f = formData.get('file')
  if (!(f instanceof File) || f.size === 0 || f.size > MAX_FILE_BYTES) return null
  return f.text()
}

export async function importStoresAction(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const { admin, actor } = await ctx()
  const body = await readFile(formData)
  if (body === null) return { error: 'Choose a CSV file smaller than 5 MB.' }
  const parsed = parseStoresCsv(body)
  const result = await importStores(admin, actor, parsed.rows)
  revalidatePath('/admin/stores')
  return { result, parseErrors: parsed.errors }
}

export async function importDevicesAction(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const { admin, actor } = await ctx()
  const body = await readFile(formData)
  if (body === null) return { error: 'Choose a CSV file smaller than 5 MB.' }
  const parsed = parseDevicesCsv(body)
  const result = await importDevices(admin, actor, parsed.rows)
  revalidatePath('/admin/devices')
  return { result, parseErrors: parsed.errors }
}
