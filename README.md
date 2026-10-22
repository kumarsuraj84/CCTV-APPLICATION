# CityKart Drishti (CKDRISHTI)

CityKart Drishti (formerly "CityKart Network Monitoring Hub"; the npm package name `cctv-hub` is unchanged). Monitors CCTV cameras, NVRs, servers, attendance machines, footfall counters and any other IP device,
with live camera feeds and per-user access to locations (stores, head office, distribution centres, warehouses) and cameras. Built on the Citykart Desk stack
(Next.js 16, Supabase/PostgreSQL, shadcn/ui). The app listens on **port 3212**.

- Design: `docs/superpowers/specs/2026-10-21-network-monitoring-hub-design.md`
- Plans: `docs/superpowers/plans/`
- Legacy app kept for reference only: `reference/cctv-hub-legacy/`

## First run (needs Node 20+ and Docker)

    npm install
    npm run db:start        # local Supabase on ports 55321-55324 (first run downloads images)
    npm run db:reset        # applies the migrations and the seed organisation
    npm run env:local       # writes .env.local (git-ignored) with generated keys and secrets
    node scripts/create-dev-admin.mjs
    npm run dev             # http://localhost:3212

The dev admin's e-mail and password are in `.env.local` (`DEV_ADMIN_EMAIL`, `DEV_ADMIN_PASSWORD`).

## Checks

    npm run typecheck
    npm run lint
    npm run test:unit
    npm run test:integration   # needs the local Supabase stack; uses disposable organisations

Integration tests only run against the local stack (port 55321) and never touch a real location.

## Monitoring (worker)

The checks run in a separate process, the worker, next to the web app:

    npm run worker          # checks devices and NVRs every 60 s, cameras every 300 s; Ctrl+C stops it cleanly
    npm run worker:dev      # same, restarts when the code changes

- It answers "Check now" requests within a few seconds and shows its progress on the **Monitoring** page (administrators).
  Operators, administrators and platform owners may press **Check now**; managers and viewers may not.
- `GET /api/health` says whether the database and the worker are alive (`ok` or `degraded`). It carries no names, counts or error details.
- Time while the worker was not running is never counted as downtime.
- Only one worker may run against a database at a time.
- **Integration tests must not run while a worker uses the same database**: both write the single `worker_state` row. Stop the worker first.

### Demo without any hardware

    npm run fake:nvr                  # pretend NVR, camera port and devices, on 127.0.0.1 only (add --flip, --port=NNNN)
    npm run demo:seed                 # DEMO organisation: 3 locations, 14 cameras, 4 devices, one demo user per role
    npm run worker                    # in another window
    npm run dev

`demo:seed` works on the local stack only. It creates one demo person for each role, with the e-mail
`demo.<role>@demo.example.test` (`demo.user`, `demo.operator`, `demo.manager`, `demo.admin`, `demo.platform-owner`). Their passwords are made up
when you run it and printed **once**, in the terminal; they are not saved anywhere. If you lose them, run `npm run demo:seed -- --fresh` for new ones.
Everything it creates points at 127.0.0.1 and lives in its own organisation. Stop the worker, then
`npm run demo:seed -- --reset` removes that organisation and nothing else (`-- --fresh` removes and adds it again).
Sign in as the demo administrator, open **Locations and NVRs**, press **Find cameras for all** (or open DEMO1 and its NVR and press **Find cameras**), then **Check now** on Monitoring. The old addresses `/stores`, `/stores/<id>` and `/admin/stores` still work: they redirect to `/locations`, `/locations/<id>` and `/admin/locations` (ruling T-1).

## Video gateway and go2rtc

Live video goes camera/NVR -> go2rtc -> gateway -> browser. The gateway is a small process that checks a signed stream token and then passes the
video through; it is the only video address a browser can reach.

    npm run stack:up        # starts go2rtc in Docker (image alexxit/go2rtc:1.9.9)
    npm run gateway         # the gateway on port 3412; needs STREAM_TOKEN_SECRET in .env.local
    npm run stack:down      # stops and removes go2rtc

| Port | What | Reachable from |
| --- | --- | --- |
| 3412 | gateway: `GET /g/health`, `GET /g/video-stream.js`, `GET /g/video-rtc.js`, WebSocket `/g/ws?token=...` | the network (browsers) |
| 1984 | go2rtc API (with its own login since P2-6) | this machine only (127.0.0.1) |

go2rtc's WebRTC listener (8555) is off and no longer published (P2-6, D-13: live video goes through the gateway WebSocket).

Settings (`.env.example` lists them): `GO2RTC_URL` (default `http://127.0.0.1:1984`), `GATEWAY_PORT` (default 3412) and
`GATEWAY_ALLOWED_ORIGINS` (the web app address(es), comma separated, default `NEXT_PUBLIC_APP_URL`). The gateway also needs the
database address (`SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL`) and, since P2-6, its own database key `SUPABASE_VIDEO_GATEWAY_KEY`
(role `video_gateway`: it may call media_session_open, media_sessions_still_valid and media_session_close and nothing else; in
development without it the gateway falls back to `SUPABASE_SERVICE_ROLE_KEY` with a warning, in production it does not start): it
checks every video connection in the media session registry and does not start without it. go2rtc's API login
(`GO2RTC_API_USERNAME`, `GO2RTC_API_PASSWORD`) is sent by the web app and the gateway; `npm run stack:up` passes the same two to the
go2rtc container from `.env.local` (`--env-file`). `node scripts/gen-secrets.mjs` makes all of these keys without printing them
(`docs/drishti/runbooks/secret-rotation.md`). `GET /g/health` answers
JSON with the number of open video sessions and the age of the last access check (no ids, people or addresses); the Monitoring page
shows it (`GATEWAY_HEALTH_URL` overrides the address the web server uses to read it).

The web app reads `NEXT_PUBLIC_STREAM_GATEWAY_URL` (the gateway address a browser can reach, for example `http://localhost:3412`; it is built into the pages, so restart `npm run dev` or rebuild after changing it). The **Live** page loads the player script from `<that address>/g/video-stream.js` and opens its sockets there, so the web app address must also be in `GATEWAY_ALLOWED_ORIGINS`, exactly as a browser spells it (scheme, host and port, no path). If it is not, tiles say "Video is not available right now."

**Live wall** (`/live`, `/live?location=<id>` (the older `?store=<id>` still works), `/live?group=<id>`, `/live?camera=<id>`): the web app asks for the cameras the signed-in person may see (at most 36 per request, 30 requests per person per minute), registers each in go2rtc and hands the browser one signed token per camera; nothing else about the camera, and never its password or RTSP address, reaches the browser. A token opens a socket within 90 seconds and names its own media session; tokens are renewed every minute while the tab is open; pictures stop while the tab is hidden. Needs `STREAM_TOKEN_SECRET`; without it the page says live video is not set up.

**Demo video** (no real cameras): set `DEMO_VIDEO=1` in `.env.local` (development only; it is ignored in production mode, `DRISHTI_ENV=production` or `NODE_ENV=production`, where the processes refuse to start with it). A location whose NVR address is this computer (`127.0.0.1`, as the demo locations are) then shows go2rtc's generated test picture instead of a camera. Start go2rtc with `npm run stack:up:demo` (stop it with `npm run stack:down:demo`) instead of `stack:up`: it adds `deploy/go2rtc.demo.yaml`, which has the RTSP listener the generated picture needs (127.0.0.1:8554 inside the container, not published). The normal `deploy/go2rtc.yaml` has no RTSP server.

**Fast playback** (optional, 2x, 4x and 8x on the Playback screen; for now only administrators and platform owners are offered it) needs **ffmpeg** on the machine that runs the web app (not in Docker; go2rtc has its own). Install it so that `ffmpeg -version` works for the account that runs the app and `ffmpeg` is in a full-path entry of `PATH` (empty, `.` and relative `PATH` entries are never searched), or set `FFMPEG` in `.env.local` to the FULL path of the program (one line; a bare name or a relative path is refused with a plain message; it is run directly, never through a shell; on Windows use the `.exe`, not a `.cmd` shim). Without ffmpeg the Playback screen offers an administrator only 1x and says "Fast playback is not set up on this server."; nothing else is affected. The app asks the NVR for the recording (`GET /api/vod`, signed-in administrators only, for cameras they may see), passes it through ffmpeg without re-encoding (ffmpeg may only read from the pipe and only MPEG-PS, MPEG-TS, MP4, H.264 or H.265 streams) and streams the result to a plain video element. Up to 30 minutes per request. A person has one running conversion at a time: starting a new one ends their previous one first. 8 run in all (more is refused with a plain message). A conversion stops when the page is closed, after 30 minutes, or when the NVR has sent no data for 60 seconds while it was being waited for. Whether ffmpeg works is checked when the Playback page opens and remembered for a minute. After installing ffmpeg, reload the Playback page after a minute (restart the app after changing `FFMPEG`).

- A video socket is accepted only with a valid, unexpired token and an `Origin` that is in `GATEWAY_ALLOWED_ORIGINS`, and only after the database opened the token's media session (that person, camera and stream, once, still allowed); anything else is closed (code 1008; 1013 when the database cannot be asked).
- Every open socket is checked again every 15 seconds in one database call; a socket whose person lost access (grant removed or ended, deactivated, password reset, role changed, camera or place moved or archived, NVR switched off) closes with code 4403 "Access changed". If the database cannot be asked for 45 seconds, every socket closes ("Cannot verify access").
- The go2rtc stream name comes from the signed token only. Nothing the browser sends can choose a stream, and go2rtc's address and error texts never reach a browser.
- At most 300 sockets at once (100 per address), 240 connection attempts per address per minute, 4 MB per message; a session lasts at most 30 minutes (the page reconnects with a new token). A token only has to be valid when the connection is made (90 seconds); revoked access also ends a video already running (previous point).
- A browser may only send the player's start requests (`mse`, `mp4`, `mjpeg`) to go2rtc; anything else closes the socket. The player scripts are served with `Access-Control-Allow-Origin` for the listed web app addresses only.
- The log has outcomes only (no tokens, stream names or people). Stop the gateway with Ctrl+C; it closes all sockets within 5 seconds.
- Behind a proxy or load balancer the per-address limit sees the proxy's address. Put the gateway where browsers reach it directly, or move the limit to the proxy.
- go2rtc's API (127.0.0.1:1984) can run commands (go2rtc 1.9.9 still accepts `echo:`, `expr:` and `ffmpeg:` sources through it, verified 2026-10-22) and its stream list holds NVR sources with their passwords, so it must never be exposed beyond this machine: do not publish port 1984 on other interfaces and do not put a proxy in front of it. Since P2-6 it asks for its own login (set `GO2RTC_API_USERNAME` / `GO2RTC_API_PASSWORD`), and the web app registers only `rtsp://` sources of NVRs it read from the database (plus the demo picture in development); every other source is refused before go2rtc is asked (`lib/security/targets.ts`).
- The stream token travels in the query string of the WebSocket address, so any reverse proxy or load balancer in front of the gateway must not log query strings.
- The go2rtc config file is mounted read-only on purpose: camera addresses and passwords are sent to go2rtc at run time and are never written into it. With a read-only file go2rtc answers 400 to a stream change after applying it in memory, so the app reads the stream list back to confirm every change instead of trusting the status. The image is pinned by digest in `deploy/docker-compose.dev.yml`; the container logs are rotated (3 x 10 MB).

## Safety rules

No passwords, keys or tokens in the repository, logs or chat. NVR passwords live only in Supabase Vault.
Do not connect to production systems from a development machine.

Since P2-6 (`docs/drishti/adr-service-roles.md`):

- Every process has its own database key: the web app `SUPABASE_APP_WEB_KEY` (it cannot read an NVR password) and
  `SUPABASE_MEDIA_SERVICE_KEY` (its video path), the worker `SUPABASE_MONITOR_WORKER_KEY`, the gateway `SUPABASE_VIDEO_GATEWAY_KEY`.
  `node scripts/gen-secrets.mjs` adds them (and the other secrets) to `.env.local` without printing them; then restart the gateway
  and the worker (`npm run dev` reloads `.env.local` itself). Without them development keeps working on the service key and logs
  `service_key_fallback`; production refuses. Every NVR password read is logged in `vault_reads` (who, which NVR, why; never the value).
- Production is one switch for every process: `DRISHTI_ENV=production` (`deploy/production.env.example`; `npm run worker` and
  `npm run gateway` run under tsx, which sets no NODE_ENV). Each process then checks itself at start-up and refuses with one plain line
  when its own key, a shared secret or go2rtc's login is missing, the full service key is in the worker's or gateway's environment,
  or (web app) an organisation has not locked the service key out of NVR logins; `npm run stack:up` refuses to start go2rtc there
  without its login. Development only warns.
- Outbound connections go only to the NVRs and devices of the database (or `OUTBOUND_TARGET_ALLOWLIST`), never to link-local, cloud
  metadata or other special addresses, and to this computer only in development (`lib/security/targets.ts`).
- Sign-in, password changes, administration, import, discovery, connection tests and video opening are rate limited for every app
  instance together (database `rate_limit_hit`). Sign-in waits longer after each wrong password (from the third: 5 s, 10 s, ... at most
  5 minutes) instead of locking the account. The client address is believed only behind `TRUSTED_PROXY_HOPS` trusted proxies.
- Rotation of every secret: `docs/drishti/runbooks/secret-rotation.md`.
