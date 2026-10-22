# CityKart Drishti — Initial Audit (facts)

Audit date: 2026-10-22. Auditor: lead auditor (independent, read-only on source).
Directive audited against: `docs/drishti/REQUIREMENTS-DIRECTIVE.md` (owner directive, 2026-10-22).
Companion document: `docs/audit/REWORK-PLAN-PROPOSAL.md` (section 9: plan, decisions, risks, traceability).

Method: every migration, rollback, Server Action, the access, stream, gateway, monitoring and worker modules, the deploy files, the plans, the spec, the architecture document and both SDD ledgers were read in full or in the parts cited. Test files were inventoried and their test names read; test bodies were read only where cited. No server, worker, gateway, Docker command or test suite was run (instruction). `.env*` files were not read. Line numbers refer to the working tree at the time of the audit.

Status words used: **Verified** (code and, where named, tests match the claim), **Partially** (true with a material caveat), **Not found** (no code), **Contradicted** (code does something else).

---

## 1. Repository and git state

### 1.1 Branches and commits

| Item | Fact |
|---|---|
| Current branch | `feat/plan-3-live-feeds` (HEAD `2b5dc2f`) |
| Stack | `main` (2 docs commits) → `feat/plan-1-foundation` (+23 commits) → `feat/plan-2-monitoring` (+25) → `feat/plan-3-live-feeds` (+20 commits incl. docs) |
| Remote | none configured for push; nothing pushed or merged (ledgers and git confirm) |
| Plan 3 progress (ledger `.superpowers/sdd/2026-10-22-plan-3-live-feeds/progress.md`) | Tasks 1–7 complete and reviewed (last: `2b5dc2f`, 774 unit / 290 integration passing at that commit per ledger). Task 8 (fast playback through ffmpeg) is being built now; Task 9 (wire-up/demo) not started |

### 1.2 Uncommitted and untracked work (a builder is active in the tree)

Modified: `lib/nvr/client.ts` (+152 lines: `postStream` download with byte/time caps), `lib/streams/playback.ts` (exports `findCamera`, `startInBounds`), `tests/helpers/fake-servers.ts`.
Untracked: `app/api/vod/route.ts`, `lib/streams/vod.ts`, `lib/streams/speed.ts`, `components/live/FastPlayer.tsx` (appeared during the audit), `tests/helpers/fake-ffmpeg.mjs`, `tests/helpers/fake-spawn.ts`, `tests/unit/nvr-post-stream.test.ts`, `tests/unit/vod.test.ts`, `tests/integration/vod.test.ts` (appeared during the audit), `docs/drishti/` (the directive), `public/brand/` (logo set).
The tree changed while the audit ran. Findings on Task 8 code describe the state at about 10:50 IST. At the end of the audit Task 8 had been committed as `3fc5c1f feat: fast playback through ffmpeg` (same permission model: camera visibility only). A parallel session had also created `docs/design/ASSET-MANAGEMENT-DESIGN-REFERENCE.md` and `docs/design/reference-screenshots/` (not reviewed in this audit).

### 1.3 Documents read

`AGENTS.md`/`CLAUDE.md` (Next 16 warning only), `README.md`, spec `docs/superpowers/specs/2026-10-21-network-monitoring-hub-design.md`, plans 1–8 and `plan-1-carryover.md`, `docs/ARCHITECTURE-AND-DESIGN-FOR-REVIEW.md`, migrations `20261021000001`–`…0007` and all seven rollbacks, `supabase/config.toml`, `supabase/seed.sql`, ledgers `.superpowers/sdd/2026-10-22-plan-2-monitoring/progress.md` and `…plan-3-live-feeds/{progress,constraints,task-8-brief,task-9-brief}.md`.

Deferred items recorded in the ledgers and still open (relevant to the directive):

- Column-level grants on `stores` (`nvr_ip`, `nvr_username`, `nvr_secret_id`) were listed in `plan-1-carryover.md` as "Before live feeds (Plan 3)". **Not done** (see 4.6).
- `SECURITY DEFINER` functions pin `search_path = public` (or `public, vault` / `public, auth`), not `pg_temp`-safe; carried to Plan 4.
- `privilege_violations()` covers relations only (not function EXECUTE, sequences, global default ACL) — Plan 2 ledger, Task 1.
- Worker guard race windows; lease column "planned hardening" (Plan 2 ledger, Task 8).
- Late-result protection is per-process only (`at < last_checked_at` guard not in SQL) — Plan 2 ledger, Task 7.
- Back-off state lost on worker restart (in-memory).
- Outage end reason `switched_off`; devices of a switched-off store still checked (Plan 2 follow-ups).
- `TRUSTED_PROXY_HOPS` unset means the sign-in lock-out counter is shared by all clients (anyone can lock out an e-mail for 15 min) — carry-over Plan 4.
- `admin_audit_log` is mutable by `service_role`; "hash-chained system_log replaces it" (Plan 4, not built).
- Plan 4 CSP must include the gateway origin in `script-src`/`connect-src` (Plan 3 ledger M9).

---

## 2. Verification of the "BUILT" claims in `docs/ARCHITECTURE-AND-DESIGN-FOR-REVIEW.md`

| # | Claim (doc section) | Status | Evidence |
|---|---|---|---|
| 1 | Server Actions check the caller first, then call a service returning `Result` (§2) | **Verified, with caveat** | All actions in `lib/actions/**` call `requireProfile()`/`requireAdmin()` first. Caveat: stream, playback and VOD entry points check only "signed in"; authorisation is delegated entirely to RLS visibility of the camera row (`lib/actions/streams.ts:18`, `lib/actions/playback.ts:35,47,59`, `app/api/vod/route.ts:21-23`). There is no action-level permission (live vs playback vs export) |
| 2 | Two Supabase clients; admin writes org-scoped; `assertRefsInOrg` before FK writes (§2) | **Verified** | `lib/security/org-scope.ts`; used in `lib/admin/users.ts:62,105`, `lib/inventory/devices.ts:16`; RPC `replace_user_access` re-checks org (`0002:244-264`) |
| 3 | IST display through one helper; UTC storage (§2) | **Verified** | `lib/time.ts`, `tests/unit/time.test.ts`. Playback uses a separate "shown time" convention (a fake-UTC instant whose UTC fields are IST wall clock), `lib/streams/playback.ts:16-18` |
| 4 | Raw DB messages never reach UI; logger redacts secrets (§2) | **Verified** | `lib/observability/sanitize-error.ts`, `lib/observability/logger.ts:3-16` (key-name redaction), `mask.ts` (pattern redaction). Stream/playback errors log only the error kind |
| 5 | One secret per purpose, ≥16 chars (§2) | **Partially** | `lib/secrets.ts:11-23,30-46`. But the proxy's verified-user header HMAC uses `SUPABASE_SERVICE_ROLE_KEY` as its key (`lib/auth/verified-user.ts:10`), i.e. the service key is reused for a second purpose |
| 6 | Default privileges closed; explicit REVOKE/GRANT; `privilege_violations()` asserted empty (§2) | **Partially** | `0004:7-11` closes defaults; every later migration grants explicitly. `privilege_violations()` (`0004:14-38`) inspects table/view ACLs only — not function EXECUTE, sequences, or the global (namespace-less) function default; asserted in `tests/integration/hardening.test.ts:28` |
| 7 | Numbered migrations with rollback scripts (§2) | **Verified** | 7 migrations, 7 rollbacks (`supabase/rollback/*`). Rollback 0004 re-opens default privileges; rollback 0005 drops monitoring history tables (destructive by design); rollbacks do not delete `nvr:%` Vault secrets (carry-over) |
| 8 | Ports: app 3212, gateway 3213, go2rtc 1984/8555 loopback, Supabase 55321-55324 (§3) | **Verified, with caveat** | `package.json` scripts; `deploy/docker-compose.dev.yml:24-27`; gateway binds `0.0.0.0` (`services/gateway/index.ts:541`); `next dev` currently listens on `::` (all interfaces, see §8) |
| 9 | App and worker use PostgREST only, never direct Postgres (§3) | **Verified** | No `pg` dependency (`package.json`); all DB access via supabase-js. Consequence: no `LISTEN/NOTIFY` path for revocation; Supabase Realtime is excluded from `db:start` |
| 10 | Tables `organizations … camera_group_items` (§4) | **Verified** | Migrations 0001-0007 |
| 11 | Same-organisation integrity by composite FKs `(id, org_id)` (§4) | **Verified** | `0002:28,33-37,51,67,77-93`; `0007:18-19`. Exception: `check_state`/`outages` target ids are not FKs (polymorphic), `0005:63` |
| 12 | `store_status` security-invoker view; `targets_uptime` excluding gaps and pre-first-check time (§4) | **Verified** | `0006:148-165`, `0005:152-187`; tests `monitoring-db.test.ts:140-184`, `status-queries.test.ts` |
| 13 | Vault RPCs service-role only (§4) | **Verified** | `0002:205-241,266-269`, `0004:53-75`; `tests/integration/inventory-rls.test.ts:220`, `negative-rls.test.ts:42` |
| 14 | Roles `user, agent, manager, admin, platform_owner`; manager sees everything read-only (§5) | **Verified** (and conflicts with directive) | `0001:4`; `is_staff_all()` `0002:114-117`; `lib/admin/roles.ts:14` |
| 15 | Stores visible = direct, zone, own store, stores of an individually granted camera; manager+ all (§5) | **Verified** (conflicts with directive) | `granted_store_ids()` `0002:120-129` (includes `profiles.store_id`), `visible_store_ids()` `0002:131-140`; tests `inventory-rls.test.ts:108,114,126,144` |
| 16 | Cameras visible = individual grants + cameras of granted stores unless individual grants exist in that store (§5) | **Verified** (this is the "hidden grant" behaviour) | `visible_camera_ids()` `0002:142-156` (`NOT IN` narrowing at :153-155); test `inventory-rls.test.ts:132` asserts the narrowing |
| 17 | Devices visible = devices of granted stores; camera-only grant does not reveal devices; storeless devices manager+ only (§5) | **Verified** (store/zone/home-store grant DOES reveal IT devices) | `visible_device_ids()` `0002:158-163`; tests `inventory-rls.test.ts:120,126` |
| 18 | `must_reset_password` ⇒ no org/role in RLS; no public sign-up; sessions revoked on reset and deactivation (§5) | **Verified** | `0001:44-52`; `supabase/config.toml` `enable_signup = false`; `lib/admin/users.ts:112-127,143-148`; `0003`; tests `users-admin.test.ts:164,189,213`, `identity-rls.test.ts:43`, `negative-rls.test.ts:27` |
| 19 | Server-only tables have read policies and no write grants for people (§5) | **Verified** | `0005:207-237`; `worker_state` and `monitor_gaps` have no policy and no grant for `authenticated` (service only) |
| 20 | Camera groups: visible if ≥1 visible camera / creator / sees-all; operators+admins create; only visible cameras added; delete = creator or admin (§5) | **Verified** | `0007:28-37`; `lib/groups/service.ts:72-82,100-121`; `lib/admin/roles.ts:20`; `tests/integration/groups.test.ts:89-382` |
| 21 | Sign-in flow: proxy verifies session once, signed user-id header always overwritten, exact public allow-list (§6.1) | **Verified** | `proxy.ts:6-7,16-22,49-54`; `lib/auth/verified-user.ts`; `tests/unit/verified-user.test.ts` |
| 22 | Admin write flow with zod, assertRefsInOrg, audit row (§6.2) | **Verified, with caveat** | `lib/admin/users.ts`, `lib/inventory/*`. Audit is best effort: a failed audit insert is only logged (`lib/admin/audit.ts:15-23`) |
| 23 | Live video flow: rate limit 30/min/person, ≤36 ids, RLS read, one Vault read per store, stream name from token, token `{u,c,k,exp=now+600}` (§6.3) | **Verified** | `lib/actions/streams.ts`, `lib/streams/open.ts:44-110`, `lib/streams/request-limit.ts:7-13`, `lib/streams/token.ts`; `tests/integration/open-streams.test.ts` (22 tests), `tests/unit/stream-token.test.ts` (33) |
| 24 | Token = base64url(JSON).HMAC-SHA256('stream.v1.'+payload), lifetime enforced, ≥16-char secret, exact key set, never throws (§6.3, §8) | **Verified** | `lib/streams/token.ts:22-78` |
| 25 | Gateway: exact Origin, HMAC token, close 1008 before upstream, message allow-list, limits 240/min/IP, 100/IP, 300 total, 4 MB, backpressure, go2rtc error text replaced (§6.3) | **Verified** | `lib/streams/gateway.ts:48-58,74-82,142-153,288-341`; `tests/integration/gateway.test.ts` (36 tests). Gateway performs **no database or permission check** and has no revocation path |
| 26 | Session ends ≤30 min (§6.3) | **Verified** | `gateway.ts:48,362`. With a 10-min token + 60 s clock skew, a socket can stay open ~41 min after the permission that minted it was removed |
| 27 | go2rtc confirm-by-GET, skip identical re-register, prune idle `cam_*`/`pb_*` only without consumers (§6.3) | **Verified (by code outline and tests)** | `lib/streams/go2rtc.ts:93-266`; `tests/unit/go2rtc-client.test.ts` (45), `go2rtc-inspect.test.ts` (6) |
| 28 | Demo video only with `DEMO_VIDEO=1`, non-production, loopback store (§6.3) | **Verified** | `lib/streams/source.ts:64-69`; tests `open-streams.test.ts:299,320` |
| 29 | Playback: "search/calendar BUILT, screen being built" (§6.4) | **Contradicted (doc is out of date)** | Search/calendar (`lib/nvr/playback.ts:20-22,138-206`) and the playback screen (`app/(app)/playback/page.tsx`, `components/live/PlaybackView.tsx`, `lib/streams/playback.ts`) are both committed and reviewed (`fe3339f`, `2b5dc2f`). Fast playback (Task 8) is the part in progress, uncommitted |
| 30 | Recording paging guards ≤50 pages, ≤5000 segments, `truncated`/`skipped` (§6.4) | **Verified** | `lib/nvr/playback.ts:20-22,105-178`; `tests/unit/playback.test.ts` (61), `playback-streams.test.ts:298,304` |
| 31 | `PLAYBACK_OFFSET_MIN` handles NVR clocks (§6.4) | **Partially** | One global env value for all NVRs (`lib/actions/playback.ts:25`, `lib/streams/playback.ts:77-87`); no per-NVR offset, no drift measurement |
| 32 | Monitoring methods/intervals: TCP/ICMP 60 s, NVR TCP to RTSP port 60 s, cameras ISAPI + RTSP DESCRIBE 300 s (§7.1) | **Verified** | `lib/monitor/checks.ts:64-122,184-324`; `lib/monitor/config.ts:21-33` |
| 33 | ICMP success needs TTL= and exit 0 (§7.1) | **Verified** | `lib/probes.ts:~99-140`; `tests/unit/probes.test.ts` (18) |
| 34 | State machine: down after 2 failures, up on first success, outage starts at first failure, NVR down ⇒ cameras down at once with `cause='nvr_down'`, gap discards stale run, inactive ignored, service role only (§7.2) | **Verified** | `0006:28-106`; `lib/monitor/checks.ts:188-196` (cameras sent `ok:false`, threshold 1, cause `nvr_down`); tests `monitoring-db.test.ts:51-98`, `monitoring-fixes-db.test.ts:39-163` |
| 35 | "Inputs from the caller are validated (uuid shape, known types)" (§7.2) | **Partially** | Validation is in TypeScript (`lib/monitor/supabase-db.ts`, test `monitor-db-fixes.test.ts:131,143`). The SQL function casts `(r->>'id')::uuid` without a guard (`0006:44`): a malformed element raises and aborts the whole batch; unknown types are skipped |
| 36 | Per-target serialisation; store pool 10 (§7.3) | **Verified (per process only)** | `lib/monitor/checks.ts:23-38` (in-memory lanes keyed by db object); no SQL `at < last_checked_at` guard |
| 37 | Heartbeat every 5 s on own timer; silent periods recorded as gaps (§7.3) | **Verified** | `lib/monitor/config.ts:23`, `runner.ts:224-317`, `supabase-db.ts:143-170`; `monitor-db.test.ts:137` |
| 38 | Check-now stamped by DB clock, 30 s cooldown, roles operator/admin/owner (§7.3) | **Verified** | `0006:18-21`; `lib/monitor/check-now.ts:10-53`; `lib/admin/roles.ts:17`; `tests/integration/check-now.test.ts` |
| 39 | NVR login problems: no camera results, 15-min back-off (§7.3) | **Verified (in-memory only)** | `lib/monitor/checks.ts:144-179,209,305-311`; `tests/unit/monitor-backoff.test.ts` (11) |
| 40 | Single-worker start-up guard heartbeat-based with documented races (§7.3) | **Verified** (this is the design the directive rejects) | `lib/monitor/guard.ts:98-131`; `services/worker/index.ts:47-68`. No lease, owner column or fencing token; `worker_state` is a single global row (`0005:41-50`) |
| 41 | Status words Live / Offline / Not checked yet / Not checked lately; uptime excludes gaps; stopped monitor shows "No data" (§7.3) | **Verified** | `lib/queries/status.ts:40-66`; `lib/monitor/uptime.ts:275-313`; `components/monitor/MonitoringBanner.tsx` |
| 42 | Camera discovery upserts on `(store_id, channel)` keeping ids; keeps names on placeholders; camera IPs never probed (§7.4) | **Verified** | `lib/monitor/discovery.ts:48-68`; worker probes only via the NVR (`checks.ts:259-266`); `tests/integration/discovery.test.ts` |
| 43 | No Basic authentication anywhere; Digest only (§8) | **Verified** | `lib/nvr/digest.ts` (`DigestUnsupportedError`), ruling R6; `tests/unit/digest.test.ts` (17) |
| 44 | Egress guard refuses non-loopback TCP and ping/tracert in tests (§8) | **Verified** | `tests/setup/egress-guard.ts:1-17,41-50,88`; UDP, dns.* and custom `lookup` not covered (documented); `tests/unit/egress-guard.test.ts` |
| 45 | `SECURITY DEFINER` functions pin `search_path` (§8) | **Partially** | Pinned to `public` (+`vault`/`auth`), not `pg_catalog, public, pg_temp` or `''` (carry-over item) |
| 46 | Rate limits on logins, admin actions, import, stream opening (§8) | **Partially** | Logins (`lib/actions/auth.ts:27-36`), forgot-password, check-now, stream/playback/VOD (in-process `Map`s: `lib/rate-limit.ts:4`, `lib/streams/limiter.ts`, `lib/streams/vod.ts:381-416`). **Admin actions and import have no rate limit** (`lib/actions/admin/*.ts`) |
| 47 | CSV exports neutralise `= + - @` (§8) | **Not found in this repo** | No CSV/Excel export exists yet (reports are Plan 4); only CSV import exists (`lib/import/*`) |
| 48 | CSP: PLANNED (§8) | **Verified as absent** | `next.config.ts:18-30` sets nosniff, X-Frame-Options, Referrer-Policy, Permissions-Policy, HSTS-if-https; no Content-Security-Policy anywhere |
| 49 | Tests ≈730 unit / ≈240 integration (§9) | **Partially** | Ledger at `2b5dc2f`: 774 unit / 290 integration. Static count of `it(`/`test(` declarations now (incl. uncommitted Task 8 files): 689 unit / 325 integration (each `it.each` counted once). Suites were not run in this audit |
| 50 | Repository map (§14) | **Verified** | Matches tree; plus uncommitted Task 8 files |

Summary: the BUILT claims are substantially accurate as engineering statements. The material problems are not false claims but **design choices that the directive now rejects** (rows 14-17, 25-26, 31, 40, 48) and a few overstatements (rows 5, 6, 35, 45, 46, 47) plus one stale status (row 29).

---

## 3. System map

### 3.1 Page routes (`app/**`)

| Route | Guard | Data client | Notes |
|---|---|---|---|
| `/` | — | — | redirect `/home` |
| `/login`, `/forgot-password` | public (`proxy.ts:6`) | RLS | `LoginForm.tsx`; brand text from `lib/brand.ts` ("CityKart Network Hub"); no logo image used anywhere |
| `/reset-password` | allowed signed-out (`proxy.ts:45`) | — | redirect to `/change-password` |
| `/change-password` | `getCurrentProfile()` | RLS + admin (clears flag) | forced first-login change |
| `/auth/callback` (route) | public-ish (`proxy.ts:28`) | RLS | exchanges reset code, `safeNext` |
| `(app)/layout` | `requireProfile()` | — | `AppShell` (Sidebar, MobileNav, ThemeSwitcher, NewVersionBanner) |
| `/home` | `requireProfile()` | RLS; admin for uptime/worker state | dashboard (`getDashboard`), Check-now for `canRunChecks` |
| `/stores`, `/stores/[id]` | `requireProfile()` | RLS; admin for uptime | store detail lists cameras **and devices** of a visible store |
| `/devices` | `requireProfile()` | RLS; admin for uptime | any person with a store/zone/home-store grant sees that store's IT devices with IP:port |
| `/live` (`?store|group|camera`) | `requireProfile()` | RLS | live wall, 36/page |
| `/playback` | `requireProfile()` | RLS | calendar + day timeline + player; (Task 8 adds speed select / FastPlayer) |
| `/groups`, `/groups/[id]` | `requireProfile()`; edit UI for `canManageGroups` | RLS | |
| `/admin/users`, `/admin/users/[id]/access` | `requireAdmin()` | admin | access editor (stores, zones, cameras) |
| `/admin/stores`, `/admin/devices`, `/admin/import`, `/admin/monitoring` | `requireAdmin()` | admin | NVR IP shown to admins (`admin/stores/page.tsx:39`) |
| `error.tsx` | — | — | generic error |

### 3.2 API routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | public | `{status, db, worker}` cached 2 s (`app/api/health/route.ts`) |
| `GET /api/version` | public | build id |
| `GET /api/vod` (uncommitted, Task 8) | session (`getCurrentProfile`) + RLS camera visibility | NVR download → ffmpeg → `video/mp4` stream; 1 per person / 8 total in-process; `probe=1` diagnostic |

### 3.3 Server Actions (`lib/actions/**`) and their checks

| Action | File | Check | Service |
|---|---|---|---|
| `signIn`, `signOut`, `forgotPassword`, `changePassword` | `auth.ts` | none / none / none / `getCurrentProfile` | GoTrue; failed-login limit 5 per 15 min per ip+e-mail (in-process) |
| `requestCheckNowAction` | `monitor.ts` | `requireProfile` + `canRunChecks` (agent/admin/owner) + 3/min | `lib/monitor/check-now.ts` |
| `createGroupAction`, `deleteGroupAction`, `addCamerasAction`, `addByKeywordAction`, `removeCameraAction` | `groups.ts` | `requireProfile` + `canManageGroups` (agent/admin/owner) | `lib/groups/service.ts` (re-checks role; delete = creator or admin) |
| `openStreamsAction`, `refreshStreamTokensAction` | `streams.ts` | `requireProfile` + 30/min | `lib/streams/open.ts` (RLS camera read) |
| `listRecordedDaysAction`, `listDaySegmentsAction`, `openPlaybackAction` | `playback.ts` | `requireProfile` (+ 60/min lookups, 30/min opens) | `lib/streams/playback.ts` (RLS camera read) |
| `saveStoreAction`, `deleteStoreAction`, `saveDeviceAction`, `deleteDeviceAction`, `importStoresAction`, `importDevicesAction` | `admin/inventory.ts` | `requireAdmin` | `lib/inventory/*`, `lib/import/*` |
| `discoverCamerasAction` | `admin/monitoring.ts` | `requireAdmin` | `lib/monitor/discovery.ts` |
| `createUserAction`, `setActiveAction`, `setRoleAction`, `resetPasswordAction`, `saveAccessAction` | `admin/users.ts` | `requireAdmin` + `canManageRole` in service | `lib/admin/users.ts` |

No action checks a capability distinct from "can see the camera row"; no action re-authenticates or requires MFA.

### 3.4 Services and libraries (`lib/**`)

- Identity/admin: `auth/{profile,verified-user,safe-next}`, `admin/{roles,users,audit,types}`, `security/org-scope`, `validation/password`, `secrets`, `secure-compare`, `rate-limit`.
- Inventory/import: `inventory/{stores,devices,schemas,device-types}`, `import/{csv,stores-csv,devices-csv,apply,regions,validators}`, `queries/inventory`.
- Monitoring: `monitor/{runner,checks,probes,guard,health,check-now,config,discovery,uptime,supabase-db,nvr-state,last-checked,failure-log,refresh-delay,types}`, `probes.ts`, `rtsp/describe`, `nvr/{digest,isapi,client,playback}`, `queries/status`.
- CCTV: `groups/{service,live-wall}`, `queries/{groups,live}`, `streams/{token,go2rtc,source,open,gateway,limiter,request-limit,playback,timeline,calendar,wall}`, uncommitted `streams/{vod,speed}`.
- Platform: `supabase/{server,admin,client,fetch-all,resilient-fetch}`, `observability/{logger,mask,sanitize-error}`, `async/pool`, `time`, `brand`, `nav`, `forms/submitted-values`, `utils`.

### 3.5 Background processes

| Process | Entry | Binds | Notes |
|---|---|---|---|
| Web app | `next dev --port 3212` / `next start --port 3212` | `::` (observed) | `output: 'standalone'` |
| Worker | `services/worker/index.ts` (`npm run worker`, tsx) | none | heartbeat guard; service-role key; all orgs |
| Gateway | `services/gateway/index.ts` (`npm run gateway`, tsx) | `0.0.0.0:3213`, plain HTTP/WS | stateless HMAC check |
| go2rtc | `deploy/docker-compose.dev.yml` (image `alexxit/go2rtc:1.9.9@sha256:7d31…`) | host `127.0.0.1:1984`, `127.0.0.1:8555/tcp+udp` | `cap_drop: ALL`, `no-new-privileges`, config `:ro` |
| go2rtc demo override | `deploy/docker-compose.demo.yml` + `go2rtc.demo.yaml` | adds in-container `127.0.0.1:8554` RTSP | dev only |
| Supabase | `supabase start` (Docker) | 55321-55324 (observed on `::`/`::1`) | GoTrue, PostgREST, Postgres 17, Vault, Studio, Inbucket |
| ffmpeg (optional) | spawned per VOD request from the web process | — | not installed on the dev host |
| Fake NVR / demo seed | `scripts/fake-nvr.ts`, `scripts/seed-demo.ts` | loopback | dev only |

### 3.6 External integrations

- **Hikvision ISAPI over HTTP Digest** (`lib/nvr/client.ts`): `InputProxy/channels/status`, `InputProxy/channels`, `System/Video/inputs/channels`, `ContentMgmt/search`, `ContentMgmt/record/tracks/<ch>01/dailyDistribution`, (uncommitted) `ContentMgmt/download`. No storage/HDD, recording-status, time/clock or deviceInfo calls.
- **RTSP**: DESCRIBE probe (`lib/rtsp/describe.ts`); live `Streaming/Channels/<ch>0{1,2}`; playback `Streaming/tracks/<ch>01?starttime&endtime` (`lib/streams/source.ts`).
- **go2rtc HTTP API** (`/api/streams` GET/PUT/DELETE, `/api/ws`, `/video-stream.js`, `/video-rtc.js`).
- **Supabase**: GoTrue (password auth, admin API, ban, reset e-mail), PostgREST, Vault (`vault.create_secret/update_secret/decrypted_secrets`), RLS.
- **TCP/ICMP** to devices (`ping.exe` absolute path).
- None yet: SMTP, Teams, WhatsApp, webhook, WinRM, SSH, SNMP, VNC, RDP, agents.

### 3.7 Environment variables (names only; from code and `.env.example`)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_STREAM_GATEWAY_URL`, `NEXT_PUBLIC_BUILD_ID`/`CK_BUILD_ID`, `TZ`, `CRON_SECRET`, `WORKER_SECRET`, `STREAM_TOKEN_SECRET`, `SYSTEM_LOG_INGEST_SECRET`, `DEVICE_CHECK_SEC`, `CAMERA_CHECK_SEC`, `FAIL_THRESHOLD`, `STORE_CONCURRENCY`, `NVR_LOGIN_BACKOFF_SEC`, `GO2RTC_URL`, `GATEWAY_PORT`, `GATEWAY_ALLOWED_ORIGINS`, `DEMO_VIDEO`, `PLAYBACK_OFFSET_MIN`, `FFMPEG` (Task 8), `TRUSTED_PROXY_HOPS`, `NODE_ENV`, dev-only `DEV_ADMIN_EMAIL`, `DEV_ADMIN_PASSWORD`, `FAKE_NVR_PORT`. `CRON_SECRET`, `WORKER_SECRET`, `SYSTEM_LOG_INGEST_SECRET` have no consumer yet.

### 3.8 npm scripts

`dev`, `build`, `start`, `lint`, `typecheck`, `test`/`test:unit`, `test:integration`, `db:start` (excludes logflare, vector, edge-runtime, realtime, imgproxy, supavisor), `db:stop`, `db:reset`, `db:types`, `env:local`, `worker`, `worker:dev`, `gateway`, `stack:up[:demo]`, `stack:down[:demo]`, `fake:nvr`, `demo:seed`. Note `tsx` is a devDependency used to run worker and gateway.

### 3.9 Test inventory (static count of `it`/`test` declarations; `it.each` counted once)

| Area | Unit files (tests) | Integration files (tests) |
|---|---|---|
| Identity, roles, RLS, admin, hardening | roles 6, nav 10, safe-next 6, verified-user 4, password 4, one-time-password 3, secrets 4, secure-compare 2, rate-limit 3, sanitize-error 3, mask-secrets 3, logger 2, submitted-values 4, api-routes 9 (≈63) | identity-rls 5, inventory-rls 15, negative-rls 4, users-admin 16, inventory-admin 7, hardening 6, password-policy 3, viewer-queries 7 (63) |
| Inventory import | csv 4, stores-csv 5, devices-csv 3, regions 4 (16) | — |
| Monitoring and NVR | monitor-* ×10 files (135), probes 18, rtsp 18, digest 17, isapi 13, nvr-client 41, status-* 13, last-checked 4, uptime-page 7, get-states 2, refresh-delay 2, pool 2, fetch-all 2, resilient-fetch 2, time 3 | check-now 9, discovery 8, health 2, health-rounds 1, monitor-db 10, monitor-db-fixes 7, monitor-login 2, monitoring-db 13, monitoring-fixes-db 13, status-queries 14, store-camera-failure 2, worker-run 5 (86) |
| CCTV, groups, streams, playback | go2rtc-client 45, go2rtc-inspect 6, stream-token 33, stream-source 25, streams-action 9, live-wall 10, groups-actions 9, groups-service 4, playback 61, playback-timeline 27, playback-actions 7; uncommitted nvr-post-stream 18, vod 42 | gateway 36, open-streams 22, groups 26, groups-queries 3, live-queries 5, playback-streams 49; uncommitted vod 35 |
| Test infrastructure | egress-guard 7, fake-servers 9, demo-tools 16, env-output 2 | — |
| **Totals** | 61 files, 689 declarations | 27 files, 325 declarations |

What the key tests truly assert (and will need to change under the directive):

- `inventory-rls.test.ts:108` manager sees everything; `:114` zone grant gives devices; `:120` store grant gives all cameras **and devices**; `:132` camera grants inside a granted store **narrow** it; `:144` a store login (home store) sees its own store without any grant.
- `open-streams.test.ts:220`, `playback-streams.test.ts:204`, `groups.test.ts:90`: manager sees/opens every camera.
- `check-now.test.ts:19`, `groups.test.ts:143`: role literal `agent`.
- No test anywhere asserts: playback denied while live allowed; export permission; grant expiry; revocation of an open stream; device invisibility for a store-grant CCTV user; multiple NVRs per location; parent-unknown states.

---

## 4. Permission audit (current model, precisely)

### 4.1 Roles

Enum `public.user_role = ('user','agent','manager','admin','platform_owner')` (`0001:4`). UI labels: Viewer, Operator, Manager, Administrator, Platform owner (`components/admin/UserRow.tsx:21`, `CreateUserForm.tsx:12`). Capability helpers (`lib/admin/roles.ts`):

- `isAdminRole` = admin | platform_owner.
- `canManageRole`: owner manages all; admin manages user/agent/manager.
- `SEES_EVERYTHING` = manager, admin, platform_owner (`:14`).
- `canRunChecks`, `canManageGroups` = agent | admin | owner (`:17,:20`).

Roles conflate organisational authority, data scope (manager = global) and actions. There is no capability concept and no IT/CCTV separation.

### 4.2 Grant tables

`user_store_access(user_id, store_id)`, `user_zone_access(user_id, zone text)`, `user_camera_access(user_id, camera_id)` (`0002:72-94`). No `id`, no `capability`, no `valid_from/valid_until`, no `revoked_at`, no `created_by`/reason, no history (replace = delete + insert, `replace_user_access` `0002:244-264`). Camera deletion cascades grants (`ON DELETE CASCADE`), so grant history is lost when a camera row is deleted.

### 4.3 Visibility functions (actual SQL)

- `is_staff_all()` = `current_user_role() IN ('manager','admin','platform_owner')` (`0002:114-117`).
- `granted_store_ids()` = stores in org where id ∈ store grants **OR zone ∈ zone grants OR id = profiles.store_id** (`0002:120-129`). **The profile's home store is a full grant**, invisible in the access editor (the editor shows only the three grant tables, `components/admin/AccessEditor.tsx`).
- `visible_store_ids()` = all (staff) ∪ granted ∪ stores of individually granted cameras (`0002:131-140`).
- `visible_camera_ids()` = all (staff) ∪ individually granted cameras ∪ cameras of granted stores **except stores in which the person has any individual camera grant** (`0002:142-156`). This is the hidden narrowing: adding one camera of store S to a person who holds a store grant (or zone grant, or home store) for S silently reduces them from all cameras of S to that one camera. The editor's help text says so (`AccessEditor.tsx:47-48`), but no preview shows the effect.
- `visible_device_ids()` = all (staff) ∪ devices whose `store_id ∈ granted_store_ids()` (`0002:158-163`). **Any store, zone or home-store grant reveals every IT device of that store (name, type, IP, port, status, uptime).** A camera-only grant does not.
- All are `STABLE SECURITY DEFINER`, executable by `authenticated` (`0002:165-168`), evaluated per query via `id IN (SELECT …)` in policies (`0002:180-185`).

### 4.4 What each person type can see today

| Person | Stores | Cameras | IT devices | Monitoring status/outages | Profiles |
|---|---|---|---|---|---|
| Viewer/operator, no grants, no home store | none | none | none | none | own row |
| Viewer with home store S only | S | all of S | **all devices of S** | of S | own |
| Viewer with store grant S | S | all of S | **all devices of S** | of S | own |
| Viewer with zone grant Z | all stores in Z | all cameras in Z | **all devices in Z** | of Z | own |
| Viewer with store grant S + 1 camera grant in S | S | **only that camera** (hidden narrowing) | all devices of S | of S's visible items | own |
| Viewer with camera grants only (S1 c1, S2 c5) | S1, S2 (row incl. `nvr_ip`, `nvr_username`, `nvr_secret_id` columns) | c1, c5 | none | NVR status of S1, S2; cameras c1, c5 | own |
| Manager | all | all (live, playback, VOD) | all incl. storeless | all | **all profiles of org** (`0001:66-67`) |
| Admin / owner | all | all | all | all + audit log | all |

### 4.5 Camera groups

Groups are visible to staff-all, the creator, or anyone seeing ≥1 member camera (`0007:28-34`); items are filtered by `visible_camera_ids()` (`0007:36-37`); counts in lists come from RLS-filtered items (`lib/queries/groups.ts:177-193`). Groups do **not** expand access (verified: live wall group scope uses RLS reads only, `lib/queries/live.ts:271-277`). Residual leaks: group **name** and `created_by` are visible to anyone who sees one member; a creator sees a group name even after losing all its cameras; duplicate-name error reveals hidden group names (ledger, deferred).

### 4.6 Column exposure

`GRANT SELECT` on whole tables (`0002:199-200`): any person who can see a store row can read `stores.nvr_ip`, `rtsp_port`, `http_port`, `nvr_username`, `nvr_secret_id` (Vault id) directly through PostgREST with their own JWT; cameras expose `camera_ip`; devices expose `ip`/`tcp_port`. Vault contents are not readable. The stream and playback services rely on this: they read NVR address/user through the **RLS client** (`lib/streams/open.ts:55-60`, `lib/streams/playback.ts:94-100`), so a column-grant fix requires changing those reads.

### 4.7 Which server operations check what

| Operation | Check | Capability distinction |
|---|---|---|
| Open live streams (sub/main) | signed in; camera visible via RLS; store active | none (sub vs main not separately permitted) |
| Token refresh (every 8 min) | same as open (re-evaluated, so a removed grant stops renewal) | none |
| Gateway WebSocket connect | Origin + HMAC token validity only | no DB check, no user status check |
| Recording calendar/day search | signed in; camera visible | none (= live) |
| Open playback | signed in; camera visible | none (= live) |
| Fast playback `/api/vod` (uncommitted) | signed in; camera visible | none; returns a savable `video/mp4` = de facto export without an export permission |
| Thumbnails / snapshots | not implemented | — |
| Clip export / download jobs | not implemented | — |
| Check now | role agent/admin/owner | global (all orgs' targets in one worker) |
| Camera groups writes | role agent/admin/owner; added cameras must be visible | — |
| Discovery, inventory, import, users, access | admin/owner | — |
| Device list, store detail, dashboard | signed in; RLS | CCTV grant reveals IT devices |

### 4.8 Session revocation today

- Deactivation: profile `is_active=false` → GoTrue ban 100 years → `revoke_user_sessions` deletes `auth.sessions` and refresh tokens (`lib/admin/users.ts:110-127`, `0003`). RLS stops returning data immediately because `current_org_id()` requires `is_active` (`0001:44-47`). Page loads fail at the next request (`getCurrentProfile` returns null for inactive, `lib/auth/profile.ts:32`).
- Password reset: sessions revoked (`users.ts:143-148`).
- **Role change, grant change, home-store change: no session revocation and no stream revocation** (`users.ts:91-131,153-171`). RLS reflects the change on the next query.
- **Open video**: the gateway never re-checks. A live/playback socket stays open until it ends itself (≤30 min, `gateway.ts:48`). A token minted just before revocation can still open a new socket within its 10-minute validity (+60 s skew) — worst case ≈41 minutes of continued viewing after deactivation or grant removal. go2rtc streams stay registered until pruned when idle.
- **VOD (uncommitted)**: an ffmpeg conversion runs until the client disconnects or 30 min (`MAX_DOWNLOAD_MS`, `lib/nvr/client.ts:40`); no revocation.
- Client router cache `staleTimes.dynamic = 30` s (`next.config.ts:15`) can show already-rendered pages for up to 30 s.
- No session registry, no session ids in tokens, no deny list. Target ≤60 s: **not met, not designed, not tested**.

### 4.9 Grant expiry and the `agent` role

- Grant expiry: **none** (no columns, no job).
- The human role `agent` exists in the enum, roles helpers, UI maps, seed (`demo.agent@…`): 17 files contain the literal (plus the UI label maps in `components/admin/{UserRow,CreateUserForm}.tsx`) — (`lib/admin/roles.ts`, `scripts/{seed-demo,lib/demo}.ts`, `tests/integration/{check-now,discovery,groups-queries,groups,inventory-rls,negative-rls,users-admin}.test.ts`, `tests/unit/{demo-tools,groups-actions,groups-service,nav,roles}.test.ts`, `types/database.ts`, migration 0001). It collides with the planned endpoint "agent" (Plan 6).

### 4.10 Every place that must change for the access-control corrections

1. `supabase/migrations`: new migration(s) for capability grants, scopes, expiry, revocation, history; rename enum value `agent`→`operator`; redefine or replace `is_staff_all`, `granted_store_ids`, `visible_store_ids`, `visible_camera_ids`, `visible_device_ids`; replace `replace_user_access`; RLS policies on `stores`, `cameras`, `devices`, `check_state`, `outages`, `camera_groups`, `camera_group_items`, `profiles` (manager org-wide read), `user_*_access`; column privileges or table split for NVR address/credential columns and device IPs; `store_status` view (camera counts per capability).
2. `lib/admin/roles.ts` (`SEES_EVERYTHING`, `canRunChecks`, `canManageGroups`), `lib/nav.ts` (nav by capability), `lib/auth/profile.ts` (capabilities on the profile), `types/database.ts`.
3. `lib/admin/users.ts` (`setUserAccess`, `updateUser` revocation on role/grant/home-store change, `SEES_EVERYTHING` refusal at `:159`), `lib/actions/admin/users.ts`, `components/admin/{AccessEditor,CreateUserForm,UserRow}.tsx`, `app/(app)/admin/users/**` (assignment modes, expiry, effective-access preview).
4. Video path: `lib/streams/open.ts`, `lib/streams/playback.ts` (`findCamera`), `lib/actions/{streams,playback}.ts`, `app/api/vod/route.ts` + `lib/streams/vod.ts` (capability `cctv.playback`/`cctv.export`), `lib/streams/token.ts` (session id/jti, capability claim), `lib/streams/gateway.ts` + `services/gateway/index.ts` (session registry, periodic re-validation, close on revoke).
5. Monitoring/IT views: `lib/queries/{inventory,status,live,groups}.ts`, `app/(app)/{devices,stores/[id],home}/page.tsx` (IT data only with IT capability; CCTV users see camera availability only).
6. Groups: `lib/groups/service.ts`, `0007` policies (hide names when no member is visible, including for creators without access), `lib/queries/groups.ts`.
7. Check-now: per-capability (`it.monitoring.operate`) and per-scope, `lib/monitor/check-now.ts`, `lib/actions/monitor.ts`.
8. Seed/demo/test fixtures: `scripts/seed-demo.ts`, `scripts/lib/demo.ts`, `tests/setup/fixtures.ts`, and the tests listed in 3.9 that assert the old behaviour.
9. Audit: grant changes, video sessions, searches, exports into durable audit (`lib/admin/audit.ts` is best effort today).

---

## 5. Data-model audit

### 5.1 The one-NVR-per-store assumption — every dependent code path

The store row carries one recorder: `stores.nvr_ip, rtsp_port, http_port, nvr_username, nvr_secret_id, expected_channels` (`0002:19-24`); Vault secret named `nvr:<store id>` (`0004:66-67`); credential RPCs keyed by **store id** (`nvr_store_credential/nvr_read_credential/nvr_delete_credential(p_store)`).

Dependents:

- Monitoring: `lib/monitor/supabase-db.ts:62-65` (NVR jobs from stores), `:75-117` (store jobs with credential per store), `lib/monitor/checks.ts:96-122` (NVR TCP check per store), `:184-324` (cameras per store through one NVR), `:157` (login fingerprint per store), back-off map keyed by store id; `lib/monitor/types.ts:6-11` (`NvrJob`, `StoreJob`).
- Monitoring history: `check_state`/`outages` rows with `target_type='nvr'` and `target_id = store id` (`0005:9`); `store_status` view joins NVR state on store id (`0006:163`); `lib/queries/status.ts:134-140,221-223` (NVR outage grouping by store); `app/(app)/stores/[id]/page.tsx:43` (`getStates('nvr',[storeId])`); `app/(app)/admin/monitoring/page.tsx:54`; `monitor_stop_store` trigger (`0006:128-138`); `stores_forget` trigger deletes NVR history on store delete (`0005:74`).
- Video: `lib/streams/open.ts:25,55-93`, `lib/streams/playback.ts:51,94-117,140,165,222`, `lib/streams/vod.ts:512` (address, port, user, credential per store), `lib/streams/source.ts:67-69` (demo detection by `nvr_ip`).
- Discovery: `lib/monitor/discovery.ts:26-68` (one NVR per store; upsert cameras on `(store_id, channel)`).
- Admin/inventory/import: `lib/inventory/{stores,schemas}.ts`, `components/admin/StoreForm.tsx:11-41`, `lib/actions/admin/inventory.ts:23-35`, `lib/import/{stores-csv,apply}.ts` (legacy CSV columns ip/port/http_port/user/password/channels), `app/(app)/admin/{stores,import}/page.tsx`, `scripts/seed-demo.ts:124-131`, `lib/inventory/stores.ts` placeholder cameras up to `expected_channels`.
- Separately, `device_type` has an `'nvr'` value (`0002:7`, `lib/inventory/device-types.ts:1`): a second NVR at a store can only be added as a plain TCP-pinged device with no video, no credentials and no camera relationship — two inconsistent NVR representations.

### 5.2 Cameras, channels and identity

`cameras(id, org_id, store_id, channel, name, camera_ip, is_active)` with `UNIQUE (store_id, channel)` (`0002:39-52`). The channel is unique per store, so two NVRs at one location (both with channel 1) cannot be represented. Camera identity is stable while `(store, channel)` is stable; discovery upserts on that key (`discovery.ts:68`), so moving a camera to another recorder/channel creates a new identity (grants, groups, history lost or attached to the wrong camera). Deleting a camera cascades its grants, group items, status and outages (`0002:93`, `0007:19`, `0005:72`).

### 5.3 Devices and uniqueness

`devices(id, org_id, store_id null, type, name, ip, tcp_port, notes, enabled)`; `UNIQUE NULLS NOT DISTINCT (org_id, ip, tcp_port)` (`0004:49-50`). No serial, MAC, model, firmware, owner, criticality, lifecycle, warranty or last-inventory fields; IP is the de facto identity. With SD-WAN, overlapping private ranges across locations (e.g. every store using 192.168.1.0/24 behind NAT or VRF) would make this constraint reject legitimate devices or force fake addresses. How SD-WAN addressing works (unique routed ranges vs overlapping + NAT) is **unknown and is an external dependency** (network team). Store `nvr_ip` has no uniqueness at all.

### 5.4 Locations

Only `stores` exist (code, name, city, zone, state, address). Head office, DCs and other locations would have to be fake stores (and would require a fake NVR, since `nvr_ip`/`nvr_username` are NOT NULL, `0002:19,22`). Zones are free text.

### 5.5 Parent dependencies

None. The only dependency is implicit and hard-coded: "store NVR down ⇒ that store's cameras down with cause `nvr_down`" (`checks.ts:188-196`). There is no WAN/SD-WAN edge, switch or location node; a whole-location WAN outage is recorded as an NVR outage plus camera outages and device outages, each as a confirmed failure. Natural plug-in points: an `asset_dependencies` (or `parent_asset_id`) relation consulted by the worker before applying results, and a `cause_asset_id` on outages.

### 5.6 Monitoring history: keys and what a migration must preserve

- `check_state (org_id, target_type ∈ {camera, device, nvr}, target_id)` unique; `outages (org_id, target_type, target_id, started_at, ended_at, cause)`; `monitor_gaps (started_at, ended_at)` global, no org or worker id; `worker_state` single row `id=1`.
- Target ids are polymorphic, not FKs. Camera and device rows can keep their ids; **NVR history is keyed by store id** and must be re-keyed to new recorder ids (UPDATE `target_type='recorder', target_id=<recorder id>` for both tables, in one transaction, with the unique-open-outage index respected).
- A migration must preserve: camera ids (grants, group items, check_state, outages reference them), device ids, store ids (grants, profiles.store_id, check_state nvr rows, cameras.store_id), Vault secrets (move pointer, not value), `monitor_gaps` (uptime correctness), outage `cause` semantics, `admin_audit_log`.
- Deletion triggers (`monitor_forget_target`, `0005:64-74`) erase history on delete: switch to soft delete / archive before any remapping work.

---

## 6. Gap analysis against the directive

Legend: **I** Implemented · **P** Partial · **M** Missing · **C** Contradicted by current design. IDs are reused in the traceability table of the proposal.

### 6.1 Branding, design, port

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| BR-1 | Follow Asset Management design language (inspected) | M | Not inspected yet. Local reference: `D:\ANKUR AI PROJECTS\Asset Management` — its `main` working tree holds only docs; the application lives in worktree `.claude/worktrees/brave-euler-07879a` (branch `claude/brave-euler-07879a`: `frontend/design-tokens/tokens.json`, `frontend/src/components/ui/*`) and `release-packages/` |
| BR-2 | Clearly visible fields/labels/focus/contrast incl. auth pages | P | shadcn base components; not reviewed visually; native checkboxes/selects in `AccessEditor.tsx` |
| BR-3 | Full transparent logo on login and where space allows | M | `public/brand/citykart-drishti-logo.png` 1851×849 RGBA plus 925/462 variants: corners and full border alpha = 0 (truly transparent background, checked by decoding); artwork pixels mostly alpha 224–254 (≈0.3 % fully opaque) — visually check that lettering is not faint on light backgrounds. Not referenced by any page |
| BR-4 | Compact mark for nav/favicon only | P | `citykart-drishti-mark-{32,64,180,256,512}.png` exist (transparent corners); the 32 and 64 px marks touch the image edge (border alpha up to 200/154) — check for clipping. `app/favicon.ico`/icons not wired |
| BR-5 | Name "CityKart Drishti" / "CKDRISHTI" | C | `lib/brand.ts`: "CityKart Network Hub"; `package.json` name `cctv-hub`; README title |
| BR-6 | Dev app on port 3212 | I | `package.json` `dev`/`start --port 3212`; running (see §8) |

### 6.2 Access control

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| AC-1 | Separate roles, scopes, actions | C | Roles imply scope (manager = all) and actions; no capability model (§4.1) |
| AC-2 | Live / playback+search / export independently assignable | C | All three gated by one rule: camera visible (§4.7) |
| AC-3 | IT actions separately assignable (10 actions) | M | No IT actions exist; only check-now by role |
| AC-4 | CCTV store grant must not grant servers/IT | C | `visible_device_ids()` `0002:158-163`; asserted by `inventory-rls.test.ts:120` |
| AC-5 | Five assignment cases | P | Cases 1-4 representable (store, stores, cameras); case 5 (different live/playback/export rights for the same coverage) impossible |
| AC-6 | Remove hidden narrowing; explicit modes; predictable overlaps | C | `0002:153-155`; `inventory-rls.test.ts:132` |
| AC-7 | No CCTV access from home store | C | `granted_store_ids()` `0002:127`; `inventory-rls.test.ts:144` |
| AC-8 | Manager not global | C | `is_staff_all()`; `profiles_select_org` (`0001:66-67`) |
| AC-9 | Effective-access preview before saving | M | `AccessEditor.tsx` has none |
| AC-10 | Enforce on searches, thumbnails, stream creation, clip jobs, downloads | P | Searches/streams/VOD check camera visibility only; thumbnails, clip jobs, downloads not built; gateway does not re-check |
| AC-11 | Groups never expand; filter membership and metadata | P | Expansion: none (verified). Metadata: names/creator visible to anyone seeing one member; creator sees name without access (§4.5) |
| AC-12 | Grant expiry | M | §4.9 |
| AC-13 | Deactivation | I | §4.8 (for pages and RLS) |
| AC-14 | Revocation of active video/remote sessions ≤60 s, tested | C | Gateway is stateless; ≈41 min worst case (§4.8) |
| AC-15 | Rename human `agent` → `operator` | M | §4.9 |

### 6.3 Asset and location model

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| AL-1 | Stores, HO, DCs, other locations | M | Only `stores` with mandatory NVR columns (§5.4) |
| AL-2 | Multiple NVRs per location | C | One NVR on the store row; `UNIQUE (store_id, channel)` (§5.1-5.2) |
| AL-3 | Explicit locations/NVRs/cameras/recorder-channel mappings; stable camera identity and grant history on remap | M | §5.2 |
| AL-4 | Parent dependencies location → SD-WAN → switch → NVR/endpoint | M | §5.5 |
| AL-5 | Stable asset identity: serial/MAC/model/firmware/owner/criticality/lifecycle/warranty/last inventory | M | `devices` has none of these (§5.3) |
| AL-6 | IP is an attribute; resolve overlapping SD-WAN before global uniqueness | C | `UNIQUE (org_id, ip, tcp_port)` (`0004:49-50`) |
| AL-7 | Migrate without losing grants/identities/history | M (no migration yet) | Constraints listed in §5.6 |

### 6.4 CCTV

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| CC-1 | Live viewing | I (pre-directive permissions) | Live wall, groups, single camera; real-hardware unvalidated |
| CC-2 | Camera groups | I | §4.5 |
| CC-3 | Playback | I (Task 7 committed) | calendar, day timeline, 1–60 min, R19 non-shared streams |
| CC-4 | Authorised clip exports | M | Not built; `/api/vod` (uncommitted) is a de facto download without an export permission |
| CC-5 | Substreams for grids, main on demand | I | `kind: 'sub'|'main'` (`open.ts`), large view opens main |
| CC-6 | Calendar/timeline with clear unavailable intervals | P | Timeline draws recorded blocks on a muted background (`DayTimeline.tsx:83-91`); no explicit "unavailable / NVR unreachable / truncated" interval rendering beyond a truncated message |
| CC-7 | IST display; explicit NVR clock offsets | P | IST yes; one global `PLAYBACK_OFFSET_MIN`, no per-NVR offset or drift measurement |
| CC-8 | Test recordings crossing midnight | P | Fake-NVR and unit tests (`playback-streams.test.ts:240`, `playback-timeline.test.ts:54`); no real-NVR test |
| CC-9 | Bound live/playback/export concurrency | P | Per-request 36, per-person 30 requests/min, gateway 100/IP and 300 total, playback ≤20 viewers per window, VOD 1/person 8 total — all in-process; no per-user concurrent-stream cap, no NVR bandwidth budget |
| CC-10 | Stop hidden/abandoned streams | P | Client stops tiles when tab hidden (`useOpenedStreams.ts:9-16`); go2rtc idle prune; gateway 30-min cap; server cannot stop a stream for a revoked user |
| CC-11 | Audit viewing sessions/searches/exports without credentials/tokens | M | Only stdout gateway outcome lines with an 8-hex camera hash and no user (`gateway.ts:13-20`); no audit rows for searches or playback |
| CC-12 | Expiring authorised downloads | M | — |
| CC-13 | Export retention, cleanup, quotas | M | — |
| CC-14 | User exports vs scheduled evidence backup | M | Plan 4 Task 5 "NVR backup" only, conflated |
| CC-15 | Real codec/browser combinations tested | M | Demo H.264 test pattern only; README notes MSE gaps (iOS < 17.1); H.265 cameras would need transcoding — untested |
| CC-16 | Reachability, stream availability, recording health shown separately | C | One status per camera derived from ISAPI online/RTSP DESCRIBE; NVR status = TCP to RTSP port; no recording health at all |

### 6.5 Monitoring and control centre

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| MC-1 | Compact operational overview (8 elements) | P | `/home` shows camera counts, NVR-down list, device counts by type, 10 recent outages; missing: locations affected, coverage/stale panel, incidents awaiting action, recovery/change events |
| MC-2 | Every summary opens an investigation; filters preserved | P | Links to store/devices pages; no timeline, evidence or next-action views |
| MC-3 | Distinguish confirmed failure / unreachable from HQ / unknown due to parent / stale / maintenance / healthy | C | Status ∈ {up, down, unknown} (`0005:10`); UI words Live/Offline/Not checked yet/Not checked lately (`status.ts:50-59`). No unreachable-vs-failed distinction, no parent-unknown, no maintenance |
| MC-4 | Do not label cameras failed because NVR/WAN is unreachable | C | Cameras are written `status='down'` with an outage when the NVR is down (`checks.ts:188-196`); counted in `cameras_down` (`0006:153`) and shown "Offline"; only the recent-outages list hides them (`status.ts:136-140`) |
| MC-5 | Correlate parent incidents, suppress duplicates, retain child observations | P | Child outages retained; display grouping for NVR only; no WAN/location correlation; no notifications yet |
| MC-6 | Report availability, unknown time and coverage separately; gaps never healthy | P | Gaps excluded from both numerator and denominator (good); but parent-caused camera downtime counts as downtime (`targets_uptime` ignores `cause`), and no "unknown time"/coverage figure is reported |
| MC-7 | NVR storage/recording errors, gaps, retention, clock drift | M | No such ISAPI calls (§3.6) |
| MC-8 | Camera decode, stale/frozen/black frames | M | Only RTSP DESCRIBE/ISAPI online |
| MC-9 | SD-WAN latency/loss/tunnels/failover | M | — |
| MC-10 | Switch/AP/PoE, UPS/printer | M | Plan 8 SNMP (not built) |
| MC-11 | Windows performance/disk/services/security/patch/reboot | M | Plan 6 (not built) |
| MC-12 | Attendance/footfall data freshness | M | Only TCP/ICMP reachability |
| MC-13 | Unsupported checks show unsupported, not healthy | P | Unknown is shown as "Not checked yet"; no "unsupported" state; Basic-only NVRs reported as unsupported login (R6) |

### 6.6 Alerts

| ID | Requirement | Status |
|---|---|---|
| AR-1 … AR-6 | Channels, dedup, maintenance suppression, acknowledgement, escalation, recovery | M (Plan 4 Tasks 1-3 designed: rules/events/engine, e-mail/Teams/webhook, delay 5 min, recovery; no ack/escalation/maintenance in the plan) |
| AR-7 | WhatsApp/webhook configurable | M (webhook planned; WhatsApp not in plans) |
| AR-8 | No external messages during development | I (nothing sends); must be enforced by a dev "sink" mode when alerts are built |

### 6.7 Endpoint agent

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| EA-1 | Outbound agent primary; retain WinRM/SSH/SNMP/vendor adapters | M | Plan 6 (PowerShell agent) not built; Plan 6 explicitly avoids WinRM; SNMP in Plan 8 |
| EA-2 | Read-only inventory and health first | M | Plan 6 mixes inventory with commands in one plan |
| EA-3 | Secure enrolment, device auth, rotation, revocation, upgrades, local credential protection | M | Plan 6: hashed enrolment and device tokens; no rotation, no self-update ("later item"), no DPAPI/ACL protection specified |
| EA-4 | Separate command-signing authority, public-key verification | C | Plan 6 line 21 ("HMAC … using the device token") vs line 101 ("sign with the token hash as the key") — the hub's stored hash becomes the symmetric key, so anyone who can read `agents.token_hash` (DB backup, service role, SQL access) can forge commands for every device; the architecture doc §11.1 still states device-token signing |
| EA-5 | Bind command to device, job, immutable version, params, expiry, policy version | P (design) | Plan 6 MAC covers jobId, kind, params, expiresAt, script SHA-256; no device id (implicit in key), no policy version, no approval binding |
| EA-6 | Compromised device credential cannot create/approve commands | P (design) | Device cannot create via API, but with symmetric signing a stolen token lets an attacker mint valid commands for that device to replay locally; DB-level compromise mints for all |

### 6.8 Remote management

| ID | Requirement | Status | Evidence (all Plan 6/5 designs; nothing built) |
|---|---|---|---|
| RM-1 | Versioned approved library; no unrestricted fleet box | P (design) | Plan 6 script library with versions; "no free-text box" |
| RM-2 | Persistent local execution journal | P (design) | `state.json` saves results before sending |
| RM-3 | Leases/acks/reconciliation; no blind rerun on ack timeout | C (design) | Plan 6: `sent` > 15 min ⇒ re-queued up to 3 attempts |
| RM-4 | Revalidate queued commands when an offline PC returns | C (design) | "an offline PC runs everything queued, in order" |
| RM-5 | Supersede obsolete configuration jobs | M | — |
| RM-6 | Action-specific expiry, maintenance windows | P (design) | single default expiry 30 days; `not_before` only |
| RM-7 | Approval bound to exact immutable payload | P (design) | approval on fleet command row, not on a payload hash |
| RM-8 | Canaries, bounded batches, pause/cancel, failure-stop | P (design) | cancel only |
| RM-9 | Rollback/recovery per action | M | — |
| RM-10 | Install/uninstall, wallpaper, screensaver, batch/PS, patching in stages | P (design) | install (no uninstall), scripts, Windows Update scan/install |
| RM-11 | Per-user settings when agent runs as SYSTEM | M | wallpaper/screensaver as SYSTEM not addressed |
| RM-12 | Verify results beyond exit code | M | exit code + output only |
| RM-13 | Windows LAPS for joined devices; separate workgroup design | C (design) | Plan 6 rotates all local admin passwords itself |
| RM-14 | No default "enable local administrator" fleet action | C (design) | `enable_admin_account` is an allow-listed fleet command |
| RM-15 | View vs control separate; view-only enforced in protocol path | P (design) | Plan 5: gateway drops input in view-only; `profiles.remote_access` single column |
| RM-16 | Rotate shared VNC credentials through a controlled migration | P (design) | Plan 5 mentions per-machine passwords later |
| RM-17 | Do not claim `.rdp` files give enforced controls | P (design) | Plan 5 offers `.rdp` download; wording must state no enforcement |

### 6.9 Security and operations

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| SO-1 | Privileged MFA and fresh authentication | M | `supabase/config.toml` `[auth.mfa.totp] enroll_enabled=false, verify_enabled=false`; no `aal` checks; `secure_password_change=false` |
| SO-2 | Least-privilege service separation | C | Web app, worker and gateway-adjacent code all use the single service-role key (bypasses RLS, reads Vault); VOD/ffmpeg runs inside the web process |
| SO-3 | RLS, explicit grants, safe SECURITY DEFINER | P | RLS everywhere and explicit grants; search_path not pg_temp-safe; whole-table SELECT exposes NVR columns (§4.6); `privilege_violations` blind to functions |
| SO-4 | Registered-target/network restrictions on outbound connections | M | `isValidHost` accepts any syntactically valid host/IP incl. loopback/link-local (`lib/probes.ts:16-20`); credentials are sent to whatever an admin types |
| SO-5 | HTTPS/WSS and secret/token redaction | P | Plain HTTP/WS in dev; HSTS only if https; tokens travel in the WS query string (README warns proxies); logger redaction exists |
| SO-6 | Strong generated signing secrets and rotation | P | `scripts/env-from-supabase.mjs` generates secrets; ≥16-char rule; no rotation path (one key per purpose, no key id) |
| SO-7 | Shared rate limiting across processes | M | All limiters are in-process (§2 row 46) |
| SO-8 | Strict CSP compatible with the player | M | §2 row 48 |
| SO-9 | Review go2rtc listeners 1984/8555/8554; restrict modules/API/exec | P | API `:1984` on all container interfaces, published to host loopback only; WebRTC `:8555` tcp+udp published to loopback although unused; RTSP off in normal config, `127.0.0.1:8554` in demo; API unauthenticated (no `username/password`), no module/`allow_paths` restriction; `exec:` refused via API (R16) but `ffmpeg:` sources are accepted via API (lets anything that reaches the API make go2rtc's ffmpeg open arbitrary inputs); other module defaults (e.g. `srtp`, `rtmp`, `echo`, `expr`, `homekit`) not explicitly disabled — unverified for 1.9.9 |
| SO-10 | Isolate media processing from fleet execution | P | No fleet yet; ffmpeg spawned by the web process (should move to the media service) |
| SO-11 | Durable audit and independent tamper-evidence checkpoints | M | `admin_audit_log` best effort and mutable by service role; hash-chained log planned |
| SO-12 | Health/visibility for workers, queues, gateway, DB | P | `/api/health` (DB + worker heartbeat), gateway `/g/health`; no queue metrics, no gateway session counts in UI |
| SO-13 | Tested backup/restore incl. Vault decryption material | M | Planned in Plan 4 docs only |
| SO-14 | Atomic lease/fencing worker singleton | C | §2 row 40 |

### 6.10 Windows deployment

| ID | Requirement | Status |
|---|---|---|
| WD-1 | Separate in-place repair from clean install | P (Plan 7 separates "reinstall pilot" and "clean-reinstall runbook only") |
| WD-2 | No placeholder presented as working | P (Plan 7 calls clean reinstall "runbook plus a stub"; must stay labelled) |
| WD-3 | Lab validation list (boot/recovery, backups, BitLocker, drivers, licensing, apps, identity, failure recovery) | M |
| WD-4 | Approval, fresh preflight, windows, staging, local safeguards, destructive off outside pilot | P (Plan 7 design: two approvers, preflight, window, hub switch + agent setting) |

### 6.11 Development and validation

| ID | Requirement | Status |
|---|---|---|
| VA-1 | Regression, typecheck, lint, build | I (gates per task per ledgers; not re-run here) |
| VA-2 | Cross-user/store/camera/action permission boundary tests | P (user/store/camera yes; action dimension absent) |
| VA-3 | Playback/export denial despite live permission | M |
| VA-4 | Camera-only users cannot see IT devices | P (camera-only yes `inventory-rls.test.ts:126`; store-grant CCTV users can) |
| VA-5 | Multiple NVRs per location | M |
| VA-6 | Active-session revocation | M |
| VA-7 | WAN/NVR/monitor failure distinctions | P (monitor stop vs downtime tested; WAN/NVR distinctions absent) |
| VA-8 | Queue replay, lost acks, expiry, cancellation | M |
| VA-9 | Browser video compatibility and resource cleanup | P (gateway/socket cleanup tested; browser codecs not) |
| VA-10 | Load tests (streams, bitrates, agent traffic) | M |
| VA-11 | Rendered pages incl. auth/error states at desktop and control-room sizes; field visibility; logo | M |
| VA-12 | Local only; no push/merge; fakes by default | I (egress guard; nothing pushed) |

### 6.12 Specific items the brief asked to confirm

- **Signing contradiction (Plan 6)**: confirmed, see EA-4.
- **go2rtc listeners**: see SO-9; files `deploy/go2rtc.yaml`, `deploy/go2rtc.demo.yaml`, `deploy/docker-compose.dev.yml:24-30`, `deploy/docker-compose.demo.yml`.
- **Heartbeat-only worker singleton**: confirmed (`lib/monitor/guard.ts:98-105`, check-then-act, no fencing; two workers started within one poll window both pass).
- **CSP**: absent. **MFA**: disabled. **Rate limiting**: in-process only; none on admin actions/import.
- **Export/download**: no export feature; Task 8 `/api/vod` streams `video/mp4` gated only by camera visibility — pre-directive permission model; it must be re-gated (playback vs export decision, see proposal D-6).
- **Monitoring semantics**: verified the UI does not distinguish confirmed failure vs unreachable-from-HQ vs unknown-due-to-parent vs stale vs maintenance; only "Not checked lately" (stale) and "Not checked yet" exist beside Live/Offline.

---

## 7. Existing functionality to preserve

The rework must keep these working (and their tests green, adapted where the behaviour intentionally changes):

1. Authentication: password sign-in with failed-attempt lock-out, forgot/reset password via e-mail link, forced first-login password change, sign-out; proxy session verification with signed user header; exact public allow-list; `safeNext` (`tests/unit/safe-next.test.ts`, `verified-user.test.ts`, `users-admin.test.ts`).
2. User administration: create with one-time password, role changes with `canManageRole` rules, self-change refusal, deactivate (ban + session revocation), reactivate, password reset with session revocation, audit rows.
3. Inventory: store/device CRUD, NVR password to Vault only (`nvr_store_credential` locking and stale-pointer recovery), CSV import of stores/devices (legacy columns), placeholder cameras, discovery ("Find cameras") with stable ids.
4. RLS foundations: org isolation via composite FKs, closed default privileges, `privilege_violations()` check, must-reset ⇒ no org, deactivated ⇒ no data.
5. Monitoring: TCP/ICMP (TTL rule), NVR TCP, ISAPI channel status + RTSP DESCRIBE fallback, Digest-only client, NVR login back-off (no false outages), state machine (2-failure rule, first-failure start, gap handling, switched-off targets), uptime excluding gaps and pre-first-check time, stale (20 min) labelling, "monitoring not running" banner, check-now with DB clock and cooldown, worker heartbeat and graceful shutdown, `/api/health`.
6. CCTV: live wall (36 tiles, paging, sub/main, renewal every 8 min, tab-hidden pause, accessible large view), camera groups (create/rename/delete/add by list or keyword/remove), stream tokens and gateway (all checks in `gateway.test.ts`), go2rtc client confirm-by-GET and pruning, demo video mode, recording calendar and day timeline, playback 1–60 min with R19 non-sharing and R13 offset semantics, (Task 8) fast playback when ffmpeg exists.
7. Safety tooling: egress guard, fake NVR/RTSP/TCP servers, fake ffmpeg/spawn, `assertLocalStack`, demo seed with per-run random passwords.
8. Conventions: `Result` services, sanitised errors, IST formatting, plain-English copy, migrations with rollbacks.

---

## 8. Runtime facts at audit time (port 3212 and services)

- **Port 3212**: listening on `::` (all IPv6 and, dual-stack, IPv4 interfaces), PID 46920 `node.exe "D:\ANKUR AI PROJECTS\CCTV MONITORING TOOL\node_modules\next\dist\server\lib\start-server.js"`, started 22-10-2026 10:17:23; parent PID 44416 `node …\CCTV MONITORING TOOL\node_modules\.bin\..\next\dist\bin\next dev --port 3212`. **It is this project's Next.js dev server** (the one the ledger says is running for the owner). Not touched. Because it binds all interfaces over plain HTTP, the dev app is reachable from the LAN/VPN; for the final handover the bind address should be stated explicitly (directive "bind address").
- Port 3213 (gateway), 1984/8555 (go2rtc) and 8554: **not listening** — live video cannot work in the running instance until `npm run stack:up` and `npm run gateway` are started.
- Supabase API 55321 and DB 55322: listening (Docker backend PIDs 32696/28512) on `::1` and `::`.
- ffmpeg: not installed on the host (ledger), so Task 8 fast playback degrades to "ffmpeg is not installed on the server".
- Logo asset facts: see BR-3/BR-4.
- Design reference location: see BR-1 (not yet inspected for parity; this audit makes no visual-parity claim).
