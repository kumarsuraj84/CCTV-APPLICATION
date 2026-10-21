# CityKart Network Monitoring Hub: Design (Desk stack)

Date: 2026-10-21
Status: design approved by the user in chat (revision 2, replaces the FastAPI design). This spec awaits written review.
Source designs: the legacy `cctv-hub` (in `reference/cctv-hub-legacy/`), the camera report (`docs/reference/camera-report-2026-10-21.md`) and the Citykart Desk blueprint (`D:\ANKUR AI PROJECTS\CitykartDesk-ZOHO Alternate\docs\CITYKART-DESK-FULL-APPLICATION-DESIGN.md`, called "Desk" below).

## 1. Goal

One web app that monitors every IP device on the CityKart network and lets staff watch CCTV, with each user limited to the stores and cameras they are allowed to see.

Monitored: CCTV cameras and their NVRs (uptime, live feeds, playback, backup), servers, attendance machines, footfall counters, and any other device with an IP address.

It replaces the legacy `cctv-hub` (FastAPI + SQL Server + one HTML page). It keeps that app's working NVR logic (Hikvision ISAPI, RTSP checks, playback, backup, report) and rebuilds it in Desk's stack, with Desk's conventions for security, access, UX and operations.

Scale reference: 215 stores, 4,609 cameras, about 16.5% offline, 4 stores with the NVR down. Design for 300 stores and 8,000 cameras.

## 2. Decisions already made

| Topic | Decision |
|---|---|
| Stack | Desk's stack: Next.js 16.3 (App Router, Server Actions, `proxy.ts`), React 19, TypeScript 5.9, Tailwind 4, shadcn/ui (base-nova), Supabase (PostgreSQL, PostgREST, GoTrue, Storage, Vault) |
| Carry-over features | Camera groups, recorded playback with timeline (and fast playback), recording backup, Excel/health report |
| App port | **3212** (dev and production) |
| Device intake | CSV import plus manual add/edit. No subnet auto-discovery in v1 |
| Viewer access | Whole stores (optionally a whole zone), with optional per-camera restriction inside a store |
| Alerts (mail, SMS, push) | Not in v1 |
| Repository | https://github.com/kumarsuraj84/CCTV-APPLICATION.git. Nothing is pushed until the user asks |
| Production hosting | Decided at the hardening phase (Desk-style Windows services, or Docker). Local development uses the Supabase CLI in Docker |

## 3. Architecture

```
Browser ──► Next.js app (port 3212)  ── RLS client (user cookie) ──► PostgREST ─► PostgreSQL (RLS, RPC, Vault)
   │             │ service-role client (server only) ─────────────────────────────────┘      ▲
   │             └── asks go2rtc to register streams                                         │
   └─ video ─► Stream gateway (port 3213, WebSocket) ─► go2rtc (internal)       Worker (Node) ┘
                    checks a signed token                                        probes NVRs/devices,
                                                                                 runs backups, check-now
```

Processes:

| Process | Role |
|---|---|
| `app` | Next.js standalone server. Pages, Server Actions, route handlers, playback streaming. Port 3212. |
| `worker` | Long-running Node service (TypeScript, shares `lib/` code with the app). Runs all probes, outage tracking, backups and "check now" requests. Writes through the service-role client. |
| `gateway` | Small Node WebSocket service on port 3213. Verifies a signed stream token, then proxies the browser to go2rtc. (Next.js route handlers cannot proxy WebSocket upgrades.) |
| `go2rtc` | Turns camera RTSP streams into browser-playable streams. Reachable only from `app`, `worker` and `gateway`. |
| Supabase | PostgreSQL 17 locally (18 in production), PostgREST, GoTrue, Storage, Vault. |

The app talks to the database only over HTTP (supabase-js to PostgREST), never a direct Postgres connection. The worker does the same.

Local development ports (chosen not to clash with a Desk stack on the same PC, which uses 543xx and 554xx): Supabase API 55321, DB 55322, Studio 55323, mail catcher 55324, shadow DB 55320; isolated test stack 556xx; app 3212; gateway 3213; go2rtc 1984 and 8555.

Repository layout (follows Desk):

```
app/
  (auth)/        login, forgot-password, reset-password
  (app)/         home, stores, stores/[id], live, playback, devices, groups, reports, backup,
                 admin/(users, access, import, logs, monitoring, settings)
  api/           health, version, csp-report, playback/stream, reports export
components/      layout/, ui/ (shadcn), stores/, devices/, live/, admin/
lib/             supabase/, auth/, access/, actions/, queries/, monitor/, nvr/, rtsp/, streams/,
                 import/, export/, observability/, security/, http/, secrets.ts, rate-limit.ts, ...
services/        worker/, gateway/
supabase/        config.toml, migrations/, rollback/, seed.sql
scripts/         cron-tick / worker runners, windows/ deploy scripts (later)
tests/           unit/, integration/, setup/
types/           database.ts (generated, then hand-kept like Desk)
proxy.ts  next.config.ts  vitest.config.ts
reference/       legacy cctv-hub source (read-only)
docs/            specs, plans, reference report
```

## 4. Conventions adopted from Desk

1. Server Actions live in `lib/actions/**` (`'use server'`). Each one checks the caller (`getCurrentProfile()`), role and organisation scope first.
2. Two Supabase clients: `createClient()` (cookie-bound, RLS enforced) and `createAdminClient()` (service role, server only). Admin-client writes of a foreign key first prove the referenced row belongs to the caller's organisation (`assertRefsInOrg`).
3. `proxy.ts` verifies the session once per request and forwards a signed user-id header (always overwritten, never merged). Public routes are an exact-match allow-list: `/login`, `/forgot-password`, `/reset-password`, `/api/health`, `/api/version`, `/api/csp-report`, and the secret-protected worker/cron endpoints.
4. Time is stored UTC and shown in IST, 24-hour clock, through one helper. Business-hour logic is not needed here.
5. Errors: never return a raw database message; `sanitizeError()` maps SQLSTATE codes to short plain messages. Structured `logger` with secret redaction. `alertOperator` for batch-level failures.
6. One secret per purpose (`getSecret(purpose)`): `cron`, `worker`, `stream_token`, `system_log_ingest`. A missing one switches the feature off; two purposes must not share a value; minimum 16 characters.
7. In-process `rateLimit` for login, password reset, admin actions and import.
8. Race guards (`.eq('status', current)`) and idempotent worker writes.
9. Simple language in every screen text. No jargon.
10. Version bar ("new version available"), `/api/health` returns `{status, db, worker}`, `/api/version` returns the build id.
11. Per-release migration run sheet and rollback SQL under `supabase/rollback/`; each new enum value gets its own migration.
12. Comments explain why, above the non-obvious line.

## 5. Data model (PostgreSQL, `public` schema)

Every business table has `id uuid default gen_random_uuid()`, `org_id uuid` (FK `organizations`), `created_at`, `updated_at`; row-level security is on for every table. The app is single-organisation in practice (CityKart) but keeps the multi-organisation schema, as Desk does.

| Table | Key columns |
|---|---|
| `organizations` | name, slug (unique), is_owner, status |
| `profiles` | id (= `auth.users.id`), email, full_name, role (`user_role`), is_active, must_reset_password, `store_id` (store logins) |
| `stores` | code (unique per org, upper-case), name, city, zone, state, address, is_active, nvr_ip, rtsp_port (554), http_port (80), nvr_username, nvr_secret_id (Vault), expected_channels |
| `cameras` | store_id, channel, name, camera_ip, is_active; unique (store_id, channel) |
| `devices` | store_id (nullable), type (`device_type`: `nvr, server, attendance, footfall, other`), name, ip, tcp_port (nullable), notes, enabled |
| `user_store_access` | user_id, store_id |
| `user_zone_access` | user_id, zone |
| `user_camera_access` | user_id, camera_id |
| `check_state` | target_type (`camera, device, nvr`; nvr id = store id), target_id, status (`up, down, unknown`), last_checked_at, last_up_at, first_failure_at, down_since, consecutive_failures, method, error. Server-only |
| `outages` | target_type, target_id, started_at, ended_at, cause (`nvr_down` or null). Server-only |
| `worker_state` | single row: last_heartbeat, check_requested_at, run_started_at, run_finished_at, progress. Server-only |
| `monitor_gaps` | started_at, ended_at: periods when the worker was not running, excluded from uptime. Server-only |
| `camera_groups`, `camera_group_items` | named camera sets |
| `backup_jobs` | status, counters, errors, requested_by |
| `admin_audit_log` | who did what: user, access and import changes, backups. Server-written |
| `system_log` | hash-chained audit and error log (hardening phase), as in Desk |

Status labels in the UI: Live, Offline, Not checked yet.

Server-only tables follow Desk's migration pattern: `ENABLE ROW LEVEL SECURITY; REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT ALL ... TO service_role;` (read policies are added for `check_state` and `outages` so users can read the rows they may see; they can never write them).

NVR passwords live in Vault. The Vault RPCs `nvr_store_credential(store, secret)` and `nvr_read_credential(store)` are callable only by the service role.

## 6. Access control

### 6.1 Roles (Desk's fixed enum `user_role`)

| Role | CCTV meaning |
|---|---|
| `user` | Viewer. Sees only what is granted (stores, zones, cameras) plus their own store if the profile has `store_id`. |
| `agent` | Operator. Same visibility as `user`, plus "check now" and managing camera groups. |
| `manager` | Sees every store, camera and device, read-only, with reports. |
| `admin` | Everything: users, grants, import, devices, backup. |
| `platform_owner` | Everything, plus owner-only functions. |

A person with `must_reset_password = true` resolves to no organisation and no role in row security until they choose their own password (as in Desk migration 168).

### 6.2 Visibility rules (enforced in the database)

- Set-returning STABLE SECURITY DEFINER functions `visible_store_ids()`, `visible_camera_ids()`, `visible_device_ids()` hold the rules; policies use `id IN (SELECT visible_...())` so they are evaluated once per query, not once per row.
- A store-grant set = stores granted by `user_store_access`, stores in zones granted by `user_zone_access`, and the profile's own `store_id`.
- **Stores visible** = store-grant set, plus stores that contain a camera granted individually. `manager`, `admin`, `platform_owner`: every store of the organisation.
- **Cameras visible** = individually granted cameras, plus cameras of stores in the store-grant set unless the user has individual camera grants in that store (then only those). This gives the three cases: all cameras of a store, several stores, some cameras of some stores.
- **Devices visible** = devices of stores in the store-grant set (a camera-only grant does not reveal a store's servers). Devices with no store are visible only to `manager`, `admin`, `platform_owner`.
- Direct data-API requests for anything outside scope return no rows. The app never relies on hidden navigation as a control.

### 6.3 Writes

Stores, cameras, devices, users, grants and imports are changed only by `admin` and `platform_owner`, through Server Actions using the admin client, each with a role check and `assertRefsInOrg`. Operators (`agent`) may request a check run and edit camera groups through their own actions. Every such action writes `admin_audit_log`.

## 7. Monitoring (worker)

Same rules as the approved design, written in TypeScript with pure, unit-tested modules in `lib/monitor`, `lib/nvr` and `lib/rtsp`.

| Target | Method | Interval |
|---|---|---|
| Servers, attendance, footfall, other devices | TCP connect to `tcp_port`; if no port is set, ICMP ping | 60 s |
| NVR reachability | TCP connect to the NVR RTSP port | 60 s |
| Cameras of a store | ISAPI `InputProxy/channels/status` from the NVR; cameras the NVR does not report online are re-checked with an RTSP DESCRIBE on the sub-stream | 300 s |

- A target goes `down` after **2 consecutive failures** and `up` on the first success; the outage starts at the first failure's time.
- If the NVR is `down`, its cameras are marked `down` at once with outage cause `nvr_down`, and the dashboard lists the NVR outage, not each camera.
- Concurrency limits as in the legacy app (about 10 stores at once, 4 RTSP probes per store).
- Uptime over 24h / 7d / 30d is computed in a SQL function from `outages`, excluding `monitor_gaps` and the time before a target was first checked. A worker stoppage shows as "no data", not as downtime.
- NVR authentication uses HTTP Digest, implemented once in `lib/nvr/digest.ts` and unit-tested. NVR and RTSP errors are stored so "NVR refused the login" differs from "NVR unreachable".
- "Check now" (operators and above) sets `worker_state.check_requested_at`; the worker picks it up within 5 seconds and reports progress.
- Camera discovery reads channels and names from the NVR and upserts by `(store_id, channel)` so camera ids stay stable.
- The worker writes a heartbeat; `/api/health` reports it, and an old heartbeat shows on the Monitoring page.

## 8. Live feeds

1. The user opens a store or group. A Server Action reads the cameras through the RLS client (so only visible cameras come back), registers their streams in go2rtc (main and sub, named by camera id) and returns a stream token per camera.
2. The token is signed with the `stream_token` secret, names one camera and one user, and lasts 10 minutes (the page renews it while open).
3. The browser connects to the gateway (`ws://host:3213/stream?token=...`). The gateway verifies signature, expiry and stream name, then proxies to go2rtc. The old hub let any signed-in user open any stream by name; this does not.

## 9. Playback, backup, reports

- **Playback:** calendar of recorded days and a 24-hour timeline from the NVR (ISAPI search). Normal speed through go2rtc RTSP; 2x/4x/8x through an NVR download piped through ffmpeg to fragmented MP4 in a streaming route handler. The NVR time-offset setting from the legacy app is kept.
- **Backup:** an admin selects cameras and a time range; the worker downloads recordings from the NVR to a configured directory, one download per NVR at a time. Progress is in `backup_jobs`.
- **Reports:** fixed reports like Desk's Report Analytics: NVR down, stores with no live camera, offline cameras with "offline since" and "last seen online", store-wise and zone-wise live counts, uptime by store, devices down. Excel export through `exceljs`, CSV-injection-safe, scoped to what the user may see, and every export is audited. The workbook has the same sheets as the legacy report plus a Devices sheet.

## 10. UI

Desk's shell and design system:

- Left sidebar grouped Monitoring / Workspace / Admin; top bar with search (Ctrl+K), theme toggle and profile; mobile bottom navigation with at most four items and a More sheet; a "new version available" bar.
- Screens: Home (counts by device type, zone and store; stores with NVR down; recent outages), Stores, Store detail (camera grid with status and uptime), Live wall, Playback, Devices, Camera groups, Reports, Backup, Admin: Users, Access (grants), Import, Logs, Monitoring (worker health), Settings (brand name, subtitle, colour and logo, as in `brand.json`).
- Tables with sticky headers, searchable selects, toasts (sonner), skeleton loading, empty states with the next action, in-page confirmations (no browser dialogs), light and dark themes.
- Labels in plain English; IST 24-hour times.

## 11. Import formats

- Stores CSV: legacy `stores_sample.csv` columns (`name, city, zone, ip, port, http_port, user, password, channels`) plus optional `code` and `state`. Zone and state labels are normalised (`JH` and `Jharkhand` become one value). Re-import updates stores matched by code. The NVR password goes straight to Vault.
- Devices CSV: `name, type, store_code, ip, port, notes`. Invalid rows are reported with their line numbers and skipped; valid rows are imported. Imports are per-row tolerant and return `{imported, errors[]}`.

## 12. Security

Follows Desk section 18: three authorisation layers (page guard, Server Action checks, row-level security and table privileges); server-only writes for check results, outages, audit and secrets; forced first password change enforced in the database; no public sign-up (admins create users and get a one-time password shown once); signed header from `proxy.ts`; per-purpose secrets; rate limits; security headers and a report-only Content-Security-Policy (connect-src allows the gateway); CSV exports neutralise leading `= + - @`; no secrets in the repository, logs or screens; hash-chained `system_log` in the hardening phase; type errors fail the production build.

## 13. Environment variables (names only)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_STREAM_GATEWAY_URL`, `GO2RTC_URL`, `TZ`, `PORT`, `CRON_SECRET`, `WORKER_SECRET`, `STREAM_TOKEN_SECRET`, `SYSTEM_LOG_INGEST_SECRET`, `FFMPEG`, `BACKUP_DIR`, `PLAYBACK_OFFSET_MIN`, `DEVICE_CHECK_SEC=60`, `CAMERA_CHECK_SEC=300`. `.env.local` is git-ignored; `.env.example` is committed with blanks.

## 14. Testing

- **Unit (vitest):** digest auth, ISAPI and RTSP parsing against saved sample responses, the failure/outage state machine, uptime arithmetic, CSV parsing and region normalisation, stream-token signing, secrets audit, shared access helpers.
- **Integration on an isolated Supabase stack:** row-level security tests (a viewer sees only granted stores, cameras and devices; the three grant cases; `must_reset_password` blocks everything; cross-organisation isolation), Vault RPC privileges, server-only table privileges.
- **Worker tests** use fake NVR (HTTP), RTSP and TCP servers on localhost.
- **Isolation gate** (a script that must pass before any integration suite): the database is the local test stack, every NVR/device IP in test data is in a loopback or documentation range, and an egress guard preloaded in the test process refuses outbound connections to any other address. A test can therefore never probe a real store.
- **Not covered:** real Hikvision hardware, real store networks and video over the VPN. These need a check on a real store after deployment.
- Release gates: type check clean, lint clean, unit tests, applicable integration tests, production build.

## 15. Build order

Plans, each producing working, testable software:

1. **Foundation, identity and inventory:** project, Supabase stack, shared libraries, shell, auth, roles, grants, users admin, stores/cameras/devices, CSV import, row-level security tests, health and version.
2. **Monitoring:** NVR/RTSP/TCP clients, state machine, outages, uptime, worker, discovery, check-now, Home dashboard and status on Stores and Devices.
3. **Live feeds, playback and camera groups:** go2rtc, gateway, signed tokens, playback and fast playback, groups.
4. **Backup, reports and hardening:** backup jobs, fixed reports with Excel export, system log with hash chain, CSP, load test, production packaging.

## 16. Out of scope for v1

Alerts and notifications, subnet auto-discovery, non-Hikvision camera protocols, mobile apps, WhatsApp or e-mail intake, automatic migration from the old SQL Server database (stores are re-imported from CSV).

## 17. Open items to confirm

- Production hosting (Windows services or Docker) and where recordings are backed up.
- Whether every NVR exposes `InputProxy/channels/status` over ISAPI; the RTSP fallback covers the rest.
- Retention for `outages` and logs (default: keep everything; review after a month).
- ICMP ping only works where the worker host allows it; TCP checks are the default.
