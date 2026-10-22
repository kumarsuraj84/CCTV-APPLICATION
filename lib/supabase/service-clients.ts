import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { logger } from '@/lib/observability/logger'
import { processSingleton } from '@/lib/process-singleton'
import { isProductionMode } from '@/lib/runtime-mode'
import { resilientFetch } from '@/lib/supabase/resilient-fetch'

// Per-service database identities (P2-6, decision D-14 / D-14a; spike: docs/drishti/adr-service-roles.md). Each server process talks
// to PostgREST with its OWN key: a JWT whose `role` claim names a least-privilege database role (migration
// 20261021000033_p26_service_roles.sql). The keys are made by `node scripts/gen-secrets.mjs` and read from the environment only.
//
//   app_web        the web app's server code (createAdminClient): no NVR login, no observation writes
//   media_service  the video path and the NVR login reads of the web process (createMediaClient)
//   monitor_worker the worker
//   video_gateway  the gateway (three registry functions only)
//
// Compatibility: when a role's key is missing, development falls back to SUPABASE_SERVICE_ROLE_KEY with a loud warning (once per role
// and process) so running processes keep working until the keys are added; production (lib/runtime-mode.ts: DRISHTI_ENV=production or
// NODE_ENV=production) refuses, and lib/startup-checks.ts stops each process at start-up before it serves anything.
// Keys go only into request headers: never into a URL, an error message or a log line.

export type ServiceRole = 'app_web' | 'media_service' | 'monitor_worker' | 'video_gateway'

export const SERVICE_KEY_ENV: Record<ServiceRole, string> = {
  app_web: 'SUPABASE_APP_WEB_KEY',
  media_service: 'SUPABASE_MEDIA_SERVICE_KEY',
  monitor_worker: 'SUPABASE_MONITOR_WORKER_KEY',
  video_gateway: 'SUPABASE_VIDEO_GATEWAY_KEY',
}

type Env = Record<string, string | undefined>
export type KeyAnswer = { ok: true; key: string; fallback: boolean } | { ok: false; error: string }

/** The `role` claim of a JWT (its signature is checked by PostgREST, not here: this only catches a key pasted into the wrong place). */
function roleClaim(jwt: string): string | null {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { role?: unknown }
    return typeof claims.role === 'string' ? claims.role : null
  } catch {
    return null
  }
}

/** Which key this role uses here. Never returns or mentions a key value in an error. */
export function serviceKeyFor(role: ServiceRole, env: Env = process.env): KeyAnswer {
  const name = SERVICE_KEY_ENV[role]
  const own = env[name]?.trim()
  if (own) {
    const claimed = roleClaim(own)
    if (claimed !== role) return { ok: false, error: `${name} is not a key for the ${role} database role. Make it again with: node scripts/gen-secrets.mjs` }
    return { ok: true, key: own, fallback: false }
  }
  if (isProductionMode(env)) return { ok: false, error: `${name} is required in production (its own database key; make it with: node scripts/gen-secrets.mjs).` }
  const service = env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!service) return { ok: false, error: `${name} (or, in development only, SUPABASE_SERVICE_ROLE_KEY) is not set.` }
  return { ok: true, key: service, fallback: true }
}

const warned = processSingleton('supabase.serviceKeyFallbackWarned', () => new Set<ServiceRole>())

/** The key for this role, warning loudly (once per role and process) when development falls back to the service key. Throws a plain error. */
export function requireServiceKey(role: ServiceRole, env: Env = process.env): string {
  const k = serviceKeyFor(role, env)
  if (!k.ok) throw new Error(k.error)
  if (k.fallback && !warned.has(role)) {
    warned.add(role)
    logger.warn({
      event: 'service_key_fallback',
      role,
      message: `${SERVICE_KEY_ENV[role]} is not set: using the full service key in development. Run "node scripts/gen-secrets.mjs" and restart this process. Production refuses to start without it.`,
    })
  }
  return k.key
}

/** A supabase-js client acting as one service role. Server only; never sent to a browser. */
export function createServiceClient(role: ServiceRole) {
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, requireServiceKey(role), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: resilientFetch },
  })
}

/** The media path's client (live, playback, fast playback; NVR logins for those and for discovery and the connection test). */
export const createMediaClient = () => createServiceClient('media_service')

/**
 * GoTrue's admin API (create a person, set a one-time password, ban) accepts only the service-role key on this stack (ADR, remaining
 * risk 1). Used by the user-administration actions for `auth.admin.*` only; their database work goes through the web app's own role.
 */
export function createAuthAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is needed for user administration.')
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: resilientFetch },
  })
}
