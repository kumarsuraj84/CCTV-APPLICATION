// P5.4 fix round 3: shared helpers of the Windows lab suite (tests/windows-lab). The lab changes real access lists, plants junctions
// and hard links (to decoy folders it makes itself, never to a real folder), and compiles the service host: it is the pre-install
// verification on the production server, never part of the default test run (the owner's antivirus on managed PCs). It runs only
// through `npm run test:windows-lab` with DRISHTI_WINDOWS_LAB=1 (scripts/windows-lab.mjs); vitest.config.ts leaves this folder out
// otherwise, and every lab file refuses on its own as well.
// Everything it makes lives under <repo>/.scratch/windows-lab (gitignored) and is removed afterwards. PowerShell reads its commands
// from standard input: no script file is written and no execution policy is switched.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'

export const ROOT = path.resolve(__dirname, '../..')
export const WIN = path.join(ROOT, 'deploy', 'windows')
export const SCRATCH = path.join(ROOT, '.scratch', 'windows-lab')
const SYS32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
export const ICACLS = path.join(SYS32, 'icacls.exe')
export const CMD = path.join(SYS32, 'cmd.exe')
export const SC = path.join(SYS32, 'sc.exe')
const POWERSHELL = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** Every lab file calls this first: the lab never runs by accident (a direct `vitest run tests/windows-lab` included). */
export function assertLab(): void {
  if (process.platform !== 'win32') throw new Error('The Windows lab suite runs on Windows only.')
  if (process.env.DRISHTI_WINDOWS_LAB !== '1') {
    throw new Error('Refused: the Windows lab suite changes access lists and makes junctions on THIS computer. Run it on the server you are about to install: DRISHTI_WINDOWS_LAB=1 npm run test:windows-lab (docs/drishti/runbooks/windows-services.md section 7).')
  }
}

/** A fresh folder under <repo>/.scratch/windows-lab. */
export function scratch(name: string): string {
  mkdirSync(SCRATCH, { recursive: true })
  return mkdtempSync(path.join(SCRATCH, `${name}-`))
}

export const quote = (s: string) => `'${s.replace(/'/g, "''")}'`

/** Commands for one PowerShell process that dot-sources the shared library, on standard input. */
export function psCommon(lines: string[], env: Record<string, string> = {}): string {
  const input = [`. ${quote(path.join(WIN, 'lib', 'Drishti.Common.ps1'))}`, ...lines].join('\r\n')
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', '-'], { input, encoding: 'utf8', timeout: 180_000, env: { ...process.env, ...env } })
  return `${r.stdout}\n${r.stderr}`
}

/** One repo script with its arguments, on standard input. */
export function ps(script: string, args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const call = `& ${quote(path.join(WIN, script))} ${args.map((a) => (a.startsWith('-') ? a : quote(a))).join(' ')}`
  const input = `try { ${call}; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine(($_ | Out-String)); exit 1 }`
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', '-'], { input, encoding: 'utf8', timeout: 180_000, env: { ...process.env, ...env } })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

/** A junction made by the lab, always to a decoy folder the lab made under its scratch folder. */
export function junction(link: string, decoy: string): void {
  if (!path.resolve(decoy).toLowerCase().startsWith(SCRATCH.toLowerCase() + path.sep)) throw new Error(`lab junctions point at decoys under ${SCRATCH} only`)
  const r = spawnSync(CMD, ['/d', '/c', 'mklink', '/J', link, decoy], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`mklink /J failed: ${r.stdout}${r.stderr}`)
}

/** Removes a link itself (never its target). */
export function unlink(link: string): void {
  spawnSync(CMD, ['/d', '/c', 'rmdir', link], { encoding: 'utf8' })
}

export const icacls = (p: string) => spawnSync(ICACLS, [p], { encoding: 'utf8' }).stdout
export const grant = (p: string, entry: string) => spawnSync(ICACLS, [p, '/grant', entry], { encoding: 'utf8' })
export const sddl = (p: string) => psCommon([`(Get-Acl -LiteralPath ${quote(p)}).Sddl`]).trim()

/**
 * Removes a scratch folder the lab locked: the person running the lab gets full access back (as the owner of what it made), the
 * links inside are removed first by the tests themselves, and then the folder goes.
 */
export function removeScratch(dir: string): void {
  if (!dir || !path.resolve(dir).toLowerCase().startsWith(SCRATCH.toLowerCase() + path.sep)) return
  const me = psCommon(['[Security.Principal.WindowsIdentity]::GetCurrent().User.Value']).trim().split(/\r?\n/).at(-1)
  spawnSync(ICACLS, [dir, '/grant', `*${me}:(OI)(CI)F`, '/T', '/C', '/Q'], { encoding: 'utf8' })
  rmSync(dir, { recursive: true, force: true })
}

/** A configuration for the scripts, every folder under the given scratch folder. */
export function labConfig(dir: string): string {
  return [
    '@{',
    `  InstallRoot = '${dir}\\Drishti'; ConfigDir = '${dir}\\Drishti\\config'; DataDir = '${dir}\\data'; LogDir = '${dir}\\logs'; BackupDir = '${dir}\\backups'`,
    `  NodeExe = 'C:\\Program Files\\nodejs\\node.exe'; Go2rtcExe = '${dir}\\Drishti\\go2rtc\\go2rtc.exe'`,
    "  Services = @('DrishtiGo2rtc', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiWeb')",
    "  Database = @{ Mode = 'Direct'; PgBin = 'C:\\pg\\bin'; Host = '127.0.0.1'; Port = 5432; User = 'postgres'; Name = 'postgres'; PasswordEnv = 'DRISHTI_DB_PASSWORD' }",
    "  MigrationMode = 'DbUrl'",
    `  VaultKey = @{ Mode = 'File'; Path = 'C:\\pg\\pgsodium_root.key'; KeyBackupDir = '${dir}\\keys' }`,
    '  Retention = @{ Days = 30; KeepAtLeast = 3 }',
    '}',
  ].join('\r\n')
}

/** A backup folder name of n days ago, as backup.ps1 names them. */
export const day = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-020000`
}
