// P5.5 item 2: the browser journeys of Release 1, driven in headless Microsoft Edge through the real screens of the application, with
// screenshots at 1366x768, 1920x1080 and 375 px under docs/drishti/evidence/p5/journeys/ and a report (journeys-report.json).
//
// It needs its OWN stack (never the owner's 3212 / 3412 / go2rtc): a `next dev` on JOURNEY_APP (default http://localhost:3551), a gateway
// on JOURNEY_GATEWAY (http://localhost:3552) and a go2rtc container with the demo configuration (generated test picture), plus headless
// Edge with remote debugging on JOURNEY_DEBUG_PORT (9551). The commands are in the P5.5 report. Run:
//   npx tsx tests/journeys/run-journeys.ts
// Everything it needs is made here in a synthetic `test-…` organisation and removed at the end (also after a failure): a super
// administrator (random password, never printed), a fake NVR and video port on loopback (18551 / 18552), the people the journeys create.
// One-time passwords and the two-step key shown on screen are masked in every screenshot.
//
// Journeys: (a) administrator builds region / clusters / location / NVR (fake) / finds its cameras / imports a synthetic CSV / makes a
// group / creates people with cluster- and location-scoped rights and previews the effect; (b) the cluster viewer signs in and sees exactly
// the cluster's cameras (live video playing), a second viewer with another scope sees others; (c) playback refused for the live-only
// viewer; (e) the CCTV-only viewer sees no IT data; (d) a grant removed in the access editor stops the open video within 60 s; (f) the
// super administrator's Health page and audit log; (g) two-step sign-in: set-up and the challenge, with real TOTP codes.
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { totpCode } from '../helpers/totp'
import { startFakeNvr, startFakeRtsp } from '../helpers/fake-servers'
import { adminClient, cleanupOrg, createOrg, createUser } from '../setup/fixtures'
import { Cdp, sleep, type Page } from './cdp'

process.loadEnvFile(path.resolve(__dirname, '../../.env.local'))
const APP = process.env.JOURNEY_APP ?? 'http://localhost:3551'
const DEBUG_PORT = Number(process.env.JOURNEY_DEBUG_PORT ?? 9551)
const NVR_PORT = 18551
const RTSP_PORT = 18552
const OUT = path.resolve(__dirname, '../../docs/drishti/evidence/p5/journeys')
const SCRATCH = process.env.JOURNEY_SCRATCH ?? path.resolve(__dirname, '../../.next/p55-journeys')
const SIZES = [[1366, 768], [1920, 1080], [375, 812]] as const

type Shot = { name: string; url: string; width: number; height: number; scrollWidth: number; videos: number; playing: number }
const report = { app: APP, startedAt: new Date().toISOString(), shots: [] as Shot[], checks: [] as { journey: string; check: string; ok: boolean; detail?: string }[], timings: {} as Record<string, number>, console: [] as string[] }

function check(journey: string, what: string, ok: boolean, detail?: string) {
  report.checks.push({ journey, check: what, ok, ...(detail ? { detail } : {}) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${journey}: ${what}${detail ? ` (${detail})` : ''}`)
}

/** Masks what must never be in a picture: one-time passwords, the two-step key and its QR code. */
const MASK = `(() => {
  for (const p of document.querySelectorAll('p')) if (/One-time password/.test(p.innerText)) for (const c of p.querySelectorAll('code')) c.textContent = '•••••••••••• (masked)'
  for (const k of document.querySelectorAll('[aria-label="Key for the authenticator app"]')) k.textContent = '•••• •••• •••• •••• (masked)'
  for (const i of document.querySelectorAll('img[alt^="QR code"]')) i.style.filter = 'blur(12px)'
})()`

// The player (go2rtc's <video-stream>) may keep its <video> in a shadow root: look there too.
const VIDEO_STATE = `(() => {
  const all = []
  const walk = (root) => { for (const e of root.querySelectorAll('*')) { if (e.tagName === 'VIDEO') all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }
  walk(document)
  return { videos: all.length, playing: all.filter((x) => !x.paused && x.readyState >= 2).length }
})()`

async function shot(page: Page, name: string, o: { maxHeight?: number; waitVideo?: number } = {}) {
  for (const [w, h] of SIZES) {
    await page.viewport(w, h)
    await sleep(700)
    if (o.waitVideo) await page.waitFor(`${VIDEO_STATE}.playing >= ${Math.min(o.waitVideo, w < 768 ? 1 : o.waitVideo)}`, `${o.waitVideo} playing videos`, 45_000).catch(() => {})
    await page.eval(MASK)
    const s = await page.screenshot(o.maxHeight ?? 3000)
    const file = `${name}-${w}.png`
    writeFileSync(path.join(OUT, file), s.data)
    const v = await page.eval<{ videos: number; playing: number }>(VIDEO_STATE)
    report.shots.push({ name: file, url: (await page.url()).replace(APP, ''), width: w, height: s.height, scrollWidth: s.scrollWidth, ...v })
  }
  await page.viewport(1366, 768)
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${APP}/login`)
  await page.fill('E-mail', email)
  await page.fill('Password', password)
  await page.click('Sign in')
  await page.waitFor(`!location.pathname.startsWith('/login')`, 'leaving the sign-in page')
  await page.settle()
}

async function choosePassword(page: Page, password: string) {
  await page.waitFor(`location.pathname.startsWith('/change-password')`, 'the choose-a-password page')
  await page.settle()
  await page.fill('New password', password)
  await page.fill('Type it again', password)
  await page.click('Save password')
  await page.waitFor(`!location.pathname.startsWith('/change-password')`, 'leaving the choose-a-password page')
  await page.settle()
}

const strongPassword = () => `${randomBytes(12).toString('base64url')}aA1!`

async function main() {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(SCRATCH, { recursive: true })
  const nvr = await startFakeNvr({ port: NVR_PORT, statuses: { 1: true, 2: true, 3: true, 4: true }, channels: ['Entrance', 'Billing counter', 'Stockroom', 'Back door'].map((name, i) => ({ channel: i + 1, name, ip: `192.0.2.${21 + i}` })) })
  const rtsp = await startFakeRtsp('open', RTSP_PORT)
  const orgId = await createOrg()
  const cdp = await Cdp.connect(DEBUG_PORT)
  const pages: Page[] = []
  try {
    const owner = await createUser(orgId, 'platform_owner')
    const g = await adminClient().rpc('grant_platform_owner_all', { p_org: orgId, p_user: owner.id })
    if (g.error) throw new Error(`grant_platform_owner_all: ${g.error.message}`)

    // ── (a) the administrator builds the estate and gives rights ───────────────────────────────────────────────────────────────────
    const adminPage = await cdp.newPage()
    pages.push(adminPage)
    await adminPage.viewport(1366, 768)
    await adminPage.goto(`${APP}/login`)
    await shot(adminPage, 'Ja-01-sign-in')
    await signIn(adminPage, owner.email, owner.password)
    check('a', 'the super administrator signs in on the sign-in page', !(await adminPage.url()).includes('/login'))

    await adminPage.goto(`${APP}/admin/regions`)
    await adminPage.fill('Region code', 'JR1')
    await adminPage.fill('Region name', 'Journey East')
    await adminPage.click('Add region')
    await adminPage.waitForText('JR1 · Journey East')
    for (const [code, name] of [['JC1', 'Journey cluster one'], ['JC2', 'Journey cluster two']]) {
      await adminPage.goto(`${APP}/admin/regions`)
      const last = (await adminPage.count('Cluster code')) - 1 // the "Add a cluster" form is the last cluster form
      await adminPage.fill('Cluster code', code, last)
      await adminPage.fill('Cluster name', name, last)
      await adminPage.select('Region', 'JR1', (await adminPage.count('Region')) - 1)
      await adminPage.click('Add cluster')
      await adminPage.waitForText('Cluster saved.')
    }
    await adminPage.goto(`${APP}/admin/regions`)
    await shot(adminPage, 'Ja-02-regions-and-clusters')
    const clusters = (await adminClient().from('clusters').select('code, region_id').eq('org_id', orgId)).data ?? []
    check('a', 'a region and two clusters in it are made on the Regions and clusters screen', clusters.length === 2 && clusters.every((c) => c.region_id !== null), clusters.map((c) => c.code).join(', '))

    await adminPage.goto(`${APP}/admin/locations`)
    await adminPage.fill('Location code', 'JL1')
    await adminPage.fill('City', 'Patna')
    await adminPage.select('Cluster', 'JC1', (await adminPage.count('Cluster')) - 1) // the last one: the list's filter comes first
    await adminPage.click('Add location')
    await adminPage.waitFor(`/\\/admin\\/locations\\/[0-9a-f-]{36}/.test(location.pathname) || document.body.innerText.includes('JL1')`, 'the new location')
    await adminPage.settle()
    const db = adminClient()
    const jl1 = (await db.from('locations').select('id').eq('org_id', orgId).eq('code', 'JL1').single()).data!.id
    await adminPage.goto(`${APP}/admin/locations/${jl1}`)
    await adminPage.click('Add an NVR')
    await adminPage.settle(300)
    await adminPage.fill('NVR name', 'Ground floor')
    await adminPage.fill('NVR address', '127.0.0.1')
    await adminPage.fill('Web port', String(NVR_PORT))
    await adminPage.fill('Video port (RTSP)', String(RTSP_PORT))
    await adminPage.fill('NVR user name', 'viewer')
    await adminPage.fill('NVR password', 'secret-pass')
    await adminPage.fill('Number of cameras', '4')
    await adminPage.click('Add NVR')
    await adminPage.waitFor(`document.body.innerText.includes('Ground floor')`, 'the new NVR')
    await adminPage.settle(1500)
    await shot(adminPage, 'Ja-03-location-with-nvr')
    const rec = (await db.from('recorders').select('id').eq('location_id', jl1).single()).data!.id
    await adminPage.goto(`${APP}/admin/locations/${jl1}/nvrs/${rec}`)
    await adminPage.click('Find cameras')
    await adminPage.waitFor(`/found|new camera|camera(s)? (added|found)|4 cameras/i.test(document.body.innerText)`, 'the discovery result', 60_000).catch(() => {})
    await adminPage.settle(1500)
    await shot(adminPage, 'Ja-04-nvr-cameras-found')
    const jl1Cams = (await db.from('cameras').select('id, name').eq('location_id', jl1).is('archived_at', null)).data ?? []
    check('a', 'Find cameras on the fake NVR lists its four cameras by name', jl1Cams.length === 4 && jl1Cams.some((c) => c.name === 'Billing counter'), `${jl1Cams.length} cameras`)

    const csv = [
      'code,name,display_name,kind,city,zone,region,cluster,ip,port,http_port,user,password,channels,nvr_name,monitoring',
      `JL2,,Journey two,store,Gaya,BR,JR1,JC1,127.0.0.1,${RTSP_PORT},${NVR_PORT + 10},viewer,Pw-journey-2a,3,Ground floor,`,
      // Two NVRs of one location need two addresses (an address is unique within the location's network); 127.0.0.2 is loopback too.
      `JL2,,,,,,,,127.0.0.2,${RTSP_PORT},${NVR_PORT + 11},viewer,Pw-journey-2b,2,First floor,`,
      `JL3,,Journey three,store,Ranchi,JH,JR1,JC2,127.0.0.1,${RTSP_PORT},${NVR_PORT + 12},viewer,Pw-journey-3,3,NVR,`,
    ].join('\n')
    const csvFile = path.join(SCRATCH, 'journey-locations.csv')
    writeFileSync(csvFile, csv + '\n')
    await adminPage.goto(`${APP}/admin/import`)
    await adminPage.upload('#import-file', csvFile)
    await sleep(400)
    await adminPage.click('Check the file')
    await adminPage.waitForText('What the import would do', 30_000)
    await adminPage.settle()
    await shot(adminPage, 'Ja-05-import-preview')
    await adminPage.click('Import', { within: 'section[aria-labelledby="import-preview"]' }).catch(() => adminPage.click('Import'))
    await adminPage.waitFor(`/imported|were saved|Imported/i.test(document.body.innerText)`, 'the import result', 60_000).catch(() => {})
    await adminPage.settle(1500)
    await shot(adminPage, 'Ja-06-import-result')
    const loc = async (code: string) => (await db.from('locations').select('id').eq('org_id', orgId).eq('code', code).maybeSingle()).data?.id
    const jl2 = await loc('JL2')
    const jl3 = await loc('JL3')
    const camsOf = async (l: string | undefined) => (l ? ((await db.from('cameras').select('id').eq('location_id', l).is('archived_at', null)).data ?? []).map((c) => c.id) : [])
    check('a', 'the synthetic CSV imports two locations (one with two NVRs) into the clusters', !!jl2 && !!jl3 && (await camsOf(jl2)).length === 5 && (await camsOf(jl3)).length === 3)

    await adminPage.goto(`${APP}/groups`)
    await adminPage.fill('Group name', 'Journey wall')
    await adminPage.click('Make group')
    await adminPage.waitFor(`/\\/groups\\/[0-9a-f-]{36}/.test(location.pathname) || document.body.innerText.includes('Journey wall')`, 'the new group')
    await adminPage.settle()
    const group = (await db.from('camera_groups').select('id').eq('org_id', orgId).eq('name', 'Journey wall').single()).data!.id
    await adminPage.goto(`${APP}/groups/${group}`)
    await adminPage.select('Location', 'JL1')
    await adminPage.click('Show cameras')
    await adminPage.settle()
    await adminPage.click('Select all not yet added')
    await adminPage.settle(300)
    await adminPage.click('Add 4 selected cameras')
    await adminPage.settle(1500)
    await shot(adminPage, 'Ja-07-group')
    const items = (await db.from('camera_group_items').select('camera_id').eq('group_id', group)).data ?? []
    check('a', 'a camera group is made with the location\'s cameras', items.length === 4, `${items.length} cameras`)

    const people: Record<string, { email: string; oneTime: string; id: string; password?: string }> = {}
    for (const [key, name] of [['cluster', 'Journey cluster viewer'], ['live', 'Journey live viewer']] as const) {
      await adminPage.goto(`${APP}/admin/users`)
      const email = `journey-${key}-${randomBytes(4).toString('hex')}@example.test`
      await adminPage.fill('Name', name)
      await adminPage.fill('E-mail', email)
      await adminPage.select('Role', 'Viewer')
      await adminPage.click('Add person').catch(() => adminPage.click('Add'))
      await adminPage.waitForText('One-time password')
      const oneTime = await adminPage.eval<string>(`[...document.querySelectorAll('p')].find((p) => /One-time password/.test(p.innerText))?.querySelector('code')?.textContent ?? ''`)
      if (key === 'cluster') await shot(adminPage, 'Ja-08-person-created')
      const id = (await db.from('profiles').select('id').eq('email', email).single()).data!.id
      people[key] = { email, oneTime, id }
    }

    // The cluster viewer: live and playback for the whole cluster JC1, previewed, then saved.
    await adminPage.goto(`${APP}/admin/users/${people.cluster.id}/access`)
    await adminPage.click('CCTV')
    await adminPage.check('A cluster')
    await adminPage.settle(300)
    await adminPage.check('Cluster JC1 · Journey cluster one')
    await adminPage.click('Preset: Location CCTV viewer (live + playback)')
    await adminPage.fill('Reason', 'Cluster manager of JC1 (journey)')
    await adminPage.click('Add to the list of changes')
    await adminPage.click('Check the effect')
    await adminPage.waitForText('Effect of these changes')
    await adminPage.settle()
    await shot(adminPage, 'Ja-09-access-preview', { maxHeight: 3600 })
    const previewText = await adminPage.text()
    check('a', 'the effect preview lists what the cluster right gives before anything is saved', /Effect of these changes/.test(previewText) && (await db.from('access_grants').select('id').eq('user_id', people.cluster.id)).data!.length === 0)
    await adminPage.click('Save these changes')
    await adminPage.waitFor(`/saved|Saved/.test(document.body.innerText)`, 'the save', 30_000).catch(() => {})
    await adminPage.settle(1500)
    await shot(adminPage, 'Ja-10-access-saved', { maxHeight: 3600 })
    const clusterGrants = (await db.from('access_grants').select('id, capability, scope_kind').eq('user_id', people.cluster.id).is('revoked_at', null)).data ?? []
    check('a', 'the cluster-scoped live and playback rights are saved', clusterGrants.length === 2 && clusterGrants.every((x) => x.scope_kind === 'cluster'), JSON.stringify(clusterGrants.map((x) => x.capability)))

    // The second viewer: live only, for location JL3 (another cluster).
    await adminPage.goto(`${APP}/admin/users/${people.live.id}/access`)
    await adminPage.click('CCTV')
    await adminPage.check('All cameras in these locations')
    await adminPage.settle(300)
    await adminPage.check('JL3 · Journey three').catch(() => adminPage.check('JL3'))
    await adminPage.settle(300)
    await adminPage.eval(`(() => { const b = [...document.querySelectorAll('input[type=checkbox][aria-label]')].find((x) => /^Live/i.test(x.getAttribute('aria-label')) && /JL3/.test(x.getAttribute('aria-label'))); if (b && !b.checked) b.click() })()`)
    await adminPage.fill('Reason', 'Location JL3, live only (journey)')
    await adminPage.click('Add to the list of changes')
    await adminPage.click('Check the effect')
    await adminPage.waitForText('Effect of these changes')
    await adminPage.click('Save these changes')
    await adminPage.settle(1500)
    const liveGrants = (await db.from('access_grants').select('capability, scope_kind').eq('user_id', people.live.id).is('revoked_at', null)).data ?? []
    check('a', 'the second viewer holds live only, for one location', liveGrants.length === 1 && liveGrants[0].capability === 'cctv.live' && liveGrants[0].scope_kind === 'location', JSON.stringify(liveGrants))

    // ── (b) the viewers sign in and see exactly their cameras ──────────────────────────────────────────────────────────────────────
    const viewer = await cdp.newPage()
    pages.push(viewer)
    await viewer.viewport(1366, 768)
    people.cluster.password = strongPassword()
    await signIn(viewer, people.cluster.email, people.cluster.oneTime)
    await shot(viewer, 'Jb-01-choose-password')
    await choosePassword(viewer, people.cluster.password)
    await viewer.goto(`${APP}/live`)
    await shot(viewer, 'Jb-02-cluster-viewer-live-tree')
    const treeText = await viewer.text()
    check('b', 'the cluster viewer\'s Live tree shows the cluster\'s locations JL1 and JL2 and not JL3', treeText.includes('JL1') && treeText.includes('JL2') && !treeText.includes('JL3'))
    await viewer.goto(`${APP}/live?location=${jl1}`)
    await viewer.waitFor(`${VIDEO_STATE}.playing >= 4`, 'four playing tiles', 60_000).catch(() => {})
    const playing = await viewer.eval<{ videos: number; playing: number }>(VIDEO_STATE)
    await shot(viewer, 'Jb-03-cluster-viewer-wall-playing', { waitVideo: 4 })
    check('b', 'the location wall plays the four cameras (go2rtc test picture through the gateway)', playing.playing === 4, JSON.stringify(playing))

    const second = await cdp.newPage()
    pages.push(second)
    await second.viewport(1366, 768)
    people.live.password = strongPassword()
    await signIn(second, people.live.email, people.live.oneTime)
    await choosePassword(second, people.live.password)
    await second.goto(`${APP}/live`)
    await shot(second, 'Jb-04-second-viewer-live-tree')
    const secondText = await second.text()
    check('b', 'the second viewer (other scope) sees JL3 only', secondText.includes('JL3') && !secondText.includes('JL1') && !secondText.includes('JL2'))

    // ── (c) playback denied for the live-only viewer ──────────────────────────────────────────────────────────────────────────────
    const jl3Cam = (await camsOf(jl3))[0]
    await second.goto(`${APP}/playback?camera=${jl3Cam}`)
    await shot(second, 'Jc-01-live-only-playback-refused')
    const pbUrl = await second.url()
    const pbText = await second.text()
    const navHasPlayback = await second.eval<boolean>(`[...document.querySelectorAll('nav a')].some((a) => a.innerText.trim() === 'Playback')`)
    check('c', 'the live-only viewer has no Playback in the menu and the playback address does not play the camera', !navHasPlayback && (!pbUrl.includes('/playback') || !/Play|Calendar/.test(pbText) || /not (found|available)/i.test(pbText)), pbUrl.replace(APP, ''))

    // ── (e) the CCTV-only viewer sees no IT data ──────────────────────────────────────────────────────────────────────────────────
    await viewer.goto(`${APP}/locations/${jl1}`)
    await shot(viewer, 'Je-01-cctv-only-location-page')
    const locText = await viewer.text()
    check('e', 'the location page shows the cameras but no NVR name, address, login or device', locText.includes('Billing counter') && !locText.includes('Ground floor') && !locText.includes('127.0.0.1') && !/viewer@|NVR user/i.test(locText))
    await viewer.goto(`${APP}/devices`)
    const devUrl = await viewer.url()
    await shot(viewer, 'Je-02-cctv-only-devices-refused')
    check('e', 'the Devices page is not open to a CCTV-only viewer', !devUrl.includes('/devices'), devUrl.replace(APP, ''))
    await viewer.goto(`${APP}/home`)
    await shot(viewer, 'Je-03-cctv-only-home')
    const homeText = await viewer.text()
    check('e', 'Home shows the camera figures and no NVR or device section', !/NVRs? (up|down)|Devices/i.test(homeText))

    // ── (d) a grant removed in the access editor stops the open video within 60 s ────────────────────────────────────────────────
    await viewer.goto(`${APP}/live?location=${jl1}`)
    await viewer.waitFor(`${VIDEO_STATE}.playing >= 4`, 'four playing tiles', 60_000)
    await shot(viewer, 'Jd-01-watching-before-revocation', { waitVideo: 4 })
    await adminPage.goto(`${APP}/admin/users/${people.cluster.id}/access`)
    // The "Remove…" of the live grant (its accessible name says which right and where).
    const removeLabel = await adminPage.eval<string>(`[...document.querySelectorAll('button[aria-label^="Remove "]')].map((b) => b.getAttribute('aria-label')).find((l) => /live/i.test(l)) ?? ''`)
    if (!removeLabel) throw new Error('No "Remove…" button for the live grant')
    await adminPage.click(removeLabel)
    await adminPage.fill('Reason for removing (required)', 'Moved to another cluster (journey)')
    await adminPage.click('Check the effect')
    await adminPage.waitForText('Effect of these changes')
    await shot(adminPage, 'Jd-02-removal-preview', { maxHeight: 3600 })
    // The wall is playing at the moment the removal is saved (after the screenshots it was laid out again at 1366 px).
    await viewer.waitFor(`${VIDEO_STATE}.playing >= 4`, 'four playing tiles again', 60_000)
    report.timings.playing_when_saved = (await viewer.eval<{ playing: number }>(VIDEO_STATE)).playing
    await adminPage.click('Save these changes')
    const savedAt = Date.now()
    await adminPage.settle(800)
    let stoppedAfter: number | null = null
    while (Date.now() - savedAt < 75_000) {
      const v = await viewer.eval<{ videos: number; playing: number }>(VIDEO_STATE)
      if (v.playing === 0) {
        stoppedAfter = Date.now() - savedAt
        break
      }
      await sleep(250)
    }
    report.timings.revocation_video_stopped_ms = stoppedAfter ?? -1
    await shot(viewer, 'Jd-03-video-stopped-after-revocation')
    const liveLeft = (await db.from('access_grants').select('capability').eq('user_id', people.cluster.id).is('revoked_at', null)).data ?? []
    check('d', 'the open live video stops within 60 s of saving the removal', stoppedAfter !== null && stoppedAfter < 60_000, `${stoppedAfter} ms; rights left: ${liveLeft.map((x) => x.capability).join(', ')}`)

    // ── (f) super administrator: Health and audit ─────────────────────────────────────────────────────────────────────────────────
    await adminPage.goto(`${APP}/admin/health`)
    await shot(adminPage, 'Jf-01-health')
    check('f', 'the Health page opens for the super administrator', (await adminPage.text()).includes('Health'))
    await adminPage.goto(`${APP}/admin/audit`)
    await shot(adminPage, 'Jf-02-audit-log')
    const auditText = await adminPage.text()
    check('f', 'the audit log shows the access changes of the journey', /access|Access/.test(auditText))

    // ── (g) two-step sign-in: set-up, then the challenge at the next sign-in ─────────────────────────────────────────────────────
    await adminPage.goto(`${APP}/mfa/enrol`)
    await adminPage.click('Set up')
    await adminPage.waitFor(`document.querySelector('[aria-label="Key for the authenticator app"]')`, 'the key', 20_000)
    const secret = (await adminPage.eval<string>(`document.querySelector('[aria-label="Key for the authenticator app"]').textContent`)).replace(/\s+/g, '')
    await shot(adminPage, 'Jg-01-two-step-set-up')
    await adminPage.fill('6-digit code', totpCode(secret))
    await adminPage.click('Finish set-up')
    await adminPage.waitFor(`!location.pathname.startsWith('/mfa')`, 'leaving the set-up', 20_000).catch(() => {})
    await adminPage.settle()
    const third = await cdp.newPage()
    pages.push(third)
    await third.viewport(1366, 768)
    await signIn(third, owner.email, owner.password)
    await third.waitFor(`location.pathname.startsWith('/mfa')`, 'the code step', 20_000).catch(() => {})
    await shot(third, 'Jg-02-two-step-challenge')
    const atChallenge = (await third.url()).includes('/mfa')
    await sleep(Math.max(0, 31_000 - (Date.now() % 30_000))) // a fresh 30 s window, so the code differs from the set-up one
    await third.fill('6-digit code', totpCode(secret))
    await third.click('Continue')
    await third.waitFor(`!location.pathname.startsWith('/mfa')`, 'leaving the code step', 20_000).catch(() => {})
    await third.settle()
    check('g', 'after set-up, the next sign-in asks for the code, and a correct code signs in', atChallenge && !(await third.url()).includes('/mfa'), (await third.url()).replace(APP, ''))
  } catch (e) {
    // A failed step: what each page showed, for the person fixing it (scratch folder, not evidence).
    for (const [i, p] of pages.entries()) {
      await p.eval(MASK).catch(() => {})
      const s = await p.screenshot().catch(() => null)
      if (s) writeFileSync(path.join(SCRATCH, `failed-page-${i}.png`), s.data)
    }
    throw e
  } finally {
    for (const p of pages) report.console.push(...p.console.slice(0, 40))
    report.console = [...new Set(report.console)].slice(0, 80)
    writeFileSync(path.join(OUT, 'journeys-report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2) + '\n')
    cdp.close()
    await nvr.close()
    await rtsp.close()
    await cleanupOrg(orgId)
    const failed = report.checks.filter((c) => !c.ok)
    console.log(`${report.checks.length - failed.length} of ${report.checks.length} checks passed; ${report.shots.length} screenshots.`)
    if (failed.length) process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})
