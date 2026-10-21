# CityKart Network Monitoring Hub: Design

Date: 2026-10-21
Status: approved by the user in chat (design); this spec awaits written review.

## 1. Goal

One web app that monitors every IP device on the CityKart network and lets staff watch CCTV, with each user limited to the stores and cameras they are allowed to see.

Monitored device types:

- CCTV cameras and their NVRs (uptime, live feeds, playback, backup)
- Servers
- Attendance machines
- Footfall counters
- Any other device that has an IP address

The app replaces the existing `cctv-hub` (FastAPI + SQL Server + one `index.html`, kept for reference in `reference/cctv-hub-legacy/`). It keeps that app's working NVR/ISAPI/RTSP logic and moves it onto PostgreSQL, a React frontend and per-user access control.

Scale reference (`docs/reference/camera-report-2026-10-21.md`): 215 stores, 4,609 cameras, about 16.5% offline, 4 stores with the NVR down.

## 2. Decisions already made

| Topic | Decision |
|---|---|
| Features carried over from cctv-hub | Camera groups, recorded playback with timeline, recording backup, Excel/health report |
| Platform | Docker Compose; backend FastAPI (Python), frontend React + TypeScript + Vite, PostgreSQL |
| Public port | **3212** (the only port exposed to the office network) |
| Device intake | CSV import plus manual add/edit in the UI. No subnet auto-discovery in v1 |
| Viewer access | Whole stores (optionally a whole zone), with optional per-camera restriction inside a store |
| Source repository | https://github.com/kumarsuraj84/CCTV-APPLICATION.git (nothing is pushed until the user asks) |
| Alerts (email, SMS, push) | Not in v1 |

## 3. Architecture

Containers (Docker Compose):

| Container | Role |
|---|---|
| `web` | nginx. Serves the built React app and proxies `/api` and the video WebSocket to `api`. Published on host port **3212**. |
| `api` | FastAPI. Authentication, access control, REST API, playback and backup endpoints, go2rtc WebSocket proxy. Image includes ffmpeg. |
| `worker` | Same codebase and image as `api`, different command. Runs all periodic checks and writes results to Postgres. |
| `go2rtc` | Turns camera RTSP streams into browser-playable streams. Reachable only from `api`. |
| `postgres` | PostgreSQL 16 with a named volume. Not published to the host. |

The `api` and `worker` containers need outbound access to the store LAN/VPN addresses (NVR HTTP and RTSP ports, device TCP ports). On a Linux host Compose bridge networking is enough. Docker Desktop on Windows also works for outbound TCP; ICMP ping is not available there, so TCP checks are the default (see section 6).

Repository layout:

```
backend/        FastAPI app, worker, Alembic migrations, tests
frontend/       React + TypeScript + Vite app
deploy/         docker-compose.yml, nginx.conf, go2rtc.yaml, .env.example
docs/           specs, plans, reference report
reference/      legacy cctv-hub source (read-only reference)
```

Backend module boundaries (each testable alone):

- `auth`: password hashing, JWT issue/verify, current-user dependency.
- `access`: `visible_cameras(user)` and `visible_stores(user)`. Every endpoint that returns or opens a camera goes through these.
- `nvr`: ISAPI client (channel list, channel status, recording search, daily distribution, download). Pure functions parse XML so they can be tested with sample responses.
- `rtsp`: RTSP DESCRIBE probe with Digest/Basic fallback.
- `monitor`: check scheduling, state transitions, outage open/close.
- `uptime`: uptime percentage and "down since" derived from outage periods.
- `streams`: go2rtc registration and the authenticated WebSocket proxy.
- `playback`, `backup`, `reports`, `groups`, `imports`, `users`: one router each.

## 4. Data model (PostgreSQL, Alembic migrations)

- `users`: id, username (unique), password_hash, role (`admin | viewer`), can_manage_groups, active, created_at, last_login_at.
- `stores`: id, code (unique), name, city, zone, state (normalised: `JH` and `Jharkhand` become one value), NVR ip, rtsp_port, http_port, nvr_username, nvr_password (Fernet-encrypted), expected_channels.
- `cameras`: id, store_id, channel, name, camera_ip, unique (store_id, channel).
- `devices`: id, store_id (nullable), type (`nvr | server | attendance | footfall | other`), name, ip, tcp_port (nullable), notes, optional encrypted credentials, enabled.
- `check_state`: one current row per monitored target (camera or device or store NVR): status (`up | down | unknown`), last_checked_at, last_up_at, down_since, consecutive_failures, method, error.
- `outages`: id, target_type, target_id, started_at, ended_at (null while open). Source of truth for uptime.
- `user_store_access`: user_id, store_id.
- `user_zone_access`: user_id, zone. A zone grant is expanded to its stores at query time, so new stores in the zone are included automatically.
- `user_camera_access`: user_id, store_id, channel. If a user has any rows for a store, they see only those cameras in it; otherwise they see all cameras in the store.
- `camera_groups`, `camera_group_items`: named camera sets, as in the legacy app.
- `backup_jobs`: id, requested_by, status, counters, errors, created_at (jobs survive an API restart).
- `audit_log`: id, user_id, action, detail, at. Records logins, failed logins, user and access changes, imports, backups.

## 5. Access control

- Login is a username and password submitted to `/api/auth/login`; the API returns a short-lived JWT. The legacy browser Basic-auth prompt is removed.
- A first admin is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD` environment variables on first start if no admin exists. No default password ships in the repo.
- Roles: `admin` can do everything. `viewer` can only view, within granted scope. `can_manage_groups` lets a viewer edit camera groups.
- Visibility rules:
  - Stores visible = granted stores plus stores in granted zones.
  - Cameras visible in a store = the camera-level subset if one exists for that user and store, otherwise all of the store's cameras.
  - Devices (servers, attendance, footfall) are visible for stores the user can see. Devices with no store are admin-only.
- Enforcement is in the backend: the list, live, playback, group, report and export endpoints all call `visible_cameras` or `visible_stores`. Direct requests for a camera outside scope return 404.
- The video WebSocket takes a token that names the user and one stream. The proxy checks the user still has access to that camera before connecting to go2rtc. (The legacy app let any logged-in user open any stream by name.)
- Admin-only: import, add/edit/delete stores and devices, user and access management, backup, triggering a check run, report debug.
- NVR and device passwords are encrypted with a Fernet key from `.env`. The key is never in the image or the repo.

## 6. Monitoring

All checks run in the `worker`.

| Target | Method | Interval |
|---|---|---|
| Servers, attendance, footfall, other devices | TCP connect to `tcp_port`; if no port is set, ICMP ping | 60 s |
| NVR reachability | TCP connect to the NVR RTSP port | 60 s |
| Cameras of a store | ISAPI `InputProxy/channels/status` from the NVR; cameras the NVR does not report as online are re-checked with an RTSP DESCRIBE on the sub-stream | 300 s |

- Concurrency is limited (about 10 stores at a time, 4 RTSP probes per store), matching the legacy defaults.
- A target is marked `down` after 2 consecutive failures and `up` on the first success. This avoids flapping on a single dropped probe.
- A transition to `down` opens an `outages` row; a transition to `up` closes it.
- If the NVR is down, its cameras are `down` for the same period and the outage is attributed to the NVR, not counted again as separate camera failures in the dashboard summary.
- Uptime % over 24h, 7d or 30d is the window minus the overlap with outages, divided by the window. The worker writes a heartbeat; windows when the worker itself was not running are excluded from the uptime calculation and shown as "no data".
- An admin can trigger an immediate full check ("check now") and see progress.
- Camera discovery (the legacy "find cameras" action) reads the camera names and channels from the NVR and fills `cameras`.

## 7. Live feeds, playback, backup, reports

- **Live:** the API registers main and sub streams for the cameras a user opens in go2rtc, and the browser connects through the authenticated WebSocket proxy. Streams are named by camera id.
- **Playback:** calendar of days with recordings, a 24-hour timeline of recorded segments, and a recorded clip window. Normal-speed playback goes through go2rtc RTSP; 2x/4x/8x goes through NVR download piped through ffmpeg to fragmented MP4. The NVR time offset setting from the legacy app is kept.
- **Backup:** admin selects cameras and a time range; the API downloads recordings from the NVR to a mounted backup directory with one download per NVR at a time. Progress comes from `backup_jobs`.
- **Reports:** store-wise and group-wise live/offline counts, and an offline-cameras list with "offline since" and "last seen online", exportable as `.xlsx` (same sheets as the legacy report plus a Devices sheet). Reports only include what the requesting user may see.

## 8. Frontend

React + TypeScript + Vite, calling the REST API under `/api`. Screens:

1. Login.
2. Dashboard: totals by device type, zone and store; live vs offline; stores with the NVR down; recent outages.
3. Stores list and store detail with a camera grid showing status and uptime.
4. Live wall: grid of sub-streams, click for main stream, open one camera in its own window.
5. Playback.
6. Devices (servers, attendance, footfall, other).
7. Camera groups.
8. Reports with the Excel export and the offline list.
9. Backup (admin).
10. Users and access (admin): create users, set role, grant stores, zones and cameras.
11. Import (admin): stores CSV and devices CSV, with row-level errors shown.

The UI is responsive and usable on a laptop and a tablet. The brand name, subtitle, colour and logo come from the existing `brand.json` and `logo` convention. UI language is English by default with a Hindi option.

## 9. Import formats

- Stores CSV: the same columns as the legacy `stores_sample.csv` (`name, city, zone, ip, port, http_port, user, password, channels`) plus optional `code` and `state`. Re-importing updates matching stores.
- Devices CSV: `name, type, store_code, ip, port, notes`. Rows with an unknown type or store, or an invalid IP, are reported with their line numbers and skipped; valid rows are imported.

## 10. Error handling

- Check failures are recorded on the target (`error`, `method`) and never crash the worker; one failing store does not stop the others.
- NVR authentication and permission errors are stored and shown as such, so "NVR refused the login" is distinguishable from "NVR unreachable".
- API errors use a consistent JSON shape with a clear message. The UI shows the message and keeps the user's input.
- The API refuses to start without `FERNET_KEY`, `JWT_SECRET` and `DATABASE_URL`.

## 11. Testing

- **Unit (pytest):** access rules (store, zone, camera-subset, ungranted, admin), outage open/close and the 2-failure rule, uptime calculation including worker-gap exclusion, ISAPI XML parsing against saved sample responses, CSV validation, password hashing and JWT.
- **Integration:** a fake NVR (small mock ISAPI HTTP server) and a fake TCP device in the test run, with a real Postgres in Compose. Covers discovery, status checks, playback search and a backup run.
- **API:** endpoint tests confirming a viewer cannot read, stream, play back or export a camera outside their scope.
- **Frontend:** component tests for the access-management screen and the dashboard; the Compose stack is run end to end and exercised in a browser.
- **Not covered:** real Hikvision hardware, real store networks, WebRTC/RTSP behaviour over the VPN. These need a check on a real store after deployment.

## 12. Configuration (`deploy/.env`)

`DATABASE_URL`, `POSTGRES_PASSWORD`, `FERNET_KEY`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `PUBLIC_PORT=3212`, `GO2RTC_URL`, `PLAYBACK_OFFSET_MIN`, `DEVICE_CHECK_SEC=60`, `CAMERA_CHECK_SEC=300`, `BACKUP_DIR`. `.env` is git-ignored; `.env.example` is committed with placeholders.

## 13. Build order

1. Repo foundations: Compose stack, Postgres, migrations, config.
2. Auth, users, roles and access rules, with tests.
3. Stores, cameras and devices: CRUD and CSV import.
4. NVR/RTSP clients and the monitor worker with outages and uptime.
5. Dashboard, stores and devices screens.
6. Live feeds with the authenticated proxy.
7. Playback and fast playback.
8. Backup.
9. Reports and Excel export.
10. Hardening: audit log, rate limiting on login, end-to-end run in Compose.

## 14. Out of scope for v1

Alerts and notifications, subnet auto-discovery, non-Hikvision camera protocols (the legacy app is Hikvision ISAPI/RTSP only), mobile apps, automatic migration of data from the old SQL Server database (stores are re-imported from CSV).

## 15. Open items to confirm on real hardware

- Whether all NVRs expose `InputProxy/channels/status` over ISAPI (the legacy report logic assumes so, with RTSP fallback).
- Docker host choice (Linux recommended; on Windows Docker Desktop, ICMP checks are unavailable).
- Retention for `outages` and `audit_log` (default: keep everything; revisit after the first month of data).
