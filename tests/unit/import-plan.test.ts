import { describe, expect, it } from 'vitest'
import { parseLocationsCsv } from '@/lib/import/locations-csv'
import { MSG_PASSWORD_AGAIN } from '@/lib/inventory/recorder-admin'
import { matchRecorderRows, planImport, type ImportSnapshot, type SnapLocation, type SnapRecorder } from '@/lib/import/locations-plan'

// P2-5c-2 brief item 1: the preview of the validated location import, worked out from the file and what the database holds (a pure
// function; the loader and the apply are tested against the local stack in tests/integration/p2-5c-2-import.test.ts). Synthetic data.

const L1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const L2 = 'aaaaaaaa-0000-4000-8000-000000000002'
const R1 = 'bbbbbbbb-0000-4000-8000-000000000001'
const R2 = 'bbbbbbbb-0000-4000-8000-000000000002'
const C1 = 'cccccccc-0000-4000-8000-000000000001'
const K1 = 'dddddddd-0000-4000-8000-000000000001'
const G1 = 'eeeeeeee-0000-4000-8000-000000000001'

// Review B-I3: the snapshot holds nothing about saved passwords (only whether one is saved), so the preview cannot tell whether a
// password in the file equals the saved one: it is not an oracle.
const empty = (): ImportSnapshot => ({ locations: [], recorders: [], activeCameras: [], channelsEverMapped: {}, regions: [], clusters: [], archivedCodes: [], looseCameras: [] })
const loc = (o: Partial<SnapLocation> = {}): SnapLocation => ({ id: L1, code: 'JCL', name: 'JCL', kind: 'store', city: 'Jhansi', zone: 'UP', state: null, address: null, cluster_id: null, ...o })
const rec = (o: Partial<SnapRecorder> = {}): SnapRecorder => ({
  id: R1, location_id: L1, name: 'NVR', host: '192.0.2.10', http_port: 80, rtsp_port: 554, username: 'viewer', expected_channels: 4, monitoring_enabled: true,
  has_password: true, primary: true, ...o,
})
const cams = (recorder: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `ffffffff-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, recorder_id: recorder, channel: i + 1, name: `Camera ${i + 1}` }))
const ever = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

const LEGACY = 'name,city,zone,ip,port,http_port,user,password,channels'
const ROW = 'JCL,Jhansi,UP,192.0.2.10,554,80,viewer,Pw-JCL-1,4'

/** The same snapshot as the database would give right after the file was imported once. */
function afterFirstImport(): ImportSnapshot {
  return { ...empty(), locations: [loc({ name: 'JCL - Jhansi' })], recorders: [rec()], activeCameras: cams(R1, 4), channelsEverMapped: { [R1]: ever(4) } }
}

describe('planImport: what the import would do, row by row (never a password)', () => {
  it('a new location from a legacy row: created with "CODE - City", its NVR with the password set and its cameras', () => {
    const p = planImport(parseLocationsCsv(`${LEGACY}\n${ROW}\n`), empty(), { skipBadRows: false })
    expect(p.preview.errors).toEqual([])
    expect(p.preview.canApply).toBe(true)
    expect(p.preview.locations).toEqual([{
      line: 2, code: 'JCL', status: 'create', id: null, name: 'JCL - Jhansi', previousName: null, kind: 'store', changes: [], cluster: null,
      recorders: [{ line: 2, action: 'create', id: null, name: 'NVR', host: '192.0.2.10', http_port: 80, rtsp_port: 554, matchedBy: null, changes: [], password: 'set', monitoring: 'on', camerasToAdd: 4, camerasToRelink: 0 }],
    }])
    expect(p.preview.counts).toMatchObject({ locationsNew: 1, locationsChanged: 0, locationsUnchanged: 0, recordersNew: 1, passwordsSet: 1, camerasNew: 4 })
    // The preview goes to the browser: no password in it. The apply plan (server only) carries it for the vault.
    expect(JSON.stringify(p.preview)).not.toContain('Pw-JCL-1')
    expect(p.apply.locations[0].recorders[0]).toMatchObject({ action: 'create', password: 'Pw-JCL-1', monitoring: true, placeholders: 4 })
  })

  // Review B-I3 replaces "the password unchanged" (that answer came from comparing with the saved password: an oracle). A password in
  // the file is "set"; the database writes it only when it differs (tests/integration/p2-5c-2-import.test.ts: no vault write, no audit).
  it('importing the same file again changes nothing (idempotent): unchanged everywhere, no camera; a password in the file shows "set"', () => {
    const csv = `${LEGACY}\n${ROW}\n`
    const p = planImport(parseLocationsCsv(csv), afterFirstImport(), { skipBadRows: false })
    expect(p.preview.locations[0]).toMatchObject({ status: 'unchanged', id: L1, changes: [] })
    expect(p.preview.locations[0].recorders[0]).toMatchObject({ action: 'unchanged', id: R1, matchedBy: 'address', password: 'set', camerasToAdd: 0 })
    expect(p.preview.counts).toMatchObject({ locationsNew: 0, locationsChanged: 0, locationsUnchanged: 1, recordersNew: 0, recordersChanged: 0, passwordsSet: 1, camerasNew: 0 })
    expect(p.apply.locations[0].recorders[0].password).toBe('Pw-JCL-1')
    // The fingerprint binds the apply to exactly this preview.
    expect(planImport(parseLocationsCsv(csv), afterFirstImport(), { skipBadRows: false }).preview.fingerprint).toBe(p.preview.fingerprint)
    expect(p.preview.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a display name still at its starting value follows the ruling ("CODE - City"); one a person edited is kept', () => {
    const asCode = planImport(parseLocationsCsv(`${LEGACY}\n${ROW}\n`), { ...afterFirstImport(), locations: [loc({ name: 'JCL' })] }, { skipBadRows: false })
    // Review B-M1: the preview shows the old name next to the new one.
    expect(asCode.preview.locations[0]).toMatchObject({ status: 'update', name: 'JCL - Jhansi', previousName: 'JCL', changes: ['display name'] })
    // …and "Keep the current display names" opts out of the ruling's rename (a display_name column still applies).
    const keep = planImport(parseLocationsCsv(`${LEGACY}\n${ROW}\n`), { ...afterFirstImport(), locations: [loc({ name: 'JCL' })] }, { skipBadRows: false, keepNames: true })
    expect(keep.preview.locations[0]).toMatchObject({ status: 'unchanged', name: 'JCL', previousName: null, changes: [] })
    expect(keep.preview.fingerprint).not.toBe(asCode.preview.fingerprint)
    const edited = planImport(parseLocationsCsv(`${LEGACY}\n${ROW}\n`), { ...afterFirstImport(), locations: [loc({ name: 'Jhansi main road' })] }, { skipBadRows: false })
    expect(edited.preview.locations[0]).toMatchObject({ status: 'unchanged', name: 'Jhansi main road' })
    const given = planImport(parseLocationsCsv(`code,display_name,city\nJCL,Jhansi Sadar,Jhansi\n`), { ...afterFirstImport(), locations: [loc({ name: 'Jhansi main road' })] }, { skipBadRows: false })
    expect(given.preview.locations[0]).toMatchObject({ status: 'update', name: 'Jhansi Sadar', changes: ['display name'] })
  })

  it('a password in the file is "set" (whatever is saved); an empty one is "kept"; a new NVR without one is refused on its row and column', () => {
    const given = planImport(parseLocationsCsv(`${LEGACY}\n${ROW}\n`), afterFirstImport(), { skipBadRows: false })
    expect(given.preview.locations[0].recorders[0]).toMatchObject({ action: 'unchanged', password: 'set', changes: [] })
    expect(given.apply.locations[0].recorders[0].password).toBe('Pw-JCL-1')
    const kept = planImport(parseLocationsCsv(`${LEGACY}\nJCL,Jhansi,UP,192.0.2.10,554,80,viewer,,4\n`), afterFirstImport(), { skipBadRows: false })
    expect(kept.preview.locations[0].recorders[0]).toMatchObject({ action: 'unchanged', password: 'kept' })
    expect(kept.apply.locations[0].recorders[0].password).toBeUndefined()
    const none = planImport(parseLocationsCsv(`${LEGACY}\nNEW1,Gaya,BR,192.0.2.40,,,viewer,,4\n`), empty(), { skipBadRows: false })
    expect(none.preview.errors).toEqual([{ line: 2, column: 'password', message: 'A new NVR needs its password.' }])
    expect(none.preview.canApply).toBe(false)
  })

  it('an existing NVR without a saved password needs one in the file', () => {
    const p = planImport(parseLocationsCsv(`${LEGACY}\nJCL,Jhansi,UP,192.0.2.10,554,80,viewer,,4\n`), { ...afterFirstImport(), recorders: [rec({ has_password: false })] }, { skipBadRows: false })
    expect(p.preview.errors).toEqual([{ line: 2, column: 'password', message: 'This NVR has no saved password yet: give it in the file.' }])
  })

  it('legacy rule: the one row of a location whose address changed updates its primary NVR (no second NVR)', () => {
    const p = planImport(parseLocationsCsv(`${LEGACY}\nJCL,Jhansi,UP,192.0.2.99,554,80,viewer,Pw-JCL-1,4\n`), afterFirstImport(), { skipBadRows: false })
    expect(p.preview.locations[0].recorders[0]).toMatchObject({ action: 'update', id: R1, matchedBy: 'primary', host: '192.0.2.99', changes: ['address'], password: 'set' })
    expect(p.preview.counts.recordersNew).toBe(0)
  })

  it('review B-M2: empty port cells keep the saved ports; an NVR is then matched by its address alone (no second identity)', () => {
    const snap: ImportSnapshot = { ...afterFirstImport(), recorders: [rec({ http_port: 8080, rtsp_port: 8554 })] }
    const one = planImport(parseLocationsCsv(`${LEGACY}\nJCL,Jhansi,UP,192.0.2.10,,,viewer,,4\n`), snap, { skipBadRows: false })
    expect(one.preview.errors).toEqual([])
    expect(one.preview.locations[0].recorders[0]).toMatchObject({ action: 'unchanged', id: R1, matchedBy: 'address', http_port: 8080, rtsp_port: 8554 })
    // Two rows: the first (empty ports) is the NVR at that address; nothing new is made for it.
    const two = planImport(parseLocationsCsv(`${LEGACY}\nJCL,Jhansi,UP,192.0.2.10,,,viewer,,4\nJCL,,,192.0.2.11,,,viewer,Pw-new,2\n`), snap, { skipBadRows: false })
    expect(two.preview.locations[0].recorders.map((r) => [r.action, r.id, r.http_port, r.rtsp_port])).toEqual([['unchanged', R1, 8080, 8554], ['create', null, 80, 554]])
    expect(two.preview.archive).toEqual([])
    expect(two.apply.locations[0].recorders[0]).toMatchObject({ http_port: 8080, rtsp_port: 8554 })
  })

  it('review B-M3: a code of an ARCHIVED location is refused (restore it instead of making a second location)', () => {
    const p = planImport(parseLocationsCsv(`${LEGACY}\nOLD1,Gaya,BR,192.0.2.70,554,80,viewer,pw,2\n`), { ...empty(), archivedCodes: ['OLD1'] }, { skipBadRows: false })
    expect(p.preview.errors).toEqual([{ line: 2, column: 'code', message: 'A location with this code is archived. Restore it (Locations and NVRs → show archived ones) and check the file again.' }])
    expect(p.preview.canApply).toBe(false)
  })

  it('review B-M12: a channel that an unmapped camera of a one-NVR location goes back to is "linked again", not a new camera', () => {
    const snap: ImportSnapshot = {
      ...afterFirstImport(), activeCameras: cams(R1, 3), channelsEverMapped: { [R1]: ever(3) },
      looseCameras: [{ id: K1, location_id: L1, channel: 4, last_recorder_id: null, last_channel: null }],
    }
    const p = planImport(parseLocationsCsv(`${LEGACY}\n${ROW}\n`), snap, { skipBadRows: false })
    expect(p.preview.locations[0].recorders[0]).toMatchObject({ action: 'update', camerasToAdd: 0, camerasToRelink: 1, changes: ['1 camera to link again'] })
    expect(p.preview.counts).toMatchObject({ camerasNew: 0, camerasRelinked: 1 })
  })

  it('P2-5c-1 review I-4: a changed address or web port needs the password again (the saved one belongs to the old address)', () => {
    const p = planImport(parseLocationsCsv(`${LEGACY}\nJCL,Jhansi,UP,192.0.2.99,554,80,viewer,,4\n`), afterFirstImport(), { skipBadRows: false })
    // The same rule and words as the NVR page (lib/inventory/recorder-admin.ts, commit 0ade633).
    expect(p.preview.errors).toEqual([{ line: 2, column: 'password', message: MSG_PASSWORD_AGAIN }])
    const port = planImport(parseLocationsCsv(`${LEGACY}\nJCL,Jhansi,UP,192.0.2.10,554,8080,viewer,,4\n`), afterFirstImport(), { skipBadRows: false })
    expect(port.preview.errors.map((e) => e.column)).toEqual(['password'])
  })

  it('repeated rows: an NVR is matched by its address and web port; a new address is a new NVR; an NVR not in the file is only listed', () => {
    const snap: ImportSnapshot = {
      ...afterFirstImport(),
      recorders: [rec(), rec({ id: R2, name: 'Old box', host: '192.0.2.11', primary: false, expected_channels: 0 })],
    }
    const csv = `${LEGACY}\nJCL,Jhansi,UP,192.0.2.10,554,80,viewer,,4\nJCL,,,192.0.2.12,554,80,viewer,Pw-new,2\n`
    const matched = matchRecorderRows(parseLocationsCsv(csv).groups, snap)
    expect([...matched.entries()]).toEqual([[2, { id: R1, by: 'address' }]])
    const p = planImport(parseLocationsCsv(csv), snap, { skipBadRows: false })
    expect(p.preview.locations[0].recorders.map((r) => [r.line, r.action, r.id, r.name])).toEqual([[2, 'unchanged', R1, 'NVR'], [3, 'create', null, 'NVR 3']])
    expect(p.preview.archive).toEqual([{ kind: 'recorder', id: R2, label: 'JCL · Old box (192.0.2.11)', cameras: 0 }])
    expect(p.apply.archive).toEqual([])
    expect(planImport(parseLocationsCsv(csv), snap, { skipBadRows: false, archive: true }).apply.archive).toEqual([{ kind: 'recorder', id: R2 }])
  })

  it('a location that is not in the file is listed to archive (only with the confirmation); archiving needs a file without problems', () => {
    const snap: ImportSnapshot = { ...afterFirstImport(), locations: [loc({ name: 'JCL - Jhansi' }), loc({ id: L2, code: 'GONE', name: 'GONE - Gaya' })] }
    const p = planImport(parseLocationsCsv(`${LEGACY}\n${ROW}\n`), snap, { skipBadRows: false })
    expect(p.preview.archive).toEqual([{ kind: 'location', id: L2, label: 'GONE · GONE - Gaya', cameras: 0 }])
    expect(p.preview.archiveAllowed).toBe(true)
    expect(p.preview.counts.archiveLocations).toBe(1)
    // A file with a bad row: the bad row's location is never taken for "not in the file", and nothing may be archived.
    const bad = planImport(parseLocationsCsv(`${LEGACY}\n${ROW}\nGONE,Gaya,BR,not-an-ip,,,viewer,pw,2\n`), snap, { skipBadRows: true, archive: true })
    expect(bad.preview.archive).toEqual([])
    expect(bad.preview.archiveAllowed).toBe(false)
    expect(bad.apply.archive).toEqual([])
  })

  it('cameras on channels above the number in the file are listed to archive; the NVR keeps the others', () => {
    const snap: ImportSnapshot = { ...afterFirstImport(), recorders: [rec({ expected_channels: 6 })], activeCameras: cams(R1, 6), channelsEverMapped: { [R1]: ever(6) } }
    const p = planImport(parseLocationsCsv(`${LEGACY}\n${ROW}\n`), snap, { skipBadRows: false })
    expect(p.preview.locations[0].recorders[0]).toMatchObject({ action: 'update', changes: ['number of cameras'] })
    expect(p.preview.archive.map((a) => [a.kind, a.label])).toEqual([['camera', 'JCL · NVR · channel 5 (Camera 5)'], ['camera', 'JCL · NVR · channel 6 (Camera 6)']])
  })

  it('an empty channels cell keeps the saved number and adds no camera', () => {
    const p = planImport(parseLocationsCsv(`${LEGACY}\nJCL,Jhansi,UP,192.0.2.10,554,80,viewer,,\n`), afterFirstImport(), { skipBadRows: false })
    expect(p.preview.locations[0].recorders[0]).toMatchObject({ action: 'unchanged', camerasToAdd: 0 })
    expect(p.preview.archive).toEqual([])
  })

  it('a channel that ever had a camera on that NVR gets no new placeholder (review I-3)', () => {
    const snap: ImportSnapshot = { ...afterFirstImport(), activeCameras: cams(R1, 3), channelsEverMapped: { [R1]: ever(4) } }
    const p = planImport(parseLocationsCsv(`${LEGACY}\n${ROW}\n`), snap, { skipBadRows: false })
    expect(p.preview.locations[0].recorders[0].camerasToAdd).toBe(0)
    const more = planImport(parseLocationsCsv(`${LEGACY}\nJCL,Jhansi,UP,192.0.2.10,554,80,viewer,,6\n`), snap, { skipBadRows: false })
    expect(more.preview.locations[0].recorders[0].camerasToAdd).toBe(2)
  })

  it('regions and clusters: missing ones are created by code; a location without a cluster joins it; one in another cluster is NOT moved', () => {
    const csv = 'code,city,region,cluster\nJCL,Jhansi,NORTH,UP-1\nNEW2,Agra,NORTH,UP-1\nMOVED,Kanpur,,UP-1\n'
    const snap: ImportSnapshot = {
      ...empty(), locations: [loc({ name: 'JCL - Jhansi' }), loc({ id: L2, code: 'MOVED', name: 'MOVED - Kanpur', city: 'Kanpur', cluster_id: C1 })],
      clusters: [{ id: C1, code: 'OLD', region_id: null }],
    }
    const p = planImport(parseLocationsCsv(csv), snap, { skipBadRows: false })
    expect(p.preview.regionsToCreate).toEqual(['NORTH'])
    expect(p.preview.clustersToCreate).toEqual([{ code: 'UP-1', region: 'NORTH' }])
    expect(p.preview.locations.map((l) => [l.code, l.status, l.changes, l.cluster])).toEqual([
      ['JCL', 'update', ['joins cluster UP-1'], 'UP-1'], ['NEW2', 'create', [], 'UP-1'], ['MOVED', 'unchanged', [], 'OLD'],
    ])
    expect(p.preview.warnings).toEqual([{ line: 4, column: 'cluster', message: 'This location is already in cluster OLD; the import does not move it. Move it on its page, which shows the effect on access first.' }])
    expect(p.apply.locations[0]).toMatchObject({ action: 'update', join_cluster: 'UP-1' })
  })

  it('one cluster code with two regions in the file is refused; an existing cluster keeps its region (warning)', () => {
    const two = planImport(parseLocationsCsv('code,region,cluster\nA1,NORTH,UP-1\nA2,SOUTH,UP-1\n'), empty(), { skipBadRows: false })
    expect(two.preview.errors).toEqual([{ line: 3, column: 'region', message: 'Line 2 puts this cluster in another region; one cluster belongs to one region.' }])
    const snap: ImportSnapshot = { ...empty(), regions: [{ id: G1, code: 'EAST' }], clusters: [{ id: C1, code: 'UP-1', region_id: G1 }] }
    const kept = planImport(parseLocationsCsv('code,region,cluster\nA1,NORTH,UP-1\n'), snap, { skipBadRows: false })
    expect(kept.preview.errors).toEqual([])
    expect(kept.preview.regionsToCreate).toEqual([])
    expect(kept.preview.warnings).toEqual([{ line: 2, column: 'region', message: 'This cluster is already in region EAST; the import does not move it. Move it on the Regions and clusters page.' }])
  })

  it('all or nothing: a file with a bad row cannot be applied unless "skip bad rows" is chosen; then the bad location is skipped whole', () => {
    const csv = `${LEGACY}\n${ROW}\nBAD,Gaya,BR,192.0.2.50,,,viewer,pw,4\nBAD,,,999.1.1.1,,,viewer,pw,4\n`
    const strict = planImport(parseLocationsCsv(csv), empty(), { skipBadRows: false })
    expect(strict.preview.canApply).toBe(false)
    expect(strict.preview.errors).toEqual([{ line: 4, column: 'ip', message: 'Not a valid IP address.' }])
    const skip = planImport(parseLocationsCsv(csv), empty(), { skipBadRows: true })
    expect(skip.preview.canApply).toBe(true)
    expect(skip.preview.skipped).toBe(1)
    expect(skip.preview.locations.map((l) => [l.code, l.status])).toEqual([['JCL', 'create'], ['BAD', 'skipped']])
    expect(skip.apply.locations.map((l) => l.code)).toEqual(['JCL'])
  })

  it('review B-I1: a row with a wrong number of cells skips its location whole; an unclosed quote blocks the file even with "skip bad rows"', () => {
    const csv = `${LEGACY}\n${ROW}\nPTN,Patna,BR,192.0.2.20,554,80,viewer,pw1,4\nPTN,,,192.0.2.21,554,80,viewer,pw2,4,oops\n`
    const skip = planImport(parseLocationsCsv(csv), empty(), { skipBadRows: true })
    expect(skip.preview.canApply).toBe(true)
    expect(skip.apply.locations.map((l) => l.code)).toEqual(['JCL'])
    expect(skip.preview.locations.map((l) => [l.code, l.status])).toEqual([['JCL', 'create'], ['PTN', 'skipped']])
    const open = planImport(parseLocationsCsv(`${LEGACY}\n${ROW}\nPTN,"Patna,BR,192.0.2.20,554,80,viewer,pw1,4\n`), empty(), { skipBadRows: true })
    expect(open.preview.canApply).toBe(false)
    expect(open.apply.locations).toEqual([])
  })

  it('the monitoring column switches an existing NVR off (with the import as the reason) or leaves it as it is', () => {
    const off = planImport(parseLocationsCsv('code,ip,user,password,monitoring\nJCL,192.0.2.10,viewer,,off\n'), afterFirstImport(), { skipBadRows: false })
    expect(off.preview.locations[0].recorders[0]).toMatchObject({ action: 'update', monitoring: 'off', changes: ['monitoring'] })
    expect(off.apply.locations[0].recorders[0].monitoring).toBe(false)
    const same = planImport(parseLocationsCsv('code,ip,user,password\nJCL,192.0.2.10,viewer,\n'), afterFirstImport(), { skipBadRows: false })
    expect(same.preview.locations[0].recorders[0]).toMatchObject({ monitoring: 'unchanged' })
    expect(same.apply.locations[0].recorders[0].monitoring).toBeUndefined()
  })

  it('a head office row without an NVR is created without one; nothing asks for a password', () => {
    const p = planImport(parseLocationsCsv('code,display_name,kind,city\nHO,Head office,head_office,Kolkata\n'), empty(), { skipBadRows: false })
    expect(p.preview.errors).toEqual([])
    expect(p.preview.locations[0]).toMatchObject({ status: 'create', name: 'Head office', kind: 'head_office', recorders: [] })
  })

  it('an empty cell keeps what is saved; a changed cell is a change', () => {
    const p = planImport(parseLocationsCsv('code,city,zone,kind,address\nJCL,,,dc,New road\n'), afterFirstImport(), { skipBadRows: false })
    expect(p.preview.locations[0]).toMatchObject({ status: 'update', changes: ['kind', 'address'], kind: 'dc' })
    expect(p.apply.locations[0].fields).toEqual({ kind: 'dc', address: 'New road' })
  })

  it('a location whose NVR is unchanged but whose camera is missing is a change (one camera to add)', () => {
    const p = planImport(parseLocationsCsv(`${LEGACY}\n${ROW}\n`), { ...afterFirstImport(), activeCameras: cams(R1, 3), channelsEverMapped: { [R1]: ever(3) } }, { skipBadRows: false })
    expect(p.preview.locations[0]).toMatchObject({ status: 'update' })
    expect(p.preview.locations[0].recorders[0]).toMatchObject({ action: 'update', camerasToAdd: 1, changes: ['1 camera to add'] })
    expect(p.preview.counts.camerasNew).toBe(1)
    void K1
  })
})
