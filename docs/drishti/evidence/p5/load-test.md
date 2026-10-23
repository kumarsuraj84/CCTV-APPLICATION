# Release 1 load test (P5.5): media path and metadata scale

Two separate tests, because they load different parts of the system: the **media path** (browser → gateway → go2rtc, with the access
registry in the database) and the **metadata scale** (the screens' database reads, the access rules and the monitoring worker at the size
of the owner's estate). Everything ran on the developer PC against the local database, with **synthetic `test-…` organisations made and
removed by the tests** (the run's ledger checks nothing is left) and **fakes on loopback only**. The owner's organisation, its 216 NVRs
and its cameras were never contacted or read by these tests.

Commands (both write their JSON result next to this file):

```
npx vitest run tests/load/media-path.load.test.ts                     # CI mode: 10 s ramp, 60 s hold
LOAD_MODE=full npx vitest run tests/load/media-path.load.test.ts      # full: 60 s ramp, 10-minute hold
npx vitest run tests/load/metadata-scale.load.test.ts                 # CI mode: 60 s of 25 viewers
LOAD_MODE=full npx vitest run tests/load/metadata-scale.load.test.ts  # full: 5 minutes of 25 viewers
```
(PowerShell: `$env:LOAD_MODE='full'; npx vitest run …`.) Options: `LOAD_SUB`, `LOAD_MAIN`, `LOAD_VIEWERS`, `LOAD_HOPS=0` (no proxy).

## Machine

Intel Core i9-14900KS (24 cores, 32 threads), 128 GB RAM (about 90 GB free at the start), Windows 11 Pro 10.0.26200, Node.js 24.14.0,
local Supabase stack in Docker (PostgreSQL 17.11, PostgREST 16.4) on the same PC. The owner's development server, gateway and go2rtc
kept running on the same PC during the runs (idle). A production server will be smaller; the numbers below are per-request costs on a
fast machine, not a capacity promise.

## Media path

### Workload
- **100 sub-streams + 20 main streams = 120 concurrent video sockets**, 10 viewers (each a signed-in person with `cctv.live`, 10 sub
  and 2 main streams each, under the per-person cap of 25), one camera per stream.
- Each viewer asks for its wall the application's way (`openStreams`: the capability check, media sessions in the real database, 90 s
  tokens), then opens one WebSocket per tile to the **real gateway** (`lib/streams/gateway.ts`) and sends the player's first message.
- The gateway runs **in its own process** (CPU and memory measured apart from the load generator) with the production registry client
  (PostgREST, the gateway's database role; in development the service-key fallback) and the **production check interval of 15 s**.
- Behind the gateway, a **fake go2rtc video endpoint** on loopback answers the player's request and sends filler fragments at camera-like
  rates: sub 512 kbit/s at 15 fps, main 2 Mbit/s at 25 fps, a 5x key frame every 2 s (about 90 Mbit/s offered in all).
- Every socket carries the X-Forwarded-For address the TLS proxy (Caddy) would add, one address per viewer, and the gateway trusts one
  proxy hop — the production layout of `docs/drishti/runbook-tls.md` (see the defect below).
- Ramp: viewers join one after another over the ramp time. Hold: 60 s (CI) or **10 minutes** (full). Half-way through the hold one
  viewer's grant is revoked (`revoke_grant`): its 12 sockets must close with 4403 within 20 s while the other 108 go on.

### Results

| | CI (60 s hold) | **Full (10-minute hold)** |
|---|---|---|
| Session start (wall request → first video fragment), p50 / p95 / p99 / max | 138 / 187 / 203 / 204 ms | **141 / 184 / 200 / 200 ms** |
| — token issue (`openStreams`, one call per wall), p50 / p95 | 35 / 54 ms | 38 / 60 ms |
| — socket open (upgrade), p50 / p95 | 4 / 17 ms | 4 / 18 ms |
| — open → first fragment (registry open + upstream connect), p50 / p95 | 90 / 107 ms | 91 / 104 ms |
| Failures (a stream that never started) | 0 of 120 | **0 of 120** |
| Dropped sessions during the hold | 0 | **0** |
| Stalls (> 3 s without a fragment) / silent at the end | 0 / 0 | **0 / 0** |
| Fragments per second received (sub / main), p50 | 15.0 / 25.1 | 15.0 / 25.0 |
| Throughput through the gateway (average incl. ramp) | 77 Mbit/s | 79 Mbit/s |
| Revocation under load: 12 sockets closed with 4403 after | 13.0 s (all 12) | **13.1 s (all 12)** |
| Gateway CPU (% of one core, 2 s samples), p50 / p95 / max | 9 / 27 / 31 % | **8 / 29 / 50 %** |
| Gateway memory RSS idle → under load p50 / max | 77 → 108 / 142 MB | **77 → 124 / 171 MB** (heap 27 MB, flat over 10 min) |
| Gateway event-loop delay p99 (Windows timer floor ≈ 16 ms) | 17–35 ms | 16–22 ms |
| Registry `media_session_open` per socket, p50 / p95 / max | 10 / 28 / 37 ms | 14 / 29 / 38 ms |
| Registry `media_sessions_still_valid` for all 120 sockets, p50 / p95 (one call every 15 s) | 51 / 55 ms | 57 / 65 ms (44 checks) |
| Token check (HMAC-SHA256 + parse) per socket | 3.1 µs | 3.1 µs |

Files: `load-media-ci.json`, `load-media-full.json`.

### Defect found and fixed: the per-address limits counted the whole estate as one address behind the TLS proxy
Behind the one HTTPS address (Caddy on the same server, `GATEWAY_HOST=127.0.0.1`), every browser's socket reaches the gateway from
127.0.0.1. The gateway's per-address limits (100 open videos, 240 connection attempts a minute) therefore applied to **all users
together**: the 101st concurrent video anywhere in the estate was refused with "Too many open videos from this address.", and wall
reconnects of all users shared one 240-a-minute budget. Measured with the same workload and the gateway ignoring X-Forwarded-For
(`LOAD_HOPS=0`, the behaviour before the fix): **20 of the 120 streams refused (1013)** — `load-media-ci-no-proxy-hops.json`.
**Fix (Important):** `createGateway({ trustedProxyHops })` and `TRUSTED_PROXY_HOPS` for the gateway service (as for the web app): with
one trusted hop the limits count the client address the proxy writes (the last X-Forwarded-For entry), only for sockets that come from
this computer; anything else (no header, not an address, a direct client) counts as the socket's own address. Tests in
`tests/integration/gateway.test.ts` (written first, seen red). **Operator action:** `gateway.env` needs `TRUSTED_PROXY_HOPS=1` behind
Caddy (the generated production files and `deploy/production.env.example` belong to P5.4, whose fix round was in flight: handed over).

## Metadata scale

### Workload
- A synthetic organisation of the estate's size: 6 regions × 5 clusters, **216 locations** (200 in clusters, 16 without), one NVR each,
  **4,637 cameras** (channels 1–22), NVR logins in the Vault.
- **Monitoring round** first: the worker's own code (`MonitorRunner`, production settings: 10 NVRs at a time, 4 RTSP checks per NVR, 8 s
  NVR timeout, 3 s TCP timeout) in the test process, scoped to this organisation with a test lease and without writing the shared worker
  row. The NVRs point at fakes on loopback: 8 fake NVRs that answer (channel 17 offline), 2 that never answer their web port (11 NVRs
  hang until the 8 s timeout, their cameras are then checked by RTSP), and 11 NVRs with nothing listening (down).
- **25 signed-in viewers** — 10 organisation-wide control-room operators with the IT view, 5 region, 5 cluster and 5 location viewers
  (CCTV only) — in a closed loop with 1 s think time, each cycle reading what their screens read, through PostgREST as the person: the
  access summary, the Live landing tree, Home (dashboard + roll-ups), the Locations list, one location page with its camera states and a
  cluster wall (`lib/queries/*`). The real pages refresh every 60 s; this loop is about **50 times** the request rate of 25 real people.
- `EXPLAIN (ANALYZE, BUFFERS)` of the key views and functions as an organisation-wide viewer and as a cluster viewer, in a rolled-back
  transaction (`load-metadata-explain.txt`).

### Results

| Screen (server-side reads, as the person), p50 / p95 / p99 ms | CI (60 s, 1,248 cycles) | **Full (5 min)** |
|---|---|---|
| Access summary (`my_access_summary`, every request) | 4 / 19 / 34 | 4 / 24 / 43 |
| Live landing (region → cluster → location tree with roll-ups) | 17 / 48 / 83 | 16 / 54 / 83 |
| Home (dashboard + roll-ups) | 48 / 130 / 176 | 48 / 139 / 167 |
| Locations list (locations + status) | 15 / 38 / 57 | 15 / 39 / 61 |
| One location page (cameras + their states) | 39 / 94 / 141 | 45 / 101 / 140 |
| Cluster wall (≈ 150 cameras) | 47 / 95 / 155 | 55 / 104 / 166 |
| Errors | 0 | **0** (6,175 cycles) |

Budget asserted: p95 under 1 s per screen (P4-L1 measured single requests under 300 ms). The numbers are the reads only, not the
rendering of the page by Next.js; page rendering was not load-tested (see below).

EXPLAIN execution times (full run, after the monitoring round, so `check_state` holds the states of the round):

| As | `location_status` | `status_rollups('cctv.live')` | `recorder_status` | `cameras` (row security) | `my_access_summary()` | `cameras_with_capability` (25 ids) |
|---|---|---|---|---|---|---|
| Organisation-wide viewer | 16.5 ms | 15.1 ms | 1.2 ms | 4.4 ms | 1.8 ms | 6.3 ms |
| Cluster viewer | 5.6 ms | 7.4 ms | 0.9 ms | 2.0 ms | 0.9 ms | 2.4 ms |

At this size the planner reads `locations`, `recorders`, `assets`, `cameras` and `check_state` with sequential scans (hash joins on the
organisation's rows; the local database also holds the owner's estate, so every scan reads both organisations, about 9,300 cameras) and
uses `check_state_status_idx` and `cameras_id_org_key` where it pays. All of it is linear in the number of cameras: at 4,637 cameras the
heaviest read (the organisation-wide `location_status`) takes 16 ms. An estate several times larger should be measured again.

**Worker round** (216 NVRs, 4,637 cameras): devices and NVR round 0.1 s; **cameras round 16.3–16.4 s** (both rounds, CI and full), about 283 camera
results per second, well inside the 300 s camera interval. The 11 hanging NVRs dominate it (8 s each, 10 at a time). After two rounds:
11 NVRs down (their cameras "recorder not reachable"), 3,970 cameras up, 667 down (channel 17 offline, the hanging NVRs' cameras
confirmed by RTSP, the down NVRs' cameras).

Files: `load-metadata-ci.json`, `load-metadata-full.json`, `load-metadata-explain.txt`.

## Limits

- Fakes only: the media fragments are filler bytes at fixed rates, sent by a fake go2rtc; the NVRs answer from a fake ISAPI server.
  The test proves the gateway, the registry, the access checks and the worker at this size, **not** video.
- One machine for everything (database, gateway, load generator): no network between the parts, so latencies are lower than over a LAN
  and the database is not shared with other load.
- The live wall's one-minute token renewal and eight-minute full reopen were not simulated during the media hold (the sockets stay open;
  renewal is a database call per wall per minute, measured as `openStreams` cost above).
- 120 sockets is the planned concurrency of Release 1; the gateway's own global cap is 300 sockets (`maxSockets`), the per-person cap 25.
  Beyond that was not measured.
- Windows: timers tick about every 15.6 ms, which is the floor of the event-loop delay figures; the fake upstream sends by the clock to
  keep the bitrate exact.

## Not measured (honest)

- **Real NVR bandwidth and behaviour**: Hikvision firmware, real RTSP sessions, how many sub/main streams one NVR serves at once, NVR CPU.
- **Real go2rtc remuxing** of real camera video (go2rtc was a fake here; P4-L1's screenshots used go2rtc's generated test picture).
- **Real WAN / SD-WAN / VPN links** to the stores: latency, loss, bandwidth per location; the 8 s NVR timeout against slow links.
- **H.265** cameras and browser decoding of 120 tiles (CPU/GPU of the viewing PCs).
- Next.js page rendering under load (the server-side reads were measured, not the HTML rendering), and the TLS proxy (Caddy) itself.
- Endpoint-agent traffic and Wi-Fi job orchestration (later releases).

These remain unvalidated until the **supervised pilot** at a real location (the first live step in production), then rollout by cluster.
