import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const no = vi.hoisted(() => async () => ({ ok: false, error: 'x' }))
vi.mock('@/lib/actions/admin/import-locations', () => ({ checkLocationImportAction: no, applyLocationImportAction: no }))
vi.mock('@/lib/actions/admin/discover-all', () => ({ startDiscoverAllAction: no, discoverAllStatusAction: no }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { DiscoverAll, RunResults } from '@/components/admin/inventory/DiscoverAll'
import { ImportResultPanel, LocationImport, PreviewPanel } from '@/components/admin/import/LocationImport'
import { WifiInventoryTable } from '@/components/wifi/WifiInventoryTable'
import { DEVICES_IMPORT_HELP } from '@/lib/import/help'
import { parseLocationsCsv } from '@/lib/import/locations-csv'
import { planImport } from '@/lib/import/locations-plan'
import type { RunView } from '@/lib/inventory/discover-all'
import type { WifiItem } from '@/lib/wifi/inventory'

// P2-5c-2 screens: every control has a visible name, the wording is plain ("Location", never "Store" in sentences), no password is ever
// rendered, and there are no dead buttons (Import shows only when the file can be applied). Synthetic data only.

function unnamed(html: string): string[] {
  const out: string[] = []
  const re = /<(input|select|textarea|button)\b([^>]*)>/g
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const [tag, name, attrs] = m
    if (/type="hidden"/.test(attrs)) continue
    if (/aria-label="[^"]+"/.test(attrs)) continue
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1]
    if (id && html.includes(`for="${id}"`)) continue
    const before = html.slice(0, m.index)
    if (name !== 'button' && before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue
    if (name === 'button') {
      const rest = html.slice(m.index + tag.length)
      const text = rest.slice(0, rest.indexOf('</button>')).replace(/<[^>]+>/g, '').trim()
      if (text) continue
    }
    out.push(tag)
  }
  return out
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const empty = { locations: [], recorders: [], activeCameras: [], channelsEverMapped: {}, regions: [], clusters: [], archivedCodes: [], looseCameras: [] }
const CSV = 'code,city,ip,user,password,channels,nvr_name\nPTN,Patna,192.0.2.20,viewer,Pw-screen-1,3,Ground floor\nPTN,,192.0.2.21,viewer,Pw-screen-2,2,First floor\nGAYA,Gaya,not-an-ip,viewer,Pw-screen-3,2,\n'

const run: RunView = {
  id: 'r1', startedAt: '2026-10-22T09:00:00Z', finishedAt: '2026-10-22T09:01:30Z', total: 3, done: 3, concurrency: 4, error: null, stopped: false,
  items: [
    { recorderId: 'a', locationId: 'l1', code: 'PTN', nvrName: 'Ground floor', outcome: 'done', message: null, cameras: 4, created: 1, updated: 3, mapped: 0, moved: 0, toReconcile: 1 },
    { recorderId: 'b', locationId: 'l1', code: 'PTN', nvrName: 'First floor', outcome: 'failed', message: 'The NVR took too long to answer.', cameras: 0, created: 0, updated: 0, mapped: 0, moved: 0, toReconcile: 0 },
    { recorderId: 'c', locationId: 'l2', code: 'GAYA', nvrName: 'NVR', outcome: 'skipped', message: 'Monitoring is switched off for this NVR.', cameras: 0, created: 0, updated: 0, mapped: 0, moved: 0, toReconcile: 0 },
  ],
  summary: { asked: 2, done: 1, failed: 1, skipped: 1, cameras: 4, created: 1, mapped: 0, moved: 0, toReconcile: 1 },
}
const wifi: WifiItem[] = [{
  id: 'w1', locationId: 'l1', locationCode: 'PTN', locationName: 'PTN - Patna', kind: 'Wi-Fi access point', name: 'Shop floor AP', vendor: 'NETGEAR', model: 'WAX615',
  firmware: '10.5.1', serial: 'SN-1', mac: null, managementMode: 'standalone', managementIp: '192.0.2.40', lifecycle: 'active', reachability: 'Not reachable', lastChecked: '2026-10-22T09:00:00Z',
  profile: 'Not assigned', capabilitySummary: '1 documented (none tested here), 1 not supported, 15 unverified.',
  capabilities: [
    { operation: 'mac_acl', label: 'MAC allow / deny lists', support: 'supported', source: 'S9', notes: null, labValidated: false },
    { operation: 'telnet', label: 'Telnet', support: 'unsupported', source: 'S19', notes: null, labValidated: false },
    { operation: 'radio', label: 'Radio settings', support: 'unverified', source: null, notes: 'No documentation found for this model and mode.', labValidated: false },
  ],
}]

describe('P2-5c-2 screens', () => {
  const strict = planImport(parseLocationsCsv(CSV), empty, { skipBadRows: false }).preview
  const skip = planImport(parseLocationsCsv(CSV), empty, { skipBadRows: true }).preview
  const screens: [string, string][] = [
    ['import form', renderToStaticMarkup(<LocationImport />)],
    ['preview with problems', renderToStaticMarkup(<PreviewPanel preview={strict} archive={false} onArchive={() => {}} showUnchanged={false} onShowUnchanged={() => {}} />)],
    ['preview skipping', renderToStaticMarkup(<PreviewPanel preview={skip} archive={false} onArchive={() => {}} showUnchanged onShowUnchanged={() => {}} />)],
    ['import result', renderToStaticMarkup(<ImportResultPanel result={{ locationsCreated: 1, locationsUpdated: 0, recordersCreated: 2, recordersUpdated: 0, passwordsGiven: 2, camerasCreated: 5, camerasRelinked: 0, regionsCreated: 0, clustersCreated: 0, archived: { locations: 0, recorders: 0, cameras: 0 }, warnings: [] }} />)],
    ['find cameras for all', renderToStaticMarkup(<DiscoverAll initial={null} counts={{ recorders: 3, switchedOff: 1, locationOff: 0, concurrency: 4 }} />)],
    ['run results', renderToStaticMarkup(<RunResults run={run} />)],
    ['wifi inventory', renderToStaticMarkup(<WifiInventoryTable items={wifi} />)],
  ]

  it.each(screens)('%s: every control has a visible name', (_name, html) => {
    expect(unnamed(html)).toEqual([])
  })

  it.each(screens)('%s: plain wording, "location" not "store", and no password anywhere', (_name, html) => {
    expect(text(html)).not.toMatch(/\bstores?\b/i)
    expect(html).not.toMatch(/Pw-screen/)
  })

  // T-1: the visible help says "location code" and documents the accepted spellings of the column.
  it('the import help speaks of the location code and names location_code and store_code', () => {
    const t = text(screens[0][1])
    expect(t).toContain('the location code (code, also written location_code or, in older files, store_code)')
    expect(t).toContain('with the same location code')
    expect(DEVICES_IMPORT_HELP).toContain('location_code (optional; the older name store_code also works)')
  })

  it('the preview names each problem by line, column and reason; with problems there is no Import button, only the way out', () => {
    const t = text(screens[1][1])
    expect(t).toContain('Line')
    expect(t).toContain('Column')
    expect(t).toContain('Not a valid IP address.')
    expect(t).not.toContain('not-an-ip')
    expect(screens[1][1]).not.toMatch(/<button[^>]*>(?:<[^>]+>)*[^<]*Import/)
    expect(t).toContain('Skip the rows with problems')
  })

  it('skipping bad rows: the good location can be imported; the skipped one is named; the password shows only as "set"', () => {
    const t = text(screens[2][1])
    // (the button starts with its icon: the tags before the word are skipped)
    expect(screens[2][1]).toMatch(/<button[^>]*type="submit"[^>]*>(?:<[^>]+>)*[^<]*Import/)
    expect(t).toMatch(/GAYA.*Skipped/)
    expect(t).toContain('Password: will be set')
    expect(t).toContain('Ground floor')
    // Review B-M5: a new NVR says it will be checked.
    expect(t).toContain('Monitoring: switched on')
  })

  it('review B-M1 / B-M6 / B-M4: the old display name is shown, every item to archive is listed, the form offers to keep names and says what skipping covers', () => {
    const snap = { ...empty, locations: Array.from({ length: 150 }, (_, i) => ({ id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, code: `X${i}`, name: `X${i}`, kind: 'store', city: 'Agra', zone: null, state: null, address: null, cluster_id: null })) }
    const p = planImport(parseLocationsCsv('name,city\nX0,Agra\n'), snap, { skipBadRows: false }).preview
    const html = renderToStaticMarkup(<PreviewPanel preview={p} archive={false} onArchive={() => {}} showUnchanged onShowUnchanged={() => {}} />)
    expect(text(html)).toContain('X0 → X0 - Agra')
    expect(p.archive).toHaveLength(149)
    expect(text(html)).toContain('X149')
    const form = text(screens[0][1])
    expect(form).toContain('Keep the current display names')
    expect(form).toContain('a refusal by the database still stops the whole file')
  })

  it('"find cameras for all" says what it will do before it starts (read-only, how many at once, what is skipped)', () => {
    const t = text(screens[4][1])
    expect(t).toContain('Find cameras for all locations')
    expect(t).toMatch(/only reads/i)
    expect(t).toContain('4 at a time')
    expect(t).toContain('1 NVR is switched off')
  })

  it('the run results list each NVR with its outcome in words and point to the reconciliation list', () => {
    const t = text(screens[5][1])
    expect(t).toContain('The NVR took too long to answer.')
    expect(t).toContain('Skipped')
    expect(t).toContain('Failed')
    expect(screens[5][1]).toContain('href="/admin/reconciliation"')
  })

  it('the Wi-Fi inventory shows capabilities in words (documented, not supported, unverified) and the profile placeholder', () => {
    const t = text(screens[6][1])
    expect(t).toContain('Documented — not tested here')
    expect(t).toContain('Not supported')
    expect(t).toContain('Unverified')
    expect(t).toContain('Not reachable')
    expect(t).toContain('Not assigned')
  })
})
