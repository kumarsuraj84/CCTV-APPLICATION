// Generates the secrets and per-service database keys of CityKart Drishti (P2-6) into an env file. NEVER prints a value: only the
// names of what was added, kept or rotated. Never overwrites a value that is already set unless --rotate says so.
//
//   node scripts/gen-secrets.mjs                         add what is missing to .env.local (local stack: the JWT secret comes from
//                                                        `supabase status`)
//   node scripts/gen-secrets.mjs --file <path>           another env file (for example a production one, outside the repository)
//   node scripts/gen-secrets.mjs --jwt-secret-env NAME   read the project JWT secret from environment variable NAME instead of the
//                                                        local stack (production: the hosted project's JWT secret)
//   node scripts/gen-secrets.mjs --rotate                replace every generated value (not the plain settings)
//   node scripts/gen-secrets.mjs --rotate=A,B            replace only these keys
//   node scripts/gen-secrets.mjs --only=A,B              look only at these keys
//   node scripts/gen-secrets.mjs --dry-run               say what would change, write nothing
//   node scripts/gen-secrets.mjs --production --out-dir C:\Drishti\config [--jwt-secret-env NAME]
//                                                        P5.4: the production skeleton, one file per Windows service (web.env,
//                                                        worker.env, gateway.env, go2rtc.env), outside the repository only, never over
//                                                        an existing file
//
// After writing: restart the processes that read the changed keys (docs/drishti/runbooks/secret-rotation.md says which).
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnvOutput } from './lib/env-output.mjs'
import { ALL_KEYS, plan, render, SERVICE_KEYS, valueFor } from './lib/gen-secrets-core.mjs'
import { insideDir, PRODUCTION_FILES, productionEnvFiles } from './lib/prod-env.mjs'
import { lockPath, lockedWorkDir, windowsAcl } from './lib/win-acl.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
const valueOf = (name) => {
  const i = args.indexOf(`--${name}`)
  if (i >= 0) return args[i + 1]
  const eq = flag(name)
  return eq && eq.includes('=') ? eq.slice(eq.indexOf('=') + 1) : undefined
}
const fail = (message) => {
  console.error(message)
  process.exit(1)
}
const list = (v) => new Set(String(v).split(',').map((s) => s.trim()).filter(Boolean))

// P5.4: --production --out-dir <folder> writes the production skeleton, one file per Windows service (web.env, worker.env,
// gateway.env, go2rtc.env), to a folder OUTSIDE the repository, never over an existing file. Names only are printed.
if (args.includes('--production')) {
  const outDir = valueOf('out-dir')
  if (!outDir) fail('--production needs --out-dir <folder> (outside the repository, for example C:\\Drishti\\config).')
  const target = path.resolve(outDir)
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  if (insideDir(target, repo)) fail('The production env files must not be written inside the repository: choose a folder outside it (for example C:\\Drishti\\config).')
  const existing = Object.keys(PRODUCTION_FILES).filter((f) => existsSync(path.join(target, f)))
  if (existing.length) fail(`Not written: ${existing.join(', ')} already exist in that folder (nothing is overwritten; edit them, or rotate single values with --file <file> --rotate=NAME).`)
  const envName = valueOf('jwt-secret-env')
  const jwtSecret = envName ? process.env[envName] : undefined
  if (envName && (typeof jwtSecret !== 'string' || jwtSecret.length < 32)) fail(`Environment variable ${envName} does not hold a JWT secret of 32 characters or more.`)
  const files = productionEnvFiles({ jwtSecret })
  if (args.includes('--dry-run')) {
    console.log(`Dry run (nothing written): would write ${Object.keys(files).join(', ')} to ${target}.`)
    process.exit(0)
  }
  // Review I-7: a folder made here is locked at once; each file is created EMPTY, locked, and only then given its secrets.
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true })
    lockPath(target, { folder: true })
  }
  // Re-review M-new-5: an existing folder may not be locked: the temporary copies are made in a locked folder of their own.
  const work = lockedWorkDir(target)
  try {
    for (const [name, text] of Object.entries(files)) {
      const tmp = path.join(work.dir, `${name}.tmp-${process.pid}`)
      writeFileSync(tmp, '', { mode: 0o600, flag: 'wx' })
      lockPath(tmp)
      writeFileSync(tmp, text, { mode: 0o600 })
      renameSync(tmp, path.join(target, name))
    }
  } finally {
    work.done()
  }
  console.log(`Wrote ${Object.keys(files).join(', ')} to ${target} (each readable by SYSTEM and the Administrators only, until the install grants its service).`)
  if (!jwtSecret) console.log('The four database keys are empty: run again per file with --file <file> --jwt-secret-env NAME --only=<KEY> (prints names only).')
  console.log('Fill the addresses (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_URL, NEXT_PUBLIC_APP_URL, GATEWAY_ALLOWED_ORIGINS) and the project keys in web.env,')
  console.log('then run deploy\\windows\\drishti-services.ps1 -Action Install (or -Action RepairAcl): it gives each service read access to its own file.')
  process.exit(0)
}

const file = path.resolve(valueOf('file') ?? '.env.local')
const rotateFlag = flag('rotate')
const rotate = rotateFlag === undefined ? false : rotateFlag.includes('=') ? list(rotateFlag.slice(rotateFlag.indexOf('=') + 1)) : true
const only = flag('only') ? list(valueOf('only')) : undefined
const dryRun = args.includes('--dry-run')
for (const k of [...(rotate instanceof Set ? rotate : []), ...(only ?? [])]) if (!ALL_KEYS.includes(k)) fail(`Unknown key: ${k}`)

const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
const steps = plan(before, { rotate, only })
const writing = steps.filter((s) => s.action !== 'keep')

let jwtSecret
if (writing.some((s) => SERVICE_KEYS.includes(s.key))) {
  const envName = valueOf('jwt-secret-env')
  if (envName) jwtSecret = process.env[envName]
  else {
    try {
      jwtSecret = parseEnvOutput(execSync('npx supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).JWT_SECRET
    } catch {
      jwtSecret = undefined
    }
  }
  if (typeof jwtSecret !== 'string' || jwtSecret.length < 32) {
    fail('The project JWT secret is needed for the service keys: start the local stack (npm run db:start) or pass --jwt-secret-env NAME.')
  }
}

const values = Object.fromEntries(writing.map((s) => [s.key, valueFor(s.key, { jwtSecret })]))
const say = (action) => steps.filter((s) => s.action === action).map((s) => s.key)
const added = say('add')
const rotated = say('rotate')
const kept = say('keep')
if (dryRun) {
  console.log(`Dry run for ${path.basename(file)} (nothing written).`)
} else if (writing.length > 0) {
  // Review I-7: the temporary copy is locked before the secrets go in. A file that exists is then rewritten IN PLACE (on Windows), so
  // its ACL (the service account's read right) is kept: a rename would give it the temporary file's ACL instead. The temporary copy,
  // complete, is removed afterwards (it is the recovery copy if the in-place write were interrupted).
  // Re-review M-new-5: the temporary copy is made in a locked folder of its own (the file's folder may not be locked).
  const work = lockedWorkDir(path.dirname(file))
  try {
    const tmp = path.join(work.dir, `${path.basename(file)}.tmp-${process.pid}`)
    const text = render(before, steps, values)
    writeFileSync(tmp, '', { mode: 0o600, flag: 'wx' })
    lockPath(tmp)
    writeFileSync(tmp, text, { mode: 0o600 })
    if (windowsAcl && existsSync(file)) {
      writeFileSync(file, text)
      rmSync(tmp, { force: true })
    } else renameSync(tmp, file)
  } finally {
    work.done()
  }
  console.log(`Wrote ${path.basename(file)}.`)
} else {
  console.log(`${path.basename(file)} already has every key; nothing written.`)
}
if (added.length) console.log(`Added: ${added.join(', ')}`)
if (rotated.length) console.log(`Rotated: ${rotated.join(', ')}`)
if (kept.length) console.log(`Kept (already set; use --rotate=NAME to replace): ${kept.join(', ')}`)
if (writing.length) console.log('Restart the processes that read these keys (docs/drishti/runbooks/secret-rotation.md).')
