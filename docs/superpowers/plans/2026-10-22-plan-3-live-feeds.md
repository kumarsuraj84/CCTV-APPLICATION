# Live Feeds, Playback and Camera Groups (Plan 3 of 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People watch the live video of the cameras they may see (one camera, a store wall, or a saved group), can look at recorded video by day and time, and operators manage camera groups; every video connection is authorised for exactly one camera for a short time.

**Architecture:** Browsers never see camera passwords or go2rtc. A Server Action checks, with the person's own client (row-level security), which cameras they may see, registers those streams in go2rtc (a media server in Docker) using credentials read from the vault, and returns short-lived signed tokens. A small Node gateway (port 3213) accepts a WebSocket with a token, works out the stream name from the token (never from the browser), and pipes the video from go2rtc. Playback uses the NVR's own search (ISAPI) for what exists and go2rtc's RTSP playback for the video. Camera groups are plain tables with the same visibility rules as cameras.

**Tech Stack:** Next.js 16, Supabase, `ws` (moved to a runtime dependency), go2rtc `alexxit/go2rtc` Docker image (includes ffmpeg), the `video-rtc.js` player served by go2rtc through the gateway. Optional: ffmpeg on the web server for fast playback.

**Spec:** `docs/superpowers/specs/2026-10-21-network-monitoring-hub-design.md` (sections 8 and 9). Builds on Plan 2 (branch `feat/plan-2-monitoring`).

## Global Constraints

- All Plan 1 and Plan 2 constraints still apply (Next 16, Server Actions check the caller first, IST 24-hour, plain English, services return `Result`, explicit grants on every new object, egress guard and loopback fakes in tests, no secrets in the repo, never push).
- Camera credentials never reach a browser, a log or an API response. The RTSP URL with credentials exists only in the server-to-go2rtc call.
- A stream token names one person, one camera and one kind (`sub`, `main` or `pb` for playback), is signed with the `stream_token` secret (HMAC-SHA256), and lives **10 minutes**. The gateway derives the go2rtc stream name from the token only; the browser cannot choose it. A missing secret turns live video off with a plain message.
- Cameras a person may not see are silently left out of any request; asking for them never reveals that they exist.
- At most **36** streams are opened per request (a 6 by 6 wall). Rate limit: 10 stream requests per person per minute.
- Stream names: `cam_<cameraId>_sub`, `cam_<cameraId>_main`, `pb_<cameraId>_<startEpoch>`.
- Camera groups: any signed-in person sees a group only if they may see at least one camera in it (or created it, or sees everything); `agent`, `admin` and `platform_owner` may create, change and delete groups; they may only add cameras they can see themselves.
- Playback time zone: the NVR's clock offset in minutes is `PLAYBACK_OFFSET_MIN` (default 0).
- Gateway ports: HTTP and WebSocket on **3213**; go2rtc API on 1984 (loopback only) and 8555.
- Demo video: only when `DEMO_VIDEO=1`, `NODE_ENV` is not `production`, and the store's NVR address is loopback, streams use a generated test pattern (go2rtc `exec:ffmpeg` source) instead of the store's RTSP URL.
- `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration` clean at the end of every task.

## File Structure

```
supabase/migrations/20261021000006_camera_groups.sql   (+ rollback)         Task 1
lib/groups/service.ts  lib/actions/groups.ts  app/(app)/groups/**           Tasks 1-2
lib/streams/{token,go2rtc,source}.ts                                          Task 3
lib/streams/gateway.ts  services/gateway/index.ts  deploy/docker-compose.dev.yml  deploy/go2rtc.yaml   Task 4
lib/streams/open.ts  lib/actions/streams.ts  components/live/*  app/(app)/live/page.tsx   Task 5
lib/nvr/playback.ts  tests/helpers/fake-servers.ts (extended)                 Task 6
lib/actions/playback.ts  app/(app)/playback/page.tsx  components/live/PlaybackView.tsx   Task 7
app/api/vod/route.ts  lib/streams/vod.ts                                       Task 8
```

---

### Task 1: Camera groups: schema, rules and service

**Files:**
- Create: `supabase/migrations/20261021000006_camera_groups.sql`, `supabase/rollback/20261021000006_camera_groups_rollback.sql`, `lib/groups/service.ts`
- Modify: `lib/admin/roles.ts` (add `canManageGroups`), `tests/setup/fixtures.ts` (delete order), `types/database.ts` (regenerate)
- Test: `tests/unit/roles.test.ts` (extend), `tests/integration/groups.test.ts`

**Interfaces:**
- Produces: `canManageGroups(role)` (agent, admin, platform_owner); tables `camera_groups(id, org_id, name, created_by, created_at, updated_at)` and `camera_group_items(org_id, group_id, camera_id, added_at)` with same-organisation composite keys; service functions in `lib/groups/service.ts`, all taking `(deps: {admin: AdminClient; rls: AdminClient}, actor: Actor, ...)` and returning `Result`: `createGroup(deps, actor, name)`, `renameGroup(deps, actor, groupId, name)`, `deleteGroup(deps, actor, groupId)`, `addCameras(deps, actor, groupId, cameraIds)`, `addCamerasByKeyword(deps, actor, groupId, keyword)`, `removeCamera(deps, actor, groupId, cameraId)`. `rls` is the person's own signed-in client (used to prove which cameras they may see); `admin` does the writes.

SQL (use verbatim):
```sql
BEGIN;
CREATE TABLE public.camera_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT camera_groups_org_name_key UNIQUE (org_id, name),
  CONSTRAINT camera_groups_id_org_key UNIQUE (id, org_id)
);
CREATE TABLE public.camera_group_items (
  org_id uuid NOT NULL,
  group_id uuid NOT NULL,
  camera_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, camera_id),
  FOREIGN KEY (group_id, org_id) REFERENCES public.camera_groups (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (camera_id, org_id) REFERENCES public.cameras (id, org_id) ON DELETE CASCADE
);
CREATE INDEX camera_group_items_camera_idx ON public.camera_group_items (camera_id);
CREATE TRIGGER camera_groups_updated BEFORE UPDATE ON public.camera_groups FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.camera_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.camera_group_items ENABLE ROW LEVEL SECURITY;

-- A group is visible to people who see everything, to its creator, and to anyone who may see at least one camera in it.
CREATE POLICY camera_groups_select ON public.camera_groups FOR SELECT TO authenticated
  USING (
    org_id = (SELECT public.current_org_id()) AND (
      (SELECT public.is_staff_all()) OR created_by = auth.uid() OR
      id IN (SELECT group_id FROM public.camera_group_items WHERE camera_id IN (SELECT public.visible_camera_ids()))
    )
  );
-- Items: only the cameras the reader may see.
CREATE POLICY camera_group_items_select ON public.camera_group_items FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND camera_id IN (SELECT public.visible_camera_ids()));

REVOKE ALL ON public.camera_groups, public.camera_group_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.camera_groups, public.camera_group_items TO authenticated;
GRANT ALL ON public.camera_groups, public.camera_group_items TO service_role;
COMMIT;
```
Rollback: drop both tables.

- [ ] **Step 1: Tests first.** Unit: `canManageGroups` true for agent/admin/platform_owner, false for user/manager. Integration (`tests/integration/groups.test.ts`), using the fixtures (org, two stores each with cameras, users: viewer with store grant A, viewer2 with store B, manager, agent with store A grant, admin):
  - a manager sees a group containing cameras of both stores and all its items; the viewer with store A sees the group but only the store A items; the viewer with store B sees only the items in B (and the group, as it has a B camera); a viewer with no grants does not see the group at all; another organisation sees nothing;
  - nobody can write the tables through the data API (42501);
  - service: an `agent` can create a group, add cameras they can see, and gets a plain refusal ("Some of those cameras are not available to you.") when any id is not visible to them (nothing is added); `addCamerasByKeyword` adds only visible cameras whose name matches (case-insensitive, at most 500), returns how many; duplicate adds are ignored; a viewer (`user`) and a `manager` cannot create groups; deleting is allowed for the creator and for admins only; a duplicate group name returns the plain duplicate message; names are trimmed and 1 to 100 characters.
- [ ] **Step 2:** Run, see failures. **Step 3:** write the migration, rollback, `canManageGroups`, add `camera_group_items` and `camera_groups` (in that order) to the fixtures delete order, regenerate types (`npm run db:reset`, `node scripts/create-dev-admin.mjs`, `npm run db:types`), implement the service (admin client for writes; `rls` client for visibility: `rls.from('cameras').select('id').in('id', ids)` must return every id, else refuse). Audit rows (`group_created`, `group_deleted`, `group_cameras_added`) through `addAudit`. **Step 4:** run all checks. **Step 5:** commit `feat: camera groups with visibility rules`.

---

### Task 2: Camera groups screens

**Files:** Create `lib/actions/groups.ts`, `app/(app)/groups/page.tsx`, `app/(app)/groups/[id]/page.tsx`, `components/groups/{CreateGroupForm,GroupEditor}.tsx`; modify `lib/nav.ts` (item "Groups", group Monitoring, mobile false), nav test.

**Interfaces:** Server Actions `createGroupAction`, `deleteGroupAction`, `addCamerasAction(groupId, cameraIds)`, `addByKeywordAction(groupId, keyword)`, `removeCameraAction(groupId, cameraId)`; each calls `requireProfile()`, builds `{admin: createAdminClient(), rls: await createClient()}` and the matching service function, revalidates `/groups`.

- [ ] Build: `/groups` lists the groups the person may see (name, number of cameras they can see, "Open live wall" link to `/live?group=<id>` once Task 5 exists) and, for `canManageGroups` roles, a create form. `/groups/[id]` shows the cameras (store code, channel, name) with a remove button, and for managers an "Add cameras" area: a store select that lists that store's visible cameras as checkboxes, plus "add by name" keyword box. Plain texts, toasts for results, empty states. Nav test updated (the admin and agent lists contain `/groups`; viewers see it too because everybody may see groups they can open).
- [ ] Verify: typecheck, lint, tests; start `npm run dev` and check `/groups` redirects to login when signed out. Commit `feat: camera group screens`.

---

### Task 3: Stream tokens, go2rtc client and source builder

**Files:** Create `lib/streams/token.ts`, `lib/streams/go2rtc.ts`, `lib/streams/source.ts`; test `tests/unit/stream-token.test.ts`, `tests/unit/stream-source.test.ts`, `tests/unit/go2rtc-client.test.ts`.

**Interfaces (exact):**
```ts
// token.ts
export type StreamKind = 'sub' | 'main' | 'pb'
export type StreamClaims = { u: string; c: string; k: StreamKind; exp: number; s?: number; e?: number } // exp, s, e are epoch SECONDS; s/e only for 'pb'
export const TOKEN_LIFETIME_SEC = 600
export function signStreamToken(claims: StreamClaims, secret?: string | null): string          // throws Error('stream_token secret is not set') without a secret
export function verifyStreamToken(token: string, nowMs?: number, secret?: string | null): StreamClaims | null   // null for anything wrong, expired, tampered, wrong kind/shape
export function streamName(claims: Pick<StreamClaims, 'c' | 'k' | 's'>): string
// source.ts
export function buildRtspUrl(o: { host: string; port: number; username: string; password: string; channel: number; kind: 'sub' | 'main' }): string
export function buildPlaybackUrl(o: { host: string; port: number; username: string; password: string; channel: number; start: Date; end: Date; offsetMin: number }): string
export function demoSource(channel: number): string
export function isDemoStore(o: { code: string; nvr_ip: string }, env?: Record<string, string | undefined>): boolean
// go2rtc.ts
export class Go2rtcClient { constructor(baseUrl: string, fetchImpl?: typeof fetch); register(name: string, src: string): Promise<void>; remove(name: string): Promise<void>; has(name: string): Promise<boolean> }
```
Token format `base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payload))`; verify with `timingSafeEqual`; validate `c` and `u` as UUIDs, `k` in the kinds, `exp` a number, `pb` requires `s` and `e` numbers with `e > s` and `e - s <= 86400`. `streamName`: `cam_<c>_sub|main` or `pb_<c>_<s>`. `buildRtspUrl`: `rtsp://<enc(user)>:<enc(pass)>@<host>:<port>/Streaming/Channels/<channel>0<2|1>` (sub is `…02`, main `…01`), IPv6 hosts in brackets, credentials percent-encoded. `buildPlaybackUrl`: `…/Streaming/tracks/<channel>01?starttime=<UTC yyyymmddThhmmssZ>&endtime=<…>` where the instants are shifted by `-offsetMin` minutes (as the legacy app did: NVR time = true time + offset). `demoSource(channel)`: `exec:ffmpeg -re -f lavfi -i <pattern>=size=640x360:rate=10 -c:v libx264 -preset ultrafast -tune zerolatency -g 20 -rtsp_transport tcp -f rtsp {output}` with the pattern chosen by `channel % 4` from `testsrc`, `testsrc2`, `smptebars`, `rgbtestsrc`. `isDemoStore`: true only when `env.DEMO_VIDEO === '1'`, `env.NODE_ENV !== 'production'`, `nvr_ip` is `127.0.0.1`/`localhost`/`::1`. `Go2rtcClient.register`: `PUT <base>/api/streams?name=<enc>&src=<enc>`; throws a plain `Error('The video server did not accept the stream.')` on a non-2xx answer or network failure (never including the URL); `has` reads `GET /api/streams` and checks the name; `remove` `DELETE /api/streams?src=<name>`.

- [ ] Tests (write first): token round trip; tampered payload, tampered signature, wrong secret, expired (`exp` in the past), malformed strings, `pb` without `s/e`, `pb` longer than 24 hours, non-UUID camera id, missing secret on sign (throws) and on verify (null); `streamName` for each kind; `buildRtspUrl` with special characters in the password (`p@ss:w/rd#` is encoded) and an IPv6 host; `buildPlaybackUrl` with offset 330 (an instant 2026-03-10T10:00:00Z becomes `20260310T043000Z`); `isDemoStore` for the four cases; `Go2rtcClient` against an in-test `http` server on loopback (register sends the right query; error answers throw the plain message without the URL; `has`).
- [ ] Implement, run all checks, commit `feat: stream tokens, go2rtc client and stream sources`.

---

### Task 4: The video gateway and go2rtc in Docker

**Files:** Create `lib/streams/gateway.ts`, `services/gateway/index.ts`, `deploy/docker-compose.dev.yml`, `deploy/go2rtc.yaml`, `tests/integration/gateway.test.ts`; modify `package.json` (move `ws` and `@types/ws` as appropriate: `ws` to `dependencies`; add scripts `gateway`, `stack:up`, `stack:down`), `.env.example` (`GO2RTC_URL`, `NEXT_PUBLIC_STREAM_GATEWAY_URL` already listed; add `GATEWAY_ALLOWED_ORIGINS`), `README.md`.

**Interfaces:**
```ts
export type GatewayOptions = { go2rtcUrl: string; secret: string; allowedOrigins: string[]; maxSessionMs?: number; now?: () => number }
export function createGateway(opts: GatewayOptions): http.Server
```
Behaviour (exact): `GET /g/health` answers `200 ok`. `GET /g/video-stream.js` and `/g/video-rtc.js` are fetched from `<go2rtcUrl>/video-stream.js` and `/video-rtc.js` and returned with `Content-Type: text/javascript`, `Cache-Control: public, max-age=300`, `X-Content-Type-Options: nosniff` (502 with plain text when go2rtc cannot be reached). A WebSocket upgrade on `/g/ws?token=<token>` is accepted only when the `Origin` header is in `allowedOrigins` (a missing Origin is refused) and `verifyStreamToken(token, now(), secret)` returns claims; otherwise the socket is closed with code 1008 (policy violation) before any upstream connection is made. For a valid token the gateway opens `ws://<go2rtc>/api/ws?src=<streamName(claims)>` and pipes text and binary frames both ways; either side closing closes the other; the session ends after `maxSessionMs` (default 30 minutes). The browser's `src` parameter, if any, is ignored. More than 300 open client sockets are refused with 1013. All other paths return 404.

`services/gateway/index.ts`: loads `.env.local` if it exists, requires `STREAM_TOKEN_SECRET` (log a plain error and exit 1 without it), reads `GO2RTC_URL` (default `http://127.0.0.1:1984`), `GATEWAY_PORT` (default 3213) and `GATEWAY_ALLOWED_ORIGINS` (default `NEXT_PUBLIC_APP_URL`, comma separated), listens on `0.0.0.0`, handles SIGINT/SIGTERM.

`deploy/docker-compose.dev.yml`:
```yaml
name: cctv-hub-media
services:
  go2rtc:
    image: alexxit/go2rtc:1.9.9
    restart: unless-stopped
    ports:
      - "127.0.0.1:1984:1984"
      - "8555:8555/tcp"
      - "8555:8555/udp"
    volumes:
      - ./go2rtc.yaml:/config/go2rtc.yaml:ro
```
`deploy/go2rtc.yaml`:
```yaml
api:
  listen: ":1984"
rtsp:
  listen: ""
webrtc:
  listen: ":8555"
streams: {}
```
(If the pinned image tag does not exist, use the newest `1.9.x` tag that does and say which.) Scripts: `"gateway": "tsx services/gateway/index.ts"`, `"stack:up": "docker compose -f deploy/docker-compose.dev.yml up -d"`, `"stack:down": "docker compose -f deploy/docker-compose.dev.yml down"`.

- [ ] Tests first (`tests/integration/gateway.test.ts`; all on loopback, a fake go2rtc made of an `http` server that serves the two JS files and a `ws` `WebSocketServer` on `/api/ws` recording the `src` query and echoing frames; the gateway started with `createGateway` on port 0; use the `ws` client with an `Origin` header): health 200; scripts proxied with the right headers; a bad token, an expired token (inject `now`), a good token with a wrong Origin, a good token without Origin are all closed with 1008 and the fake go2rtc never sees a connection; a valid token connects upstream with `src=cam_<id>_sub` even when the client adds `&src=evil`; frames flow both ways (text and binary); closing the client closes upstream and the reverse; `maxSessionMs` ends the session; unknown path 404; the upstream being down yields a close with code 1011 and a plain reason; 301 sockets: refuse beyond the limit (use a small `maxSockets` option for the test, default 300).
- [ ] Implement; run `npm run stack:up` once and check `curl http://127.0.0.1:1984/api` answers, then `npm run stack:down` (record the image tag used). Commit `feat: video gateway with signed tokens and go2rtc compose file`.

---

### Task 5: Opening streams and the Live wall

**Files:** Create `lib/streams/open.ts`, `lib/actions/streams.ts`, `components/live/{LiveWall,LiveTile}.tsx`, `types/custom-elements.d.ts`, `app/(app)/live/page.tsx`; modify `lib/nav.ts` (item "Live", Monitoring), nav tests, `components/layout` icons if needed.

**Interfaces:**
```ts
// lib/streams/open.ts
export type OpenedStream = { cameraId: string; name: string; storeCode: string; channel: number; token: string; kind: 'sub' | 'main' }
export async function openStreams(deps: { admin: AdminClient; rls: AdminClient; go2rtc: Go2rtcClient; env?: Record<string, string | undefined>; now?: () => number },
  actor: { id: string; orgId: string }, cameraIds: string[], kind: 'sub' | 'main'): Promise<Result<{ streams: OpenedStream[] }>>
```
Behaviour: refuses with a plain message when `getSecret('stream_token')` is null ("Live video is not set up yet."), when more than 36 ids are given, or none. Visible cameras are read with `rls` (`from('cameras').select('id, name, channel, store_id, stores(code, nvr_ip, rtsp_port)').in('id', ids)`); ids that come back are the only ones used. For each, the NVR password is read with the admin RPC `nvr_read_credential` (once per store), the RTSP URL is built (or the demo source when `isDemoStore`), registered in go2rtc under `streamName`, and a token signed with `exp = now+600s`. A go2rtc failure for one camera leaves that camera out and the rest work (the result lists only the opened streams, and `ok:false` with "The video server is not available." only when none could be opened). The result never contains a password or an RTSP URL. `lib/actions/streams.ts`: `openStreamsAction(cameraIds, kind)` (requireProfile, rate limit 10 per minute per person, builds the deps with `new Go2rtcClient(process.env.GO2RTC_URL ?? 'http://127.0.0.1:1984')`) and `refreshStreamTokensAction(cameraIds, kind)` (same call; used by the page every 8 minutes).

Page `/live`: query `?store=<id>` or `?group=<id>` or `?camera=<id>`; with none, a chooser (stores the person may see, then their groups); the wall shows up to 16 tiles per page (4 by 4; layout buttons 1, 2x2, 3x3, 4x4), page controls, tile click opens the same camera in a large view with `kind: 'main'`. `LiveTile` is a client component rendering go2rtc's `<video-stream mode="mse" src="<ws gateway>/g/ws?token=…">` (the script `…/g/video-stream.js` is loaded once as a module from `NEXT_PUBLIC_STREAM_GATEWAY_URL`), shows the camera name, store code, and an `Offline`/`Live` badge (from Plan 2 status), pauses when the tab is hidden and refreshes the token before it expires. `types/custom-elements.d.ts` declares the `video-stream` JSX element. If the gateway or go2rtc is unavailable the tile says "Video is not available right now." and keeps trying every 30 seconds.

- [ ] Tests first (`tests/integration/open-streams.test.ts` with a fake go2rtc HTTP server on loopback, the fixtures, and a real vault password): a viewer asking for cameras of two stores gets only the visible ones, and the fake go2rtc received exactly those registrations with the right RTSP URLs (check path and encoded credentials on the server side only); the response JSON contains no password and no `rtsp://`; tokens verify with the right claims (`u`, `c`, `k`, `exp` about 600 s ahead); more than 36 ids refused; no secret configured refused; one registration failing (fake returns 500 for one name) still opens the others; none opening gives the plain error; with `DEMO_VIDEO=1` and a loopback store the registered `src` starts with `exec:ffmpeg`; main kind uses `…01`.
- [ ] Implement, check the page by starting `npm run dev` (signed out redirect only), run all checks. Commit `feat: live wall with authorised streams`.

---

### Task 6: Recording search on the NVR

**Files:** Create `lib/nvr/playback.ts`; modify `lib/nvr/client.ts` (add `post(path, xml)`), `tests/helpers/fake-servers.ts` (fake NVR learns the search, daily and download endpoints); test `tests/unit/playback.test.ts`.

**Interfaces:**
```ts
export type Segment = { start: Date; end: Date }
export function buildSearchBody(o: { channel: number; start: Date; end: Date; position: number; limit: number; searchId: string }): string
export function parseSearchResult(xml: string): { segments: Segment[]; more: boolean }
export function parseDailyDistribution(xml: string): number[]            // days of the month with recordings
export async function findSegments(client: NvrClient, o: { channel: number; day: string /* yyyy-mm-dd */; offsetMin: number }): Promise<Segment[]>   // paged until no more, instants converted to true UTC
export async function recordedDays(client: NvrClient, o: { channel: number; year: number; month: number }): Promise<number[]>
```
`NvrClient.post(path, xml)` uses `digestFetch` with `method: 'POST'`, `Content-Type: application/xml`, same error mapping as `get`. ISAPI details (from the legacy app): search is `POST /ISAPI/ContentMgmt/search` with `<CMSearchDescription><searchID>…</searchID><trackIDList><trackID>{channel}01</trackID></trackIDList><timeSpanList><timeSpan><startTime>…Z</startTime><endTime>…Z</endTime></timeSpan></timeSpanList><maxResults>200</maxResults><searchResultPostion>N</searchResultPostion><metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>` (note the NVR's own spelling `searchResultPostion`); the answer holds `<searchMatchItem>` entries each with `<timeSpan><startTime>` and `<endTime>`, and `<responseStatusStrg>MORE</responseStatusStrg>` when more remain; the calendar is `POST /ISAPI/ContentMgmt/record/tracks/{channel}01/dailyDistribution` with `<trackDailyParam><year>Y</year><monthOfYear>M</monthOfYear></trackDailyParam>`, the answer has `<day><dayOfMonth>D</dayOfMonth><record>true</record></day>` blocks. NVR times are local to the NVR; the UTC instant is `nvrTime - offsetMin`; the query window for a local day `d` is `[d 00:00 - offset, d+1 00:00 - offset)`.
- [ ] Tests first: body builder (exact element names and `Z` times); parse a two-segment answer with and without MORE; daily distribution (only `true` days); `findSegments` against the fake NVR over two pages (fake returns `MORE` for the first page by `searchResultPostion`) with `offsetMin = 330`, giving UTC instants shifted back by 330 minutes; `recordedDays`; an NVR error maps like `get`.
- [ ] The fake NVR (`startFakeNvr`) gains `recordings?: { start: string; end: string }[]` option (ISO strings in NVR-local terms), serving the three endpoints above (search honours `searchResultPostion` and a page size of 2 for tests; daily distribution derives days from `recordings`; `/ISAPI/ContentMgmt/download` (POST) returns 200 with a small fixed byte payload and records the request body). Commit `feat: NVR recording search and calendar`.

---

### Task 7: Playback screen

**Files:** Create `lib/actions/playback.ts`, `lib/streams/playback.ts`, `components/live/PlaybackView.tsx`, `app/(app)/playback/page.tsx`; modify `lib/streams/gateway.ts` only if the `pb` kind needs anything beyond Task 4 (it should not), nav (item "Playback"); test `tests/integration/playback-streams.test.ts`.

**Interfaces:**
```ts
// lib/streams/playback.ts
export async function listRecordedDays(deps: { rls: AdminClient; admin: AdminClient; nvr: (ep: NvrEndpoint) => NvrClient }, actor, cameraId: string, year: number, month: number, offsetMin: number): Promise<Result<{ days: number[] }>>
export async function listDaySegments(deps, actor, cameraId: string, day: string, offsetMin: number): Promise<Result<{ segments: { start: string; end: string }[] }>>   // ISO UTC strings
export async function openPlayback(deps: { rls; admin; go2rtc: Go2rtcClient; now?: () => number; env? }, actor, cameraId: string, start: Date, minutes: number, offsetMin: number): Promise<Result<{ token: string; name: string }>>
```
Behaviour: the camera must be visible through `rls` (else "Camera not found."); the NVR is asked with the store's credentials; `openPlayback` limits `minutes` to 1..60, registers `pb_<camera>_<startEpoch>` with `buildPlaybackUrl` and returns a token of kind `pb` (`s`, `e` set, lifetime 600 s). Actions wrap these with `requireProfile()`, `PLAYBACK_OFFSET_MIN`, the rate limit and the plain error mapping from `describeNvrError`. Page `/playback`: choose a store then a camera (only visible ones), a calendar of the month with recorded days marked (month navigation), a 24-hour timeline bar of the day's segments (IST labels), click or drag on the bar to pick a start time, "Play 10 minutes" (length select 5/10/30/60); the player is a `video-stream` like the live tile. Plain empty states ("No recordings on this day.", "The NVR did not answer.").
- [ ] Tests first against the fake NVR and fake go2rtc: invisible camera refused; days and segments shown for a visible camera; `openPlayback` registers a `tracks/…01?starttime=…&endtime=…` URL on the fake go2rtc with the offset applied, returns a `pb` token whose claims verify, and clamps `minutes`; NVR down gives the plain NVR message. Implement, run all checks. Commit `feat: playback by day and time`.

---

### Task 8: Fast playback and short clips (needs ffmpeg)

**Files:** Create `lib/streams/vod.ts`, `app/api/vod/route.ts`; modify `.env.example` (`FFMPEG`), `proxy.ts` (nothing: the route needs a session), test `tests/integration/vod.test.ts`.

Behaviour: `GET /api/vod?camera=<id>&start=<ISO>&minutes=<1..30>` for a signed-in person who may see the camera: finds the first recording segment covering the start (via `findSegments`), asks the NVR to download that span (`POST /ISAPI/ContentMgmt/download` with `<downloadRequest><playbackURI>…</playbackURI></downloadRequest>`), pipes the bytes through `ffmpeg -loglevel error -i pipe:0 -an -c:v copy -movflags frag_keyframe+empty_moov+default_base_moof -flush_packets 1 -f mp4 pipe:1` and streams `video/mp4` to the browser (so the browser's `<video>` can play it at 2x, 4x, 8x). It kills ffmpeg when the client disconnects, limits to 1 running conversion per person and 8 in total (429 beyond), and returns plain JSON errors (404 no recording, 502 NVR problem, 500 "ffmpeg is not installed on the server" when the binary is missing). The Playback screen gets a speed select (1x uses go2rtc; 2x/4x/8x use this route). The route reads `FFMPEG` (default `ffmpeg`).
- [ ] Tests: unit-test the argument builder and the concurrency limiter; the end-to-end integration test (fake NVR whose download endpoint serves a tiny valid MP4 generated by ffmpeg once in the test setup) runs only when `ffmpeg -version` works and is reported as skipped otherwise (`it.skipIf`); in any case the route returns the plain 500 JSON when `FFMPEG` points at a missing binary, and 404 for an invisible camera. Commit `feat: fast playback through ffmpeg`.

---

### Task 9: Wire-up, demo mode and checks

**Files:** modify `README.md` (live video section: `npm run stack:up`, `npm run gateway`, `DEMO_VIDEO=1`, ports, what is needed on the server: Docker image, optional ffmpeg), `.env.example`, `scripts/seed-demo.ts` (nothing new needed; demo stores already use loopback), `package.json` (script `demo:all` documenting the order is optional).
- [ ] Run all checks; `npm run build` must pass. With the Docker go2rtc up, `npm run gateway` and `npm run dev` running and `DEMO_VIDEO=1` in `.env.local`, verify with curl that `/g/health` answers and that a signed token (generated by a one-line `tsx` script from the secret in `.env.local`, printing nothing but the HTTP result) lets a WebSocket client connect and receive binary frames from a generated test stream of a demo camera. Record the result in the report. Commit `docs: live video setup and demo mode`.

---

## Plan self-review

Spec section 8 (tokens, gateway, access) is covered by Tasks 3 to 5; section 9 playback and fast playback by 6 to 8 (backup and reports are Plan 4); camera groups (legacy feature) by 1 and 2. Security rules from the spec and the Plan 1 review are explicit: tokens bound to one person, camera and kind; stream name derived server-side; no credentials to browsers; origin check; short lifetimes; rate limits; visibility checks through row-level security. Known limits: real camera video and the NVR's playback cannot be tested here (the demo uses generated video; the NVR side is tested against a fake NVR), and fast playback needs ffmpeg on the web server.
