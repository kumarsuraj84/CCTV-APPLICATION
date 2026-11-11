// Per-service database keys for the integration tests (P2-6, D-14). The tests sign their own short-lived keys with the local stack's
// JWT secret, so they never depend on (or touch) the keys in the owner's .env.local. The secret is read from SUPABASE_JWT_SECRET when
// set, else once from `supabase status -o env` of the LOCAL stack; it is kept in memory only and never printed.
import { execSync } from 'node:child_process'
import path from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { parseEnvOutput } from '../../scripts/lib/env-output.mjs'
import { signServiceJwt } from '../../scripts/lib/service-jwt.mjs'
import { assertLocalStack } from './fixtures'

export type ServiceRole = 'app_web' | 'media_service' | 'monitor_worker' | 'video_gateway'

let cached: string | null = null

/** The local stack's JWT secret (never printed). */
export function localJwtSecret(): string {
  assertLocalStack()
  if (cached) return cached
  const fromEnv = process.env.SUPABASE_JWT_SECRET
  if (typeof fromEnv === 'string' && fromEnv.length >= 32) return (cached = fromEnv)
  const out = execSync('npx supabase status -o env', { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const secret = (parseEnvOutput(out) as Record<string, string | undefined>).JWT_SECRET
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('The local stack did not give its JWT secret (is it running?).')
  return (cached = secret)
}

/** A key for one service role, valid for ten minutes. */
export function serviceKey(role: ServiceRole): string {
  return signServiceJwt(localJwtSecret(), role, { lifetimeSec: 600 })
}

// P5.4 fix round 3 (P5.5 report defect 3): every test request says it is a test (x-drishti-test-fixture: on, as tests/setup/fixtures.ts
// does for the service key), so the housekeeping runs a test makes are recorded as '<task>:test' (migration 0047) and never shown as the
// worker's real "last run". The header changes nothing else for these roles (worker_rows_guard reads it for the service key only).
export const TEST_FIXTURE_HEADERS = { 'x-drishti-test-fixture': 'on' }

/** A supabase-js client acting as one service role (PostgREST switches to the role of the key). */
export function serviceClient(role: ServiceRole, o: { realRun?: boolean } = {}): SupabaseClient<Database> {
  assertLocalStack()
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey(role), {
    auth: { persistSession: false, autoRefreshToken: false },
    // realRun: a test that must act exactly as the worker does (no test header).
    global: { headers: o.realRun ? {} : TEST_FIXTURE_HEADERS },
  })
}

/** A plain PostgREST call with a key (status and parsed body; never throws for an HTTP error). */
export async function rest(key: string, pathAndQuery: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
  assertLocalStack()
  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1${pathAndQuery}`, {
    method: init.method ?? 'GET',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json', ...TEST_FIXTURE_HEADERS },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // not JSON
  }
  return { status: res.status, body }
}
