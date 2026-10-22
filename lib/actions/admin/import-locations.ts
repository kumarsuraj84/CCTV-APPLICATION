'use server'

// Server Actions of the validated location import (P2-5c-2 brief item 1). Each one first checks the caller (requireAdministration:
// signed in, active, password chosen, administrative role AND admin.inventory for the whole organisation; anybody else is sent away
// before anything happens); the service asks again from the person's own summary and scopes everything to the organisation. They
// return plain results; the preview and the result never hold a password.
import { revalidatePath } from 'next/cache'
import { requireAdministration } from '@/lib/auth/profile'
import { applyLocationImport, checkLocationImport, type ImportOutcome } from '@/lib/import/locations-import'
import type { ImportPreview } from '@/lib/import/locations-plan'
import { localGo2rtc } from '@/lib/streams/local-go2rtc'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export type ImportCheckState = { ok: true; preview: ImportPreview } | { ok: false; error: string }
export type ImportApplyState = { ok: true; preview: ImportPreview; result: ImportOutcome } | { ok: false; error: string }

const MAX_BYTES = 5 * 1024 * 1024
const MSG_FILE = 'Choose a CSV file smaller than 5 MB.'

async function fileText(f: FormData): Promise<string | null> {
  const file = f.get('file')
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_BYTES) return null
  return file.text()
}
const on = (f: FormData, k: string) => f.get(k) === 'on' || f.get(k) === 'true'

export async function checkLocationImportAction(f: FormData): Promise<ImportCheckState> {
  const p = await requireAdministration('admin.inventory')
  const text = await fileText(f)
  if (text === null) return { ok: false, error: MSG_FILE }
  return checkLocationImport({ admin: createAdminClient(), rls: await createClient() }, { id: p.id, orgId: p.org_id, role: p.role }, text, { skipBadRows: on(f, 'skip_bad_rows') })
}

export async function applyLocationImportAction(f: FormData): Promise<ImportApplyState> {
  const p = await requireAdministration('admin.inventory')
  const text = await fileText(f)
  if (text === null) return { ok: false, error: MSG_FILE }
  const res = await applyLocationImport(
    { admin: createAdminClient(), rls: await createClient(), go2rtc: localGo2rtc() }, { id: p.id, orgId: p.org_id, role: p.role }, text,
    { skipBadRows: on(f, 'skip_bad_rows'), archive: on(f, 'archive'), fingerprint: String(f.get('fingerprint') ?? '') },
  )
  if (res.ok) for (const path of ['/admin/locations', '/admin/regions', '/admin/reconciliation', '/admin/stores', '/stores']) revalidatePath(path, 'layout')
  return res
}
