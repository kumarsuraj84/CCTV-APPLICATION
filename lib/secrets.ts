// One secret per purpose. A missing one means "not available" (the feature is off and says so), never "use another secret".
// access_preview (P2-3 review M-5): the key of the access editor's preview token (an HMAC binding a save to the preview shown).
export type SecretPurpose = 'cron' | 'worker' | 'stream_token' | 'system_log_ingest' | 'access_preview'

const ENV_NAME: Record<SecretPurpose, string> = {
  cron: 'CRON_SECRET',
  worker: 'WORKER_SECRET',
  stream_token: 'STREAM_TOKEN_SECRET',
  system_log_ingest: 'SYSTEM_LOG_INGEST_SECRET',
  access_preview: 'ACCESS_PREVIEW_SECRET',
}

export const MIN_SECRET_LENGTH = 16
const clean = (v: string | undefined) => (typeof v === 'string' && v.trim() !== '' ? v : null)

/** A secret value that may be used: not blank and at least MIN_SECRET_LENGTH characters. Anything else counts as "not set". */
export const usableSecret = (v: string | null | undefined): string | null => {
  const c = clean(v ?? undefined)
  return c !== null && c.length >= MIN_SECRET_LENGTH ? c : null
}

/** The secret for this purpose, or null when it is not configured (or too short to be safe). The caller must then refuse or switch the feature off. */
export function getSecret(purpose: SecretPurpose): string | null {
  return usableSecret(process.env[ENV_NAME[purpose]])
}

export const secretEnvName = (purpose: SecretPurpose) => ENV_NAME[purpose]

export type SecretIssue = { purpose: SecretPurpose; env: string; problem: string }

/** What is wrong with the configured secrets, without ever returning a value. */
export function auditSecrets(env: Record<string, string | undefined> = process.env): SecretIssue[] {
  const issues: SecretIssue[] = []
  const seen = new Map<string, string>()
  for (const purpose of Object.keys(ENV_NAME) as SecretPurpose[]) {
    const name = ENV_NAME[purpose]
    const v = clean(env[name])
    if (!v) {
      issues.push({ purpose, env: name, problem: 'not set' })
      continue
    }
    if (v.length < MIN_SECRET_LENGTH) issues.push({ purpose, env: name, problem: `shorter than ${MIN_SECRET_LENGTH} characters` })
    const other = seen.get(v)
    if (other) issues.push({ purpose, env: name, problem: `the same value as ${other}` })
    else seen.set(v, name)
  }
  return issues
}
