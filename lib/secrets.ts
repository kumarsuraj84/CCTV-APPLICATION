// One secret per purpose. A missing one means "not available" (the feature is off and says so), never "use another secret".
export type SecretPurpose = 'cron' | 'worker' | 'stream_token' | 'system_log_ingest'

const ENV_NAME: Record<SecretPurpose, string> = {
  cron: 'CRON_SECRET',
  worker: 'WORKER_SECRET',
  stream_token: 'STREAM_TOKEN_SECRET',
  system_log_ingest: 'SYSTEM_LOG_INGEST_SECRET',
}

export const MIN_SECRET_LENGTH = 16
const clean = (v: string | undefined) => (typeof v === 'string' && v.trim() !== '' ? v : null)

/** The secret for this purpose, or null when it is not configured. The caller must then refuse or switch the feature off. */
export function getSecret(purpose: SecretPurpose): string | null {
  return clean(process.env[ENV_NAME[purpose]])
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
