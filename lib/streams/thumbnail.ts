import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { cameraFor } from '@/lib/auth/resource'

// Thumbnails / snapshots do not exist yet (INITIAL-AUDIT §4.7). When they are built, a snapshot of a camera is a live picture of it, so
// every route or action that serves one MUST call thumbnailAllowed first, with the person's own client, and only then read the NVR
// login with the service role (P2-2 brief item 2). A failed check is "not allowed".

export const THUMBNAIL_CAPABILITY = 'cctv.live' as const

export async function thumbnailAllowed(rls: SupabaseClient<Database>, cameraId: string): Promise<boolean> {
  const r = await cameraFor(rls, THUMBNAIL_CAPABILITY, cameraId)
  return r.ok && r.allowed
}
