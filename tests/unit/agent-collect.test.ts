// WP-6.2a: the read-only endpoint collector (agent/windows/collector).
// Windows only. The collector is run for real on this machine; machine data (names, serials) is
// compared inside the test and is never printed, logged or put in an assertion message.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)
const isWin = process.platform === 'win32'

const ROOT = path.resolve(__dirname, '../..')
const COLLECTOR_DIR = path.join(ROOT, 'agent/windows/collector')
const COLLECTOR = path.join(COLLECTOR_DIR, 'Collect-DrishtiInventory.ps1')
const SCHEMA_PATH = path.join(ROOT, 'docs/drishti/agent-telemetry-schema.json')

type Run = { code: number; stdout: string; stderr: string }

async function ps(args: string[], env?: Record<string, string>): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      // No -ExecutionPolicy Bypass (P5.4 fix round 3: the owner's antivirus flags it): the collector is a local file, which the default
      // policy of a managed PC (RemoteSigned) runs.
      ['-NoProfile', '-NonInteractive', ...args],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 150_000, env: { ...process.env, ...env } },
    )
    return { code: 0, stdout, stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

const collector = (extra: string[]) => ps(['-File', COLLECTOR, ...extra])

// ---------------------------------------------------------------------------
// A small JSON Schema (draft-07 subset) checker. ajv is not a project dependency, so the schema
// file is checked with the keywords it actually uses: type, enum, const, required, properties,
// additionalProperties, items, minItems, maxItems, minimum, maximum, maxLength, pattern,
// anyOf, $ref to #/definitions.
// ---------------------------------------------------------------------------
type Schema = Record<string, unknown>

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v)
  if (t === actual) return true
  return t === 'number' && actual === 'integer'
}

function validate(value: unknown, schema: Schema, root: Schema, at = '$'): string[] {
  const errors: string[] = []
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/definitions/', '')
    const target = (root.definitions as Record<string, Schema>)[name]
    return validate(value, target, root, at)
  }
  if (Array.isArray(schema.anyOf)) {
    const ok = (schema.anyOf as Schema[]).some((s) => validate(value, s, root, at).length === 0)
    if (!ok) errors.push(`${at}: matches none of anyOf`)
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string]
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${at}: wrong type ${typeOf(value)}`)
      return errors
    }
  }
  if ('const' in schema && value !== schema.const) errors.push(`${at}: not the constant value`)
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) errors.push(`${at}: not an allowed value`)
  if (typeof value === 'string') {
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match pattern`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${at}: below minimum`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${at}: above maximum`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`)
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`)
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((v, i) => errors.push(...validate(v, schema.items as Schema, root, `${at}[${i}]`)))
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const props = (schema.properties ?? {}) as Record<string, Schema>
    for (const req of (schema.required ?? []) as string[]) {
      if (!(req in obj)) errors.push(`${at}: missing ${req}`)
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) errors.push(...validate(v, props[k], root, `${at}.${k}`))
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property ${k}`)
    }
  }
  return errors
}

function walkStrings(v: unknown, fn: (s: string, at: string) => void, at = '$'): void {
  if (typeof v === 'string') fn(v, at)
  else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, fn, `${at}[${i}]`))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walkStrings(x, fn, `${at}.${k}`)
}

const SECTIONS = ['host', 'os', 'hardware', 'network', 'software', 'services', 'security', 'updates', 'metrics']

type Item = { section: string; status: string; reason: string | null }
type Doc = Record<string, unknown> & {
  collection: { duration_ms: number; items: Item[]; privilege?: string }
  host?: Record<string, unknown> | null
  software?: unknown[] | null
  os?: Record<string, unknown> | null
}

let tmp = ''
let schema: Schema
let full: Doc
let fullText: string
let redacted: Doc
let redactedText: string
let realName = ''
let realSerial = ''
let fullRun: Run
let selfTestRun: Run

describe.skipIf(!isWin)('endpoint collector (Windows only)', () => {
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drishti-collect-'))
    schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as Schema
    realName = os.hostname()
    const fullOut = path.join(tmp, 'full.json')
    const redOut = path.join(tmp, 'redacted.json')
    const serialRun = ps([
      '-Command',
      "$s=(Get-CimInstance Win32_BIOS).SerialNumber; if($s){[Console]::Out.Write($s.Trim())}",
    ])
    const [a, b, c, s] = await Promise.all([
      collector(['-OutFile', fullOut]),
      collector(['-Redact', '-OutFile', redOut]),
      collector(['-SelfTest']),
      serialRun,
    ])
    fullRun = a
    selfTestRun = c
    realSerial = s.stdout.trim()
    void b
    fullText = fs.existsSync(fullOut) ? fs.readFileSync(fullOut, 'utf8') : '{}'
    redactedText = fs.existsSync(redOut) ? fs.readFileSync(redOut, 'utf8') : '{}'
    full = JSON.parse(fullText) as Doc
    redacted = JSON.parse(redactedText) as Doc
  }, 240_000)

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  describe('the scripts', () => {
    const scripts = fs.existsSync(COLLECTOR_DIR)
      ? fs.readdirSync(COLLECTOR_DIR).filter((f) => f.toLowerCase().endsWith('.ps1')).map((f) => path.join(COLLECTOR_DIR, f))
      : []

    it('the collector script exists', () => {
      expect(fs.existsSync(COLLECTOR)).toBe(true)
      expect(scripts.length).toBeGreaterThan(0)
    })

    it('every script parses with no errors', async () => {
      for (const file of scripts) {
        const r = await ps(
          [
            '-Command',
            "$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:DRISHTI_PS,[ref]$t,[ref]$e);[Console]::Out.Write(@($e).Count)",
          ],
          { DRISHTI_PS: file },
        )
        expect({ file: path.basename(file), errors: r.stdout.trim() }).toEqual({ file: path.basename(file), errors: '0' })
      }
    })

    it('every script is plain ASCII (PowerShell 5.1 reads BOM-less files as ANSI)', () => {
      for (const file of scripts) {
        const bytes = fs.readFileSync(file)
        expect({ file: path.basename(file), nonAscii: bytes.some((b) => b > 127) }).toEqual({ file: path.basename(file), nonAscii: false })
      }
    })

    // Read-only guarantee: only commands from an allow-list (or functions defined in the same file)
    // may be called, none may be on the write/network deny list, and the single file write sits in
    // the guarded -OutFile function.
    const ALLOWED = new Set([
      'Set-StrictMode', 'Get-CimInstance', 'Get-ItemProperty', 'Get-HotFix', 'Get-MpComputerStatus',
      'Get-NetFirewallProfile', 'Get-Date', 'ConvertTo-Json', 'ConvertFrom-Json', 'Sort-Object', 'Select-Object',
      'Where-Object', 'ForEach-Object', 'Measure-Object', 'Write-Output', 'Write-Host', 'Test-Path', 'Join-Path',
      'Split-Path', 'Resolve-Path', 'Get-Command', 'Get-Item', 'Get-Variable', 'Get-Location',
    ])
    const DENY =
      /^(Set|New|Remove|Start|Stop|Restart|Register|Unregister|Install|Uninstall|Enable|Disable|Add|Clear|Import|Export|Move|Copy|Rename|Out|Invoke|Update|Send|Receive|Push|Pop|Grant|Revoke|Block|Unblock|Suspend|Resume|Save|Publish|Test-Connection|Resolve-DnsName|Disconnect|Connect|Enter|Exit)-|^(iex|sc|ni|ri|rm|rd|del|erase|mv|mi|cp|copy|move|ren|rni|sp|rp|set|sv|saps|sasv|start|kill|spps|spsv|curl|wget|iwr|irm|ping|nslookup)$/i
    const DENY_EXCEPT = new Set(['Set-StrictMode'])

    let ast: { errors: string[]; commands: string[]; functions: string[] } = { errors: [], commands: [], functions: [] }
    beforeAll(async () => {
      const r = await ps(
        [
          '-Command',
          "$e=$null;$t=$null;$a=[System.Management.Automation.Language.Parser]::ParseFile($env:DRISHTI_PS,[ref]$t,[ref]$e);" +
            '$c=@($a.FindAll({param($x) $x -is [System.Management.Automation.Language.CommandAst]},$true)|ForEach-Object{$_.GetCommandName()}|Where-Object{$_}|Sort-Object -Unique);' +
            "$f=@($a.FindAll({param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)|ForEach-Object{'{0}:{1}:{2}' -f $_.Name,$_.Extent.StartLineNumber,$_.Extent.EndLineNumber});" +
            '[Console]::Out.Write((@{errors=@($e|ForEach-Object{$_.Message});commands=$c;functions=$f}|ConvertTo-Json -Compress))',
        ],
        { DRISHTI_PS: COLLECTOR },
      )
      ast = JSON.parse(r.stdout || '{"errors":[],"commands":[],"functions":[]}')
    }, 60_000)

    it('calls only allow-listed commands or its own functions', () => {
      const own = new Set(ast.functions.map((f) => f.split(':')[0].toLowerCase()))
      expect(ast.commands.length).toBeGreaterThan(5)
      const unexpected = ast.commands.filter((c) => !ALLOWED.has(c) && !own.has(c.toLowerCase()))
      expect(unexpected).toEqual([])
    })

    it('calls no write, state-changing, invoke or network command', () => {
      const own = new Set(ast.functions.map((f) => f.split(':')[0].toLowerCase()))
      const bad = ast.commands.filter((c) => !own.has(c.toLowerCase()) && !DENY_EXCEPT.has(c) && DENY.test(c))
      expect(bad).toEqual([])
      // none of our own functions may borrow a write verb either
      const ownBad = [...own].filter((n) => /^(set|new|remove|start|stop|restart|register|install|enable|disable|add|out|invoke)-/i.test(n))
      expect(ownBad).toEqual([])
    })

    const source = fs.existsSync(COLLECTOR) ? fs.readFileSync(COLLECTOR, 'utf8') : ''
    const code = source
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')

    it('uses no network class, tool or cmdlet', () => {
      const net =
        /Net\.WebClient|System\.Net\b|HttpClient|WebRequest|Sockets|Invoke-WebRequest|Invoke-RestMethod|Test-Connection|Resolve-DnsName|GetHostEntry|GetHostAddresses|\[Dns\]|BitsTransfer|nslookup|ping\.exe|curl|wget|NetworkInformation|TcpClient|UdpClient|SmtpClient|Send-MailMessage|WinRM|Enter-PSSession|New-PSSession|-ComputerName|-CimSession|-Online\b/i
      expect(code.match(net)).toBeNull()
    })

    it('has no registry write, no dynamic code and no process start', () => {
      const bad =
        /SetValue|CreateSubKey|DeleteSubKey|DeleteValue|DeleteSubKeyTree|OpenSubKey\([^)]*\$true|Add-Type|Invoke-Expression|\biex\b|\[System\.Diagnostics\.Process\]|Process\]::Start|\bStart-Process\b|-EncodedCommand|LoadUserProfile|RegLoadKey|\.Kill\(|Reflection\.Assembly|LoadWithPartialName/i
      expect(code.match(bad)).toBeNull()
    })

    it('writes a file in exactly one place: the guarded -OutFile function', () => {
      const writes = [...code.matchAll(/\[System\.IO\.(File|Directory|FileStream|StreamWriter)\]::?\w*|\bFile\]::(Write|Append|Create|Delete|Move|Copy|Open)\w*/g)]
      const writeCalls = writes.filter((m) => /Write|Append|Create|Delete|Move|Copy|Open|StreamWriter|FileStream/.test(m[0]))
      expect(writeCalls.length).toBeGreaterThan(0)
      const fn = ast.functions.find((f) => f.toLowerCase().startsWith('write-drishtioutfile:'))
      expect(fn).toBeTruthy()
      const [, start, end] = fn!.split(':').map(Number) as unknown as [string, number, number]
      const lines = source.split(/\r?\n/)
      lines.forEach((line, i) => {
        if (/^\s*#/.test(line)) return
        if (/File\]::(Write|Append|Create|Delete|Move|Copy|Open)|StreamWriter|FileStream/.test(line)) {
          const lineNo = i + 1
          expect({ lineNo, inGuardedFunction: lineNo >= start && lineNo <= end }).toEqual({ lineNo, inGuardedFunction: true })
        }
      })
    })
  })

  describe('self test', () => {
    it('passes and prints no machine data', () => {
      expect(selfTestRun.code).toBe(0)
      expect(selfTestRun.stdout).toContain('SELFTEST: PASS')
      const out = (selfTestRun.stdout + selfTestRun.stderr).toLowerCase()
      expect(out.includes(realName.toLowerCase())).toBe(false)
      if (realSerial.length >= 4) expect(out.includes(realSerial.toLowerCase())).toBe(false)
      expect(selfTestRun.stdout.length).toBeLessThan(2000)
    })
  })

  describe('the telemetry document', () => {
    it('was written by the -OutFile run', () => {
      expect(fullRun.code).toBe(0)
      expect(Object.keys(full).length).toBeGreaterThan(3)
    })

    it('matches the JSON schema', () => {
      expect(validate(full, schema, schema)).toEqual([])
    })

    it('the schema checker itself rejects bad documents', () => {
      const bad = JSON.parse(fullText) as Doc
      ;(bad.host as Record<string, unknown>).join_type = 'cloud'
      expect(validate(bad, schema, schema).length).toBeGreaterThan(0)
      const extra = { ...(JSON.parse(fullText) as Doc), surprise: 1 }
      expect(validate(extra, schema, schema).length).toBeGreaterThan(0)
      const longName = JSON.parse(fullText) as Doc
      ;(longName.host as Record<string, unknown>).model = 'x'.repeat(257)
      expect(validate(longName, schema, schema).length).toBeGreaterThan(0)
      const noCollection = JSON.parse(fullText) as Record<string, unknown>
      delete noCollection.collection
      expect(validate(noCollection, schema, schema).length).toBeGreaterThan(0)
    })

    it('has every section and a status line for each', () => {
      for (const s of SECTIONS) expect(s in full).toBe(true)
      const top = full.collection.items.filter((i) => !i.section.includes('.'))
      expect(top.map((i) => i.section).sort()).toEqual([...SECTIONS].sort())
      for (const i of full.collection.items) expect(['ok', 'unavailable', 'error']).toContain(i.status)
    })

    it('no section failed with an error on this machine', () => {
      const errors = full.collection.items.filter((i) => i.status === 'error').map((i) => i.section)
      expect(errors).toEqual([])
    })

    it('every unavailable or error item says why', () => {
      for (const i of full.collection.items) {
        if (i.status !== 'ok') expect(typeof i.reason === 'string' && i.reason.length > 3).toBe(true)
      }
    })

    it('reports sensible basics for a Windows PC', () => {
      const host = full.host as Record<string, string>
      expect(host.computer_name?.toLowerCase()).toBe(realName.toLowerCase())
      expect(['domain', 'workgroup', 'azure_ad', 'unknown']).toContain(host.join_type)
      const osd = full.os as Record<string, unknown>
      expect(String(osd.build)).toMatch(/^\d{4,6}/)
      expect(String(osd.caption)).toMatch(/windows/i)
      expect(Math.abs((osd.uptime_s as number) - os.uptime())).toBeLessThan(180)
      const hw = full.hardware as { cpu_logical: number; ram_total_mb: number; disks: unknown[] }
      expect(hw.cpu_logical).toBeGreaterThan(0)
      expect(hw.ram_total_mb).toBeGreaterThan(512)
      expect(hw.disks.length).toBeGreaterThan(0)
      const m = full.metrics as { cpu_pct: number; ram_used_pct: number; cpu_samples: number }
      expect(m.cpu_samples).toBe(3)
      expect(m.cpu_pct).toBeGreaterThanOrEqual(0)
      expect(m.cpu_pct).toBeLessThanOrEqual(100)
      expect(m.ram_used_pct).toBeGreaterThan(0)
      expect((full.software as unknown[]).length).toBeGreaterThan(0)
      const svc = (full.services as { required: { name: string }[] }).required.map((s) => s.name.toLowerCase())
      for (const need of ['wuauserv', 'mpssvc', 'w32time', 'spooler', 'rpcss', 'dhcp', 'dnscache', 'windefend']) expect(svc).toContain(need)
    })

    it('keeps to the size caps and carries no control characters', () => {
      expect((full.software ?? []).length).toBeLessThanOrEqual(2000)
      expect(((full.updates as { hotfixes: unknown[] }).hotfixes ?? []).length).toBeLessThanOrEqual(200)
      walkStrings(full, (s, at) => {
        expect({ at, tooLong: s.length > 256 }).toEqual({ at, tooLong: false })
        expect({ at, control: /[\u0000-\u001f\u007f-\u009f]/.test(s) }).toEqual({ at, control: false })
      })
    })

    it('finishes inside the performance budget', () => {
      expect(full.collection.duration_ms).toBeGreaterThan(0)
      expect(full.collection.duration_ms).toBeLessThan(60_000)
    })

    it('uses UTC timestamps in ISO form', () => {
      expect(String(full.collected_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      const age = Date.now() - Date.parse(String(full.collected_at))
      expect(Math.abs(age)).toBeLessThan(10 * 60_000)
    })

    it('is pure ASCII so any console encoding is safe', () => {
      expect(/[^\x00-\x7f]/.test(fullText)).toBe(false)
    })
  })

  describe('redaction', () => {
    it('matches the schema and is marked as redacted', () => {
      expect(validate(redacted, schema, schema)).toEqual([])
      expect(redacted.redacted).toBe(true)
      expect(full.redacted === undefined || full.redacted === false).toBe(true)
    })

    it('removes the real computer name from the whole output', () => {
      expect(redactedText.toLowerCase().includes(realName.toLowerCase())).toBe(false)
      expect(fullText.toLowerCase().includes(realName.toLowerCase())).toBe(true)
    })

    it('removes the real serial number from the whole output', () => {
      if (realSerial.length < 4) return
      expect(redactedText.toLowerCase().includes(realSerial.toLowerCase())).toBe(false)
    })

    it('removes the signed-in user name from the whole output', () => {
      const user = os.userInfo().username
      if (user.length < 3) return
      expect(redactedText.toLowerCase().includes(user.toLowerCase())).toBe(false)
    })

    it('hashes MAC addresses', () => {
      const macs = ((full.hardware as { macs: string[] }).macs ?? []).map((m) => m.toLowerCase())
      const rmacs = (redacted.hardware as { macs: string[] }).macs
      expect(rmacs.length).toBe(macs.length)
      for (const m of rmacs) expect(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(m)).toBe(false)
    })

    it('is stable: the same machine gives the same hash on every run', async () => {
      const out = path.join(tmp, 'again.json')
      const r = await collector(['-Redact', '-Sections', 'host', '-OutFile', out])
      expect(r.code).toBe(0)
      const again = JSON.parse(fs.readFileSync(out, 'utf8')) as Doc
      const a = again.host as Record<string, unknown>
      const b = redacted.host as Record<string, unknown>
      expect(a.computer_name).toBe(b.computer_name)
      expect(a.serial_number).toBe(b.serial_number)
      expect(a.computer_name).not.toBe((full.host as Record<string, unknown>).computer_name)
    }, 60_000)
  })

  describe('failure isolation and options', () => {
    it('a failing section is reported as error and the others stay ok', async () => {
      const out = path.join(tmp, 'sim.json')
      const r = await collector(['-Sections', 'host,software,os', '-SimulateFailure', 'software', '-OutFile', out])
      expect(r.code).toBe(0)
      const d = JSON.parse(fs.readFileSync(out, 'utf8')) as Doc
      const by = Object.fromEntries(d.collection.items.filter((i) => !i.section.includes('.')).map((i) => [i.section, i]))
      expect(by.software.status).toBe('error')
      expect(by.software.reason).toMatch(/simulat/i)
      expect(d.software).toBeNull()
      expect(by.host.status).toBe('ok')
      expect(by.os.status).toBe('ok')
      expect(d.host).not.toBeNull()
      expect(validate(d, schema, schema)).toEqual([])
    }, 60_000)

    it('-Sections limits the output to the sections asked for', async () => {
      const r = await collector(['-Sections', 'host,os', '-Quiet', '-OutFile', path.join(tmp, 'two.json')])
      expect(r.code).toBe(0)
      const d = JSON.parse(fs.readFileSync(path.join(tmp, 'two.json'), 'utf8')) as Doc
      expect(Object.keys(d).filter((k) => SECTIONS.includes(k)).sort()).toEqual(['host', 'os'])
      expect(d.collection.items.filter((i) => !i.section.includes('.')).map((i) => i.section).sort()).toEqual(['host', 'os'])
      expect(validate(d, schema, schema)).toEqual([])
    }, 60_000)

    it('an unknown section name is refused with exit code 2 and nothing is written', async () => {
      const out = path.join(tmp, 'unknown.json')
      const r = await collector(['-Sections', 'host,nonsense', '-OutFile', out])
      expect(r.code).toBe(2)
      expect(fs.existsSync(out)).toBe(false)
    }, 60_000)

    it('-OutFile refuses anything that is not a .json file in an existing folder', async () => {
      const bad = path.join(tmp, 'would-overwrite.txt') // never a script file (the owner's antivirus)
      fs.writeFileSync(bad, 'original')
      const r1 = await collector(['-Sections', 'host', '-OutFile', bad])
      expect(r1.code).toBe(2)
      expect(fs.readFileSync(bad, 'utf8')).toBe('original')
      const r2 = await collector(['-Sections', 'host', '-OutFile', path.join(tmp, 'no-such-folder', 'x.json')])
      expect(r2.code).toBe(2)
      expect(fs.existsSync(path.join(tmp, 'no-such-folder'))).toBe(false)
    }, 60_000)

    it('prints the document to stdout when no -OutFile is given, and nothing with -Quiet', async () => {
      const loud = await collector(['-Sections', 'host'])
      expect(loud.code).toBe(0)
      const d = JSON.parse(loud.stdout) as Doc
      expect(validate(d, schema, schema)).toEqual([])
      const quiet = await collector(['-Sections', 'host', '-Quiet'])
      expect(quiet.code).toBe(0)
      expect(quiet.stdout.trim()).toBe('')
    }, 60_000)

    it('a configurable required-services list is honoured and a missing service is reported, not invented', async () => {
      const out = path.join(tmp, 'svc.json')
      const r = await collector(['-Sections', 'services', '-RequiredServices', 'Spooler,DrishtiNoSuchService', '-OutFile', out])
      expect(r.code).toBe(0)
      const d = JSON.parse(fs.readFileSync(out, 'utf8')) as { services: { required: { name: string; status: string }[] } }
      const names = d.services.required.map((s) => s.name)
      expect(names).toContain('Spooler')
      const missing = d.services.required.find((s) => s.name === 'DrishtiNoSuchService')
      expect(missing?.status).toBe('not_installed')
    }, 60_000)
  })
})
