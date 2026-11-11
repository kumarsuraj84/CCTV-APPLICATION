// P5.4 Windows lab suite: the deployment scripts' locks, links and retention on the REAL file system (scratch folders under
// <repo>/.scratch/windows-lab, decoy folders made here; nothing installed, no service, account, task or firewall rule). Moved out of
// tests/unit/windows-scripts.test.ts in fix round 3 (the owner's antivirus): the same rules are unit-tested there on made-up data.
// Run from a normal (not elevated) prompt: the checks of what the service accounts alone may do need the operator's own entry off.
import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertLab, day, grant, ICACLS, icacls, junction, labConfig, ps, psCommon, removeScratch, ROOT, SC, scratch, sddl, unlink } from './lab'

assertLab()

let dir = ''
let config = ''
// Read before the tests are collected (skipIf needs it then).
const elevated = psCommon(['"elevated=$(Test-DrishtiAdministrator)"']).includes('elevated=True')
const ICACLS_LINE = `$icacls = '${ICACLS}'`
beforeAll(() => {
  dir = scratch('scripts')
  config = path.join(dir, 'drishti.config.psd1')
  writeFileSync(config, labConfig(dir))
})
afterAll(() => removeScratch(dir))

const NO_OPERATOR = { DRISHTI_ACL_TEST_NO_OPERATOR: '1' }

describe('Windows lab: locks, links and retention on real folders (P5.4)', () => {
  it('the ACL check: a locked folder has no problem; Authenticated Users with modify (as C:\\ gives) is reported', () => {
    const p = path.join(dir, 'acltest')
    const out = psCommon([
      ICACLS_LINE, `$p = '${p}'`, 'Set-DrishtiAcl -Path $p | Out-Null', '$a = @(Test-DrishtiPathAcl -Path $p -TrustOperator)',
      "& $icacls $p /grant '*S-1-5-11:(OI)(CI)M' | Out-Null", '$b = @(Test-DrishtiPathAcl -Path $p -TrustOperator)',
      '"before=$($a.Count) after=$($b.Count)"',
    ])
    expect(out).toMatch(/before=0 after=1/)
  })

  it('N-1: a second lock (RepairAcl) removes explicit foreign entries everywhere; Users:(R) on web.env is reported', () => {
    const p = path.join(dir, 'n1')
    const out = psCommon([
      ICACLS_LINE, `$p = '${p}'`, 'Set-DrishtiAcl -Path $p | Out-Null',
      "$f = Join-Path $p 'web.env'", "Set-Content -LiteralPath $f -Value 'X=1'",
      "Set-DrishtiAcl -Path $f -ReadAccounts @('*S-1-5-19') -IsFile | Out-Null",
      "& $icacls $f /grant '*S-1-5-32-545:R' | Out-Null",
      "& $icacls $p /grant '*S-1-5-11:(OI)(CI)M' | Out-Null",
      "$sub = Join-Path $p 'sub'", 'New-Item -ItemType Directory -Path $sub | Out-Null', "& $icacls $sub /grant '*S-1-1-0:(OI)(CI)F' | Out-Null",
      "$a1 = @(Test-DrishtiPathAcl -Path $f -ReadAccounts @('*S-1-5-19') -Secret -TrustOperator)", '$a2 = @(Test-DrishtiPathAcl -Path $p -Secret -TrustOperator)',
      '"fileBefore=$($a1.Count) folderBefore=$($a2.Count)"', '$a1', '$a2',
      'Set-DrishtiAcl -Path $p | Out-Null', "Set-DrishtiAcl -Path $f -ReadAccounts @('*S-1-5-19') -IsFile | Out-Null",
      "$b1 = @(Test-DrishtiPathAcl -Path $f -ReadAccounts @('*S-1-5-19') -Secret -TrustOperator)", '$b2 = @(Test-DrishtiPathAcl -Path $p -Secret -TrustOperator)', '$b3 = @(Test-DrishtiPathAcl -Path $sub -Secret -TrustOperator)',
      '$explicit = @((Get-Acl -LiteralPath $sub).Access | Where-Object { -not $_.IsInherited }).Count',
      "$svc = @((Get-Acl -LiteralPath $f).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-19' }).Count",
      '"fileAfter=$($b1.Count) folderAfter=$($b2.Count) subAfter=$($b3.Count) subExplicit=$explicit serviceRead=$svc"',
      "$full = @((Get-Acl -LiteralPath $p).Access | Where-Object { $_.FileSystemRights -eq 'FullControl' -and -not $_.IsInherited } | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }) -join ','",
      '"full=$full protected=$((Get-Acl -LiteralPath $p).AreAccessRulesProtected)"',
      '$o = @(Test-DrishtiPathAcl -Path $p)', '"owner: $($o -join " | ")"',
    ])
    expect(out).toMatch(/fileBefore=1 folderBefore=1/)
    expect(out).toMatch(/web\.env: S-1-5-32-545 may read a secret/)
    expect(out).toMatch(/n1: S-1-5-11 may write/)
    expect(out).toMatch(/fileAfter=0 folderAfter=0 subAfter=0 subExplicit=0 serviceRead=1/)
    expect(out).toMatch(/full=S-1-5-18,S-1-5-32-544(,S-1-5-21-[0-9-]+)? protected=True/)
    // Without trusting the person who ran it (the Audit never does), their ownership of the folder is a problem.
    if (!elevated) expect(out).toMatch(/owner: .*n1: the owner is S-1-5-21-/)
  })

  // Review 2 N-3: never through a link; the folder is checked before anything changes; a decoy behind a link keeps its rules.
  describe('N-3: links, hard links and other owners', () => {
    it('a junction planted below a folder refuses the lock; nothing was changed or followed; the decoy keeps its rules', () => {
      const q = path.join(dir, 'planted')
      const decoy = path.join(dir, 'decoy-planted')
      mkdirSync(path.join(q, 'deep'), { recursive: true })
      mkdirSync(decoy)
      writeFileSync(path.join(decoy, 'keep.txt'), 'outside')
      junction(path.join(q, 'deep', 'evil'), decoy)
      const before = { decoy: sddl(decoy), file: sddl(path.join(decoy, 'keep.txt')), folder: sddl(q) }
      const out = psCommon([`try { Set-DrishtiAcl -Path '${q}'; 'notRefused' } catch { "refused: $($_.Exception.Message)" }`])
      expect(out).toMatch(/refused: Refused below \S+planted \(nothing was changed; nothing was followed\): \S+evil: a junction or link the installation did not make \(not followed\)/)
      expect(sddl(decoy)).toBe(before.decoy)
      expect(sddl(path.join(decoy, 'keep.txt'))).toBe(before.file)
      expect(sddl(q)).toBe(before.folder) // the pre-scan refuses before the folder itself is locked
      expect(readFileSync(path.join(decoy, 'keep.txt'), 'utf8')).toBe('outside')
      unlink(path.join(q, 'deep', 'evil'))
    })

    it('a path that is itself a junction is refused', () => {
      const decoy = path.join(dir, 'decoy-top')
      mkdirSync(decoy)
      const link = path.join(dir, 'top-link')
      junction(link, decoy)
      const before = sddl(decoy)
      const out = psCommon([`try { Set-DrishtiAcl -Path '${link}'; 'notRefused' } catch { "refused: $($_.Exception.Message)" }`])
      expect(out).toMatch(/refused: Refused: \S+top-link is a junction or link/)
      expect(sddl(decoy)).toBe(before)
      unlink(link)
    })

    it('a hard link below a folder, or as the file itself, is refused and its other name keeps its rules', () => {
      const q = path.join(dir, 'hard')
      mkdirSync(q)
      const outside = path.join(dir, 'decoy-hard.txt')
      writeFileSync(outside, 'another file')
      linkSync(outside, path.join(q, 'web.env'))
      const before = sddl(outside)
      const out = psCommon([
        `try { Set-DrishtiAcl -Path '${q}'; 'folderNotRefused' } catch { "folder refused: $($_.Exception.Message)" }`,
        `try { Set-DrishtiAcl -Path '${path.join(q, 'web.env')}' -IsFile; 'fileNotRefused' } catch { "file refused: $($_.Exception.Message)" }`,
      ])
      expect(out).toMatch(/folder refused: Refused below \S+hard .*web\.env: has more than one name, a hard link/)
      expect(out).toMatch(/file refused: Refused: \S+web\.env has more than one name/)
      expect(sddl(outside)).toBe(before)
    })

    it('app\\current is followed only when it is the junction to a release: one to a decoy outside app\\releases is refused', () => {
      const root = path.join(dir, 'inst')
      const releases = path.join(root, 'app', 'releases')
      mkdirSync(path.join(releases, 'b1'), { recursive: true })
      const decoy = path.join(dir, 'decoy-current')
      mkdirSync(decoy)
      const current = path.join(root, 'app', 'current')
      junction(current, decoy)
      const before = sddl(decoy)
      const bad = psCommon([
        `try { Get-DrishtiCurrentRelease -InstallRoot '${root}'; 'notRefused' } catch { "refused: $($_.Exception.Message)" }`,
        `try { Set-DrishtiAcl -Path '${path.join(root, 'app')}' -InstallRoot '${root}' -AllowedLinks @('${current}'); 'lockNotRefused' } catch { "lock refused: $($_.Exception.Message)" }`,
      ])
      expect(bad).toMatch(/refused: Refused: \S+current is not the junction update\.ps1 makes/)
      expect(bad).toMatch(/lock refused: Refused: \S+current is not the junction update\.ps1 makes/)
      expect(sddl(decoy)).toBe(before)
      unlink(current)
      junction(current, path.join(releases, 'b1'))
      const good = psCommon([
        `"release=$(Get-DrishtiCurrentRelease -InstallRoot '${root}')"`,
        `try { Set-DrishtiAcl -Path '${path.join(root, 'app')}' -InstallRoot '${root}' -AllowedLinks @('${current}') | Out-Null; 'locked' } catch { "lock refused: $($_.Exception.Message)" }`,
      ])
      expect(good).toContain(`release=${path.join(releases, 'b1')}`)
      expect(good).toMatch(/^locked$/m)
      unlink(current)
    })

    it.skipIf(elevated)('a folder that existed already and belongs to someone else is refused (the operator not trusted, as in production)', () => {
      const q = path.join(dir, 'precreated')
      mkdirSync(q)
      const out = psCommon([`try { Set-DrishtiAcl -Path '${q}'; 'notRefused' } catch { "refused: $($_.Exception.Message)" }`], NO_OPERATOR)
      expect(out).toMatch(/refused: Refused: \S+precreated existed already and belongs to S-1-5-21-[0-9-]+, not to SYSTEM or the Administrators/)
    })
  })

  // Review M-4 / M-new-1: the plan's List entry (RA,S on the folder only) gives the free space, and still not the folder's contents.
  it.skipIf(elevated)('M-4: the free space of a locked data or backup folder is readable with the List entry only, and nothing in it is', async () => {
    // Two new folders, each locked as it is made (a folder this person cannot read any more is never walked again).
    const none = path.join(dir, 'disk-none')
    const list = path.join(dir, 'disk-list')
    const me = psCommon(['[Security.Principal.WindowsIdentity]::GetCurrent().User.Value']).trim().split(/\r?\n/).at(-1)
    psCommon([`Set-DrishtiAcl -Path '${none}' | Out-Null`, `Set-DrishtiAcl -Path '${list}' -ListAccounts @('*${me}') | Out-Null`], NO_OPERATOR)
    const probe = async (d: string) => {
      const fs = await import('node:fs')
      const statfs = await fs.promises.statfs(d).then((s) => `ok ${s.bavail > 0}`, (e: NodeJS.ErrnoException) => e.code)
      let listed = 'ok'
      try {
        fs.readdirSync(d)
      } catch (e) {
        listed = (e as NodeJS.ErrnoException).code ?? 'error'
      }
      return { statfs, listed }
    }
    expect((await probe(none)).statfs).toBe('EPERM')
    expect(await probe(list)).toEqual({ statfs: 'ok true', listed: 'EPERM' })
  })

  it('the virtual account SIDs computed by the scripts are the ones sc.exe shows', () => {
    const out = psCommon(["ConvertTo-DrishtiSid 'NT SERVICE\\Spooler'", 'Get-DrishtiServiceSid -ServiceName DrishtiWeb'])
    for (const name of ['Spooler', 'DrishtiWeb']) {
      const sid = /S-1-5-80-[0-9-]+/.exec(spawnSync(SC, ['showsid', name], { encoding: 'utf8' }).stdout)?.[0]
      expect(sid, name).toBeTruthy()
      expect(out).toContain(sid!)
    }
  })

  // Review I-6: a SYSTEM task deleting old backups must never follow a junction out of the backup folder.
  it('retention for real (-RetentionOnly): an old backup goes; a junction inside one or in place of one is never followed; the decoys stay', () => {
    const backups = path.join(dir, 'backups')
    mkdirSync(backups, { recursive: true })
    const decoy = path.join(dir, 'decoy')
    const decoy2 = path.join(dir, 'decoy2')
    mkdirSync(decoy)
    mkdirSync(decoy2)
    writeFileSync(path.join(decoy, 'keep.txt'), 'precious')
    writeFileSync(path.join(decoy2, 'manifest.json'), '{"kind":"drishti-backup"}')
    writeFileSync(path.join(decoy2, 'keep.txt'), 'precious too')
    const recent = [1, 2, 3].map((n) => `${day(n)}-nightly`)
    for (const m of recent) {
      mkdirSync(path.join(backups, m))
      writeFileSync(path.join(backups, m, 'manifest.json'), '{"kind":"drishti-backup"}')
    }
    const old = `${day(40)}-nightly`
    const trap = `${day(41)}-trap`
    const jtop = `${day(42)}-jtop`
    for (const m of [old, trap]) {
      mkdirSync(path.join(backups, m))
      writeFileSync(path.join(backups, m, 'manifest.json'), '{"kind":"drishti-backup"}')
    }
    junction(path.join(backups, trap, 'inside'), decoy)
    junction(path.join(backups, jtop), decoy2)
    const r = ps('backup.ps1', ['-ConfigPath', config, '-RetentionOnly'])
    expect(r.status, r.out).toBe(0)
    const left = readdirSync(backups).sort()
    expect(left).not.toContain(old)
    expect(left).toEqual([...recent, trap, jtop].sort())
    expect(readFileSync(path.join(decoy, 'keep.txt'), 'utf8')).toBe('precious')
    expect(readFileSync(path.join(decoy2, 'keep.txt'), 'utf8')).toBe('precious too')
    expect(r.out).toMatch(/kept \S+-trap: it contains a junction or link/)
    expect(r.out).toMatch(/skipped \S+-jtop: a junction or link/)
    unlink(path.join(backups, trap, 'inside'))
    unlink(path.join(backups, jtop))
  })

  // Re-review M-new-8: the backup refuses a backup folder others may write, before it reads anything.
  it('a backup refuses a backup folder that others may write, before touching the database', () => {
    const own = path.join(dir, 'writable')
    mkdirSync(own)
    const cfg = path.join(own, 'drishti.config.psd1')
    writeFileSync(cfg, labConfig(own))
    const backups = path.join(own, 'backups')
    mkdirSync(backups)
    grant(backups, '*S-1-5-11:(OI)(CI)M')
    const r = ps('backup.ps1', ['-ConfigPath', cfg, '-Tag', 'x'])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/Backup refused: others may change or read the backup folder\s+\(\S+backups: S-1-5-11 may write/)
    expect(r.out).not.toMatch(/backup of database/)
    expect(readdirSync(backups)).toEqual([])
  })

  // Review 2 m3: an existing key folder is checked before the configuration (the services' secrets) or the Vault key goes into it.
  it('a key folder others may read is refused before anything is copied into it (dry run: no database needed)', () => {
    const own = path.join(dir, 'keycheck')
    mkdirSync(own)
    const cfg = path.join(own, 'drishti.config.psd1')
    writeFileSync(cfg, labConfig(own))
    const keys = path.join(own, 'keys')
    mkdirSync(keys)
    grant(keys, '*S-1-5-32-545:(OI)(CI)R')
    expect(icacls(keys)).toMatch(/Users/)
    const r = ps('backup.ps1', ['-ConfigPath', cfg, '-Tag', 'key-check', '-IncludeConfig', '-DryRun'])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/Refused: others may change or read the key folder/)
    expect(readdirSync(keys)).toEqual([])
  })

  it('the lab writes only under its scratch folder', () => {
    expect(dir.startsWith(path.join(ROOT, '.scratch', 'windows-lab'))).toBe(true)
    expect(existsSync(dir)).toBe(true)
  })
})
