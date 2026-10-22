// Plan hashing and structural validation (P7-0). Pure functions.
import type { AdapterCapabilities, KindCapabilities } from './adapter'
import { canonicalize, CanonicalJsonError, findNonNfc, sha256Hex, type JsonValue } from './canonical'
import { pathsOverlap } from './paths'
import type { Plan } from './types'
import { parseZonedInstant, validateWindow } from './window'

/** Domain tag so a plan hash can never equal the hash of some other canonical document. */
export const PLAN_HASH_DOMAIN = 'drishti.plan.v1'

/** Default longest time a plan may stay valid (its expiry minus now). */
export const DEFAULT_MAX_HORIZON_MS = 30 * 86_400_000

/** SHA-256 over the canonical JSON of the whole plan (every field influences execution). Throws CanonicalJsonError for non-JSON content. */
export function payloadHash(plan: Plan): string {
  return sha256Hex(`${PLAN_HASH_DOMAIN}\n${canonicalize(plan)}`)
}

export interface PlanIssue {
  field: string
  message: string
}

export interface PlanValidationOptions {
  now: number
  adapters: Record<string, AdapterCapabilities>
  /** Longest allowed distance from now to the expiry (default 30 days). */
  max_horizon_ms?: number
}

const SHA256 = /^[0-9a-f]{64}$/
const SETTING_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/
/** Parameter names that hold or name a secret; their value must be a versioned SecretRef. */
const SECRET_NAME = /(password|passphrase|passwd|secret|token|psk|pre_shared|wpa_key|community|credential|private_?key|api_?key)/i

const isInt = (n: unknown, min: number, max = Number.MAX_SAFE_INTEGER): boolean =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max
const nonEmpty = (s: unknown): boolean => typeof s === 'string' && s.trim().length > 0

/** Own-property lookup for user-supplied names (never a prototype property such as "constructor"). */
export function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined
}

export function adapterFor(adapters: Record<string, AdapterCapabilities>, plan: Plan): AdapterCapabilities | undefined {
  return own(adapters, plan.adapter)
}

export function kindFor(adapters: Record<string, AdapterCapabilities>, plan: Plan): KindCapabilities | undefined {
  const a = adapterFor(adapters, plan)
  return a ? own(a.kinds, plan.kind) : undefined
}

/** A versioned secret reference: exactly { ref: "vault:...", version: n ≥ 1, fingerprint: sha256 hex }. */
export function isSecretRef(v: JsonValue | undefined): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const keys = Object.keys(v).sort().join(',')
  return keys === 'fingerprint,ref,version' && typeof v.ref === 'string' && v.ref.startsWith('vault:') && isInt(v.version, 1) && typeof v.fingerprint === 'string' && SHA256.test(v.fingerprint)
}

/** Problems with secrets in the parameters: bare vault references or secret-named values that are not versioned references. */
export function secretIssues(params: JsonValue, path = 'params'): string[] {
  const out: string[] = []
  const walk = (v: JsonValue, p: string, key: string | null) => {
    if (key !== null && SECRET_NAME.test(key) && !isSecretRef(v)) {
      out.push(`${p}: a secret must be a versioned reference { ref, version, fingerprint }, never a value or a bare reference`)
      return
    }
    if (typeof v === 'string') {
      if (v.startsWith('vault:')) out.push(`${p}: a bare vault reference can change after approval; use { ref, version, fingerprint }`)
      return
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`, null)); return }
    if (v !== null && typeof v === 'object') {
      if ('ref' in v && !isSecretRef(v)) { out.push(`${p}: an incomplete secret reference`); return }
      if (isSecretRef(v)) return
      for (const [k, inner] of Object.entries(v)) walk(inner, `${p}.${k}`, k)
    }
  }
  walk(params, path, null)
  return out
}

/** The setting paths a plan changes: derived by the adapter when it can, else the declaration. */
export function effectiveSettingPaths(adapters: Record<string, AdapterCapabilities>, plan: Plan): string[] {
  const a = adapterFor(adapters, plan)
  const derived = a?.describeSettingPaths ? a.describeSettingPaths(plan) : plan.setting_paths
  return [...new Set(derived)].sort()
}

/** Every structural problem of a plan; empty when it may be validated. */
export function validatePlan(plan: Plan, opts: PlanValidationOptions): PlanIssue[] {
  const issues: PlanIssue[] = []
  const add = (field: string, message: string) => issues.push({ field, message })

  let plain = true
  try {
    canonicalize(plan)
  } catch (e) {
    plain = false
    const where = e instanceof CanonicalJsonError ? e.message : String(e)
    add('params', `The plan is not plain JSON: ${where}`)
  }
  const nonNfc = plain ? findNonNfc(plan) : null
  if (nonNfc) add(nonNfc.split(/[.[]/)[1] ?? 'plan', `${nonNfc} is not in Unicode NFC form; send the NFC text (the hash covers the NFC form).`)
  if (plain) for (const m of secretIssues(plan.params)) add('params', m)

  const adapter = adapterFor(opts.adapters, plan)
  const kind = kindFor(opts.adapters, plan)
  if (!adapter) add('adapter', `Unknown adapter "${plan.adapter}".`)
  else {
    if (!kind) add('kind', `The adapter "${plan.adapter}" does not perform "${plan.kind}".`)
    if (plan.adapter_version !== adapter.version) add('adapter_version', `The plan names adapter version "${plan.adapter_version}", but "${adapter.version}" is installed.`)
  }
  if (!nonEmpty(plan.kind)) add('kind', 'A kind is required.')

  if (!nonEmpty(plan.artifact?.id)) add('artifact.id', 'An artifact id is required.')
  if (!nonEmpty(plan.artifact?.version)) add('artifact.version', 'An immutable artifact version is required.')
  if (!SHA256.test(plan.artifact?.sha256 ?? '')) add('artifact.sha256', 'The artifact SHA-256 must be 64 lower-case hex characters.')

  if (!isInt(plan.policy_version, 0)) add('policy_version', 'The policy version must be a whole number of 0 or more.')

  const sel = plan.target_selector
  const hasFilter = (sel.target_ids?.length ?? 0) > 0 || (sel.location_ids?.length ?? 0) > 0
  if (sel.organisation_wide === true && hasFilter) add('target_selector', 'Organisation-wide targeting cannot be combined with target or location lists.')
  if (sel.organisation_wide !== true && !hasFilter) add('target_selector', 'Choose targets or locations, or confirm organisation-wide targeting explicitly.')

  if (plan.base_version !== null && (!nonEmpty(plan.base_version.key) || !isInt(plan.base_version.version, 0))) {
    add('base_version', 'The base version needs a key and a whole-number version.')
  }
  if (plan.supersedes_key !== null && !nonEmpty(plan.supersedes_key)) add('supersedes_key', 'The supersede key must not be blank.')

  if (!Array.isArray(plan.setting_paths) || plan.setting_paths.length === 0) add('setting_paths', 'Name at least one setting the plan changes.')
  else if (new Set(plan.setting_paths).size !== plan.setting_paths.length) add('setting_paths', 'Setting paths must be unique.')
  else if (plan.setting_paths.some((p) => !SETTING_PATH.test(p))) add('setting_paths', 'Setting paths are dot-separated names.')
  else if (adapter?.describeSettingPaths && plain) {
    const derived = effectiveSettingPaths(opts.adapters, plan)
    const stray = plan.setting_paths.filter((p) => !derived.some((d) => pathsOverlap(p, d)))
    if (stray.length > 0) add('setting_paths', `The declared settings ${stray.join(', ')} are not what the plan changes (the adapter derives ${derived.join(', ') || 'nothing'}).`)
  }

  if (plan.conflict_policy !== 'reject' && plan.conflict_policy !== 'wait') add('conflict_policy', 'The conflict policy is "reject" or "wait".')

  const notBefore = parseZonedInstant(plan.schedule.not_before)
  const expires = parseZonedInstant(plan.expires_at)
  if (notBefore === null) add('schedule.not_before', 'The start must be an ISO-8601 time with Z or an offset.')
  if (expires === null) add('expires_at', 'The expiry must be an ISO-8601 time with Z or an offset.')
  else {
    if (expires <= opts.now) add('expires_at', 'The expiry must be in the future.')
    if (notBefore !== null && expires <= notBefore) add('expires_at', 'The expiry must be after the start.')
    const horizon = opts.max_horizon_ms ?? DEFAULT_MAX_HORIZON_MS
    if (expires - opts.now > horizon) add('expires_at', `The expiry is more than ${Math.round(horizon / 86_400_000)} days away.`)
  }
  if (plan.schedule.window !== null) {
    const w = validateWindow(plan.schedule.window)
    if (w.length > 0) add('schedule.window', w.join('; '))
  }

  const c = plan.canary
  if (!['none', 'explicit', 'first_n', 'per_location'].includes(c.mode)) add('canary', 'Unknown canary mode.')
  else if (c.mode !== 'none') {
    if (!isInt(c.soak_ms, 0)) add('canary.soak_ms', 'The soak time must be 0 or more milliseconds.')
    if (c.mode === 'first_n' && !isInt(c.count, 1)) add('canary.count', 'The canary count must be 1 or more.')
    if (c.mode === 'per_location' && !isInt(c.per_location, 1)) add('canary.per_location', 'At least one canary per location.')
    if (c.mode === 'explicit' && (c.target_ids.length === 0 || new Set(c.target_ids).size !== c.target_ids.length)) {
      add('canary.target_ids', 'List one or more distinct canary targets.')
    }
  }

  const b = plan.batch
  if (!isInt(b.batch_size, 1)) add('batch.batch_size', 'The batch size must be 1 or more.')
  if (!isInt(b.global_concurrency, 1)) add('batch.global_concurrency', 'The overall concurrency must be 1 or more.')
  if (!isInt(b.per_location_concurrency, 1)) add('batch.per_location_concurrency', 'The per-location concurrency must be 1 or more.')
  if (!isInt(b.batch_soak_ms, 0)) add('batch.batch_soak_ms', 'The wait between batches must be 0 or more milliseconds.')
  if (typeof b.block_location_on_unknown !== 'boolean') add('batch.block_location_on_unknown', 'Say whether an unknown result blocks the location.')

  const t = plan.thresholds
  if (!isInt(t.stop_after_failures, 1)) add('thresholds.stop_after_failures', 'Stop after 1 or more failures.')
  if (typeof t.stop_after_failure_pct !== 'number' || !(t.stop_after_failure_pct >= 0 && t.stop_after_failure_pct <= 100)) {
    add('thresholds.stop_after_failure_pct', 'The failure percentage is 0 to 100.')
  }
  if (!isInt(t.pct_min_finished, 1)) add('thresholds.pct_min_finished', 'The percentage needs at least 1 finished target.')
  if (!isInt(t.stop_after_consecutive_failures, 1)) add('thresholds.stop_after_consecutive_failures', 'Stop after 1 or more failures in a row.')

  if (!isInt(plan.max_attempts, 1, 5)) add('max_attempts', 'Attempts per target are 1 to 5.')
  if (!['low', 'medium', 'high'].includes(plan.risk)) add('risk', 'The risk is low, medium or high.')
  if (!nonEmpty(plan.requested_by)) add('requested_by', 'The requester is required.')
  return issues
}
