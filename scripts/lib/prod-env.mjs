// P5.4 (brief item 3): the production env skeleton of the four Windows services, one file each with only that service's lines
// (deploy/production.env.example is the annotated template of the same lines). Generated values come from gen-secrets-core.mjs (43
// characters of base64url per secret, one database key per service role); the values shared between services are generated once.
// Nothing here prints or writes: scripts/gen-secrets.mjs --production does, to a folder outside the repository.
import path from 'node:path'
import { valueFor } from './gen-secrets-core.mjs'

const COMMON = [
  ['DRISHTI_ENV', 'production'], ['NODE_ENV', 'production'], ['TZ', 'Asia/Kolkata'],
  ['NEXT_PUBLIC_SUPABASE_URL', ''], ['SUPABASE_URL', ''],
]

/**
 * Each file: [key, default] lines; a default of `null` means "generated" (a secret or a database key). Comments explain the lines the
 * operator fills. The Windows service of each file (deploy/windows/drishti-services.ps1) reads only its own file.
 */
export const PRODUCTION_FILES = {
  'web.env': {
    title: 'Web app (service DrishtiWeb, account NT SERVICE\\DrishtiWeb)',
    lines: [
      ...COMMON,
      ['# The full service key, for GoTrue\'s user administration only (the project\'s service_role key).', undefined],
      ['SUPABASE_SERVICE_ROLE_KEY', ''], ['SUPABASE_APP_WEB_KEY', null], ['SUPABASE_MEDIA_SERVICE_KEY', null], ['NEXT_PUBLIC_SUPABASE_ANON_KEY', ''],
      ['# The one https address people open (runbook-tls.md); the gateway on the same address: NEXT_PUBLIC_STREAM_GATEWAY_URL=/', undefined],
      ['NEXT_PUBLIC_APP_URL', ''], ['NEXT_PUBLIC_STREAM_GATEWAY_URL', '/'],
      ['# The Health and Monitoring pages ask the gateway on this computer, never through the TLS proxy (P5.4 fix round 5).', undefined],
      ['GATEWAY_HEALTH_URL', 'http://127.0.0.1:3412'],
      ['STREAM_TOKEN_SECRET', null], ['ACCESS_PREVIEW_SECRET', null], ['MERGE_CONFIRM_SECRET', null], ['VERIFIED_USER_SECRET', null],
      ['CRON_SECRET', null], ['SYSTEM_LOG_INGEST_SECRET', null],
      ['GO2RTC_URL', 'http://127.0.0.1:1984'], ['GO2RTC_API_USERNAME', null], ['GO2RTC_API_PASSWORD', null],
      ['TRUSTED_PROXY_HOPS', '1'], ['OUTBOUND_TARGET_ALLOWLIST', ''], ['DEMO_VIDEO', ''],
      ['# The Next.js standalone server listens on this computer only (Caddy is the one listener on the network).', undefined],
      ['PORT', '3212'], ['HOSTNAME', '127.0.0.1'],
      ['# The data folder and the backup folder (BackupDir of drishti.config.psd1): the Health page reports the free space of both disks.', undefined],
      ['DRISHTI_DATA_DIR', 'C:\\Drishti\\data'], ['DRISHTI_BACKUP_DIR', 'D:\\DrishtiBackups'],
    ],
  },
  'worker.env': {
    title: 'Monitoring worker (service DrishtiWorker, account NT SERVICE\\DrishtiWorker). Its own key only; NOT the service key.',
    lines: [...COMMON, ['SUPABASE_MONITOR_WORKER_KEY', null], ['WORKER_SECRET', null]],
  },
  'gateway.env': {
    title: 'Video gateway (service DrishtiGateway, account NT SERVICE\\DrishtiGateway). Its own key only; NOT the service key.',
    lines: [
      ...COMMON, ['SUPABASE_VIDEO_GATEWAY_KEY', null], ['STREAM_TOKEN_SECRET', null],
      ['GATEWAY_PORT', '3412'], ['GATEWAY_HOST', '127.0.0.1'],
      ['# Behind the TLS proxy every video socket comes from 127.0.0.1: believe the one hop Caddy adds (the per-address limits, P5.5).', undefined],
      ['TRUSTED_PROXY_HOPS', '1'],
      ['# The web app address(es) people open, comma separated (the same as NEXT_PUBLIC_APP_URL behind Caddy).', undefined],
      ['GATEWAY_ALLOWED_ORIGINS', ''],
      ['GO2RTC_URL', 'http://127.0.0.1:1984'], ['GO2RTC_API_USERNAME', null], ['GO2RTC_API_PASSWORD', null],
    ],
  },
  'go2rtc.env': {
    title: 'go2rtc (service DrishtiGo2rtc, account NT SERVICE\\DrishtiGo2rtc): its API login, read by deploy/windows/go2rtc.windows.yaml.',
    lines: [['GO2RTC_API_USERNAME', null], ['GO2RTC_API_PASSWORD', null]],
  },
}

/** Whether `target` is `dir` or below it (case-insensitive on Windows, where D:\X and d:\x are the same folder). */
export function insideDir(target, dir) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  const rel = path.relative(norm(dir), norm(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * The text of each file. `jwtSecret`: the project's JWT secret, for the four database keys; without it their lines stay empty (fill
 * them later with `node scripts/gen-secrets.mjs --file <file> --jwt-secret-env NAME --only=KEY`).
 * @param {{ jwtSecret?: string, lifetimeSec?: number }} [o]
 * @returns {Record<string, string>}
 */
export function productionEnvFiles(o = {}) {
  /** @type {Map<string, string>} */
  const generated = new Map()
  const value = (key) => {
    if (!generated.has(key)) {
      let v = ''
      if (/_KEY$/.test(key) && key.startsWith('SUPABASE_')) v = o.jwtSecret ? valueFor(key, { jwtSecret: o.jwtSecret, lifetimeSec: o.lifetimeSec }) : ''
      else v = valueFor(key)
      generated.set(key, v)
    }
    return generated.get(key)
  }
  /** @type {Record<string, string>} */
  const out = {}
  for (const [name, spec] of Object.entries(PRODUCTION_FILES)) {
    const lines = [
      `# CityKart Drishti production environment: ${spec.title}`,
      '# Made by scripts/gen-secrets.mjs --production. Keep it private: readable by this service\'s account and the Administrators only',
      '# (icacls, docs/drishti/runbooks/windows-services.md). Never commit it. Rotation: docs/drishti/runbooks/secret-rotation.md.',
    ]
    for (const [key, def] of spec.lines) {
      if (def === undefined) lines.push(key)
      else lines.push(`${key}=${def === null ? value(key) : def}`)
    }
    out[name] = lines.join('\r\n') + '\r\n'
  }
  return out
}
