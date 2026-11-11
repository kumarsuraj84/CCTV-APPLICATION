import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// P3-1 review I-3: fresh sign-in is ONE enforced mechanism. Every Server Action (every export of a 'use server' file) and every route
// handler is either guarded — its body calls requireFreshAdministration / requireFreshProfile / requireFreshFor (lib/auth/fresh.ts)
// — or is on the explicit allow-list below with the reason. A new action or route fails this test until it is classified.
//
// Release 1 clean-ups (P3-1 re-review N-1): the scan reads the TypeScript syntax tree instead of matching text, so it also sees
// `export const x = async () => …`, `export default …`, `export { a, b }` (and re-exports, which cannot be classified and fail), a
// 'use server' directive after a comment, files under services/ and the project root. "Guarded" now means: a `const g = [await]
// requireFresh…(…)` statement followed at once by an `if` on `g` that returns — a call in a comment, a call whose result is ignored or a
// guard in another function does not count — and, in a Server Action, no `await` before the guard (it comes before any work).

const ROOT = path.resolve(__dirname, '../..')
const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, '/')
// Final fix Y (final review B minor 1): every JavaScript and TypeScript extension, in the whole tree but node_modules, dot folders and
// tests/ (a 'use server' .mjs file or a route.js would otherwise be invisible).
const SCANNED_EXTENSIONS = /^(?!.*\.d\.[cm]?ts$).*\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e)
    if (e === 'node_modules' || e.startsWith('.') || (dir === ROOT && e === 'tests')) continue
    if (statSync(p).isDirectory()) walk(p, out)
    else if (SCANNED_EXTENSIONS.test(e)) out.push(p)
  }
  return out
}

const GUARDS = new Set(['requireFreshAdministration', 'requireFreshProfile', 'requireFreshFor'])
const scriptKind = (file: string) =>
  /\.(tsx)$/.test(file) ? ts.ScriptKind.TSX : /\.(jsx)$/.test(file) ? ts.ScriptKind.JSX : /\.(m?js|cjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
const parse = (src: string, file: string) => ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKind(file))

/** The file's directive prologue says 'use server' (comments before it do not matter). */
export function isUseServer(sf: ts.SourceFile): boolean {
  for (const s of sf.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) return false
    if (s.expression.text === 'use server') return true
  }
  return false
}

type FnLike = ts.FunctionLikeDeclaration
const hasExport = (n: ts.Node) => !!ts.getModifiers(n as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
const isDefault = (n: ts.Node) => !!ts.getModifiers(n as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
const fnOf = (e: ts.Expression | undefined): FnLike | null => (e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) ? e : null)

/** Every export of a file with the function behind it (null: not a function here, or a re-export that cannot be read). */
export function exportsOfSource(sf: ts.SourceFile): { name: string; fn: FnLike | null }[] {
  const locals = new Map<string, FnLike | null>()
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) locals.set(s.name.text, s)
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) locals.set(d.name.text, fnOf(d.initializer))
  }
  const out: { name: string; fn: FnLike | null }[] = []
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && hasExport(s)) out.push({ name: isDefault(s) ? 'default' : (s.name?.text ?? 'default'), fn: s })
    else if (ts.isVariableStatement(s) && hasExport(s)) {
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, fn: fnOf(d.initializer) })
    } else if (ts.isExportAssignment(s)) out.push({ name: 'default', fn: fnOf(s.expression) ?? (ts.isIdentifier(s.expression) ? (locals.get(s.expression.text) ?? null) : null) })
    else if (ts.isExportDeclaration(s) && !s.isTypeOnly) {
      if (!s.exportClause) out.push({ name: '*', fn: null })
      else if (ts.isNamedExports(s.exportClause)) {
        for (const el of s.exportClause.elements) {
          if (el.isTypeOnly) continue
          out.push({ name: el.name.text, fn: s.moduleSpecifier ? null : (locals.get((el.propertyName ?? el.name).text) ?? null) })
        }
      } else out.push({ name: s.exportClause.name.text, fn: null })
    }
  }
  return out
}

/** `const g = [await] requireFresh…(…)`: the variable's name and the guard used, else null. */
function guardVariable(s: ts.Statement): { name: string; guard: string } | null {
  if (!ts.isVariableStatement(s) || s.declarationList.declarations.length !== 1) return null
  const d = s.declarationList.declarations[0]
  let init = d.initializer
  if (init && ts.isAwaitExpression(init)) init = init.expression
  if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression) || !GUARDS.has(init.expression.text)) return null
  return ts.isIdentifier(d.name) ? { name: d.name.text, guard: init.expression.text } : null
}
/** Final fix Y (B minor 1): any call (awaited or not, `void x()` too) is work; plain declarations before the guard are fine. */
const containsCall = (n: ts.Node): boolean => {
  let found = false
  const visit = (x: ts.Node) => {
    if (found) return
    if (ts.isAwaitExpression(x) || ts.isCallExpression(x) || ts.isNewExpression(x) || ts.isTaggedTemplateExpression(x)) found = true
    else if (!ts.isFunctionLike(x)) ts.forEachChild(x, visit)
  }
  visit(n)
  return found
}
/**
 * The refusal check of the guard's result, exactly: `!g.ok`, `!g`, or `g.ok === false`; for requireFreshFor (it returns the refusal's
 * words or null) the plain `g`.
 */
function refusalCheck(e: ts.Expression, g: string, guard: string): boolean {
  while (ts.isParenthesizedExpression(e)) e = e.expression
  const isG = (x: ts.Expression) => ts.isIdentifier(x) && x.text === g
  if (guard === 'requireFreshFor') return isG(e)
  const isGok = (x: ts.Expression) => ts.isPropertyAccessExpression(x) && isG(x.expression) && x.name.text === 'ok'
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return isG(e.operand) || isGok(e.operand)
  return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && isGok(e.left) && e.right.kind === ts.SyntaxKind.FalseKeyword
}
const returns = (s: ts.Statement): boolean => ts.isReturnStatement(s) || (ts.isBlock(s) && s.statements.some((x) => ts.isReturnStatement(x)))

/**
 * Guarded: a guard statement whose result is checked at once by an `if` that returns. Server Actions: the guard is a statement of the
 * function's own body with no await before it. Route handlers: anywhere in the handler's own blocks (they check the caller first).
 */
export function isGuarded(fn: FnLike | null, kind: 'action' | 'route'): boolean {
  if (!fn?.body || !ts.isBlock(fn.body)) return false
  const lists: ts.NodeArray<ts.Statement>[] = []
  if (kind === 'action') lists.push(fn.body.statements)
  else {
    const visit = (n: ts.Node) => {
      if (ts.isBlock(n)) lists.push(n.statements)
      if (!ts.isFunctionLike(n) || n === fn) ts.forEachChild(n, visit)
    }
    visit(fn.body)
  }
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const g = guardVariable(list[i])
      if (!g) continue
      const next = list[i + 1]
      const checked = !!next && ts.isIfStatement(next) && refusalCheck(next.expression, g.name, g.guard) && returns(next.thenStatement)
      const first = kind === 'route' || list.slice(0, i).every((s) => !containsCall(s))
      if (checked && first) return true
    }
  }
  return false
}

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
  'app/api/live/release/route.ts#POST': 'only takes the caller\'s own unused live tokens away when a Live page is left (P4-L1 fix round 2); never opens anything, never ends an open socket',
  'app/api/csp-report/route.ts#POST': 'public report sink: logs the directive and blocked origin only, size- and rate-limited',
  'app/api/health/route.ts#GET': 'reads only (public health)',
  'app/api/health/detail/route.ts#GET': 'reads only (P5.4 detailed health, super administrators who finished signing in)',
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
  // Final fix X (rulings NB-3, NB-4): the monitoring rollout and "Try again" change what is sent to real NVRs.
  'lib/actions/admin/monitoring-rollout.ts#setMonitoringRolloutAction', 'lib/actions/admin/monitoring-rollout.ts#tryNvrLoginAgainAction',
  // Final fix Y: unlocking a person's code step; the owner-only two-step switch.
  'lib/actions/admin/sessions.ts#clearCodeLockAction', 'lib/actions/admin/security.ts#setMfaRequirementAction',
]

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
/** Every file the app could serve an action or a handler from: the whole tree but node_modules, dot folders and tests/ (final fix Y). */
const scanned = () => walk(ROOT)

/** key `<file>#<export>` → whether it is guarded. */
function inventory(): Map<string, boolean> {
  const out = new Map<string, boolean>()
  for (const f of scanned()) {
    const r = rel(f)
    const sf = parse(readFileSync(f, 'utf8'), r)
    if (isUseServer(sf)) for (const e of exportsOfSource(sf)) out.set(`${r}#${e.name}`, isGuarded(e.fn, 'action'))
    if (/(^|\/)route\.(tsx?|m?jsx?|cjs|[cm]ts)$/.test(r)) for (const e of exportsOfSource(sf)) if (HTTP_METHODS.has(e.name)) out.set(`${r}#${e.name}`, isGuarded(e.fn, 'route'))
  }
  return out
}

describe('the scanner itself (release 1, re-review N-1: no blind spots)', () => {
  const kinds = (src: string) => {
    const sf = parse(src, 'x.ts')
    return { server: isUseServer(sf), exports: exportsOfSource(sf).map((e) => [e.name, isGuarded(e.fn, 'action')]) }
  }
  const guard = "const g = await requireFreshAdministration('admin.inventory')\n  if (!g.ok) return { error: g.error }"

  it('sees every form of export, and a directive after a comment', () => {
    const src = [
      "// a comment first\n/* and another */\n'use server'",
      `export async function a() {\n  ${guard}\n  return {}\n}`,
      'export const b = async () => { return 1 }',
      'const c = async () => 2\nconst d = async function () { return 3 }\nexport { c, d as dd }',
      "export { e } from './elsewhere'",
      'export default async function () { return 4 }',
    ].join('\n')
    expect(kinds(src)).toEqual({ server: true, exports: [['a', true], ['b', false], ['c', false], ['dd', false], ['e', false], ['default', false]] })
  })

  it('a guard counts only when its result is checked at once and nothing was awaited before it', () => {
    const one = (body: string) => kinds(`'use server'\nexport async function x() {\n${body}\n}`).exports[0][1]
    expect(one(guard)).toBe(true)
    expect(one("// const g = await requireFreshAdministration('admin.inventory')\nreturn {}")).toBe(false) // in a comment
    expect(one("await requireFreshAdministration('admin.inventory')\nreturn {}")).toBe(false) // result ignored
    expect(one("const g = await requireFreshAdministration('admin.inventory')\nawait save()\nif (!g.ok) return {}")).toBe(false) // checked too late
    expect(one(`await save()\n${guard}`)).toBe(false) // work before the guard
    expect(one("const g = await requireFreshAdministration('admin.inventory')\nif (!g.ok) console.log(g)")).toBe(false) // does not return
    expect(one('const s = mode === 1 ? 2 : 3\n' + guard)).toBe(true) // plain work before it is fine
  })

  // Final fix Y (final review B minor 1): the remaining blind spots.
  it('work started before the guard counts as work even without await, and only a plain refusal check counts', () => {
    const one = (body: string) => kinds(`'use server'\nexport async function x() {\n${body}\n}`).exports[0][1]
    expect(one(`void admin.rpc('x')\n${guard}`)).toBe(false) // a write fired before the guard
    expect(one(`save()\n${guard}`)).toBe(false)
    expect(one(`const r = save()\n${guard}`)).toBe(false)
    expect(one("const g = await requireFreshAdministration('admin.inventory')\nif (g.ok && false) return {}")).toBe(false) // inverted
    expect(one("const g = await requireFreshAdministration('admin.inventory')\nif (g) return {}")).toBe(false)
    expect(one("const g = await requireFreshAdministration('admin.inventory')\nif (!g.ok) return { error: g.error }")).toBe(true)
    expect(one("const g = await requireFreshAdministration('admin.inventory')\nif (g.ok === false) return { error: g.error }")).toBe(true)
  })

  it('every JavaScript and TypeScript file of the app is scanned, and a pages/ folder is refused', () => {
    expect(SCANNED_EXTENSIONS.test('x.mjs') && SCANNED_EXTENSIONS.test('x.js') && SCANNED_EXTENSIONS.test('x.cjs') && SCANNED_EXTENSIONS.test('x.jsx')).toBe(true)
    expect(SCANNED_EXTENSIONS.test('x.mts') && SCANNED_EXTENSIONS.test('x.cts') && SCANNED_EXTENSIONS.test('x.tsx')).toBe(true)
    expect(SCANNED_EXTENSIONS.test('x.d.ts')).toBe(false)
    const files = scanned().map(rel)
    expect(files).toContain('scripts/lib/runtime-mode.mjs')
    expect(files.some((f) => f.startsWith('tests/') || f.includes('node_modules/'))).toBe(false)
    expect(files.filter((f) => /(^|\/)pages\//.test(f) && !f.startsWith('public/'))).toEqual([])
    expect(files.some((f) => /(^|\/)route\.(m?js|jsx)$/.test(f) && !f.startsWith('public/'))).toBe(false)
  })

  it('a guard in another function next to the export does not count', () => {
    const src = `'use server'\nexport async function x() { return helper() }\nasync function helper() {\n  ${guard}\n  return {}\n}`
    expect(kinds(src).exports).toEqual([['x', false]])
  })
})

describe('fresh sign-in: one enforced mechanism (review I-3)', () => {
  const all = inventory()

  it('finds the Server Actions and route handlers (the scan works)', () => {
    expect(all.size).toBeGreaterThan(60)
    expect(all.has('app/api/vod/route.ts#GET')).toBe(true)
  })

  it('every Server Action and route handler is guarded or on the allow-list with a reason', () => {
    const unclassified = [...all.entries()].filter(([k, guarded]) => !guarded && !ALLOWED[k]).map(([k]) => k)
    expect(unclassified).toEqual([])
  })

  it('nothing on the allow-list is guarded anyway or gone (the list stays honest)', () => {
    expect(Object.keys(ALLOWED).filter((k) => !all.has(k))).toEqual([])
    expect(Object.keys(ALLOWED).filter((k) => all.get(k) === true)).toEqual([])
  })

  it('the high-risk ones are guarded (access, people, credentials, merge, archive, moves, monitoring, devices, imports, export, set-up)', () => {
    expect(MUST_BE_GUARDED.filter((k) => all.get(k) !== true)).toEqual([])
  })

  it('no file has an inline server action (they could not be classified here)', () => {
    const inline: string[] = []
    for (const f of scanned()) {
      const sf = parse(readFileSync(f, 'utf8'), rel(f))
      const visit = (n: ts.Node) => {
        if (ts.isFunctionLike(n) && 'body' in n && n.body && ts.isBlock(n.body)) {
          const first = n.body.statements[0]
          if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use server') inline.push(rel(f))
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    expect(inline).toEqual([])
  })
})
