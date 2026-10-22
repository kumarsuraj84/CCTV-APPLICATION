# CityKart Network Monitoring Hub

Monitors CCTV cameras, NVRs, servers, attendance machines, footfall counters and any other IP device,
with live camera feeds and per-user access to stores and cameras. Built on the Citykart Desk stack
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

Integration tests only run against the local stack (port 55321) and never touch a real store.

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
    npm run demo:seed                 # DEMO organisation: 3 stores, 14 cameras, 4 devices, one demo user per role
    npm run worker                    # in another window
    npm run dev

`demo:seed` works on the local stack only. It creates one demo person for each role, with the e-mail
`demo.<role>@demo.example.test` (`demo.user`, `demo.agent`, `demo.manager`, `demo.admin`, `demo.platform-owner`). Their passwords are made up
when you run it and printed **once**, in the terminal; they are not saved anywhere. If you lose them, run `npm run demo:seed -- --fresh` for new ones.
Everything it creates points at 127.0.0.1 and lives in its own organisation. Stop the worker, then
`npm run demo:seed -- --reset` removes that organisation and nothing else (`-- --fresh` removes and adds it again).
Sign in as the demo administrator, press **Find cameras** for DEMO1 on Manage stores, then **Check now** on Monitoring.

## Video gateway and go2rtc

Live video goes camera/NVR -> go2rtc -> gateway -> browser. The gateway is a small process that checks a signed stream token and then passes the
video through; it is the only video address a browser can reach.

    npm run stack:up        # starts go2rtc in Docker (image alexxit/go2rtc:1.9.9)
    npm run gateway         # the gateway on port 3213; needs STREAM_TOKEN_SECRET in .env.local
    npm run stack:down      # stops and removes go2rtc

| Port | What | Reachable from |
| --- | --- | --- |
| 3213 | gateway: `GET /g/health`, `GET /g/video-stream.js`, `GET /g/video-rtc.js`, WebSocket `/g/ws?token=...` | the network (browsers) |
| 1984 | go2rtc API | this machine only (127.0.0.1) |
| 8555 | go2rtc WebRTC (not used: live video goes through the gateway WebSocket) | this machine only (127.0.0.1) |

Settings (`.env.example` lists them): `GO2RTC_URL` (default `http://127.0.0.1:1984`), `GATEWAY_PORT` (default 3213) and
`GATEWAY_ALLOWED_ORIGINS` (the web app address(es), comma separated, default `NEXT_PUBLIC_APP_URL`).

The web app reads `NEXT_PUBLIC_STREAM_GATEWAY_URL` (the gateway address a browser can reach, for example `http://localhost:3213`; it is built into the pages, so restart `npm run dev` or rebuild after changing it). The **Live** page loads the player script from `<that address>/g/video-stream.js` and opens its sockets there, so the web app address must also be in `GATEWAY_ALLOWED_ORIGINS`, exactly as a browser spells it (scheme, host and port, no path). If it is not, tiles say "Video is not available right now."

**Live wall** (`/live`, `/live?store=<id>`, `/live?group=<id>`, `/live?camera=<id>`): the web app asks for the cameras the signed-in person may see (at most 36 per request, 30 requests per person per minute), registers each in go2rtc and hands the browser one signed token per camera; nothing else about the camera, and never its password or RTSP address, reaches the browser. Tokens last 10 minutes and are renewed every 8 minutes while the tab is open; pictures stop while the tab is hidden. Needs `STREAM_TOKEN_SECRET`; without it the page says live video is not set up.

**Demo video** (no real cameras): set `DEMO_VIDEO=1` in `.env.local` (development only; it is ignored when `NODE_ENV=production`). A store whose NVR address is this computer (`127.0.0.1`, as the demo stores are) then shows go2rtc's generated test picture instead of a camera. It needs `npm run stack:up` and the `rtsp` listener in `deploy/go2rtc.yaml` (127.0.0.1:8554 inside the container, not published).

- A video socket is accepted only with a valid, unexpired token and an `Origin` that is in `GATEWAY_ALLOWED_ORIGINS`; anything else is closed (code 1008).
- The go2rtc stream name comes from the signed token only. Nothing the browser sends can choose a stream, and go2rtc's address and error texts never reach a browser.
- At most 300 sockets at once (100 per address), 240 connection attempts per address per minute, 4 MB per message; a session lasts at most 30 minutes (the page reconnects with a new token). A token only has to be valid when the connection is made (10 minutes), so deactivating a person takes effect on their next connection, not on a video already running.
- A browser may only send the player's start requests (`mse`, `mp4`, `mjpeg`) to go2rtc; anything else closes the socket. The player scripts are served with `Access-Control-Allow-Origin` for the listed web app addresses only.
- The log has outcomes only (no tokens, stream names or people). Stop the gateway with Ctrl+C; it closes all sockets within 5 seconds.
- Behind a proxy or load balancer the per-address limit sees the proxy's address. Put the gateway where browsers reach it directly, or move the limit to the proxy.
- go2rtc's API (127.0.0.1:1984) has no password and can run commands (`exec:` sources), so it must never be exposed beyond this machine: do not publish ports 1984 or 8555 on other interfaces and do not put a proxy in front of them.
- The stream token travels in the query string of the WebSocket address, so any reverse proxy or load balancer in front of the gateway must not log query strings.
- The go2rtc config file is mounted read-only on purpose: camera addresses and passwords are sent to go2rtc at run time and are never written into it. With a read-only file go2rtc answers 400 to a stream change after applying it in memory, so the app reads the stream list back to confirm every change instead of trusting the status. The image is pinned by digest in `deploy/docker-compose.dev.yml`; the container logs are rotated (3 x 10 MB).

## Safety rules

No passwords, keys or tokens in the repository, logs or chat. NVR passwords live only in Supabase Vault.
Do not connect to production systems from a development machine.
