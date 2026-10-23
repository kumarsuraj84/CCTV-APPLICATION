// P2-5c-2 brief item 1: the validated location import (validate → preview → apply) against the local database. Synthetic data only
// (ruling R-1): TEST-NET addresses, made-up passwords, `test-…` organisations. Nothing here contacts any NVR (an import never does).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { importStores, parseStoresCsv } from '../setup/legacy-import'
import { applyLocationImport, checkLocationImport, MSG_PLAN_CHANGED } from '@/lib/import/locations-import'
import { ensurePlaceholderCameras } from '@/lib/inventory/cameras'
import {
  adminClient, atCluster, cleanupOrg, createCamera, createCluster, createLocation, createOrg, createRecorder, createRegion, createUser, grant, mapCamera,
  READ_EVERYTHING, type TestUser,
} from '../setup/fixtures'

const admin = () => adminClient()
const DENIED = 'Only administrators can change locations, NVRs and assets.'
const HEADER = 'code,name,display_name,kind,city,zone,region,cluster,ip,port,http_port,user,password,channels,nvr_name,monitoring'

async function counts(orgId: string) {
  const c = async (t: 'locations' | 'recorders' | 'cameras' | 'camera_channel_mappings' | 'regions' | 'clusters', archived = false) => {
    let q = admin().from(t).select('id', { count: 'exact', head: true }).eq('org_id', orgId)
    if (t === 'camera_channel_mappings') q = q.is('valid_to', null)
    else if (t !== 'recorders') q = archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null)
    return (await q).count ?? 0
  }
  return { locations: await c('locations'), recorders: await c('recorders'), cameras: await c('cameras'), mappings: await c('camera_channel_mappings'), regions: await c('regions'), clusters: await c('clusters') }
}
const locationByCode = async (orgId: string, code: string) =>
  (await admin().from('locations').select('id, code, name, kind, city, zone, cluster_id, archived_at').eq('org_id', orgId).eq('code', code).maybeSingle()).data
const recordersOf = async (locationId: string) =>
  ((await admin().from('recorders').select('id, http_port, rtsp_port, username, expected_channels, monitoring_enabled, monitoring_disabled_reason, secret_id, assets!recorders_asset_fk!inner(name, ip, archived_at)')
    .eq('location_id', locationId).order('created_at')).data ?? []) as unknown as {
    id: string; http_port: number; rtsp_port: number; username: string; expected_channels: number; monitoring_enabled: boolean; monitoring_disabled_reason: string | null
    secret_id: string | null; assets: { name: string; ip: string; archived_at: string | null }
  }[]
/** NVRs made by one import share their creation time (one transaction): listed by address for a stable order. */
const recordersByAddress = async (locationId: string) => (await recordersOf(locationId)).sort((a, b) => a.assets.ip.localeCompare(b.assets.ip))
const channelsOf = async (recorderId: string) =>
  ((await admin().from('camera_channel_mappings').select('channel').eq('recorder_id', recorderId).is('valid_to', null).order('channel')).data ?? []).map((m) => m.channel)
const secret = async (recorderId: string) => (await admin().rpc('recorder_read_credential', { p_recorder: recorderId })).data

describe('P2-5c-2 location import', () => {
  let orgId: string
  let otherOrg: string
  let me: TestUser
  let actor: Actor
  const c = (u: TestUser = me) => ({ admin: admin(), rls: u.client })

  beforeAll(async () => {
    orgId = await createOrg()
    otherOrg = await createOrg()
    me = await createUser(orgId, 'admin')
    await grant(orgId, me.id, ['admin.inventory'])
    actor = { id: me.id, orgId, role: 'admin' }
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })

  it('checks the caller first: an administrator without admin.inventory, and an operator with it, are refused before anything is read', async () => {
    const plain = await createUser(orgId, 'admin')
    await grant(orgId, plain.id, READ_EVERYTHING)
    const operator = await createUser(orgId, 'operator')
    await grant(orgId, operator.id, 'admin.inventory')
    const csv = `${HEADER}\nGATE1,,,,Patna,,,,192.0.2.1,,,viewer,Pw-gate,2,,\n`
    expect(await checkLocationImport(c(plain), { id: plain.id, orgId, role: 'admin' }, csv, { skipBadRows: false })).toEqual({ ok: false, error: DENIED })
    expect(await applyLocationImport(c(operator), { id: operator.id, orgId, role: 'operator' }, csv, { skipBadRows: false, archive: false, fingerprint: 'x' })).toEqual({ ok: false, error: DENIED })
    expect(await locationByCode(orgId, 'GATE1')).toBeNull()
  })

  it('validate and preview write nothing; the preview never holds a password', async () => {
    const before = await counts(orgId)
    const csv = `${HEADER}\nPRV1,,,,Patna,BR,,,192.0.2.2,,,viewer,Pw-preview-secret,3,,\n`
    const r = await checkLocationImport(c(), actor, csv, { skipBadRows: false })
    if (!r.ok) throw new Error(r.error)
    expect(r.preview.counts).toMatchObject({ locationsNew: 1, recordersNew: 1, passwordsSet: 1, camerasNew: 3 })
    expect(JSON.stringify(r)).not.toContain('Pw-preview-secret')
    expect(await counts(orgId)).toEqual(before)
  })

  it('applies a file: locations of every kind, several NVRs as repeated rows, passwords in the vault only, cameras, regions and clusters', async () => {
    const csv = [
      HEADER,
      'JCL,,,,Jhansi,up,NORTH,UP-1,192.0.2.10,,,viewer,Pw-JCL,4,,',
      'PTN,,Patna main,store,Patna,BR,,,192.0.2.20,,,viewer,Pw-PTN-1,3,Ground floor,',
      'PTN,,,,,,,,192.0.2.21,8554,8080,viewer,Pw-PTN-2,2,First floor,no',
      'HO,,Head office,head_office,Kolkata,,,,,,,,,,,',
    ].join('\n')
    const check = await checkLocationImport(c(), actor, csv, { skipBadRows: false })
    if (!check.ok) throw new Error(check.error)
    expect(check.preview.errors).toEqual([])
    const r = await applyLocationImport(c(), actor, csv, { skipBadRows: false, archive: false, fingerprint: check.preview.fingerprint })
    if (!r.ok) throw new Error(r.error)
    expect(r.result).toMatchObject({ locationsCreated: 3, locationsUpdated: 0, recordersCreated: 3, recordersUpdated: 0, passwordsGiven: 3, camerasCreated: 9, regionsCreated: 1, clustersCreated: 1 })
    expect(JSON.stringify(r)).not.toMatch(/Pw-/)

    const jcl = (await locationByCode(orgId, 'JCL'))!
    expect(jcl).toMatchObject({ name: 'JCL - Jhansi', kind: 'store', city: 'Jhansi', zone: 'UP' })
    const cluster = (await admin().from('clusters').select('id, code, region_id, regions!clusters_region_fk(code)').eq('id', jcl.cluster_id!).single()).data as unknown as { code: string; regions: { code: string } }
    expect(cluster).toMatchObject({ code: 'UP-1', regions: { code: 'NORTH' } })
    const [jclNvr] = await recordersOf(jcl.id)
    expect(jclNvr).toMatchObject({ http_port: 80, rtsp_port: 554, username: 'viewer', expected_channels: 4, monitoring_enabled: true, assets: { name: 'NVR', ip: '192.0.2.10' } })
    expect(await secret(jclNvr.id)).toBe('Pw-JCL')
    expect(await channelsOf(jclNvr.id)).toEqual([1, 2, 3, 4])

    const ptn = (await locationByCode(orgId, 'PTN'))!
    expect(ptn).toMatchObject({ name: 'Patna main', zone: 'BR', cluster_id: null })
    const ptnNvrs = await recordersByAddress(ptn.id)
    expect(ptnNvrs.map((n) => [n.assets.name, n.assets.ip, n.http_port, n.rtsp_port, n.monitoring_enabled])).toEqual([
      ['Ground floor', '192.0.2.20', 80, 554, true], ['First floor', '192.0.2.21', 8080, 8554, false],
    ])
    expect(ptnNvrs[1].monitoring_disabled_reason).toBe('Switched off by the CSV import.')
    // Switched off: the server never even reads that login (review M15); the vault holds it (credential status: set).
    expect(await secret(ptnNvrs[1].id)).toBeNull()
    expect((await admin().rpc('recorder_credential_status', { p_org: orgId, p_recorder: ptnNvrs[1].id })).data).toMatchObject({ set: true })
    expect(await secret(ptnNvrs[0].id)).toBe('Pw-PTN-1')
    expect(await channelsOf(ptnNvrs[0].id)).toEqual([1, 2, 3])
    expect(await channelsOf(ptnNvrs[1].id)).toEqual([1, 2])

    const ho = (await locationByCode(orgId, 'HO'))!
    expect(ho).toMatchObject({ kind: 'head_office', name: 'Head office' })
    expect(await recordersOf(ho.id)).toEqual([])
    // One audit row for the import, with counts only (never a password, never an address).
    const { data: audit } = await admin().from('admin_audit_log').select('action, detail').eq('org_id', orgId).eq('action', 'locations_imported')
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit)).not.toMatch(/Pw-|192\.0\.2/)
    const { data: all } = await admin().from('admin_audit_log').select('detail').eq('org_id', orgId)
    expect(JSON.stringify(all)).not.toMatch(/Pw-/)
  })

  it('importing the same file again changes nothing: no duplicates, no new audit of NVRs, the vault entries stay', async () => {
    const csv = [
      HEADER,
      'JCL,,,,Jhansi,up,NORTH,UP-1,192.0.2.10,,,viewer,Pw-JCL,4,,',
      'PTN,,Patna main,store,Patna,BR,,,192.0.2.20,,,viewer,Pw-PTN-1,3,Ground floor,',
      'PTN,,,,,,,,192.0.2.21,8554,8080,viewer,Pw-PTN-2,2,First floor,no',
      'HO,,Head office,head_office,Kolkata,,,,,,,,,,,',
    ].join('\n')
    const before = await counts(orgId)
    const secretsBefore = (await recordersByAddress((await locationByCode(orgId, 'PTN'))!.id)).map((r) => r.secret_id)
    const audited = async () => (await admin().from('admin_audit_log').select('id', { count: 'exact', head: true }).eq('org_id', orgId).in('action', ['recorder_created', 'recorder_updated', 'recorder_password_set'])).count
    const auditBefore = await audited()
    const check = await checkLocationImport(c(), actor, csv, { skipBadRows: false })
    if (!check.ok) throw new Error(check.error)
    // Review B-I3: the preview does not compare passwords: a password in the file shows "set"; the database writes it only if it differs.
    expect(check.preview.counts).toMatchObject({ locationsNew: 0, locationsChanged: 0, locationsUnchanged: 3, recordersNew: 0, recordersChanged: 0, recordersUnchanged: 3, passwordsSet: 3, camerasNew: 0 })
    expect(check.preview.locations.flatMap((l) => l.recorders.map((r) => r.password))).toEqual(['set', 'set', 'set'])
    const r = await applyLocationImport(c(), actor, csv, { skipBadRows: false, archive: false, fingerprint: check.preview.fingerprint })
    if (!r.ok) throw new Error(r.error)
    expect(r.result).toMatchObject({ locationsCreated: 0, locationsUpdated: 0, recordersCreated: 0, recordersUpdated: 0, passwordsGiven: 3, camerasCreated: 0 })
    expect(await counts(orgId)).toEqual(before)
    expect((await recordersByAddress((await locationByCode(orgId, 'PTN'))!.id)).map((x) => x.secret_id)).toEqual(secretsBefore)
    // No vault write, no NVR save and no audit row for anything that is already as the file says.
    expect(await audited()).toBe(auditBefore)
  })

  it('review B-I3: the preview is not a password oracle — it is the same whether the file\'s password equals the saved one or not', async () => {
    const l = await createLocation(orgId, { code: 'ORA1', name: 'ORA1 - Agra' })
    await admin().from('locations').update({ city: 'Agra' }).eq('id', l)
    const rec = await createRecorder(orgId, l, { host: '192.0.2.90', secret: 'right-guess', expectedChannels: 0 })
    const row = (pw: string) => `${HEADER}\nORA1,,,,Agra,,,,192.0.2.90,554,80,viewer,${pw},,,\n`
    const right = await checkLocationImport(c(), actor, row('right-guess'), { skipBadRows: false })
    const wrong = await checkLocationImport(c(), actor, row('wrong-guess'), { skipBadRows: false })
    if (!right.ok || !wrong.ok) throw new Error('check failed')
    expect(JSON.stringify(right.preview)).toBe(JSON.stringify(wrong.preview))
    // The comparison function is gone; nothing else compares a saved password with a given one before the apply.
    const call = admin().rpc as unknown as (fn: string, args: object) => Promise<{ error: { code?: string } | null }>
    expect((await call.call(admin(), 'recorder_credentials_match', { p_org: orgId, p_items: [] })).error?.code).toBe('PGRST202')
    // Applying a different password writes it (audited, without the value); applying the same one writes nothing.
    const audits = async () => (await admin().from('admin_audit_log').select('id').eq('org_id', orgId).eq('action', 'recorder_password_set').eq('entity_id', rec)).data!.length
    const a1 = await applyLocationImport(c(), actor, row('right-guess'), { skipBadRows: false, archive: false, fingerprint: right.preview.fingerprint })
    if (!a1.ok) throw new Error(a1.error)
    expect(await audits()).toBe(0)
    expect(await secret(rec)).toBe('right-guess')
    const again = await checkLocationImport(c(), actor, row('new-pass-1'), { skipBadRows: false })
    if (!again.ok) throw new Error(again.error)
    const a2 = await applyLocationImport(c(), actor, row('new-pass-1'), { skipBadRows: false, archive: false, fingerprint: again.preview.fingerprint })
    if (!a2.ok) throw new Error(a2.error)
    expect(await audits()).toBe(1)
    expect(await secret(rec)).toBe('new-pass-1')
  })

  it('review B-M3: a code of an archived location is refused in the preview (no second location with the same code)', async () => {
    const l = await createLocation(orgId, { code: 'ARC1' })
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'location', p_id: l })).error).toBeNull()
    const check = await checkLocationImport(c(), actor, `${HEADER}\nARC1,,,,Gaya,,,,192.0.2.91,,,viewer,pw,1,,\n`, { skipBadRows: false })
    if (!check.ok) throw new Error(check.error)
    expect(check.preview.errors.map((e) => [e.line, e.column])).toEqual([[2, 'code']])
    expect(check.preview.canApply).toBe(false)
  })

  it('review B-M14: archiving an NVR that is not in the file archives its cameras first (never deleted)', async () => {
    const o = await createOrg()
    try {
      const u = await createUser(o, 'admin')
      await grant(o, u.id, 'admin.inventory')
      const a: Actor = { id: u.id, orgId: o, role: 'admin' }
      const cl = { admin: admin(), rls: u.client }
      const two = `${HEADER}\nNV1,,,,Patna,,,,192.0.2.95,554,80,viewer,p1,2,Ground,\nNV1,,,,,,,,192.0.2.96,554,80,viewer,p2,3,First,\n`
      const c1 = await checkLocationImport(cl, a, two, { skipBadRows: false })
      if (!c1.ok) throw new Error(c1.error)
      const r1 = await applyLocationImport(cl, a, two, { skipBadRows: false, archive: false, fingerprint: c1.preview.fingerprint })
      if (!r1.ok) throw new Error(r1.error)
      const one = `${HEADER}\nNV1,,,,Patna,,,,192.0.2.95,554,80,viewer,,2,Ground,\n`
      const c2 = await checkLocationImport(cl, a, one, { skipBadRows: false })
      if (!c2.ok) throw new Error(c2.error)
      expect(c2.preview.archive.map((x) => [x.kind, x.cameras])).toEqual([['recorder', 3]])
      const r2 = await applyLocationImport(cl, a, one, { skipBadRows: false, archive: true, fingerprint: c2.preview.fingerprint })
      if (!r2.ok) throw new Error(r2.error)
      expect(r2.result.archived).toEqual({ locations: 0, recorders: 1, cameras: 0 })
      const loc = (await locationByCode(o, 'NV1'))!
      const nvrs = await recordersByAddress(loc.id)
      expect(nvrs.map((n) => [n.assets.ip, n.assets.archived_at !== null])).toEqual([['192.0.2.95', false], ['192.0.2.96', true]])
      expect((await admin().from('cameras').select('id, archived_at').eq('location_id', loc.id)).data!.filter((x) => x.archived_at !== null)).toHaveLength(3)
    } finally {
      await cleanupOrg(o)
    }
  })

  it('the apply is bound to the preview: when the data changed in between, nothing is written and the person is asked to check again', async () => {
    const csv = `${HEADER}\nFP1,,,,Agra,,,,192.0.2.30,,,viewer,Pw-FP1,2,,\n`
    const check = await checkLocationImport(c(), actor, csv, { skipBadRows: false })
    if (!check.ok) throw new Error(check.error)
    await createLocation(orgId, { code: 'FP1', name: 'Made by someone else meanwhile' })
    const r = await applyLocationImport(c(), actor, csv, { skipBadRows: false, archive: false, fingerprint: check.preview.fingerprint })
    expect(r).toEqual({ ok: false, error: MSG_PLAN_CHANGED })
    expect((await locationByCode(orgId, 'FP1'))!.name).toBe('Made by someone else meanwhile')
  })

  it('all or nothing: a file with a bad row is refused whole; with "skip bad rows" the good locations are imported and the bad one is not', async () => {
    const csv = `${HEADER}\nAON1,,,,Gaya,,,,192.0.2.40,,,viewer,Pw-AON1,1,,\nAON2,,,,Gaya,,,,not-an-ip,,,viewer,Pw-AON2,1,,\n`
    const strict = await checkLocationImport(c(), actor, csv, { skipBadRows: false })
    if (!strict.ok) throw new Error(strict.error)
    expect(strict.preview.errors).toEqual([{ line: 3, column: 'ip', message: 'Not a valid IP address.' }])
    expect(strict.preview.canApply).toBe(false)
    const refused = await applyLocationImport(c(), actor, csv, { skipBadRows: false, archive: false, fingerprint: strict.preview.fingerprint })
    expect(refused).toEqual({ ok: false, error: 'The file has problems. Fix them, or choose “Skip the rows with problems”, and check the file again.' })
    expect(await locationByCode(orgId, 'AON1')).toBeNull()
    const skip = await checkLocationImport(c(), actor, csv, { skipBadRows: true })
    if (!skip.ok) throw new Error(skip.error)
    const done = await applyLocationImport(c(), actor, csv, { skipBadRows: true, archive: false, fingerprint: skip.preview.fingerprint })
    if (!done.ok) throw new Error(done.error)
    expect(done.result.locationsCreated).toBe(1)
    expect(await locationByCode(orgId, 'AON1')).not.toBeNull()
    expect(await locationByCode(orgId, 'AON2')).toBeNull()
  })

  it('one transaction: when the database refuses one location, nothing of the file is saved and the line is named', async () => {
    const before = await counts(orgId)
    const plan = {
      regions: [], clusters: [], archive: [],
      locations: [
        { line: 2, action: 'create', id: null, code: 'TXN1', fields: { name: 'TXN1', kind: 'store' }, cluster: null, join_cluster: null, recorders: [
          { line: 2, action: 'create', id: null, name: 'NVR', host: '192.0.2.50', http_port: 80, rtsp_port: 554, username: 'viewer', channels: 2, password: 'Pw-TXN1', monitoring: true, placeholders: 2 },
        ] },
        { line: 3, action: 'create', id: null, code: 'TXN2', fields: { name: 'TXN2', kind: 'castle' }, cluster: null, join_cluster: null, recorders: [] },
      ],
    }
    const { error } = await admin().rpc('inventory_import_apply', { p_org: orgId, p_actor: me.id, p_plan: plan })
    expect(error?.code).toBe('23514')
    expect(error?.details).toBe('import_line:3')
    expect(await locationByCode(orgId, 'TXN1')).toBeNull()
    expect(await counts(orgId)).toEqual(before)
  })

  it('the database function checks the acting person too (administrative role and admin.inventory for the organisation)', async () => {
    const plain = await createUser(orgId, 'admin')
    const plan = { regions: [], clusters: [], archive: [], locations: [{ line: 2, action: 'create', id: null, code: 'ACT1', fields: { name: 'ACT1', kind: 'store' }, cluster: null, join_cluster: null, recorders: [] }] }
    expect((await admin().rpc('inventory_import_apply', { p_org: orgId, p_actor: plain.id, p_plan: plan })).error?.code).toBe('42501')
    expect((await admin().rpc('inventory_import_apply', { p_org: otherOrg, p_actor: me.id, p_plan: plan })).error?.code).toBe('42501')
    expect(await locationByCode(orgId, 'ACT1')).toBeNull()
  })

  it('the legacy store file keeps working: location + primary NVR + channels; a changed address updates the primary NVR', async () => {
    const legacy = 'name,city,zone,ip,port,http_port,user,password,channels\nLEG1,Ranchi,JH,192.0.2.60,554,80,viewer,Pw-LEG1,2\n'
    const a = await checkLocationImport(c(), actor, legacy, { skipBadRows: false })
    if (!a.ok) throw new Error(a.error)
    const ra = await applyLocationImport(c(), actor, legacy, { skipBadRows: false, archive: false, fingerprint: a.preview.fingerprint })
    if (!ra.ok) throw new Error(ra.error)
    const loc = (await locationByCode(orgId, 'LEG1'))!
    expect(loc).toMatchObject({ name: 'LEG1 - Ranchi', zone: 'Jharkhand' })
    const [nvr] = await recordersOf(loc.id)
    // P2-5c-1 review I-4: without the password, a changed address is refused on its row (the saved one belongs to the old address).
    const noPassword = await checkLocationImport(c(), actor, legacy.replace('192.0.2.60', '192.0.2.61').replace('Pw-LEG1', ''), { skipBadRows: false })
    if (!noPassword.ok) throw new Error(noPassword.error)
    expect(noPassword.preview.errors.map((e) => [e.line, e.column])).toEqual([[2, 'password']])
    const moved = legacy.replace('192.0.2.60', '192.0.2.61')
    const b = await checkLocationImport(c(), actor, moved, { skipBadRows: false })
    if (!b.ok) throw new Error(b.error)
    expect(b.preview.locations[0].recorders[0]).toMatchObject({ action: 'update', id: nvr.id, matchedBy: 'primary', changes: ['address'], password: 'set' })
    const rb = await applyLocationImport(c(), actor, moved, { skipBadRows: false, archive: false, fingerprint: b.preview.fingerprint })
    if (!rb.ok) throw new Error(rb.error)
    const after = await recordersOf(loc.id)
    expect(after.map((x) => [x.id, x.assets.ip])).toEqual([[nvr.id, '192.0.2.61']])
    expect(await secret(nvr.id)).toBe('Pw-LEG1')
  })

  it('an existing location without a cluster joins the cluster of the file like a move (audited, access versions raised); one in another cluster is not moved', async () => {
    const region = await createRegion(orgId, { code: 'JOINR' })
    const target = await createCluster(orgId, region, { code: 'JOIN-C' })
    const other = await createCluster(orgId, null, { code: 'ELSEWHERE' })
    const loose = await createLocation(orgId, { code: 'JOIN1', name: 'JOIN1' })
    const placed = await createLocation(orgId, { code: 'JOIN2', name: 'JOIN2', clusterId: other })
    const holder = await createUser(orgId, 'user')
    await grant(orgId, holder.id, ['cctv.live'], atCluster(target))
    const version = async () => Number((await admin().from('profiles').select('access_version').eq('id', holder.id).single()).data!.access_version)
    const v0 = await version()
    const csv = 'code,cluster\nJOIN1,JOIN-C\nJOIN2,JOIN-C\n'
    const check = await checkLocationImport(c(), actor, csv, { skipBadRows: false })
    if (!check.ok) throw new Error(check.error)
    expect(check.preview.warnings.map((w) => [w.line, w.column])).toEqual([[3, 'cluster']])
    const r = await applyLocationImport(c(), actor, csv, { skipBadRows: false, archive: false, fingerprint: check.preview.fingerprint })
    if (!r.ok) throw new Error(r.error)
    expect((await admin().from('locations').select('cluster_id').eq('id', loose).single()).data!.cluster_id).toBe(target)
    expect((await admin().from('locations').select('cluster_id').eq('id', placed).single()).data!.cluster_id).toBe(other)
    expect(await version()).toBeGreaterThan(v0)
    expect((await admin().from('admin_audit_log').select('id').eq('org_id', orgId).eq('action', 'hierarchy_moved').eq('entity_id', loose)).data).toHaveLength(1)
  })

  it('what is not in the file is only listed; it is archived (never deleted) only with the confirmation, and keeps its grants', async () => {
    const o = await createOrg()
    try {
      const u = await createUser(o, 'admin')
      await grant(o, u.id, 'admin.inventory')
      const a: Actor = { id: u.id, orgId: o, role: 'admin' }
      const full = `${HEADER}\nKEEP,,,,Patna,,,,192.0.2.70,,,viewer,Pw-K,4,,\nDROP,,,,Gaya,,,,192.0.2.71,,,viewer,Pw-D,2,,\n`
      const c1 = await checkLocationImport({ admin: admin(), rls: u.client }, a, full, { skipBadRows: false })
      if (!c1.ok) throw new Error(c1.error)
      const r1 = await applyLocationImport({ admin: admin(), rls: u.client }, a, full, { skipBadRows: false, archive: false, fingerprint: c1.preview.fingerprint })
      if (!r1.ok) throw new Error(r1.error)
      const drop = (await locationByCode(o, 'DROP'))!
      const viewer = await createUser(o, 'user')
      await grant(o, viewer.id, ['cctv.live'], { kind: 'location', id: drop.id })
      // The next file lists KEEP with 2 cameras instead of 4, and not DROP.
      const smaller = `${HEADER}\nKEEP,,,,Patna,,,,192.0.2.70,,,viewer,,2,,\n`
      const c2 = await checkLocationImport({ admin: admin(), rls: u.client }, a, smaller, { skipBadRows: false })
      if (!c2.ok) throw new Error(c2.error)
      expect(c2.preview.archive.map((x) => [x.kind, x.label])).toEqual([
        ['camera', 'KEEP · NVR · channel 3 (Camera 3)'], ['camera', 'KEEP · NVR · channel 4 (Camera 4)'], ['location', 'DROP · DROP - Gaya'],
      ])
      const noConfirm = await applyLocationImport({ admin: admin(), rls: u.client }, a, smaller, { skipBadRows: false, archive: false, fingerprint: c2.preview.fingerprint })
      if (!noConfirm.ok) throw new Error(noConfirm.error)
      expect(noConfirm.result.archived).toEqual({ locations: 0, recorders: 0, cameras: 0 })
      expect((await locationByCode(o, 'DROP'))!.archived_at).toBeNull()
      const c3 = await checkLocationImport({ admin: admin(), rls: u.client }, a, smaller, { skipBadRows: false })
      if (!c3.ok) throw new Error(c3.error)
      const confirmed = await applyLocationImport({ admin: admin(), rls: u.client }, a, smaller, { skipBadRows: false, archive: true, fingerprint: c3.preview.fingerprint })
      if (!confirmed.ok) throw new Error(confirmed.error)
      expect(confirmed.result.archived).toEqual({ locations: 1, recorders: 0, cameras: 2 })
      expect((await locationByCode(o, 'DROP'))!.archived_at).not.toBeNull()
      const keep = (await locationByCode(o, 'KEEP'))!
      expect(await channelsOf((await recordersOf(keep.id))[0].id)).toEqual([1, 2])
      // Archived, not deleted: the rows are there, and the grant on the archived location is kept (restorable).
      expect((await admin().from('cameras').select('id').eq('location_id', keep.id)).data).toHaveLength(4)
      expect((await admin().from('access_grants').select('id').eq('user_id', viewer.id).eq('location_id', drop.id).is('revoked_at', null)).data).toHaveLength(1)
    } finally {
      await cleanupOrg(o)
    }
  })

  it('codes are per organisation: the same code in another organisation is never touched', async () => {
    const theirs = await createLocation(otherOrg, { code: 'SHARED1', name: 'Theirs' })
    const csv = `${HEADER}\nSHARED1,,,,Delhi,,,,192.0.2.80,,,viewer,Pw-S,1,,\n`
    const check = await checkLocationImport(c(), actor, csv, { skipBadRows: false })
    if (!check.ok) throw new Error(check.error)
    expect(check.preview.locations[0].status).toBe('create')
    const r = await applyLocationImport(c(), actor, csv, { skipBadRows: false, archive: false, fingerprint: check.preview.fingerprint })
    if (!r.ok) throw new Error(r.error)
    expect((await admin().from('locations').select('name, archived_at').eq('id', theirs).single()).data).toEqual({ name: 'Theirs', archived_at: null })
    expect(check.preview.archive.some((a) => a.id === theirs)).toBe(false)
  })

  it('placeholders made by the database follow the same rules as the application (review I-3 parity)', async () => {
    // Two twins: channel 1 active, channel 2 archived (ever mapped), channel 3 a restored camera (unmapped, last on this NVR).
    const twin = async (codeName: string) => {
      const loc = await createLocation(orgId, { code: codeName })
      const rec = await createRecorder(orgId, loc, { secret: 'twin-pass' })
      const other = await createRecorder(orgId, loc, { secret: 'twin-pass' })
      await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1, name: 'Door' })
      const gone = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 2, name: 'Gone' })
      await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: gone })
      const back = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 3, name: 'Back' })
      await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: back })
      await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'camera', p_id: back })
      const moved = await createCamera(orgId, { locationId: loc, recorderId: other, channel: 4, name: 'Elsewhere' })
      void moved
      return { loc, rec }
    }
    const a = await twin('PAR1')
    const b = await twin('PAR2')
    await ensurePlaceholderCameras(admin(), orgId, a.loc, a.rec, 5)
    const { data, error } = await admin().rpc('inventory_ensure_placeholders', { p_org: orgId, p_location: b.loc, p_recorder: b.rec, p_count: 5 })
    expect(error).toBeNull()
    expect(data).toEqual({ created: 2, relinked: 1 })
    const shape = async (rec: string) => ((await admin().from('cameras').select('name, channel').eq('recorder_id', rec).order('channel')).data ?? []).map((x) => `${x.channel}:${x.name}`)
    expect(await shape(b.rec)).toEqual(await shape(a.rec))
    expect(await shape(b.rec)).toEqual(['1:Door', '3:Back', '4:Camera 4', '5:Camera 5'])
    void mapCamera
  })

  it('the new server functions are for the server only; nothing new is open to signed-in people; privilege_violations stays empty', async () => {
    const plan = { regions: [], clusters: [], archive: [], locations: [] }
    expect((await me.client.rpc('inventory_import_apply', { p_org: orgId, p_actor: me.id, p_plan: plan })).error?.code).toBe('42501')
    expect((await me.client.rpc('inventory_ensure_placeholders', { p_org: orgId, p_location: orgId, p_recorder: orgId, p_count: 1 })).error?.code).toBe('42501')
    expect((await admin().rpc('privilege_violations')).data).toEqual([])
    expect((await admin().rpc('inventory_stale_name_scan')).data).toEqual([])
  })

  it('a 216-location file (the size of the estate, synthetic) imports in one go, and again with no change; timing recorded', async () => {
    const o = await createOrg()
    try {
      const u = await createUser(o, 'admin')
      await grant(o, u.id, 'admin.inventory')
      const a: Actor = { id: u.id, orgId: o, role: 'admin' }
      const rows = Array.from({ length: 216 }, (_, i) => {
        const channels = 12 + (i % 17) // 12..28 like the estate
        return `S${String(i + 1).padStart(3, '0')},City ${i % 40},Z${i % 9},198.51.${100 + Math.floor(i / 250)}.${(i % 250) + 1},554,80,viewer,Pw-synthetic-${i % 15},${channels}`
      })
      const csv = ['name,city,zone,ip,port,http_port,user,password,channels', ...rows].join('\n')
      const expectedCameras = Array.from({ length: 216 }, (_, i) => 12 + (i % 17)).reduce((x, y) => x + y, 0)
      const cl = { admin: admin(), rls: u.client }
      const t0 = Date.now()
      const check = await checkLocationImport(cl, a, csv, { skipBadRows: false })
      if (!check.ok) throw new Error(check.error)
      const t1 = Date.now()
      const r = await applyLocationImport(cl, a, csv, { skipBadRows: false, archive: false, fingerprint: check.preview.fingerprint })
      if (!r.ok) throw new Error(r.error)
      const t2 = Date.now()
      expect(r.result).toMatchObject({ locationsCreated: 216, recordersCreated: 216, passwordsGiven: 216, camerasCreated: expectedCameras })
      expect(await counts(o)).toMatchObject({ locations: 216, recorders: 216, cameras: expectedCameras, mappings: expectedCameras })
      const again = await checkLocationImport(cl, a, csv, { skipBadRows: false })
      if (!again.ok) throw new Error(again.error)
      const t3 = Date.now()
      expect(again.preview.counts).toMatchObject({ locationsNew: 0, locationsChanged: 0, locationsUnchanged: 216, recordersUnchanged: 216, passwordsSet: 216, camerasNew: 0 })
      const r2 = await applyLocationImport(cl, a, csv, { skipBadRows: false, archive: false, fingerprint: again.preview.fingerprint })
      if (!r2.ok) throw new Error(r2.error)
      const t4 = Date.now()
      expect(await counts(o)).toMatchObject({ locations: 216, recorders: 216, cameras: expectedCameras, mappings: expectedCameras })
      // Generous bounds (local stack, shared with other suites): the check in seconds, the apply well under a minute.
      expect(t1 - t0).toBeLessThan(10_000)
      expect(t2 - t1).toBeLessThan(60_000)
      console.log(JSON.stringify({ import_perf: { rows: 216, cameras: expectedCameras, check_ms: t1 - t0, apply_ms: t2 - t1, recheck_ms: t3 - t2, reapply_ms: t4 - t3 } }))
    } finally {
      await cleanupOrg(o)
    }
  }, 180_000)

  // Review B-M13: the real data was made by the LEGACY import (display name = code; the primary NVR; channels above the file's count
  // after discovery). Seed a synthetic organisation the same way, then check and apply the same file through the new path.
  it('the estate path: 216 locations made by the legacy import, then the same file through the validated import', async () => {
    const o = await createOrg()
    try {
      const u = await createUser(o, 'admin')
      await grant(o, u.id, 'admin.inventory')
      const a: Actor = { id: u.id, orgId: o, role: 'admin' }
      const rows = Array.from({ length: 216 }, (_, i) => `S${String(i + 1).padStart(3, '0')},City ${i % 40},Z${i % 9},198.51.${100 + Math.floor(i / 250)}.${(i % 250) + 1},554,80,viewer,Pw-legacy-${i % 15},${12 + (i % 17)}`)
      const csv = ['name,city,zone,ip,port,http_port,user,password,channels', ...rows].join('\n')
      const legacy = await importStores(admin(), a, parseStoresCsv(csv).rows)
      expect(legacy).toMatchObject({ created: 216, errors: [] })
      // Like the real data after a discovery: one NVR has 3 cameras above the file's count and a camera renamed by the NVR.
      const s001 = (await locationByCode(o, 'S001'))!
      const [nvr] = await recordersOf(s001.id)
      for (const ch of [13, 14, 15]) await createCamera(o, { locationId: s001.id, recorderId: nvr.id, channel: ch })
      await admin().from('cameras').update({ name: 'Entrance' }).eq('recorder_id', nvr.id).eq('channel', 1)
      const cl = { admin: admin(), rls: u.client }
      const t0 = Date.now()
      const check = await checkLocationImport(cl, a, csv, { skipBadRows: false })
      if (!check.ok) throw new Error(check.error)
      const t1 = Date.now()
      expect(check.preview.errors).toEqual([])
      expect(check.preview.counts).toMatchObject({ locationsNew: 0, locationsChanged: 216, recordersNew: 0, recordersChanged: 0, recordersUnchanged: 216, camerasNew: 0, archiveCameras: 3 })
      expect(check.preview.locations[0]).toMatchObject({ code: 'S001', name: 'S001 - City 0', previousName: 'S001', changes: ['display name'] })
      expect(check.preview.locations.flatMap((l) => l.recorders.map((r) => r.matchedBy))).toEqual(Array(216).fill('address'))
      const r = await applyLocationImport(cl, a, csv, { skipBadRows: false, archive: false, fingerprint: check.preview.fingerprint })
      if (!r.ok) throw new Error(r.error)
      const t2 = Date.now()
      expect(r.result).toMatchObject({ locationsCreated: 0, locationsUpdated: 216, recordersCreated: 0, recordersUpdated: 0, camerasCreated: 0 })
      expect((await admin().from('cameras').select('name').eq('recorder_id', nvr.id).eq('channel', 1).single()).data!.name).toBe('Entrance')
      expect((await admin().from('admin_audit_log').select('id').eq('org_id', o).eq('action', 'recorder_password_set').gt('created_at', new Date(t1 - 1000).toISOString())).data).toEqual([])
      const again = await checkLocationImport(cl, a, csv, { skipBadRows: false })
      if (!again.ok) throw new Error(again.error)
      expect(again.preview.counts).toMatchObject({ locationsChanged: 0, locationsUnchanged: 216, recordersUnchanged: 216, camerasNew: 0 })
      expect(t1 - t0).toBeLessThan(10_000)
      expect(t2 - t1).toBeLessThan(60_000)
      console.log(JSON.stringify({ import_perf_legacy_seeded: { rows: 216, check_ms: t1 - t0, apply_ms: t2 - t1 } }))
    } finally {
      await cleanupOrg(o)
    }
  }, 240_000)
})
