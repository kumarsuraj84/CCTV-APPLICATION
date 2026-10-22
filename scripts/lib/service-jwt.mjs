// Signs the per-service database keys (P2-6, D-14): an HS256 JWT whose `role` claim names the database role PostgREST switches to.
// Used by scripts/gen-secrets.mjs and by the integration tests. Never logs anything: the caller decides where the key goes.
import { createHmac, randomUUID } from 'node:crypto'

/** The service roles that may be named in a key (migration 20261021000033_p26_service_roles.sql). */
export const SERVICE_ROLES = ['app_web', 'media_service', 'monitor_worker', 'video_gateway']

/** The environment variable that holds each role's key. */
export const SERVICE_KEY_ENV = {
  app_web: 'SUPABASE_APP_WEB_KEY',
  media_service: 'SUPABASE_MEDIA_SERVICE_KEY',
  monitor_worker: 'SUPABASE_MONITOR_WORKER_KEY',
  video_gateway: 'SUPABASE_VIDEO_GATEWAY_KEY',
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

/**
 * A key for `role`, signed with the project's JWT secret (at least 32 characters). `lifetimeSec` defaults to one year (rotate before it
 * ends: docs/drishti/runbooks/secret-rotation.md). `now` is seconds since the epoch.
 */
export function signServiceJwt(secret, role, o = {}) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('The JWT secret must be at least 32 characters.')
  if (!SERVICE_ROLES.includes(role)) throw new Error('Unknown service role.')
  const now = Number.isInteger(o.now) ? o.now : Math.floor(Date.now() / 1000)
  const lifetime = Number.isInteger(o.lifetimeSec) && o.lifetimeSec > 0 ? o.lifetimeSec : 365 * 24 * 3600
  const header = b64({ alg: 'HS256', typ: 'JWT' })
  // `jti`: every key is different, even two made in the same second (a rotation always changes the key; the id names a key in a
  // runbook without showing it).
  const payload = b64({ iss: 'drishti', role, iat: now, exp: now + lifetime, jti: o.keyId ? String(o.keyId) : randomUUID() })
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

/** The claims of a key without checking its signature (to tell which role and when it ends; never for trusting it). */
export function peekClaims(jwt) {
  if (typeof jwt !== 'string') return null
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return claims && typeof claims === 'object' ? claims : null
  } catch {
    return null
  }
}
