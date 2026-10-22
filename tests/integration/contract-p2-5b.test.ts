import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupOrg, createOrg, createSite } from '../setup/fixtures'

const admin = () => adminClient()

/** Every source file of the application (not the tests, not the generated types, not node_modules). */
function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push({ file: full.replaceAll('\\', '/'), text: readFileSync(full, 'utf8') })
    }
  }
  for (const root of ['lib', 'app', 'components', 'services', 'scripts']) walk(root)
  return out
}

// P2-5b contract migration (impact map 2.3 / 5.2, task item 6): the transitional seam of P2-5a is gone from the database AND from the
// code. Old-model assertions of P2-5a that described the seam were replaced by these (never weakened): they now prove its absence.
describe('P2-5b contract: no legacy store shape left', () => {
  let orgId: string
  let loc: string
  beforeAll(async () => {
    orgId = await createOrg()
    loc = (await createSite(orgId, { code: 'CTR', host: '127.0.0.1' })).locationId
  })
  afterAll(() => cleanupOrg(orgId))

  it('the legacy NVR columns are gone from locations', async () => {
    for (const col of ['nvr_ip', 'rtsp_port', 'http_port', 'nvr_username', 'nvr_secret_id', 'expected_channels']) {
      const { error } = await admin().from('locations').select(col).eq('id', loc)
      expect(error?.code, col).toBe('42703')
    }
    expect((await admin().from('locations').select('id, code').eq('id', loc).single()).error).toBeNull()
  })

  it('the seam functions, the location-keyed wrappers, the migration machinery and the snapshot table are gone', async () => {
    // Each is called with exactly the arguments it used to take (PostgREST finds a function by its name AND argument names).
    const gone: [string, object][] = [
      ['nvr_store_credential', { p_store: loc, p_secret: 'x' }], ['nvr_read_credential', { p_store: loc }], ['nvr_delete_credential', { p_store: loc }],
      ['recorder_seam_of', { p_location: loc }], ['recorder_ensure_primary', { p_location: loc }], ['inventory_migrate_org_test', { p_org: orgId }],
      ['inventory_unmigrate_org_test', { p_org: orgId }], ['inventory_secret_fingerprint_test', { p_org: orgId }],
    ]
    for (const [fn, args] of gone) expect((await admin().rpc(fn as never, args as never)).error?.code, fn).toBe('PGRST202')
    expect((await admin().from('inventory_migration_snapshot' as never).select('id')).error?.code).toBe('PGRST205')
    // What stays (the same calls reach the function): the recorder functions, and the location's primary recorder for the legacy
    // single-NVR form and CSV.
    const stays: [string, object][] = [
      ['recorder_read_credential', { p_recorder: loc }], ['recorder_delete_credential', { p_recorder: loc }], ['recorder_primary_of', { p_location: loc }],
      ['recorder_store_credential', { p_recorder: loc, p_secret: 'x' }],
      ['recorder_save', { p_org: orgId, p_location: loc, p_recorder: loc, p_host: '127.0.0.1', p_http_port: 80, p_rtsp_port: 554, p_username: 'u' }],
    ]
    for (const [fn, args] of stays) expect((await admin().rpc(fn as never, args as never)).error?.code ?? 'ok', fn).not.toBe('PGRST202')
  })

  it('no function body names a removed column, function or the target kind \'nvr\' (database source scan)', async () => {
    const { data, error } = await admin().rpc('inventory_stale_name_scan')
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('the target kind \'nvr\' can no longer be stored, and monitor_apply_results ignores it', async () => {
    expect((await admin().from('check_state').insert({ org_id: orgId, target_type: 'nvr', target_id: loc })).error?.code).toBe('23514')
    expect((await admin().rpc('monitor_apply_results', { p_org: orgId, p_results: [{ type: 'nvr', id: loc, ok: false, at: new Date().toISOString() }], p_threshold: 1 })).error).toBeNull()
    expect((await admin().from('check_state').select('id').eq('target_id', loc)).data).toEqual([])
  })

  it('code guard: no application code names the legacy shape (grep proof; the allow-list of P2-5a is gone)', () => {
    const forbidden: [string, RegExp][] = [
      ['legacy NVR column', /\bnvr_ip\b|\bnvr_username\b|\bnvr_secret_id\b/],
      ['location-keyed credential wrapper', /\bnvr_(store|read|delete)_credential\b/],
      ['seam helper', /\blegacyReachable\b|\brecorder_seam_of\b|\brecorder_ensure_primary\b|\binventory_migration_snapshot\b|\bisDemoStore\b|\bloadStoreJobs\b|\bStoreJob\b/],
      ['target kind nvr', /(target_type|type|kind)['"]?\s*(===|==|:|=)\s*['"]nvr['"](?!\s+as const)|['"]nvr['"]\s*\?\s*'NVR'|getStates\([^)]*['"]nvr['"]/],
      ['NVR ports or channels on a location', /from\('locations'\)[^\n]*\b(rtsp_port|http_port|expected_channels)\b|locations!?[\w!]*\([^)]*\b(rtsp_port|http_port|expected_channels)\b/],
    ]
    const hits: string[] = []
    for (const { file, text } of sources()) {
      text.split('\n').forEach((line, i) => {
        for (const [what, re] of forbidden) if (re.test(line)) hits.push(`${file}:${i + 1} ${what}: ${line.trim().slice(0, 140)}`)
      })
    }
    expect(hits).toEqual([])
  })
})
