import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// P3-1 review I-3: fresh sign-in is ONE enforced mechanism. Every Server Action (every export of a 'use server' file) and every route
// handler is either guarded — its body calls requireFreshAdministration / requireFreshProfile / requireFreshFor (lib/auth/fresh.ts)
// — or is on the explicit allow-list below with the reason. A new action or route fails this test until it is classified.

const ROOT = path.resolve(__dirname, '../..')
const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, '/')
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e)
    if (e === 'node_modules' || e.startsWith('.')) continue
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}

/** Exported async functions of a file with their bodies (up to the next top-level export). */
function exportsOf(src: string, names: RegExp): { name: string; body: string }[] {
  const re = new RegExp(`^export (?:async )?function (${names.source})\\b`, 'gm')
  const hits = [...src.matchAll(re)].map((m) => ({ name: m[1], at: m.index! }))
  return hits.map((h, i) => ({ name: h.name, body: src.slice(h.at, i + 1 < hits.length ? hits[i + 1].at : undefined) }))
}

const GUARDED = /\brequireFresh(?:Administration|Profile|For)\(/

/** Not guarded on purpose; each with its reason. Key: `<file>#<export>`. */
const ALLOWED: Record<string, string> = {
  // reads only
  'lib/actions/admin/access.ts#previewAccessAction': 'reads only: shows the effect, writes nothing (the save is guarded)',
  'lib/actions/admin/users.ts#reactivationReviewAction': 'reads only: lists the grants before a reactivation (the reactivation is guarded)',
  'lib/actions/admin/import-locations.ts#checkLocationImportAction': 'reads only: checks a file, saves nothing (the import is guarded)',
  'lib/actions/admin/discover-all.ts#discoverAllStatusAction': 'reads only: progress of a run',
  'lib/actions/admin/discover-all.ts#stopDiscoverAllAction': 'only stops a run that was started under a fresh sign-in; widens nothing',
  'lib/actions/admin/locations.ts#previewMoveAction': 'reads only: who would gain or lose access (the move is guarded)',
  'lib/actions/admin/locations.ts#previewProposalsAction': 'reads only (the apply is guarded)',
  'lib/actions/admin/locations.ts#previewMergeAction': 'reads only (the merge is guarded)',
  'lib/actions/admin/locations.ts#searchCamerasAction': 'reads only',
  'lib/actions/admin/locations.ts#testConnectionAction': 'read-only login check of one NVR; writes nothing; 6 a minute',
  // the sign-in flow itself
  'lib/actions/auth.ts#signIn': 'is the sign-in',
  'lib/actions/auth.ts#signOut': 'only ends this sign-in',
  'lib/actions/auth.ts#forgotPassword': 'signed out; sends a reset link (rate-limited, same answer for every address)',
  'lib/actions/mfa.ts#verifyCodeAction': 'is the code step of the sign-in',
  'lib/actions/mfa.ts#confirmIdentityAction': 'is the fresh sign-in ("Confirm it\'s you")',
  'lib/actions/mfa.ts#confirmEnrolmentAction': 'finishes, with the new app\'s first code, the set-up that startEnrolmentAction began under a fresh sign-in',
  'lib/actions/mfa.ts#signOutEverywhereSelfAction': 'only takes the person\'s own access away',
  // viewing and convenience, never widening access
  'lib/actions/groups.ts#createGroupAction': 'camera groups are a viewing convenience and never widen access (P2-5c-1); operators use them',
  'lib/actions/groups.ts#deleteGroupAction': 'camera groups never widen access',
  'lib/actions/groups.ts#addCamerasAction': 'camera groups never widen access (each camera checked for cctv.live)',
  'lib/actions/groups.ts#addByKeywordAction': 'camera groups never widen access',
  'lib/actions/groups.ts#addRuleAction': 'camera groups never widen access (a rule needs cctv.live for the whole place)',
  'lib/actions/groups.ts#removeRuleAction': 'camera groups never widen access',
  'lib/actions/groups.ts#removeCameraAction': 'camera groups never widen access',
  'lib/actions/monitor.ts#requestCheckNowAction': 'asks for an early check; writes only the request (3 a minute)',
  'lib/actions/playback.ts#listRecordedDaysAction': 'viewing: recordings calendar, checked per camera (cctv.playback, no MFA capability)',
  'lib/actions/playback.ts#listDaySegmentsAction': 'viewing: day search, checked per camera',
  'lib/actions/playback.ts#openPlaybackAction': 'viewing: 1x playback stream, checked per camera, audited, revoked within 60 s',
  // P4-L2 (D-L1): fast playback is viewing under cctv.playback (no MFA capability), never a file; saveable files (/api/vod) stay guarded.
  'lib/actions/playback.ts#openFastPlaybackAction': 'viewing: fast playback 2x-16x token (cctv.playback, D-L1), checked per camera, audited, revoked within 60 s; never a file',
  'lib/actions/playback.ts#oldestRecordingAction': 'viewing: the oldest recording of a camera, checked per camera (cctv.playback)',
  'lib/actions/streams.ts#openStreamsAction': 'viewing: live streams, checked per camera, audited, revoked within 60 s',
  'lib/actions/streams.ts#refreshStreamTokensAction': 'viewing: renews tokens of streams already allowed',
  'lib/actions/streams.ts#renewStreamTokensAction': 'viewing: renews tokens of streams already allowed',
  // route handlers
  'app/api/vod/route.ts#HEAD': 'always answers 405; never starts anything',
  'app/api/playback/stream/route.ts#GET': 'viewing: the fast playback stream (cctv.playback, D-L1): a 90 s token bound to person, camera and media session, script fetch only, no file headers',
  'app/api/playback/stream/route.ts#HEAD': 'always answers 405; never starts anything',
  'app/api/csp-report/route.ts#POST': 'public report sink: logs the directive and blocked origin only, size- and rate-limited',
  'app/api/health/route.ts#GET': 'reads only (public health)',
  'app/api/version/route.ts#GET': 'reads only (public build stamp)',
  'app/auth/callback/route.ts#GET': 'the reset-password link of the sign-in flow (a one-time code from the e-mail)',
}

/** Must be guarded (the review's list and the controller's: access, people, credentials, merge, archive, moves, monitoring, devices,
 *  imports, export, set-up). Checked separately so a guard cannot silently disappear from one of these. */
const MUST_BE_GUARDED = [
  'lib/actions/admin/access.ts#applyAccessAction', 'lib/actions/admin/access.ts#keepReviewedAction', 'lib/actions/admin/access.ts#selfConfirmReviewAction',
  'lib/actions/admin/users.ts#createUserAction', 'lib/actions/admin/users.ts#setActiveAction', 'lib/actions/admin/users.ts#setRoleAction', 'lib/actions/admin/users.ts#resetPasswordAction',
  'lib/actions/admin/sessions.ts#signOutEverywhereAction', 'lib/actions/admin/sessions.ts#resetFactorsAction',
  'lib/actions/admin/locations.ts#mergeCamerasAction', 'lib/actions/admin/locations.ts#linkFindingAction', 'lib/actions/admin/locations.ts#archiveNodeAction',
  'lib/actions/admin/locations.ts#restoreNodeAction', 'lib/actions/admin/locations.ts#moveNodeAction', 'lib/actions/admin/locations.ts#applyProposalsAction',
  'lib/actions/admin/locations.ts#setMonitoringAction', 'lib/actions/admin/locations.ts#saveRecorderAction', 'lib/actions/admin/locations.ts#remapCameraAction',
  'lib/actions/admin/inventory.ts#deleteDeviceAction', 'lib/actions/admin/inventory.ts#importDevicesAction', 'lib/actions/admin/inventory.ts#archiveInventoryAction',
  'lib/actions/admin/inventory.ts#restoreInventoryAction', 'lib/actions/admin/import-locations.ts#applyLocationImportAction',
  'lib/actions/admin/discover-all.ts#startDiscoverAllAction', 'lib/actions/auth.ts#changePassword',
  'lib/actions/mfa.ts#startEnrolmentAction', 'lib/actions/mfa.ts#removeOwnFactorAction', 'app/api/vod/route.ts#GET',
]

function inventory(): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of [...walk(path.join(ROOT, 'lib')), ...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'components'))]) {
    const src = readFileSync(f, 'utf8')
    const r = rel(f)
    if (/^\s*['"]use server['"]/.test(src)) for (const e of exportsOf(src, /[A-Za-z0-9_]+/)) out.set(`${r}#${e.name}`, e.body)
    if (/\/route\.tsx?$/.test(r)) for (const e of exportsOf(src, /GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS/)) out.set(`${r}#${e.name}`, e.body)
  }
  return out
}

describe('fresh sign-in: one enforced mechanism (review I-3)', () => {
  const all = inventory()

  it('finds the Server Actions and route handlers (the scan works)', () => {
    expect(all.size).toBeGreaterThan(60)
    expect(all.has('app/api/vod/route.ts#GET')).toBe(true)
  })

  it('every Server Action and route handler is guarded or on the allow-list with a reason', () => {
    const unclassified = [...all.entries()].filter(([k, body]) => !GUARDED.test(body) && !ALLOWED[k]).map(([k]) => k)
    expect(unclassified).toEqual([])
  })

  it('nothing on the allow-list is guarded anyway or gone (the list stays honest)', () => {
    expect(Object.keys(ALLOWED).filter((k) => !all.has(k))).toEqual([])
    expect(Object.keys(ALLOWED).filter((k) => GUARDED.test(all.get(k) ?? ''))).toEqual([])
  })

  it('the high-risk ones are guarded (access, people, credentials, merge, archive, moves, monitoring, devices, imports, export, set-up)', () => {
    expect(MUST_BE_GUARDED.filter((k) => !GUARDED.test(all.get(k) ?? ''))).toEqual([])
  })

  it('no file has an inline server action (they could not be classified here)', () => {
    const inline = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'components')), ...walk(path.join(ROOT, 'lib'))]
      .filter((f) => /\n\s+['"]use server['"]/.test(readFileSync(f, 'utf8'))).map(rel)
    expect(inline).toEqual([])
  })
})
