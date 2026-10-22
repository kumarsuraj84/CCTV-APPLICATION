import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { logger } from '@/lib/observability/logger'

// The capability model in the app (P2-2, decision D-1; docs/drishti/access-model.md). Two kinds of question are asked, and they are
// answered differently on purpose:
//
//  1. "What may this person do at all, and roughly where?" — the request's SUMMARY (`readCapabilities`, one call to
//     my_access_summary per request, cached by getCurrentProfile). The database evaluates every rule (active, password chosen, not
//     revoked, valid now, MFA when enforced). The app uses it to decide what to SHOW: navigation, page gates, buttons, links, wall tiles,
//     index lists. Data itself is still read through the person's own client, so a wrong display decision can never reveal data.
//
//  2. "May this person do THIS to THAT camera / location / asset?" — always the scope-specific database functions through the
//     person's own client (lib/auth/resource.ts: has_capability_for, cameras_with_capability, capability_store_ids), never the
//     any-scope has_capability() and never the report_* / access_session_* helpers (they skip MFA and exist for tooling only).
//
// Roles are administrative authority only (lib/admin/roles.ts).

export const CAPABILITIES = [
  'cctv.live', 'cctv.playback', 'cctv.export',
  'it.inventory.view', 'it.monitoring.view', 'it.monitoring.operate', 'it.remote.view', 'it.remote.control', 'it.diagnostics',
  'it.script.run', 'it.software.manage', 'it.config.deploy', 'it.patch.manage', 'it.credentials.admin', 'it.os.deploy',
  'wifi.inventory.view', 'wifi.config.view_redacted', 'wifi.profile.edit', 'wifi.deploy.approve', 'wifi.deploy.execute',
  'wifi.device.reboot_upgrade', 'wifi.config.restore', 'wifi.credentials.admin',
  'admin.users', 'admin.access', 'admin.inventory', 'admin.alerts', 'admin.audit.read',
] as const
export type Capability = (typeof CAPABILITIES)[number]
export type CctvCapability = 'cctv.live' | 'cctv.playback' | 'cctv.export'
export type AdminCapability = 'admin.users' | 'admin.access' | 'admin.inventory' | 'admin.alerts' | 'admin.audit.read'

export const CCTV_CAPABILITIES: readonly Capability[] = ['cctv.live', 'cctv.playback', 'cctv.export']
/** The IT view of locations and assets: devices, their status, NVR status and addresses (AC-4). */
export const IT_VIEW: readonly Capability[] = ['it.inventory.view', 'it.monitoring.view']

/** Where one capability counts for the person: the whole organisation, and/or specific locations, cameras and assets. */
export type ScopeSummary = { organization: boolean; locations: string[]; cameras: string[]; assets: string[] }
/** `failed`: the summary could not be read; it then holds nothing (fail closed) and screens say so instead of "nothing assigned". */
export type Capabilities = { readonly failed: boolean; readonly grants: Readonly<Partial<Record<Capability, ScopeSummary>>> }

export const NO_CAPABILITIES: Capabilities = Object.freeze({ failed: false, grants: Object.freeze({}) })

type Client = SupabaseClient<Database>
type Row = { capability: string; organization_wide: boolean; location_ids: string[] | null; camera_ids: string[] | null; asset_ids: string[] | null }

const known = new Set<string>(CAPABILITIES)

/** Reads the signed-in person's summary through their own client. Never throws: a failure gives an empty summary marked `failed`. */
export async function readCapabilities(rls: Client): Promise<Capabilities> {
  try {
    const { data, error } = await rls.rpc('my_access_summary')
    if (error) {
      logger.error({ event: 'capability_summary_failed', errorCode: error.code })
      return { failed: true, grants: {} }
    }
    const grants: Partial<Record<Capability, ScopeSummary>> = {}
    for (const r of (data ?? []) as Row[]) {
      if (!known.has(r.capability)) continue // a capability this build does not know is ignored, never guessed at
      grants[r.capability as Capability] = {
        organization: r.organization_wide === true,
        locations: [...(r.location_ids ?? [])].sort(),
        cameras: [...(r.camera_ids ?? [])].sort(),
        assets: [...(r.asset_ids ?? [])].sort(),
      }
    }
    return { failed: false, grants }
  } catch (error) {
    logger.error({ event: 'capability_summary_failed', errorName: error instanceof Error ? error.name : typeof error })
    return { failed: true, grants: {} }
  }
}

// ── Questions about the summary (display decisions and page gates) ───────────

/** The person holds the capability somewhere (any scope). For page gates and links; never for a decision about one resource. */
export const holds = (c: Capabilities, cap: Capability): boolean => c.grants[cap] !== undefined
export const holdsAny = (c: Capabilities, caps: readonly Capability[]): boolean => caps.some((k) => holds(c, k))
/** The person holds the capability for the whole organisation. */
export const holdsOrgWide = (c: Capabilities, cap: Capability): boolean => c.grants[cap]?.organization === true
/** 'organization' | 'specific' | null — the scope summary the profile exposes. */
export const scopeOf = (c: Capabilities, cap: Capability): 'organization' | 'specific' | null =>
  c.grants[cap] ? (c.grants[cap]!.organization ? 'organization' : 'specific') : null

/** Any CCTV capability (camera metadata, camera groups). */
export const holdsCctv = (c: Capabilities): boolean => holdsAny(c, CCTV_CAPABILITIES)
/** The IT view anywhere (devices page, IT dashboard section). */
export const holdsItView = (c: Capabilities): boolean => holdsAny(c, IT_VIEW)
/** Any grant that shows locations (CCTV, IT or Wi-Fi; administrative capabilities show none) — the Stores page. */
export const holdsAnyLocationGrant = (c: Capabilities): boolean => Object.keys(c.grants).some((k) => !k.startsWith('admin.'))
/** Nothing at all is assigned. */
export const holdsNothing = (c: Capabilities): boolean => Object.keys(c.grants).length === 0

/**
 * Display only: whether the summary covers one camera for a capability (organisation, its location, or the camera itself). Used for
 * lists and links; the operation behind the link checks again in the database (lib/auth/resource.ts).
 */
export function coversCamera(c: Capabilities, cap: Capability, camera: { id: string; store_id: string }): boolean {
  const s = c.grants[cap]
  return !!s && (s.organization || s.locations.includes(camera.store_id) || s.cameras.includes(camera.id))
}

/** Display only: whether a whole location is covered for any of the capabilities (organisation or location scope). */
export function coversLocation(c: Capabilities, caps: Capability | readonly Capability[], locationId: string): boolean {
  const list: readonly Capability[] = typeof caps === 'string' ? [caps] : caps
  return list.some((k) => {
    const s = c.grants[k]
    return !!s && (s.organization || s.locations.includes(locationId))
  })
}

/**
 * Display only: the capability covers at least one whole location (or the organisation) — the rule of capability_store_ids, used by
 * check-now (P2-2 fix M-5: the button appears exactly when the action can work).
 */
export function coversSomeWholeLocation(c: Capabilities, cap: Capability): boolean {
  const s = c.grants[cap]
  return !!s && (s.organization || s.locations.length > 0)
}

/** Plain-English explanation for a person who has nothing assigned yet (the home state). */
export const MSG_NOTHING_ASSIGNED = 'Nothing is assigned to your account yet. Ask an administrator for access.'
export const MSG_ACCESS_UNREADABLE = 'Your access could not be read just now. Reload the page in a moment.'
