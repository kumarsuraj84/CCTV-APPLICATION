# CCTV Hub — Project Handoff (architecture, status, source code)

> **Purpose of this file:** a single, self-contained brief so another AI model (or developer) can review the project, find defects, and continue building. Everything needed is here: goals, environment, architecture, data model, API, UI behaviour, Hikvision-specific knowledge, security model, deployment, verification status, known issues, backlog, and the **full source code in the appendix**.
>
> **Snapshot date:** 21 Oct 2026 · **Sensitive:** contains internal IPs/paths of the owner's environment. No passwords or keys are included (`run.bat` holds placeholders only). Never ask the owner to paste real passwords or the `FERNET_KEY`.

---

## 1. What this project is

A **free, self-hosted, browser-based multi-store CCTV monitoring web app** that replaces paid tools (Hikvision iVMS-4200 / HikCentral / IBMS-type products) for one organisation.

| Item | Value |
|---|---|
| Owner's scale | ~200+ retail stores, **~4,603 cameras** (imported so far), Hikvision NVRs only |
| Network | Every store NVR is reachable over the company **VPN** from the server |
| Owner's goal | One screen to watch any store/camera live, play back recordings like Hikvision's own player, group cameras across stores (e.g. "Cash Counter"), see which cameras/NVRs are offline, share read-only access with a team |
| Branding | Header shows owner's logo (Citykart) + brand colour from `brand.json`/`logo.png` |
| Owner's language | **Hindi/Hinglish.** UI strings are Hindi (Chrome sometimes auto-translates them to English, which is harmless). Reply to the owner in Hindi/Hinglish, short and step-by-step. |
| How the owner works | Non-developer. Applies updates by copying files from a zip into `C:\cctv-hub`, restarting `run.bat`, pressing Ctrl+F5, and replying with **screenshots**. Previous failures were often **stale files** (browser saved `index (1).html`). Prefer small, clearly-scoped updates and verify the deployed version. |

### Hard preferences expressed by the owner (do not violate)
1. **Free / open-source only**, no paid components.
2. Playback speed must be **real fast playback (2x/4x/8x/16x)**, *not* "jump ahead N seconds" sampling and *not* split/multi-period tiles. (Both were built, then explicitly rejected and removed.)
3. Hikvision-like UX: double-click a camera → playback with a timeline; click anywhere on it to start there; calendar highlights days that have recordings.
4. Offline cameras/NVRs must be findable, searchable, show **since when**, and open in a **new window** when clicked.
5. Team members must get **limited (view-only) access**; the owner chooses who may also create/delete groups.

---

## 2. Environment (as deployed)

| Component | Detail |
|---|---|
| Server OS | Windows 10 (build 19045), AD domain `CITYKR`, host `CKPLW10CCTVMAP`, **LAN IP 10.0.0.141** |
| App folder | `C:\cctv-hub` (venv in `C:\cctv-hub\venv`) |
| Python | 3.13 (legacy `py` launcher; `setup.bat` uses `py -3 -m venv venv`) |
| DB | **SQL Server 2022** (default instance, Windows auth, DB `cctv` created manually), ODBC Driver 18 (17 also present) via `pyodbc` |
| Web server | `uvicorn app:app --host 0.0.0.0 --port 8000` (FastAPI) |
| Stream gateway | **go2rtc 1.9.14** (`go2rtc.exe`, win64) — API :1984, WebRTC :8555 (TCP+UDP). RTSP server disabled. |
| Transcode/remux | `ffmpeg.exe` placed in `C:\cctv-hub` (used only by fast-playback `/api/vod`) |
| Clients | Chrome/Edge on office PCs, same LAN/VPN, open `http://10.0.0.141:8000` |
| Firewall | Recommended rule given to the owner: TCP 8000, 1984, 8555 and UDP 8555 for `localsubnet` (whether it was applied is unconfirmed; 1984 becomes unnecessary once go2rtc is locked to localhost) |
| NVR facts seen | One NVR web UI is reachable from the owner's PC at `192.168.101.100`; its settings showed region India, **time zone UTC+05:30**, NTP server `10.0.0.11`; web UI needs a plug-in (old firmware). Main streams may be H.265 on some cameras. |
| Network restrictions | Some Microsoft redirect domains were blocked by the office network (ODBC download failed once); GitHub worked. |

Env vars read by `app.py` (set in `run.bat`):

| Var | Required | Meaning |
|---|---|---|
| `FERNET_KEY` | **yes** | Encrypts NVR passwords in DB; also seeds the WebSocket token HMAC. Losing it = stored NVR passwords unrecoverable. |
| `SQL_CONN` | **yes** | pyodbc connection string. |
| `APP_USER` / `APP_PASS` | no (defaults `admin` / `change-me` — must be changed) | The "main admin" login (always admin, cannot be deleted/edited in UI). |
| `GO2RTC_URL` | no | default `http://127.0.0.1:1984` |
| `PLAYBACK_OFFSET_MIN` | no | default 0; global fallback for NVR time convention (330 = NVR expects UTC while server is IST). Per-store override exists in the UI. |
| `BACKUP_DIR` | no | default `backups` |
| `FFMPEG` | no | default `ffmpeg.exe` (Windows) |
| `REPORT_EVERY_MIN` | no | `>0` runs the camera health check automatically every N minutes (first run 30 s after start). Default 0 = button only. |

---

## 3. Architecture

```
 Browser (Chrome/Edge)                         Windows server 10.0.0.141
 ┌──────────────────────┐   HTTP Basic auth    ┌───────────────────────────────────────────────┐
 │ index.html (single   │ ───────────────────► │ uvicorn + FastAPI  (app.py)  :8000            │
 │ file SPA, ES module) │                      │  • AuthMW (pure ASGI): roles admin / viewer   │
 │                      │ ◄── JSON / fMP4 ──── │  • REST API (stores, groups, playback, report)│
 │  video-stream.js     │                      │  • /g/* proxy to go2rtc (JS + WebSocket)      │
 │  (go2rtc player)     │ ◄══ WebSocket ═════► │  • /api/vod  → ffmpeg (fMP4 remux, stdin/out) │
 └─────────┬────────────┘   /g/api/ws?src&t    └───────┬───────────────┬───────────────┬───────┘
           │ WebRTC media (UDP/TCP :8555)               │ pyodbc        │ REST (:1984)  │ ISAPI / RTSP
           ▼                                            ▼               ▼ (localhost)   ▼
      go2rtc :8555 ◄──────────────────────────── SQL Server 2022   go2rtc.exe      Hikvision NVRs
      (WebRTC/MSE out)  RTSP pull on demand       DB `cctv`        (stream gateway)  (200+ stores, VPN)
```

**Key design decisions**
- **On-demand streaming:** 4,600 cameras can never stream at once. The app registers go2rtc streams lazily (`PUT /api/streams`) only for cameras being viewed; go2rtc connects to the NVR only while a browser consumes them. Wall tiles use the **sub-stream** (`…/Streaming/Channels/<ch>02`), fullscreen/playback use the **main stream** (`<ch>01`).
- **Playback 1x:** go2rtc pulls Hikvision RTSP playback (`/Streaming/tracks/<ch>01?starttime=…&endtime=…`) → browser via MSE/WebRTC. Time is paced in real time by the NVR.
- **Playback >1x ("fast mode"):** NVR **bulk download** (`ISAPI /ContentMgmt/download`, runs at network speed) is piped into `ffmpeg -c:v copy` → fragmented MP4 over HTTP → plain `<video>` with `playbackRate` 2–16. Chunk = one NVR recording file (≤20 min requested), next chunk is prefetched for gapless switching. Playback auto-downshifts if it stalls 3× in 40 s.
- **Credentials:** NVR passwords are Fernet-encrypted in `stores.pw`. App users are PBKDF2-SHA256 hashed (120k iterations, 16-byte salt).
- **Auth:** pure-ASGI middleware (not FastAPI global dependency, because that breaks WebSockets and BaseHTTPMiddleware breaks streaming cancellation). Browser WebSocket auth uses a short HMAC token from `/api/wstoken` (12 h).
- **go2rtc exposure:** go2rtc's API leaks NVR credentials (stream sources contain `rtsp://user:pass@…`). The app therefore **proxies** the player JS and WebSocket via `/g/*`, so go2rtc can be bound to `127.0.0.1` (`go2rtc_secure.yaml`). Rollout is staged — see §8.

---

## 4. Repository layout

| File | Purpose |
|---|---|
| `app.py` (~880 lines) | Entire backend (FastAPI): DB bootstrap, auth, API, ISAPI/RTSP helpers, report engine, VOD, users, go2rtc proxy |
| `index.html` (~660 lines) | Entire frontend: HTML + CSS + one ES-module `<script>`; no build step, no framework |
| `go2rtc.yaml` | Current go2rtc config (API on all interfaces, `origin: "*"` for CORS — legacy direct mode) |
| `go2rtc_secure.yaml` | Hardened config: API bound to `127.0.0.1:1984` (use after the proxy is verified) |
| `run.bat` / `setup.bat` | Start (go2rtc + uvicorn) / one-time venv + pip install + prints a new Fernet key |
| `requirements.txt` | fastapi, uvicorn, httpx, cryptography, python-multipart, pyodbc, openpyxl, websockets (unpinned) |
| `brand.json`, `logo.png` | Header branding (`name`, `subtitle`, `color`; logo-only header when name is empty) |
| `stores_sample.csv` | CSV template for import |
| `README.md` | **Outdated** short setup note |

Update delivery today: a zip (`cctv-update.zip`) with `app.py`, `index.html`, `requirements.txt`, `go2rtc_secure.yaml`; owner copies into `C:\cctv-hub`, restarts, Ctrl+F5.

---

## 5. Data model (SQL Server, auto-created/altered at startup in `app.py`)

| Table | Columns | Notes |
|---|---|---|
| `stores` | `id` PK identity, `name` UNIQUE, `city`, `zone`, `ip`, `port` (RTSP, 554), `http_port` (80), `username`, `pw` (Fernet), `channels` | One row per NVR/store. CSV import upserts by `name`. |
| `cameras` | `store_id`, `ch` (PK pair), `name`, `cam_ip` | `cam_ip` filled by the health check from NVR channel list. `discover()` deletes+reinserts a store's cameras (group membership survives because it references `(store_id, ch)`; `cam_ip` is refilled on next check). |
| `cam_groups` | `id` PK identity, `name` UNIQUE | e.g. "Cash Counter" |
| `cam_group_items` | `group_id`, `store_id`, `ch` (PK triple) | Cross-store camera membership |
| `app_users` | `username` PK, `pw_hash` (`salt$pbkdf2`), `role` (`admin`/`viewer`), `can_groups` BIT, `created` | Extra logins; the env admin is separate |
| `cam_status` | `store_id`, `ch` (PK), `online` BIT, `checked`, `offline_since`, `last_online` | Latest health per camera |
| `store_status` | `store_id` PK, `reachable` BIT, `method`, `err`, `checked`, `offline_since`, `last_online` | Latest health per NVR |

Not persisted: backup jobs (`JOBS` dict), report progress (`REPORT` dict), auth cache (`_AUTHC`, 10 min), per-store NVR-time mode (browser `localStorage` key `pvoff_<storeId>`).

`offline_since` semantics: **first time our check observed it offline** (preserved across checks while still offline, cleared when it returns). `last_online` = last check where it was online. The NVR itself does not expose "offline since"; accuracy = check interval (hence `REPORT_EVERY_MIN`). Right after the feature shipped, already-offline items get "first detection after update" as their start.

---

## 6. Backend API reference

Auth levels: **any** = any logged-in user; **groups** = admin or user with `can_groups`; **admin** = role admin only. All HTTP routes require HTTP Basic (ASGI middleware, 401 otherwise). WebSocket uses a token.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | any | Serves `index.html` (also `/?view=<storeId>-<ch>` = single-camera popup mode) |
| GET | `/api/me` | any | `{name, role, can_groups}` |
| GET | `/api/brand`, `/logo` | any | Branding JSON; logo image (`logo.png/jpg/jpeg/svg/webp`) |
| GET | `/api/stores` | any | Store list with camera counts (never returns credentials) |
| POST | `/api/import` | admin | CSV upload (`name,city,zone,ip,port,http_port,user,password,channels`), upsert, encrypts passwords |
| POST | `/api/stores/{sid}/discover`, `/api/discover-all` | admin | ISAPI channel discovery (names); fallback `Camera N` from `channels` |
| POST | `/api/stores/{sid}/open` | any | Registers main+sub streams in go2rtc for a store; returns names `s{sid}c{ch}_sub/_main` |
| POST | `/api/cam/open?store_id&ch` | any | Same for one camera (popup view) |
| GET | `/api/groups` | any | Groups with counts |
| POST | `/api/groups?name=` · DELETE `/api/groups/{gid}` | groups | Create/delete |
| POST | `/api/groups/{gid}/add?store_id&ch` · `/add-by-name?keyword` · DELETE `/cam?store_id&ch` | groups | Membership edits (bulk add by camera-name substring across all stores) |
| POST | `/api/groups/{gid}/open` | any | Registers streams of all group cameras |
| GET | `/api/status` | any | TCP check of every NVR RTSP port → `{storeId: bool}` (sidebar dots) |
| POST | `/api/playback` | any | Body `{items:[{store_id,ch}], start:"YYYY-MM-DDTHH:MM[:SS]", minutes, off}` → registers RTSP playback streams `pb{sid}c{ch}_{start}` |
| GET | `/api/timeline?store_id&ch&date&off` | any | Recorded segments for a day (seconds-of-day pairs) via ISAPI search; on failure returns `{segments:[], error}` |
| GET | `/api/days?store_id&ch&year&month&off` | any | Days with recordings (ISAPI `dailyDistribution`, fallback: per-day search) |
| GET | `/api/oldest?store_id&ch&off` | any | Date of oldest recording (search 400 days back) |
| GET | `/api/vod?store_id&ch&start&minutes&off` | any | **Streaming fMP4** of a recording slice (NVR bulk download → ffmpeg copy) |
| GET | `/api/vodtest` | any | Diagnostic download-speed test (currently **unused by UI**; the pre-test was removed after it falsely reported "slow") |
| POST/GET | `/api/backup` · `/api/backup/{jid}` | admin | Download recordings from NVR HDD to server disk (`BACKUP_DIR`); in-memory job status |
| POST | `/api/report/run` | admin | Start health check of all stores (10 NVRs parallel) |
| GET | `/api/report/status` · `/api/report` · `/api/report.xlsx` | any | Progress; aggregated data; Excel (Store-wise / Group-wise / Offline cameras) |
| GET | `/api/report/debug?store_id&ch` | admin | Raw ISAPI status + RTSP DESCRIBE trace for one camera (troubleshooting) |
| GET/POST/DELETE | `/api/users`, `/api/users/{name}` | admin | List / create-or-update (empty password = keep) / delete users; fields `role`, `can_groups` |
| GET | `/api/wstoken` | any | 12 h HMAC token for the WebSocket proxy |
| GET | `/g/video-stream.js`, `/g/video-rtc.js` | any | Proxied go2rtc player scripts (whitelist of two names) |
| WS | `/g/api/ws?src=<stream>&t=<token>` | token | Bidirectional proxy to go2rtc `/api/ws` (text + binary) |
| startup | scheduler | — | If `REPORT_EVERY_MIN>0`, loop health checks |

### Hikvision interfaces used
- **ISAPI (HTTP Digest, port `http_port`)**: `GET /ISAPI/ContentMgmt/InputProxy/channels` (names, camera IP `<ipAddress>`), fallback `/ISAPI/System/Video/inputs/channels`; `GET …/InputProxy/channels/status` (`<online>`); `POST /ISAPI/ContentMgmt/search` (CMSearchDescription, trackID `<ch>01`, note Hikvision's misspelt `<searchResultPostion>`); `POST /ISAPI/ContentMgmt/record/tracks/<ch>01/dailyDistribution`; `POST /ISAPI/ContentMgmt/download` (body `<downloadRequest><playbackURI>…`, URI taken from search results with `starttime`/`endtime` rewritten).
- **RTSP (port `port`)**: live `/Streaming/Channels/<ch>01|02`; playback `/Streaming/tracks/<ch>01?starttime=YYYYMMDDTHHMMSSZ&endtime=…`; health check = raw-socket `DESCRIBE` on `<ch>02` with Digest (with/without qop) or Basic.
- **Time convention (`off`)**: NVRs differ on whether the `…Z` timestamps are local or true UTC. Server converts `local - off minutes`. UI selector per store (**Local = 0**, **UTC = 330**), remembered in `localStorage`. Local worked on the NVRs tested; UTC is untested in the field. Auto-detection per store is an open improvement.
- Channel numbering assumption: `<id>` from InputProxy = `ch`; stream id = `ch*100 + stream` (`101` main, `102` sub, `1001`… for ch 10).

---

## 7. Frontend behaviour (single `index.html`)

**Main screen**
- Header: logo/brand, clock, user label (`name (admin|viewer|viewer + ग्रुप)`), **👥 Users** (admin), **📊 Camera Report**.
- Sidebar tabs **Store / Group**; search; admin tools: *CSV import*, *Find the camera*; store list with green/red/grey status dot (from `/api/status`, refreshed every 60 s).
- Toolbar: page ‹ ›, grid size (1/4/9/16/25), tour interval + **Start tour** (cycles pages, then stores — skipping stores whose NVR dot is red; inside a group it cycles that group's pages), **▶ Playback** (same time on all visible cameras; 5–480 min), **⬇ Backup** (admin), "add by name" (groups permission).
- Wall tiles (sub-stream via go2rtc `video-stream` element, modes `webrtc,mse`): **single click** → fullscreen live (main stream, 250 ms delay to distinguish from double-click); **double-click** → playback view; hover buttons "+ group" / "× remove".

**Playback view (Hikvision-style)**
- Top bar: title, status/error line (yellow), **NVR time Local/UTC**, calendar button (month grid; recorded days blue, "oldest recording" hint), ‹ › day, ⏪/⏩ 30 s, "full day" (reset zoom), close.
- Timeline (24 h): blue = recorded; hour ticks; hover shows time; **click = start playback there** (snaps to nearest recording); **mouse-wheel zoom**; **edge dwell (700 ms) at far left/right** pans (if zoomed) or switches to previous/next day (guards: not beyond today / oldest recording, re-arm only after leaving the edge). Red cursor follows playback.
- Controls: −10/−5/−1 and +1/+5/+10 min, keyboard ←/→ = ±30 s, Shift = ±5 min; **speed 1x/2x/4x/8x/16x**.
- Engines: 1x = RTSP via go2rtc. >1x = `/api/vod` fMP4 in a native `<video>` (muted, no audio) with buffer gating (play when ≥ 6 + 1.5×rate s buffered, pause below 0.5 + 0.4×rate s), next-chunk prefetch into a hidden holder, cancels old downloads (`removeAttribute('src'); load()`), auto-downshift after 3 stalls/40 s, cursor derived from `video.currentTime`.
- If timeline fetch fails, UI falls back to "whole day recorded" and shows the NVR error text.

**Camera Report overlay**
- Cards: total / live / offline / not yet checked / NVRs down / last check (offline and NVR cards are clickable tabs).
- Tabs: **Store-wise**, **Group-wise**, **Offline cameras** (only cameras whose NVR is reachable; columns incl. camera IP, NVR IP, offline since, "for how long", last seen online; row click → camera opens in a **new window** via `/?view=<sid>-<ch>`), **Offline NVRs** (row click → NVR's own web page in a new window). Search covers store, camera, group, IPs. "Only problems" filter. **Check now** (admin) with progress; **⬇ Excel**.
- Health check logic per store: TCP check of RTSP port → ISAPI `InputProxy/channels/status` → for every camera not reported online, RTSP `DESCRIBE` on the sub-stream as a second opinion (live if either says live) → camera IPs refreshed → results saved with outage timestamps.

**Users / roles**
- `admin`: everything. `viewer`: live, playback (incl. fast mode), report (read), open offline camera/NVR windows. Hidden + server-blocked for viewers: CSV import, discover, backup, *Check now*, debug, user management. **Groups create/delete/membership** are allowed for a viewer only when `can_groups` is set (single permission for create+delete+membership; applies to *all* groups, no ownership model).
- UI hides restricted controls with body classes `viewer` (`.adm`) and `nogrp` (`.grp`); the server is the real enforcement.

**Other:** popup mode `/?view=sid-ch`; brand/logo from `/api/brand`; `?direct` URL param forces the legacy direct-to-:1984 player.

---

## 8. Security model and the staged go2rtc lock-down

- Transport is **plain HTTP**; Basic-auth credentials are sent unencrypted (acceptable only on LAN/VPN; HTTPS reverse proxy is a backlog item).
- **Critical:** until go2rtc's API is bound to localhost, anyone on the network can open `http://10.0.0.141:1984/api/streams` and read NVR credentials (the owner stored **NVR admin** passwords). Rollout order given to the owner: (1) deploy update + `pip install websockets`; (2) verify video through the `/g/` proxy; (3) replace `go2rtc.yaml` with `go2rtc_secure.yaml`; (4) long-term create **read-only NVR users** and re-import the CSV. **Status: delivered, not yet confirmed by the owner.**
- No brute-force throttling, no audit log, no password-change self-service, no session expiry (Basic auth; browser holds creds until closed).
- SQL is parameterised. `esc()` is used for report/users HTML, **but the sidebar list (`drawList`) and some labels interpolate store/group names into `innerHTML` unescaped** (data comes from admin CSV; still worth fixing).

---

## 9. Build history (chronological, condensed)

1. Concept + architecture (go2rtc + FastAPI + SQL + browser), Docker/Linux first, then **ported to Windows + SQL Server** (SQLite dropped).
2. Live wall, store search, CSV import, ISAPI channel discovery, tour mode, status dots, logins.
3. Camera **groups** (cross-store), bulk "add by camera name".
4. Branding: header, logo cropping, `brand.json`, logo-only header.
5. Bug: typing blocked in search (an `onkeydown` arrow function returned `false` → default prevented) — fixed.
6. Bug: go2rtc cross-port script import blocked (needed `origin:"*"`) — later superseded by the `/g/` proxy.
7. **Playback**: RTSP playback (multi-camera), Local/UTC time toggle, **timeline** (ISAPI search), **calendar** (dailyDistribution), edge-hover day switching, jump buttons.
8. Bug: `CAM_SQL` lacked `http_port` → `KeyError` broke timeline/backup — fixed.
9. **Fast playback**: first a sampling "skim" and a "split view" (both rejected by owner, removed) → real fast mode via NVR bulk download + ffmpeg remux. Iterations: pre-speed-test (false "slow" result, removed) → buffering gate → seamless chunk prefetch → stall-based auto-downshift.
10. **Backup** feature (download recordings to server disk) — built, **never field-tested**.
11. **Camera health report** (store/group/offline views, Excel). Iteration: first run showed almost everything offline (ISAPI parse + RTSP auth gaps) → tolerant parsing, RTSP second opinion, qop-Digest/Basic, `/api/report/debug`.
12. Click-to-open offline camera (popup) / NVR page; camera IP; **offline since**.
13. **Roles** (admin/viewer), user management UI, `can_groups` permission, ASGI auth middleware, go2rtc proxy + WS tokens, `go2rtc_secure.yaml`.

---

## 10. Verification status (be honest about this when reviewing)

| Area | Status |
|---|---|
| Windows/SQL Server install, go2rtc, live wall, CSV import, discovery, brand/logo, search typing | ✅ **Confirmed working by owner** (screenshots) |
| Playback (RTSP 1x, timeline from NVR, Local time mode) | ✅ Confirmed on tested NVRs |
| Fast mode 2x–16x (`/api/vod`) | ✅ Worked after ffmpeg added; stutter reported then fixed in later builds; owner said "ab theek hai" after the false-speed-test removal. **Seamless prefetch + stall downshift: delivered, not re-confirmed** |
| Calendar highlight, edge-hover day switch | ⚠️ Delivered; no explicit owner confirmation |
| Camera report (counts) | ✅ Works (e.g. 4603 total, ~3886 live, ~717 offline, 3 NVRs down) — **not validated against ground truth**; ~1 offline camera per store looked suspicious |
| Offline popup windows, camera IP column, offline-since, Excel columns | ⚠️ Delivered; **sandbox/unit-tested logic only**, not confirmed on real data |
| Roles, user management, `can_groups`, go2rtc proxy, WS token | ⚠️ Auth middleware, role gating, WS proxy (text+binary), password hashing **tested in a sandbox with mocks**; **not yet run on the real server**; lock-down step not yet confirmed |
| Backup to disk | ❌ **Never tested** against a real NVR (output format assumption, see §11) |
| UTC time mode | ❌ Untested in the field |
| H.265 cameras | ❌ Not playable in Chrome via fast mode/RTSP→MSE; no transcode path |

---

## 11. Known issues, risks and open questions

1. **Backup:** assumes the ISAPI download returns something playable saved as `.mp4`; Hikvision often returns a PS-wrapped stream (VLC plays, Windows players may not). Could reuse the ffmpeg remux used by `/api/vod`. Jobs are in-memory (lost on restart), no cancel, `.part` files not resumed, disk-space check is informational only. Retention-wide backup of all stores is infeasible (PB scale / VPN bandwidth) — keep it selective.
2. **Fast mode** depends on the NVR allowing bulk download at high speed and on the VPN bandwidth ≈ rate × main-stream bitrate. Each chunk = first search hit only (`maxResults=1`), so event-recorded cameras (many small files) switch chunks often. Audio is dropped (`-an`). No reverse playback.
3. **Time convention** is a manual per-store toggle; a wrong choice looks like "wrong footage" or DESCRIBE errors. Auto-detect (e.g. compare latest recording end to now) is not implemented.
4. **Report accuracy:** health = ISAPI online flag OR RTSP DESCRIBE success; `ping()` only tests the RTSP TCP port; analog/hybrid channels rely on RTSP only. A full run over 200 stores takes minutes. `offline_since` is detection time, not true outage start (could be improved by querying the last recording time per offline channel).
5. **Blocking calls:** `q()` is synchronous pyodbc (new connection per call, pooling on) and is called directly from several `async` endpoints and `_report_data`; fine at this scale, but should be moved to a thread pool/connection pool.
6. **XSS hardening** for unescaped names in `drawList`/labels; **no CSRF/rate-limit/audit**; passwords in `run.bat` are plain text; no HTTPS.
7. `discover()` falls back to generic `Camera N` names when ISAPI fails (seen on one store).
8. **Deployment fragility:** (a real incident: the owner replaced `app.py` without running `pip install websockets` → startup crash, page would not open; fixed by making `websockets` optional with a console warning and direct-mode fallback); manual file copy, no version display in the UI, no auto-start (NSSM/Task Scheduler not yet set up), `README.md` outdated, requirements unpinned.
9. Group edit permission is global (any group), not per-owner; no zone/store scoping for users.
10. Chrome auto-translation can alter on-screen text; harmless but confuses screenshots.

---

## 12. Suggested backlog (priority order)

1. Verify & finish the **security rollout** (proxy on real server → `go2rtc_secure.yaml` → read-only NVR users); add HTTPS (reverse proxy) and login rate-limit.
2. **App version string** in the UI + one-click update script (avoid stale files); Windows service/auto-start.
3. Field-test **Backup**; add ffmpeg remux to proper MP4, job cancel/persist.
4. Offline **alerts** (Telegram/WhatsApp/email) when a camera/NVR stays offline > N minutes; history table for uptime trends.
5. Per-store **time-convention auto-detect**; exact outage start from last recording time.
6. User **scopes** (zones/stores), group ownership, audit log.
7. H.265 handling (ffmpeg transcode option), clip export from a timeline selection, snapshots/thumbnails, PTZ/audio if ever needed.
8. True NVR-side speed (RTSP `Scale` relay) only if bandwidth proves a blocker.

---

## 13. How to continue (instructions for the next AI)

- **Start by reviewing** §8 (security) and §11 against the appendix code; report defects with file/line and a minimal fix.
- Deliver changes as **complete replacement files or tight diffs** that the owner can drop into `C:\cctv-hub`; keep `run.bat`/secrets untouched; mention restart + Ctrl+F5. Explain steps in **simple Hindi/Hinglish**.
- Constraints: Windows, Python 3.13, SQL Server (T-SQL), no build tooling, free components only, Chrome/Edge clients, single-file frontend. Keep SQL parameterised; do not log credentials.
- When changing `index.html` beware: the file is one large ES module; use exact anchors when patching (a past patch hit the wrong block because a 2-space-indented string also matched inside a 4-space-indented block).
- Test locally with mocks where possible (the previous work mocked RTSP servers, ISAPI XML parsing, WebSocket upstream, ffmpeg remux with `imageio-ffmpeg`); real-NVR behaviour must be confirmed through the owner's screenshots.
- Do **not** reintroduce: skim/"jump-ahead" speed emulation, split multi-period view, or the upfront network speed test.

---

# Appendix A — Configuration files

### `run.bat` (placeholders only)
````bat
@echo off
cd /d %~dp0
set "FERNET_KEY=PASTE_KEY_HERE"
set "APP_USER=admin"
set "APP_PASS=change-me"
set "SQL_CONN=DRIVER={ODBC Driver 18 for SQL Server};SERVER=localhost;DATABASE=cctv;Trusted_Connection=yes;TrustServerCertificate=yes"
start "go2rtc" go2rtc.exe
call venv\Scripts\activate
uvicorn app:app --host 0.0.0.0 --port 8000

````

### `setup.bat`
````bat
@echo off
cd /d %~dp0
py -3 -m venv venv
call venv\Scripts\activate
pip install -r requirements.txt
echo.
echo Aapki FERNET_KEY (run.bat me paste karein, surakshit rakhein):
python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"
pause

````

### `requirements.txt`
````text
fastapi
uvicorn
httpx
cryptography
python-multipart
pyodbc
openpyxl
websockets

````

### `go2rtc.yaml` (current, legacy direct mode)
````yaml
api:
  listen: ":1984"
  origin: "*"
rtsp:
  listen: ""
webrtc:
  listen: ":8555"
streams: {}

````

### `go2rtc_secure.yaml` (apply after the `/g/` proxy is verified)
````yaml
api:
  listen: "127.0.0.1:1984"
rtsp:
  listen: ""
webrtc:
  listen: ":8555"
streams: {}

````

### `brand.json`
````json
{
  "name": "",
  "subtitle": "",
  "color": "#b52024"
}

````

### `stores_sample.csv`
````csv
name,city,zone,ip,port,http_port,user,password,channels
Store 001 - Connaught Place,Delhi,North,10.10.1.10,554,80,viewer,Viewer@123,16
Store 002 - Gurgaon,Gurgaon,North,10.10.2.10,554,80,viewer,Viewer@123,16

````

# Appendix B — `app.py` (backend, complete)
````python
import os, csv, io, re, json, asyncio, secrets, hashlib, hmac, time, base64
from urllib.parse import quote
import httpx, pyodbc
from cryptography.fernet import Fernet
from fastapi import FastAPI, Depends, HTTPException, UploadFile, Request, WebSocket
from fastapi.responses import FileResponse, Response
from fastapi.security import HTTPBasic, HTTPBasicCredentials

GO2RTC = os.getenv("GO2RTC_URL", "http://127.0.0.1:1984")
APP_USER, APP_PASS = os.getenv("APP_USER", "admin"), os.getenv("APP_PASS", "change-me")
fernet = Fernet(os.environ["FERNET_KEY"].encode())
CONN = os.environ["SQL_CONN"]

def q(sql, p=()):
    """SQL Server query helper: returns list of dicts for SELECT, rowcount otherwise."""
    with pyodbc.connect(CONN, autocommit=True) as c:
        cur = c.cursor(); cur.execute(sql, p)
        if cur.description is None: return cur.rowcount
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

q("""IF OBJECT_ID('stores','U') IS NULL CREATE TABLE stores(
  id INT IDENTITY PRIMARY KEY, name NVARCHAR(200) UNIQUE, city NVARCHAR(100), zone NVARCHAR(100),
  ip VARCHAR(100), port INT, http_port INT, username NVARCHAR(100), pw NVARCHAR(500), channels INT)""")
q("""IF OBJECT_ID('cameras','U') IS NULL CREATE TABLE cameras(
  store_id INT, ch INT, name NVARCHAR(200), PRIMARY KEY(store_id, ch))""")

q("""IF OBJECT_ID('cam_groups','U') IS NULL CREATE TABLE cam_groups(id INT IDENTITY PRIMARY KEY, name NVARCHAR(200) UNIQUE)""")
q("""IF OBJECT_ID('cam_group_items','U') IS NULL CREATE TABLE cam_group_items(
  group_id INT, store_id INT, ch INT, PRIMARY KEY(group_id, store_id, ch))""")

q("""IF OBJECT_ID('app_users','U') IS NULL CREATE TABLE app_users(
  username NVARCHAR(100) PRIMARY KEY, pw_hash NVARCHAR(300), role NVARCHAR(20), created DATETIME2)""")

q("IF COL_LENGTH('app_users','can_groups') IS NULL ALTER TABLE app_users ADD can_groups BIT NOT NULL DEFAULT 0")

def _hash(pw):
    salt = secrets.token_bytes(16)
    return salt.hex() + "$" + hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 120_000).hex()

def _verify(pw, stored):
    try:
        s, h = stored.split("$")
        return secrets.compare_digest(hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(s), 120_000).hex(), h)
    except Exception:
        return False

_AUTHC = {}
def _login(u, p):
    """Main admin (run.bat wala) ya app_users table ka user. Nateeja: {"name","role"} ya None."""
    if secrets.compare_digest(u.encode(), APP_USER.encode()) and secrets.compare_digest(p.encode(), APP_PASS.encode()):
        return {"name": u, "role": "admin", "can_groups": True}
    key = hashlib.sha256(f"{u}\0{p}".encode()).hexdigest(); hit = _AUTHC.get(key)
    if hit and hit[1] > time.time(): return hit[0]
    rows = q("select pw_hash, role, can_groups from app_users where username=?", (u,))
    if rows and _verify(p, rows[0]["pw_hash"]):
        user = {"name": u, "role": rows[0]["role"], "can_groups": bool(rows[0]["can_groups"]) or rows[0]["role"] == "admin"}; _AUTHC[key] = (user, time.time() + 600); return user
    return None

class AuthMW:
    """Har HTTP request par login jaanchta hai (streaming responses ko bina chhede)."""
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http": return await self.app(scope, receive, send)
        hdr = dict(scope["headers"]).get(b"authorization", b"").decode(); user = None
        if hdr.lower().startswith("basic "):
            try:
                u, p = base64.b64decode(hdr[6:]).decode().split(":", 1); user = await asyncio.to_thread(_login, u, p)
            except Exception:
                user = None
        if not user:
            await send({"type": "http.response.start", "status": 401, "headers": [(b"www-authenticate", b'Basic realm="CCTV Hub"'), (b"content-type", b"text/plain; charset=utf-8")]})
            await send({"type": "http.response.body", "body": b"Login required"}); return
        scope["state"] = {**scope.get("state", {}), "user": user}
        await self.app(scope, receive, send)

def auth(request: Request): return request.state.user

def admin(user: dict = Depends(auth)):
    if user["role"] != "admin": raise HTTPException(403, "Yeh kaam sirf admin kar sakta hai")
    return user

def groups_ok(user: dict = Depends(auth)):
    if user["role"] != "admin" and not user.get("can_groups"): raise HTTPException(403, "Aapko group badalne ki anumati nahi hai")
    return user

app = FastAPI()
app.add_middleware(AuthMW)

@app.get("/api/me")
def me(user: dict = Depends(auth)): return user

@app.get("/")
def index(): return FileResponse("index.html")

LOGO_EXT = ("png", "jpg", "jpeg", "svg", "webp")

@app.get("/api/brand")
def brand():
    d = {"name": "My Stores", "subtitle": "Live store monitoring", "color": "#1d4ed8"}
    try: d.update(json.load(open("brand.json", encoding="utf-8")))
    except Exception: pass
    d["logo"] = any(os.path.exists(f"logo.{e}") for e in LOGO_EXT)
    return d

@app.get("/logo")
def logo():
    for e in LOGO_EXT:
        if os.path.exists(f"logo.{e}"): return FileResponse(f"logo.{e}")
    raise HTTPException(404)

@app.get("/api/stores")
def stores():
    return q("""select s.id,s.name,s.city,s.zone,s.ip,
      (select count(*) from cameras where store_id=s.id) as cams from stores s order by s.name""")

@app.post("/api/import", dependencies=[Depends(admin)])
async def import_csv(file: UploadFile):
    text = (await file.read()).decode("utf-8-sig")
    n = 0
    for r in csv.DictReader(io.StringIO(text)):
        v = (r.get("city"), r.get("zone"), r["ip"], int(r.get("port") or 554), int(r.get("http_port") or 80),
             r["user"], fernet.encrypt(r["password"].encode()).decode(), int(r.get("channels") or 0))
        if q("update stores set city=?,zone=?,ip=?,port=?,http_port=?,username=?,pw=?,channels=? where name=?", v + (r["name"],)) == 0:
            q("insert into stores(city,zone,ip,port,http_port,username,pw,channels,name) values(?,?,?,?,?,?,?,?,?)", v + (r["name"],))
        n += 1
    return {"imported": n}

def get_store(sid):
    rows = q("select * from stores where id=?", (sid,))
    if not rows: raise HTTPException(404)
    return rows[0]

async def discover(s):
    pw = fernet.decrypt(s["pw"].encode()).decode()
    base = f"http://{s['ip']}:{s['http_port']}"
    found = []
    try:
        async with httpx.AsyncClient(auth=httpx.DigestAuth(s["username"], pw), timeout=8) as h:
            for path, tag in (("/ISAPI/ContentMgmt/InputProxy/channels", "InputProxyChannel"),
                              ("/ISAPI/System/Video/inputs/channels", "VideoInputChannel")):
                r = await h.get(base + path)
                if r.status_code == 200:
                    found = re.findall(rf"<{tag}\b.*?<id>(\d+)</id>.*?<name>(.*?)</name>", r.text, re.S)
                    if found: break
    except Exception:
        pass
    if not found and s["channels"]:
        found = [(str(i), f"Camera {i}") for i in range(1, s["channels"] + 1)]
    cams = {int(i): n for i, n in found}
    q("delete from cameras where store_id=?", (s["id"],))
    for ch, n in cams.items():
        q("insert into cameras(store_id,ch,name) values(?,?,?)", (s["id"], ch, n))
    return len(cams)

@app.post("/api/stores/{sid}/discover", dependencies=[Depends(admin)])
async def discover_one(sid: int): return {"cameras": await discover(get_store(sid))}

@app.post("/api/discover-all", dependencies=[Depends(admin)])
async def discover_all():
    rows = q("select * from stores")
    sem = asyncio.Semaphore(10)
    async def run(s):
        async with sem: return await discover(s)
    res = await asyncio.gather(*(run(s) for s in rows))
    return {"stores": len(rows), "cameras": sum(res)}

CAM_SQL = """select c.store_id,c.ch,c.name,s.name as store_name,s.ip,s.port,s.http_port,s.username,s.pw
  from cameras c join stores s on s.id=c.store_id """

async def register(rows):
    """Register main+sub streams of the given cameras in go2rtc (Hikvision: ch*100+stream, 101=main, 102=sub)."""
    out, jobs = [], []
    async with httpx.AsyncClient(timeout=10, limits=httpx.Limits(max_connections=20)) as h:
        async def reg(name, r, pw, stream):
            src = f"rtsp://{quote(r['username'])}:{quote(pw)}@{r['ip']}:{r['port']}/Streaming/Channels/{r['ch']}0{stream}"
            await h.put(f"{GO2RTC}/api/streams", params={"name": name, "src": src})
        for r in rows:
            pw = fernet.decrypt(r["pw"].encode()).decode()
            sub, main = f"s{r['store_id']}c{r['ch']}_sub", f"s{r['store_id']}c{r['ch']}_main"
            jobs += [reg(sub, r, pw, 2), reg(main, r, pw, 1)]
            out.append({"store_id": r["store_id"], "ch": r["ch"], "name": r["name"], "store": r["store_name"], "sub": sub, "main": main})
        await asyncio.gather(*jobs)
    return out

@app.post("/api/stores/{sid}/open")
async def open_store(sid: int):
    get_store(sid)
    return await register(q(CAM_SQL + "where c.store_id=? order by c.ch", (sid,)))

@app.get("/api/groups")
def groups():
    return q("""select g.id,g.name,(select count(*) from cam_group_items where group_id=g.id) as cams
      from cam_groups g order by g.name""")

@app.post("/api/groups", dependencies=[Depends(groups_ok)])
def new_group(name: str):
    try: q("insert into cam_groups(name) values(?)", (name.strip(),))
    except pyodbc.IntegrityError: raise HTTPException(409, "इस नाम का ग्रुप पहले से है")
    return {"ok": True}

@app.delete("/api/groups/{gid}", dependencies=[Depends(groups_ok)])
def del_group(gid: int):
    q("delete from cam_group_items where group_id=?", (gid,)); q("delete from cam_groups where id=?", (gid,))
    return {"ok": True}

@app.post("/api/groups/{gid}/add", dependencies=[Depends(groups_ok)])
def add_cam(gid: int, store_id: int, ch: int):
    q("""if not exists(select 1 from cam_group_items where group_id=? and store_id=? and ch=?)
         insert into cam_group_items values(?,?,?)""", (gid, store_id, ch, gid, store_id, ch))
    return {"ok": True}

@app.post("/api/groups/{gid}/add-by-name", dependencies=[Depends(groups_ok)])
def add_by_name(gid: int, keyword: str):
    n = q("""insert into cam_group_items(group_id,store_id,ch)
      select ?,c.store_id,c.ch from cameras c where c.name like ? and not exists(
        select 1 from cam_group_items i where i.group_id=? and i.store_id=c.store_id and i.ch=c.ch)""",
      (gid, f"%{keyword}%", gid))
    return {"added": n}

@app.delete("/api/groups/{gid}/cam", dependencies=[Depends(groups_ok)])
def rm_cam(gid: int, store_id: int, ch: int):
    q("delete from cam_group_items where group_id=? and store_id=? and ch=?", (gid, store_id, ch))
    return {"ok": True}

@app.post("/api/groups/{gid}/open")
async def open_group(gid: int):
    return await register(q(CAM_SQL + """join cam_group_items i on i.store_id=c.store_id and i.ch=c.ch
      where i.group_id=? order by s.name, c.ch""", (gid,)))

async def ping(s):
    try:
        _, w = await asyncio.wait_for(asyncio.open_connection(s["ip"], s["port"]), 2)
        w.close(); return True
    except Exception:
        return False

@app.get("/api/status")
async def status():
    rows = q("select id,ip,port from stores")
    res = await asyncio.gather(*(ping(r) for r in rows))
    return {r["id"]: ok for r, ok in zip(rows, res)}


# ---------------- Playback (Hikvision RTSP: /Streaming/tracks/<ch>01?starttime=..&endtime=..) ----------------
from datetime import datetime, timedelta
from pydantic import BaseModel

PB_OFFSET = int(os.getenv("PLAYBACK_OFFSET_MIN", "0"))  # e.g. 330 if NVR expects true UTC and you are in India

class PbItem(BaseModel):
    store_id: int
    ch: int

class PbReq(BaseModel):
    items: list[PbItem]
    start: str          # local time "YYYY-MM-DDTHH:MM"
    minutes: int = 10
    off: int | None = None   # NVR ka time offset (minute): 0 = Local, 330 = UTC

@app.post("/api/playback")
async def playback(req: PbReq):
    t0 = datetime.strptime(req.start, "%Y-%m-%dT%H:%M:%S" if req.start.count(":") == 2 else "%Y-%m-%dT%H:%M") - timedelta(minutes=PB_OFFSET if req.off is None else req.off)
    t1 = t0 + timedelta(minutes=max(1, min(req.minutes, 1440)))
    f = lambda t: t.strftime("%Y%m%dT%H%M%SZ")
    rows = []
    for it in req.items:
        rows += q(CAM_SQL + "where c.store_id=? and c.ch=?", (it.store_id, it.ch))
    out = []
    async with httpx.AsyncClient(timeout=10, limits=httpx.Limits(max_connections=20)) as h:
        async def reg(r):
            pw = fernet.decrypt(r["pw"].encode()).decode()
            name = f"pb{r['store_id']}c{r['ch']}_{f(t0)}"
            src = (f"rtsp://{quote(r['username'])}:{quote(pw)}@{r['ip']}:{r['port']}"
                   f"/Streaming/tracks/{r['ch']}01?starttime={f(t0)}&endtime={f(t1)}")
            await h.put(f"{GO2RTC}/api/streams", params={"name": name, "src": src})
            out.append({"store_id": r["store_id"], "ch": r["ch"], "stream": name})
        await asyncio.gather(*(reg(r) for r in rows))
    return out


# ---------------- Backup: NVR HDD se recordings download karke is PC ki disk par save karna ----------------
import uuid, shutil, pathlib

BACKUP_DIR = pathlib.Path(os.getenv("BACKUP_DIR", "backups"))
JOBS, TASKS = {}, set()

class BkReq(BaseModel):
    items: list[PbItem]
    start: str = ""     # "YYYY-MM-DDTHH:MM", khaali = NVR me jo sabse purani recording hai wahin se
    end: str

_z = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
_safe = lambda s: re.sub(r"[^\w\- ]+", "_", str(s)).strip() or "x"

async def isapi_search(h, base, ch, t0, t1, pos=0, limit=200, raw=False):
    body = ("<?xml version='1.0' encoding='utf-8'?><CMSearchDescription><searchID>%s</searchID>"
            "<trackIDList><trackID>%d01</trackID></trackIDList><timeSpanList><timeSpan><startTime>%s</startTime>"
            "<endTime>%s</endTime></timeSpan></timeSpanList><maxResults>%d</maxResults>"
            "<searchResultPostion>%d</searchResultPostion><metadataList><metadataDescriptor>"
            "//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>"
            % (uuid.uuid4(), ch, _z(t0), _z(t1), limit, pos))
    r = await h.post(base + "/ISAPI/ContentMgmt/search", content=body, headers={"Content-Type": "application/xml"})
    r.raise_for_status()
    more = "<responseStatusStrg>MORE</responseStatusStrg>" in r.text
    if raw: return re.findall(r"<searchMatchItem>.*?</searchMatchItem>", r.text, re.S), more
    out = []
    for it in re.findall(r"<searchMatchItem>.*?</searchMatchItem>", r.text, re.S):
        st = re.search(r"<startTime>(.*?)</startTime>", it); uri = re.search(r"<playbackURI>(.*?)</playbackURI>", it)
        if st and uri: out.append((st.group(1), uri.group(1)))
    return out, "<responseStatusStrg>MORE</responseStatusStrg>" in r.text

async def isapi_download(h, base, uri, path, job):
    body = ("<?xml version='1.0' encoding='utf-8'?><downloadRequest version='1.0' "
            "xmlns='http://www.isapi.org/ver20/XMLSchema'><playbackURI>%s</playbackURI></downloadRequest>" % uri)
    tmp = path.with_suffix(".part")
    async with h.stream("POST", base + "/ISAPI/ContentMgmt/download", content=body, headers={"Content-Type": "application/xml"}) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            async for chunk in r.aiter_bytes(1 << 20):
                f.write(chunk); job["bytes"] += len(chunk)
    tmp.replace(path)

async def run_backup(job, rows, t0, t1):
    locks, gsem = {}, asyncio.Semaphore(4)       # ek NVR par ek baar me ek hi download, kul 4 NVR ek saath
    async def one(r):
        async with gsem, locks.setdefault(r["store_id"], asyncio.Lock()):
            try:
                pw = fernet.decrypt(r["pw"].encode()).decode()
                base = f"http://{r['ip']}:{r['http_port']}"
                async with httpx.AsyncClient(auth=httpx.DigestAuth(r["username"], pw), timeout=httpx.Timeout(30, read=900)) as h:
                    a = t0
                    if a is None:
                        first, _ = await isapi_search(h, base, r["ch"], t1 - timedelta(days=400), t1, 0, 1)
                        if not first: raise RuntimeError("koi recording nahi mili")
                        a = datetime.strptime(first[0][0][:19], "%Y-%m-%dT%H:%M:%S")
                    pos = 0
                    while True:
                        items, more = await isapi_search(h, base, r["ch"], a, t1, pos)
                        for st, uri in items:
                            d = BACKUP_DIR / _safe(r["store_name"]) / _safe("%02d_%s" % (r["ch"], r["name"]))
                            d.mkdir(parents=True, exist_ok=True)
                            f = d / (re.sub(r"\D", "", st)[:14] + ".mp4")
                            if not f.exists(): await isapi_download(h, base, uri, f, job)
                            job["files"] += 1
                        if not more or not items: break
                        pos += len(items)
            except Exception as e:
                job["errors"].append(f"{r['store_name']} cam{r['ch']}: {type(e).__name__} {str(e)[:60]}")
            job["done"] += 1
    await asyncio.gather(*(one(r) for r in rows))
    job["status"] = "done"

@app.post("/api/backup", dependencies=[Depends(admin)])
async def backup_start(req: BkReq):
    t1 = datetime.strptime(req.end, "%Y-%m-%dT%H:%M") - timedelta(minutes=PB_OFFSET)
    t0 = datetime.strptime(req.start, "%Y-%m-%dT%H:%M") - timedelta(minutes=PB_OFFSET) if req.start else None
    rows = []
    for it in req.items:
        rows += q(CAM_SQL + "where c.store_id=? and c.ch=?", (it.store_id, it.ch))
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    job = {"id": uuid.uuid4().hex[:8], "total": len(rows), "done": 0, "files": 0, "bytes": 0, "errors": [],
           "status": "running", "dir": str(BACKUP_DIR.resolve())}
    JOBS[job["id"]] = job
    t = asyncio.create_task(run_backup(job, rows, t0, t1)); TASKS.add(t); t.add_done_callback(TASKS.discard)
    return job

@app.get("/api/backup/{jid}", dependencies=[Depends(admin)])
def backup_status(jid: str):
    if jid not in JOBS: raise HTTPException(404)
    return {**JOBS[jid], "free": shutil.disk_usage(BACKUP_DIR).free}


# ---------------- Hikvision jaisa playback timeline: NVR me kab-kab recording hai ----------------
def _base(r): return f"http://{r['ip']}:{r['http_port']}"

def _nvr(r):
    pw = fernet.decrypt(r["pw"].encode()).decode()
    return httpx.AsyncClient(auth=httpx.DigestAuth(r["username"], pw), timeout=httpx.Timeout(30, read=60))

def _local(s, off=None): return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S") + timedelta(minutes=PB_OFFSET if off is None else off)

def _cam(store_id, ch):
    rows = q(CAM_SQL + "where c.store_id=? and c.ch=?", (store_id, ch))
    if not rows: raise HTTPException(404)
    return rows[0]

async def _timeline(store_id: int, ch: int, date: str, off=None):
    r = _cam(store_id, ch)
    day0 = datetime.strptime(date, "%Y-%m-%d")
    off = PB_OFFSET if off is None else off
    t0 = day0 - timedelta(minutes=off); t1 = t0 + timedelta(days=1)
    segs, pos = [], 0
    async with _nvr(r) as h:
        while True:
            items, more = await isapi_search(h, _base(r), ch, t0, t1, pos, 200, raw=True)
            for it in items:
                s_ = re.search(r"<startTime>(.*?)</startTime>", it); e_ = re.search(r"<endTime>(.*?)</endTime>", it)
                if s_ and e_:
                    s = max(0, int((_local(s_.group(1), off) - day0).total_seconds())); e = min(86400, int((_local(e_.group(1), off) - day0).total_seconds()))
                    if e > s: segs.append([s, e])
            if not more or not items: break
            pos += len(items)
    return {"segments": sorted(segs)}

@app.get("/api/oldest")
async def oldest(store_id: int, ch: int, off: int = None):
    r = _cam(store_id, ch)
    off = PB_OFFSET if off is None else off
    now = datetime.now() - timedelta(minutes=off)
    async with _nvr(r) as h:
        items, _ = await isapi_search(h, _base(r), ch, now - timedelta(days=400), now + timedelta(days=1), 0, 1, raw=True)
    s_ = re.search(r"<startTime>(.*?)</startTime>", items[0]) if items else None
    return {"oldest": _local(s_.group(1), off).strftime("%Y-%m-%d") if s_ else None}


@app.get("/api/timeline")
async def timeline(store_id: int, ch: int, date: str, off: int = None):
    try:
        return await _timeline(store_id, ch, date, off)
    except HTTPException:
        raise
    except Exception as e:      # NVR ne mana kiya (401/403 = user ko playback ki permission nahi) ya connect nahi hua
        body = getattr(getattr(e, "response", None), "text", "") or ""
        m = re.search(r"<statusString>(.*?)</statusString>", body)
        return {"segments": [], "error": f"{type(e).__name__}: {str(e)[:110]} {m.group(1) if m else ''}".strip()}


import calendar

@app.get("/api/days")
async def days(store_id: int, ch: int, year: int, month: int, off: int = None):
    """Is mahine ke kin dino ki recording NVR me hai (Hikvision calendar jaisa)."""
    try:
        r = _cam(store_id, ch); off = PB_OFFSET if off is None else off
        async with _nvr(r) as h:
            try:   # sahi tarika: NVR ka dailyDistribution
                body = "<?xml version='1.0' encoding='utf-8'?><trackDailyParam><year>%d</year><monthOfYear>%d</monthOfYear></trackDailyParam>" % (year, month)
                resp = await h.post(_base(r) + f"/ISAPI/ContentMgmt/record/tracks/{ch}01/dailyDistribution", content=body, headers={"Content-Type": "application/xml"})
                resp.raise_for_status()
                blocks = re.findall(r"<day>(.*?)</day>", resp.text, re.S)
                if blocks:
                    out = []
                    for b in blocks:
                        rec = re.search(r"<record>(.*?)</record>", b)
                        d = re.search(r"<dayOfMonth>(\d+)</dayOfMonth>", b) or re.search(r"<id>(\d+)</id>", b)
                        if d and rec and rec.group(1).strip().lower() == "true": out.append(int(d.group(1)))
                    return {"days": sorted(out)}
            except Exception:
                pass
            sem = asyncio.Semaphore(6)    # dusra tarika: har din ke liye 1 search
            async def chk(d):
                async with sem:
                    t0 = datetime(year, month, d) - timedelta(minutes=off)
                    items, _ = await isapi_search(h, _base(r), ch, t0, t0 + timedelta(days=1), 0, 1, raw=True)
                    return d if items else None
            res = await asyncio.gather(*(chk(d) for d in range(1, calendar.monthrange(year, month)[1] + 1)), return_exceptions=True)
            errs = [x for x in res if isinstance(x, Exception)]
            if errs and len(errs) == len(res): raise errs[0]
            return {"days": [d for d in res if isinstance(d, int)]}
    except HTTPException:
        raise
    except Exception as e:
        return {"days": [], "error": f"{type(e).__name__}: {str(e)[:110]}"}


# ---------------- Tez playback (2x/4x/8x): NVR se bulk download (network speed) -> ffmpeg se fMP4 -> browser <video> ----------------
from fastapi.responses import StreamingResponse

FFMPEG = os.getenv("FFMPEG", "ffmpeg.exe" if os.name == "nt" else "ffmpeg")

async def _vod_body(r, ch, t0, t1):
    zf = lambda t: t.strftime("%Y%m%dT%H%M%SZ")
    try:
        async with _nvr(r) as h:
            items, _ = await isapi_search(h, _base(r), ch, t0, t1, 0, 1, raw=True)
    except Exception as e:
        raise HTTPException(502, f"NVR se recording list nahi mili: {type(e).__name__} {str(e)[:80]}")
    if not items: raise HTTPException(404, "is samay ki recording nahi mili")
    it = items[0]
    uri = re.search(r"<playbackURI>(.*?)</playbackURI>", it).group(1)
    s_ = re.search(r"<startTime>(.*?)</startTime>", it); e_ = re.search(r"<endTime>(.*?)</endTime>", it)
    a0 = max(t0, datetime.strptime(s_.group(1)[:19], "%Y-%m-%dT%H:%M:%S")) if s_ else t0
    a1 = min(t1, datetime.strptime(e_.group(1)[:19], "%Y-%m-%dT%H:%M:%S")) if e_ else t1
    uri = re.sub(r"starttime=[^&]*", "starttime=" + zf(a0), uri, count=1)
    uri = re.sub(r"endtime=[^&]*", "endtime=" + zf(a1), uri, count=1)
    body = ("<?xml version='1.0' encoding='utf-8'?><downloadRequest version='1.0' "
            "xmlns='http://www.isapi.org/ver20/XMLSchema'><playbackURI>%s</playbackURI></downloadRequest>" % uri)
    return body

@app.get("/api/vod")
async def vod(store_id: int, ch: int, start: str, minutes: int = 10, off: int = None):
    r = _cam(store_id, ch); off = PB_OFFSET if off is None else off
    t0 = datetime.strptime(start, "%Y-%m-%dT%H:%M:%S") - timedelta(minutes=off)
    t1 = t0 + timedelta(minutes=max(1, min(minutes, 30)))
    body = await _vod_body(r, ch, t0, t1)
    try:
        ff = await asyncio.create_subprocess_exec(
            FFMPEG, "-loglevel", "error", "-i", "pipe:0", "-an", "-c:v", "copy",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-flush_packets", "1", "-f", "mp4", "pipe:1",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    except FileNotFoundError:
        raise HTTPException(500, "ffmpeg.exe nahi mila - use C:\\cctv-hub folder me rakhein")

    async def feeder():
        try:
            async with _nvr(r) as h:
                async with h.stream("POST", _base(r) + "/ISAPI/ContentMgmt/download", content=body,
                                    headers={"Content-Type": "application/xml"}) as resp:
                    resp.raise_for_status()
                    async for chunk in resp.aiter_bytes(1 << 18):
                        ff.stdin.write(chunk); await ff.stdin.drain()
        except Exception:
            pass
        finally:
            try: ff.stdin.close()
            except Exception: pass

    task = asyncio.create_task(feeder())

    async def gen():
        try:
            while True:
                data = await ff.stdout.read(1 << 16)
                if not data: break
                yield data
        finally:
            task.cancel()
            if ff.returncode is None:
                try: ff.kill()
                except Exception: pass
    return StreamingResponse(gen(), media_type="video/mp4")


# ---------------- Camera report: kitne camera live hain (store-wise / group-wise) ----------------
import hashlib, base64, io

q("""IF OBJECT_ID('cam_status','U') IS NULL CREATE TABLE cam_status(
  store_id INT, ch INT, online BIT, checked DATETIME2, PRIMARY KEY(store_id, ch))""")
q("""IF OBJECT_ID('store_status','U') IS NULL CREATE TABLE store_status(
  store_id INT PRIMARY KEY, reachable BIT, method NVARCHAR(30), err NVARCHAR(200), checked DATETIME2)""")
q("IF COL_LENGTH('cameras','cam_ip') IS NULL ALTER TABLE cameras ADD cam_ip VARCHAR(100) NULL")
for _t_ in ("cam_status", "store_status"):
    q(f"IF COL_LENGTH('{_t_}','offline_since') IS NULL ALTER TABLE {_t_} ADD offline_since DATETIME2 NULL")
    q(f"IF COL_LENGTH('{_t_}','last_online') IS NULL ALTER TABLE {_t_} ADD last_online DATETIME2 NULL")

def _outage(up, old_up, old_since, old_last, now):
    """(offline_since, last_online): band hone ka pehla samay purani jaanch se yaad rakhta hai."""
    if up: return None, now
    return ((old_since if old_up is False and old_since else None) or now), old_last

def _save_ips(sid, ips):
    for ch, ip in ips.items(): q("update cameras set cam_ip=? where store_id=? and ch=?", (ip, sid, ch))
REPORT = {"running": False, "done": 0, "total": 0, "started": None, "finished": None}

async def rtsp_describe(ip, port, user, pw, ch):
    """Camera ki sub-stream par RTSP DESCRIBE. (code, trace) lautata hai; 200 = camera chal raha hai."""
    url = f"rtsp://{ip}:{port}/Streaming/Channels/{ch}02"
    md5 = lambda s: hashlib.md5(s.encode()).hexdigest()
    async def ask(auth=None):
        rd, wr = await asyncio.wait_for(asyncio.open_connection(ip, port), 5)
        try:
            msg = f"DESCRIBE {url} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: cctvhub\r\n" + (f"Authorization: {auth}\r\n" if auth else "") + "\r\n"
            wr.write(msg.encode()); await wr.drain()
            buf = b""
            while b"\r\n\r\n" not in buf and len(buf) < 8192:
                chunk = await asyncio.wait_for(rd.read(2048), 10)
                if not chunk: break
                buf += chunk
            return buf.decode(errors="ignore")
        finally:
            wr.close()
    def code(t):
        m = re.match(r"RTSP/1\.\d (\d+)", t); return int(m.group(1)) if m else 0
    def line(t):
        m = re.search(r"WWW-Authenticate:[^\r\n]*", t, re.I); return (t.split("\r\n")[0] + " | " + (m.group(0)[:110] if m else "")).strip(" |")
    trace = []
    try:
        t = await ask(); trace.append(line(t))
        if code(t) == 401:
            realm = re.search(r'realm="([^"]*)"', t); nonce = re.search(r'nonce="([^"]*)"', t)
            if realm and nonce:
                ha1 = md5(f"{user}:{realm.group(1)}:{pw}"); ha2 = md5(f"DESCRIBE:{url}")
                if re.search(r'qop="?[^",]*auth', t):
                    cn = uuid.uuid4().hex[:16]; nc = "00000001"
                    resp = md5(f"{ha1}:{nonce.group(1)}:{nc}:{cn}:auth:{ha2}")
                    extra = f', qop=auth, nc={nc}, cnonce="{cn}"'
                else:
                    resp = md5(f"{ha1}:{nonce.group(1)}:{ha2}"); extra = ""
                t = await ask(f'Digest username="{user}", realm="{realm.group(1)}", nonce="{nonce.group(1)}", uri="{url}", response="{resp}"{extra}')
                trace.append("digest -> " + line(t))
            if code(t) == 401:
                t = await ask("Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()); trace.append("basic -> " + line(t))
        return code(t), trace
    except Exception as e:
        return 0, trace + [f"{type(e).__name__} {str(e)[:60]}"]

async def rtsp_ok(ip, port, user, pw, ch):
    return (await rtsp_describe(ip, port, user, pw, ch))[0] == 200

def _save_status(sid, reachable, method, err, chs, status):
    now = datetime.now()
    old = {r["ch"]: r for r in q("select ch, online, offline_since, last_online from cam_status where store_id=?", (sid,))}
    oss = q("select reachable, offline_since, last_online from store_status where store_id=?", (sid,))
    q("delete from cam_status where store_id=?", (sid,))
    for c in chs:
        o, up = old.get(c), bool(status.get(c))
        since, last = _outage(up, (bool(o["online"]) if o else None), o and o["offline_since"], o and o["last_online"], now)
        q("insert into cam_status(store_id,ch,online,checked,offline_since,last_online) values(?,?,?,?,?,?)", (sid, c, 1 if up else 0, now, since, last))
    p = oss[0] if oss else None
    since, last = _outage(bool(reachable), (bool(p["reachable"]) if p else None), p and p["offline_since"], p and p["last_online"], now)
    q("delete from store_status where store_id=?", (sid,))
    q("insert into store_status(store_id,reachable,method,err,checked,offline_since,last_online) values(?,?,?,?,?,?,?)",
      (sid, 1 if reachable else 0, method, err[:200], now, since, last))

async def check_store(s):
    chs = [c["ch"] for c in q("select ch from cameras where store_id=?", (s["id"],))]
    pw = fernet.decrypt(s["pw"].encode()).decode()
    reachable, status, method, err = await ping(s), {}, "", ""
    if reachable and chs:
        try:   # 1) NVR se hi poochho: kaun-kaun se IP camera online hain
            async with _nvr(s) as h:
                resp = await h.get(_base(s) + "/ISAPI/ContentMgmt/InputProxy/channels/status")
                resp.raise_for_status()
            for blk in re.findall(r"<InputProxyChannelStatus\b[^>]*>(.*?)</InputProxyChannelStatus>", resp.text, re.S | re.I):
                i = re.search(r"<id>(\d+)</id>", blk); o = re.search(r"<online>(.*?)</online>", blk)
                if i and o: status[int(i.group(1))] = o.group(1).strip().lower() == "true"
            method = "isapi"
        except Exception as e:
            err = f"{type(e).__name__} {str(e)[:80]}"
        try:   # camera ka apna IP (NVR ki channel list se)
            async with _nvr(s) as h:
                rc = await h.get(_base(s) + "/ISAPI/ContentMgmt/InputProxy/channels"); rc.raise_for_status()
            ips = {}
            for blk in re.findall(r"<InputProxyChannel\b[^>]*>(.*?)</InputProxyChannel>", rc.text, re.S | re.I):
                i = re.search(r"<id>(\d+)</id>", blk); ip = re.search(r"<ipAddress>(.*?)</ipAddress>", blk, re.I)
                if i and ip: ips[int(i.group(1))] = ip.group(1).strip()
            if ips: await asyncio.to_thread(_save_ips, s["id"], ips)
        except Exception:
            pass
        missing = [c for c in chs if not status.get(c)]   # jo NVR ne online nahi bataye unhe RTSP se dobara jaanchein
        if missing:   # 2) jinki jaankari nahi mili unhe RTSP se jaanchein
            sem = asyncio.Semaphore(4)
            async def one(c):
                async with sem: status[c] = await rtsp_ok(s["ip"], s["port"], s["username"], pw, c)
            await asyncio.gather(*(one(c) for c in missing))
            method = (method + "+rtsp") if method else "rtsp"
    await asyncio.to_thread(_save_status, s["id"], reachable, method, err, chs, status)

async def _run_report():
    stores = q("select * from stores")
    REPORT.update(running=True, done=0, total=len(stores), started=datetime.now(), finished=None)
    sem = asyncio.Semaphore(10)
    async def one(s):
        async with sem:
            try: await check_store(s)
            except Exception: pass
            REPORT["done"] += 1
    await asyncio.gather(*(one(s) for s in stores))
    REPORT.update(running=False, finished=datetime.now())

@app.post("/api/report/run", dependencies=[Depends(admin)])
async def report_run():
    if not REPORT["running"]:
        REPORT["running"] = True
        t = asyncio.create_task(_run_report()); TASKS.add(t); t.add_done_callback(TASKS.discard)
    return REPORT

@app.get("/api/report/status")
def report_status(): return REPORT

def _report_data():
    stores = q("""select s.id,s.name,s.city,s.zone,s.ip,s.http_port,
      (select count(*) from cameras where store_id=s.id) as total,
      (select count(*) from cam_status cs join cameras c on c.store_id=cs.store_id and c.ch=cs.ch
         where cs.store_id=s.id and cs.online=1) as live,
      ss.reachable, ss.checked, ss.method, ss.offline_since, ss.last_online
      from stores s left join store_status ss on ss.store_id=s.id order by s.name""")
    groups = q("""select g.id,g.name,
      (select count(*) from cam_group_items i where i.group_id=g.id) as total,
      (select count(*) from cam_group_items i join cam_status cs on cs.store_id=i.store_id and cs.ch=i.ch
         where i.group_id=g.id and cs.online=1) as live,
      (select count(*) from cam_group_items i join cam_status cs on cs.store_id=i.store_id and cs.ch=i.ch
         where i.group_id=g.id) as checked
      from cam_groups g order by g.name""")
    offline = q("""select s.id as store_id, s.name as store, s.ip, s.http_port, c.ch, c.name, c.cam_ip, cs.checked, cs.offline_since, cs.last_online, ss.reachable,
      (select string_agg(g.name, ', ') from cam_group_items i join cam_groups g on g.id=i.group_id
         where i.store_id=c.store_id and i.ch=c.ch) as grps
      from cameras c join stores s on s.id=c.store_id
      join cam_status cs on cs.store_id=c.store_id and cs.ch=c.ch
      left join store_status ss on ss.store_id=c.store_id
      where cs.online=0 order by s.name, c.ch""")
    return {"stores": stores, "groups": groups, "offline": offline}

@app.get("/api/report")
def report(): return {**_report_data(), "status": REPORT}

def _pct(l, t): return round(l * 100 / t) if t else 0
def _t(x): return str(x)[:16] if x else ""

def _xlsx_bytes(d):
    from openpyxl import Workbook
    from openpyxl.styles import Font
    wb = Workbook(); ws = wb.active; ws.title = "Store-wise"
    ws.append(["Store", "City", "Zone", "NVR", "Total cameras", "Live", "Offline", "Live %", "Last checked", "NVR IP", "NVR offline since"])
    for s in d["stores"]:
        ck = bool(s["checked"])
        ws.append([s["name"], s["city"], s["zone"], ("Online" if s["reachable"] else "OFFLINE") if ck else "Not checked", s["total"],
                   s["live"] if ck else "", (s["total"] - s["live"]) if ck else "", _pct(s["live"], s["total"]) if ck else "", _t(s["checked"]), s["ip"], _t(s["offline_since"]) if ck and not s["reachable"] else ""])
    ws2 = wb.create_sheet("Group-wise"); ws2.append(["Group", "Total cameras", "Live", "Offline", "Live %"])
    for g in d["groups"]:
        ws2.append([g["name"], g["total"], g["live"], g["checked"] - g["live"], _pct(g["live"], g["checked"])])
    ws3 = wb.create_sheet("Offline cameras"); ws3.append(["Store", "Channel", "Camera", "Group", "NVR reachable", "Last checked", "NVR IP", "Camera IP", "Offline since", "Last seen online"])
    for o in d["offline"]:
        ws3.append([o["store"], o["ch"], o["name"], o["grps"] or "", "Yes" if o["reachable"] else "No", _t(o["checked"]), o["ip"], o["cam_ip"] or "", _t(o["offline_since"]), _t(o["last_online"])])
    for w in wb.worksheets:
        for c in w[1]: c.font = Font(bold=True)
        w.freeze_panes = "A2"
        for col in w.columns: w.column_dimensions[col[0].column_letter].width = min(40, max(len(str(c.value or "")) for c in col) + 3)
    buf = io.BytesIO(); wb.save(buf); return buf.getvalue()

@app.get("/api/report.xlsx")
def report_xlsx():
    try: data = _xlsx_bytes(_report_data())
    except ImportError: raise HTTPException(500, "openpyxl install karein: venv\\\\Scripts\\\\pip install openpyxl")
    name = f"camera_report_{datetime.now():%Y%m%d_%H%M}.xlsx"
    return StreamingResponse(io.BytesIO(data), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})

REPORT_EVERY = int(os.getenv("REPORT_EVERY_MIN", "0"))   # 0 = sirf button dabane par; 30 = har 30 minute me apne aap

@app.on_event("startup")
async def _report_scheduler():
    async def loop():
        await asyncio.sleep(30)
        while True:
            if not REPORT["running"]: await _run_report()
            await asyncio.sleep(REPORT_EVERY * 60)
    if REPORT_EVERY > 0:
        t = asyncio.create_task(loop()); TASKS.add(t)


import time

@app.get("/api/vodtest")
async def vodtest(store_id: int, ch: int, start: str, off: int = None, seconds: int = 5):
    """NVR se recording kitni tezi se utarti hai (asli gati ke kitne guna) - tez playback ki limit batata hai."""
    r = _cam(store_id, ch); off = PB_OFFSET if off is None else off
    t0 = datetime.strptime(start, "%Y-%m-%dT%H:%M:%S") - timedelta(minutes=off)
    body = await _vod_body(r, ch, t0, t0 + timedelta(seconds=max(5, min(seconds, 30))))
    secs = max(5, min(seconds, 30)); st = {"got": 0, "first": None}; t_req = time.perf_counter()
    async def pull():
        async with _nvr(r) as h:
            async with h.stream("POST", _base(r) + "/ISAPI/ContentMgmt/download", content=body, headers={"Content-Type": "application/xml"}) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes(1 << 18):
                    if st["first"] is None: st["first"] = time.perf_counter()
                    st["got"] += len(chunk)
    try:
        await asyncio.wait_for(pull(), 15)
    except asyncio.TimeoutError:     # 15 second me bhi itna chhota clip nahi utra = network bahut dheema
        return {"x": round(secs / 15, 1), "mbps": round(st["got"] * 8 / 1e6 / 15, 1), "mbyte": round(st["got"] / 1e6, 1), "latency": 15, "slow": True}
    except Exception as e:
        raise HTTPException(502, f"download test fail: {type(e).__name__} {str(e)[:80]}")
    got, t_first = st["got"], st["first"]
    t_end = time.perf_counter()
    if not got or t_first is None: raise HTTPException(404, "download me data nahi aaya")
    flow = max(t_end - t_first, 0.05)
    return {"x": round(secs / max(t_end - t_req, 0.05), 1), "mbps": round(got * 8 / 1e6 / flow, 1),
            "mbyte": round(got / 1e6, 1), "latency": round(t_first - t_req, 1)}


@app.get("/api/report/debug", dependencies=[Depends(admin)])
async def report_debug(store_id: int, ch: int = 1):
    """Report galat lage to: ek store/camera ki jaanch ka kaccha nateeja dikhata hai."""
    s = get_store(store_id); pw = fernet.decrypt(s["pw"].encode()).decode()
    out = {"store": s["name"], "ip": s["ip"], "port": s["port"], "http_port": s["http_port"], "channel": ch, "tcp_ok": await ping(s)}
    try:
        async with _nvr(s) as h:
            r = await h.get(_base(s) + "/ISAPI/ContentMgmt/InputProxy/channels/status")
        out["isapi_status"] = {"code": r.status_code, "body": r.text[:900]}
    except Exception as e:
        out["isapi_status"] = {"error": f"{type(e).__name__} {str(e)[:120]}"}
    code, trace = await rtsp_describe(s["ip"], s["port"], s["username"], pw, ch)
    out["rtsp_sub_stream"] = {"code": code, "steps": trace}
    return out


@app.post("/api/cam/open")
async def cam_open(store_id: int, ch: int):
    """Sirf ek camera ke stream taiyaar karo (alag window me live dekhne ke liye)."""
    _cam(store_id, ch)
    return await register(q(CAM_SQL + "where c.store_id=? and c.ch=?", (store_id, ch)))


# ---------------- Users (admin / viewer) ----------------
from pydantic import BaseModel

class UserReq(BaseModel):
    username: str
    password: str = ""
    role: str = "viewer"
    can_groups: bool = False

@app.get("/api/users", dependencies=[Depends(admin)])
def users(): return q("select username, role, can_groups, created from app_users order by username")

@app.post("/api/users", dependencies=[Depends(admin)])
def user_set(req: UserReq):
    name = req.username.strip()
    if not re.fullmatch(r"[A-Za-z0-9_.@-]{3,50}", name): raise HTTPException(400, "Naam me sirf English akshar, ank aur . _ - @ hon (3 se 50)")
    if req.role not in ("viewer", "admin"): raise HTTPException(400, "role galat hai")
    if name.lower() == APP_USER.lower(): raise HTTPException(400, "Yeh naam main admin ka hai")
    cg = 1 if req.can_groups else 0
    if req.password:
        if len(req.password) < 8: raise HTTPException(400, "Password kam se kam 8 akshar ka rakhein")
        h = _hash(req.password)
        if q("update app_users set pw_hash=?, role=?, can_groups=? where username=?", (h, req.role, cg, name)) == 0:
            q("insert into app_users(username,pw_hash,role,can_groups,created) values(?,?,?,?,?)", (name, h, req.role, cg, datetime.now()))
    elif q("update app_users set role=?, can_groups=? where username=?", (req.role, cg, name)) == 0:
        raise HTTPException(400, "Naye user ke liye password zaroori hai")
    _AUTHC.clear(); return {"ok": True}

@app.delete("/api/users/{name}", dependencies=[Depends(admin)])
def user_del(name: str):
    q("delete from app_users where username=?", (name,)); _AUTHC.clear(); return {"ok": True}

# ---------------- go2rtc proxy: browser sirf 8000 se baat kare, go2rtc (1984) sirf is PC par khula rahe ----------------
try:
    import websockets
except ImportError:      # app phir bhi khule; tab video purane seedhe tarike se chalega
    websockets = None
    print("\n*** WARNING: 'websockets' install nahi hai. Chalayein:  venv\\Scripts\\pip install websockets  ***\n")
GO2RTC_WS = "ws" + GO2RTC[4:]
_WSKEY = (os.environ["FERNET_KEY"] + "-ws").encode()

def _wstok_new():
    exp = str(int(time.time()) + 12 * 3600)
    return exp + "." + hmac.new(_WSKEY, exp.encode(), "sha256").hexdigest()[:32]

def _wstok_ok(t):
    try:
        exp, sig = t.split(".")
        return int(exp) > time.time() and hmac.compare_digest(sig, hmac.new(_WSKEY, exp.encode(), "sha256").hexdigest()[:32])
    except Exception:
        return False

@app.get("/api/wstoken")
def wstoken(): return {"t": _wstok_new() if websockets else ""}

@app.get("/g/{name}")
async def g_static(name: str):
    if name not in ("video-stream.js", "video-rtc.js"): raise HTTPException(404)
    async with httpx.AsyncClient(timeout=10) as h:
        r = await h.get(f"{GO2RTC}/{name}")
    return Response(r.content, media_type="text/javascript")

@app.websocket("/g/api/ws")
async def g_ws(ws: WebSocket, src: str, t: str = ""):
    if websockets is None or not _wstok_ok(t) or not re.fullmatch(r"[\w\-]+", src):
        await ws.close(code=1008); return
    await ws.accept()
    try:
        async with websockets.connect(f"{GO2RTC_WS}/api/ws?src={src}", max_size=None, open_timeout=10) as up:
            async def c2u():
                while True:
                    m = await ws.receive()
                    if m["type"] == "websocket.disconnect": break
                    if m.get("text") is not None: await up.send(m["text"])
                    elif m.get("bytes") is not None: await up.send(m["bytes"])
            async def u2c():
                async for m in up:
                    if isinstance(m, bytes): await ws.send_bytes(m)
                    else: await ws.send_text(m)
            t1, t2 = asyncio.create_task(c2u()), asyncio.create_task(u2c())
            await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
            t1.cancel(); t2.cancel()
    except Exception:
        pass
    finally:
        try: await ws.close()
        except Exception: pass

````

# Appendix C — `index.html` (frontend, complete)
````html
<!doctype html>
<html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CCTV Hub</title>
<style>
:root{--brand:#1d4ed8;--bg:#eef2f7;--panel:#fff;--line:#d9e1ec;--tx:#1e293b;--mut:#64748b;--ok:#16a34a;--bad:#dc2626}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--tx);font:14px/1.4 "Segoe UI",system-ui,sans-serif;display:flex;flex-direction:column}
[hidden]{display:none!important}
.top{display:flex;align-items:center;gap:14px;padding:8px 18px;color:#fff;background:var(--brand);background:linear-gradient(90deg,var(--brand),color-mix(in srgb,var(--brand) 65%,#000))}
.top .logo{height:42px;max-width:160px;object-fit:contain;background:#fff;border-radius:8px;padding:4px 9px}
.top .logo.solo{height:54px;max-width:280px}
.top h1{margin:0;font-size:20px;font-weight:700;line-height:1.2}
.top small{display:block;opacity:.85;font-size:12px;font-weight:400}
.top .clock{margin-left:auto;font-variant-numeric:tabular-nums;opacity:.95;font-size:13px}
.app{flex:1;display:flex;min-height:0}
aside{width:290px;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column}
aside header{padding:12px;border-bottom:1px solid var(--line);display:grid;gap:8px}
input,select,button{background:#fff;color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:7px 9px;font:inherit}
button{cursor:pointer;transition:background .15s,border-color .15s}
button:hover{border-color:var(--brand);color:var(--brand)}
button.on,button.on:hover{background:var(--brand);border-color:var(--brand);color:#fff}
button:focus-visible,input:focus-visible,select:focus-visible,li:focus-visible{outline:2px solid var(--brand);outline-offset:1px}
#list{list-style:none;margin:0;padding:0;overflow:auto;flex:1}
#list li{padding:9px 12px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;gap:9px;align-items:center}
#list li:hover{background:#f3f6fb}
#list li.sel{background:#e8eefc;background:color-mix(in srgb,var(--brand) 12%,#fff);box-shadow:inset 3px 0 0 var(--brand)}
#list small{color:var(--mut);display:block}
#list .del{margin-left:auto;padding:0 8px}
.dot{width:9px;height:9px;border-radius:50%;background:#94a3b8;flex:none}.dot.up{background:var(--ok)}.dot.down{background:var(--bad)}
main{flex:1;display:flex;flex-direction:column;min-width:0}
.bar{display:flex;gap:8px;align-items:center;padding:10px 14px;background:#fff;border-bottom:1px solid var(--line);flex-wrap:wrap}
.bar h1{font-size:17px;margin:0 auto 0 0;font-weight:600;color:var(--brand)}
#wall{flex:1;display:grid;gap:3px;padding:3px;min-height:0;background:#0f172a}
.tile{position:relative;background:#000;cursor:pointer;min-height:0;overflow:hidden}
.tile video-stream{display:block;width:100%;height:100%}.tile video{object-fit:contain}
.tile span{position:absolute;left:6px;bottom:5px;background:#000a;color:#fff;padding:1px 7px;border-radius:4px;font-size:12px;pointer-events:none}
.tile .x{position:absolute;top:5px;right:5px;padding:1px 8px;background:#000a;color:#fff;border-color:#fff3;opacity:0}
.tile:hover .x,.tile .x:focus-visible{opacity:1}
#empty{margin:auto;color:#94a3b8}
dialog label{display:grid;gap:3px;font-size:13px;color:var(--mut)}
dialog{background:#fff;color:var(--tx);border:1px solid var(--line);border-radius:10px;min-width:320px}dialog::backdrop{background:#0006}
#pbView{position:fixed;inset:0;background:#0b1220;z-index:11;display:flex;flex-direction:column;color:#e2e8f0}
.pvTop{display:flex;gap:8px;align-items:center;padding:8px 12px;background:#111a2e;flex-wrap:wrap}
.pvTop b{margin-right:auto;font-size:15px}.pvTop #pvInfo{color:#fbbf24;font-size:13px}
#pvVideo{flex:1;min-height:0;background:#000}#pvVideo video-stream{display:block;width:100%;height:100%}
.pvBottom{padding:8px 14px 14px;background:#111a2e}#pvTime{font-variant-numeric:tabular-nums;font-size:13px;margin-bottom:6px;color:#94a3b8}
#tl{position:relative;height:60px;background:#1e293b;border-radius:6px;cursor:crosshair;overflow:hidden;user-select:none}
.seg{position:absolute;top:8px;height:22px;background:#3b82f6}
.tick{position:absolute;top:0;bottom:0;border-left:1px solid #475569;font-size:11px;color:#94a3b8;padding:38px 0 0 3px;pointer-events:none}
#tlCur{position:absolute;top:0;bottom:0;width:2px;background:#ef4444;pointer-events:none;display:none}
#tlHov{position:absolute;top:0;transform:translateX(-50%);font-size:11px;background:#000c;color:#fff;padding:0 5px;border-radius:3px;pointer-events:none;display:none}
#cal{position:absolute;top:calc(100% + 6px);left:0;z-index:20;width:290px;background:#fff;color:var(--tx);border:1px solid var(--line);border-radius:10px;padding:10px;box-shadow:0 8px 24px #0006}
#cal .ch{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-weight:600}
#cal .g{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;text-align:center}
#cal .w{font-size:11px;color:var(--mut)}
#cal .d{padding:6px 0;border-radius:6px;border:1px solid transparent;background:none;color:#b6c0cf;cursor:default}
#cal .d.can{color:var(--tx);cursor:pointer}
#cal .d.rec{background:#2563eb;color:#fff;font-weight:600;cursor:pointer}
#cal .d.today{border-color:var(--mut)}
#cal .d.sel{outline:2px solid #ef4444;outline-offset:1px}
#cal small{display:block;margin-top:8px;color:var(--mut);line-height:1.4}
.pvCtl{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px}.pvCtl button,.pvCtl select{padding:4px 9px}
#pvSkim{font-size:12px;color:#fbbf24}
#pvVideo.split{display:grid;gap:3px;background:#0f172a}
.stile{position:relative;background:#000;min-height:0;cursor:pointer;overflow:hidden}
.stile span{position:absolute;left:6px;bottom:5px;background:#000a;color:#fff;font-size:12px;padding:1px 7px;border-radius:4px;pointer-events:none}
.top button{background:#ffffff26;color:#fff;border-color:#ffffff66}.top button:hover{background:#ffffff40;color:#fff}
#repView{position:fixed;inset:0;background:var(--bg);z-index:12;display:flex;flex-direction:column}
.rpTop{display:flex;gap:8px;align-items:center;padding:10px 16px;background:#fff;border-bottom:1px solid var(--line);flex-wrap:wrap}
.rpTop b{font-size:17px;color:var(--brand);margin-right:auto}#rpInfo{color:var(--mut);font-size:13px}
.rpCards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;padding:12px 16px}
.rpCards div{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.rpCards small{display:block;color:var(--mut);font-size:12px}.rpCards strong{font-size:22px}
.rpBar{display:flex;gap:8px;align-items:center;padding:0 16px 10px;flex-wrap:wrap}.rpBar label{display:flex;gap:5px;align-items:center;font-size:13px}
.rpBody{flex:1;overflow:auto;margin:0 16px 16px;background:#fff;border:1px solid var(--line);border-radius:10px}
.rpBody table{width:100%;border-collapse:collapse}.rpBody th{position:sticky;top:0;background:#f1f5f9;text-align:left;padding:8px 10px;font-size:12px;color:var(--mut)}
.rpBody td{padding:7px 10px;border-top:1px solid var(--line)}.rpBody tr[data-id],.rpBody tr[data-act]{cursor:pointer}.rpBody tr[data-id]:hover,.rpBody tr[data-act]:hover{background:#f3f6fb}
.rpCards [data-tab]:hover{border-color:var(--brand)}.rpHint{padding:9px 12px;color:var(--mut);font-size:13px;border-bottom:1px solid var(--line)}
#bigTitle{position:absolute;top:14px;left:16px;color:#fff;z-index:10;font-weight:600;text-shadow:0 1px 3px #000}
.bd{padding:1px 8px;border-radius:10px;font-weight:600;font-size:12px;color:#fff}.bd.g{background:#16a34a}.bd.a{background:#d97706}.bd.r{background:#dc2626}
.bd.n{background:#94a3b8}
#tl.tl-l{box-shadow:inset 36px 0 28px -18px #fbbf24}#tl.tl-r{box-shadow:inset -36px 0 28px -18px #fbbf24}
.viewer .adm{display:none!important}.nogrp .grp{display:none!important}
#big{position:fixed;inset:0;background:#000;display:none;z-index:9}#big.on{display:block}
#big video-stream{display:block;width:100%;height:100%}
#big button{position:absolute;top:12px;right:12px;z-index:10}
</style></head><body>
<div class="top"><img id="logo" class="logo" alt="logo" hidden><div><h1 id="bn">CCTV Hub</h1><small id="bs"></small></div><div style="margin-left:auto;display:flex;gap:14px;align-items:center"><span id="me" style="font-size:13px;opacity:.9"></span><button id="usBtn" class="adm" hidden>👥 Users</button><button id="repBtn">📊 Camera Report</button><div class="clock" id="clock"></div></div></div>
<div class="app">
<aside><header>
 <div style="display:flex;gap:6px"><button id="tabS" class="on" style="flex:1">स्टोर</button><button id="tabG" style="flex:1">ग्रुप</button></div>
 <input id="q" placeholder="स्टोर, शहर या ज़ोन खोजें" aria-label="Search stores">
 <div id="storeTools" class="adm" style="display:flex;gap:6px"><button id="imp">CSV import</button><button id="disc">कैमरा खोजें</button></div>
 <div id="groupTools" class="grp" hidden><button id="newG" style="width:100%">+ नया ग्रुप बनाएँ</button></div>
 <input type="file" id="file" accept=".csv" hidden>
</header><ul id="list"></ul></aside>
<main>
 <div class="bar"><h1 id="title">कोई स्टोर चुनें</h1>
  <button id="prev">‹</button><span id="pg"></span><button id="next">›</button>
  <select id="grid"><option value="1">1</option><option value="4">4</option><option value="9">9</option><option value="16" selected>16</option><option value="25">25</option></select>
  <select id="sec"><option value="15">15 सेकंड</option><option value="30">30 सेकंड</option><option value="60">60 सेकंड</option></select>
  <span id="pbInfo" style="color:var(--bad);font-weight:600"></span>
  <button id="liveBtn" hidden>● Live पर जाएँ</button><button id="pbBtn" hidden>▶ Playback</button><button id="bkBtn" class="adm" hidden>⬇ Backup</button>
  <button id="byName" class="grp" hidden>नाम से कैमरे जोड़ें</button>
  <button id="tour">Tour चालू करें</button></div>
 <div id="wall"><div id="empty">बाईं तरफ़ से स्टोर चुनें</div></div>
</main>
</div>
<dialog id="dlg"><p id="dlgT" style="margin:0 0 10px"></p><select id="dlgSel" style="width:100%"></select>
 <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end"><button id="dlgNo">रद्द करें</button><button id="dlgOk">ग्रुप में जोड़ें</button></div></dialog>
<dialog id="pbDlg"><p style="margin:0 0 12px;font-weight:600">Playback: रिकॉर्डिंग देखें</p>
 <div style="display:grid;gap:10px">
  <label>तारीख<input type="date" id="pbDate"></label>
  <label>शुरू का समय<input type="time" id="pbTime"></label>
  <label>कितनी देर<select id="pbMin"><option value="5">5 मिनट</option><option value="10" selected>10 मिनट</option><option value="15">15 मिनट</option><option value="30">30 मिनट</option><option value="60">60 मिनट</option><option value="120">2 घंटे</option><option value="240">4 घंटे</option><option value="480">8 घंटे</option></select></label></div>
 <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end"><button id="pbNo">रद्द करें</button><button id="pbGo" class="on">चलाएँ</button></div></dialog>
<dialog id="bkDlg"><p style="margin:0 0 12px;font-weight:600">Backup: NVR की रिकॉर्डिंग इस PC में सेव करें</p>
 <div style="display:grid;gap:10px">
  <label>कौन से कैमरे<select id="bkScope"><option value="all">इस स्टोर/ग्रुप के सारे कैमरे</option><option value="page">सिर्फ़ स्क्रीन पर दिख रहे कैमरे</option></select></label>
  <label style="display:flex;gap:8px;align-items:center;color:var(--tx)"><input type="checkbox" id="bkOld" checked>NVR में जो सबसे पुरानी रिकॉर्डिंग है, वहाँ से</label>
  <label>कब से<input type="datetime-local" id="bkFrom" disabled></label>
  <label>कब तक<input type="datetime-local" id="bkTo"></label></div>
 <div id="bkProg" style="margin-top:12px;font-size:13px;line-height:1.5"></div>
 <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end"><button id="bkNo">बंद करें</button><button id="bkGo" class="on">Backup शुरू करें</button></div></dialog>
<dialog id="usDlg"><p style="margin:0 0 10px;font-weight:600">👥 यूज़र (लॉगिन)</p>
 <div id="usList" style="max-height:220px;overflow:auto;margin-bottom:12px;min-width:330px"></div>
 <div style="display:grid;gap:8px"><input id="usName" placeholder="यूज़र का नाम (English, जैसे ravi.team)"><input id="usPw" type="password" placeholder="पासवर्ड (नए यूज़र के लिए ज़रूरी; पुराने में खाली = न बदले)">
  <select id="usRole"><option value="viewer">सिर्फ़ देखने वाला (viewer)</option><option value="admin">admin (सारे अधिकार)</option></select>
  <label style="display:flex;gap:8px;align-items:center;font-size:14px;color:var(--tx)"><input type="checkbox" id="usGrp">ग्रुप बना/हटा सकता है (कैमरे जोड़ना-हटाना भी)</label></div>
 <p style="font-size:12px;color:var(--mut);max-width:340px;line-height:1.5">viewer: लाइव, प्लेबैक और रिपोर्ट देख सकता है। स्टोर जोड़ना, Backup, "अभी जाँचें" और यूज़र बनाना नहीं कर सकता। ग्रुप बनाना/हटाना तभी कर सकता है जब ऊपर वाला बॉक्स चुना हो। किसी यूज़र की अनुमति बदलने के लिए "बदलें" दबाएँ।</p>
 <div id="usMsg" style="color:var(--bad);font-size:13px;min-height:18px"></div>
 <div style="display:flex;gap:8px;justify-content:flex-end"><button id="usNo">बंद करें</button><button id="usGo" class="on">जोड़ें / बदलें</button></div></dialog>
<div id="repView" hidden>
 <div class="rpTop"><b>📊 कैमरा रिपोर्ट</b><span id="rpInfo"></span><button id="rpRun" class="on adm">अभी जाँचें</button><button id="rpXls">⬇ Excel</button><button id="rpClose">बंद करें</button></div>
 <div class="rpCards" id="rpCards"></div>
 <div class="rpBar"><button data-t="s" class="on">स्टोर वाइज़</button><button data-t="g">ग्रुप वाइज़</button><button data-t="o">बंद कैमरे</button><button data-t="n">बंद NVR</button>
  <input id="rpQ" placeholder="स्टोर, कैमरा, ग्रुप या IP खोजें"><label><input type="checkbox" id="rpBad">सिर्फ़ गड़बड़ी वाले</label></div>
 <div class="rpBody" id="rpBody"></div>
</div>
<div id="pbView" hidden>
 <div class="pvTop"><b id="pvTitle"></b><span id="pvInfo"></span>
  <select id="pvOff" title="NVR का समय किस तरह का है"><option value="0">NVR समय: Local</option><option value="330">NVR समय: UTC</option></select>
  <button id="pvPrev">‹</button><span style="position:relative"><button id="pvDate">📅</button><div id="cal" hidden></div></span><button id="pvNext">›</button>
  <button id="pvB30">⏪ 30 सेकंड</button><button id="pvF30">30 सेकंड ⏩</button><button id="pvAll">पूरा दिन</button><button id="pvClose">बंद करें</button></div>
 <div id="pvVideo"></div>
 <div class="pvBottom"><div id="pvTime">टाइमलाइन पर जहाँ क्लिक करेंगे, वहाँ से रिकॉर्डिंग चलेगी · माउस का पहिया घुमाकर ज़ूम करें</div><div class="pvCtl">
  <button data-j="-600">−10 मि</button><button data-j="-300">−5 मि</button><button data-j="-60">−1 मि</button>
  <select id="pvRate" title="चलाने की गति"><option value="1" selected>गति 1x</option><option value="2">2x</option><option value="4">4x</option><option value="8">8x</option><option value="16">16x</option></select>
  <button data-j="60">+1 मि</button><button data-j="300">+5 मि</button><button data-j="600">+10 मि</button>
  <span id="pvSkim"></span></div>
 <div id="tl"></div></div>
</div>
<div id="big"><div id="bigTitle"></div><button id="close">बंद करें</button></div>
<script type="module">
const H = location.hostname, $ = id => document.getElementById(id);
let WSB = null, WST = "";
try {
  if (new URLSearchParams(location.search).has("direct")) throw new Error("direct");
  WST = (await (await fetch("/api/wstoken")).json()).t; if (!WST) throw new Error("no token");
  await import("/g/video-stream.js");
  WSB = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/g/api/ws`;
  setInterval(async () => { try { WST = (await (await fetch("/api/wstoken")).json()).t; } catch (e) {} }, 6 * 3600e3);
} catch (e) {
  try { await import(`http://${H}:1984/video-stream.js`); }
  catch (e2) { console.error("go2rtc player load failed", e2); setTimeout(() => alert("वीडियो प्लेयर लोड नहीं हुआ। go2rtc चल रहा है या नहीं देखें।"), 500); }
}
const api = (p, m="GET", b) => fetch(p, {method:m, body:b}).then(r => r.json());
let stores = [], groups = [], status = {}, mode = "store", cur = null, cams = [], page = 0, tourT = null, pb = null, drawTok = 0;

const mk = (stream) => { const v = document.createElement("video-stream"); v.mode = "webrtc,mse"; return [v, () => v.src = WSB ? `${WSB}?src=${stream}&t=${WST}` : `ws://${H}:1984/api/ws?src=${stream}`]; };

function drawList() {
  const q = $("q").value.toLowerCase(), ul = $("list"); ul.innerHTML = "";
  if (mode === "group") {
    groups.filter(g => g.name.toLowerCase().includes(q)).forEach(g => {
      const li = document.createElement("li"); li.tabIndex = 0; if (cur?.id === g.id) li.className = "sel";
      li.innerHTML = `<div>${g.name}<small>${g.cams} कैमरे</small></div><button class="del grp" title="ग्रुप हटाएँ">×</button>`;
      li.onclick = () => openGroup(g); li.onkeydown = e => { if (e.key === "Enter") openGroup(g); };
      li.querySelector(".del").onclick = async e => { e.stopPropagation(); if (confirm(`"${g.name}" ग्रुप हटाएँ? (कैमरे नहीं हटेंगे)`)) { await api(`/api/groups/${g.id}`, "DELETE"); if (cur?.id === g.id) { cur = null; cams = []; drawWall(); } loadGroups(); } };
      ul.append(li);
    });
    return;
  }
  stores.filter(s => `${s.name} ${s.city} ${s.zone}`.toLowerCase().includes(q)).forEach(s => {
    const li = document.createElement("li"); li.tabIndex = 0; if (cur?.id === s.id) li.className = "sel";
    li.innerHTML = `<i class="dot ${status[s.id]===true?"up":status[s.id]===false?"down":""}"></i><div>${s.name}<small>${s.city||""} · ${s.zone||""} · ${s.cams} कैमरे</small></div>`;
    li.onclick = () => openStore(s); li.onkeydown = e => { if (e.key === "Enter") openStore(s); };
    ul.append(li);
  });
}
async function loadStores() { stores = await api("/api/stores"); drawList(); }
async function loadGroups() { groups = await api("/api/groups"); drawList(); }
async function loadStatus() { status = await api("/api/status"); drawList(); }

function setMode(m) {
  mode = m; cur = null; cams = []; page = 0;
  $("tabS").classList.toggle("on", m === "store"); $("tabG").classList.toggle("on", m === "group");
  $("storeTools").hidden = m !== "store"; $("groupTools").hidden = m !== "group"; $("byName").hidden = true;
  $("title").textContent = m === "store" ? "कोई स्टोर चुनें" : "कोई ग्रुप चुनें"; drawList(); drawWall();
}
$("tabS").onclick = () => setMode("store"); $("tabG").onclick = () => { setMode("group"); loadGroups(); };

async function openStore(s) {
  cur = s; page = 0; $("title").textContent = s.name; $("byName").hidden = true; drawList();
  cams = await api(`/api/stores/${s.id}/open`, "POST"); drawWall();
}
async function openGroup(g) {
  cur = g; page = 0; $("title").textContent = `${g.name} (${g.cams} कैमरे)`; $("byName").hidden = false; drawList();
  cams = await api(`/api/groups/${g.id}/open`, "POST"); drawWall();
}
async function drawWall() {
  const n = +$("grid").value, cols = Math.ceil(Math.sqrt(n)), wall = $("wall");
  wall.innerHTML = ""; $("pbBtn").hidden = !cams.length; $("bkBtn").hidden = !cams.length; $("liveBtn").hidden = !pb; $("pbInfo").textContent = pb ? "▶ Playback: " + pb.label : "";
  if (!cams.length) { wall.innerHTML = `<div id="empty">${cur ? "इसमें अभी कोई कैमरा नहीं है" : mode === "store" ? "बाईं तरफ़ से स्टोर चुनें" : "बाईं तरफ़ से ग्रुप चुनें, या नया ग्रुप बनाएँ"}</div>`; $("pg").textContent = ""; return; }
  wall.style.gridTemplateColumns = `repeat(${cols},1fr)`; wall.style.gridTemplateRows = `repeat(${Math.ceil(n/cols)},1fr)`;
  const pages = Math.max(1, Math.ceil(cams.length / n));
  page = Math.min(page, pages - 1); $("pg").textContent = `${page+1} / ${pages}`;
  const vis = cams.slice(page*n, page*n + n), tok = ++drawTok;
  let pbm = null;
  if (pb) { try { pbm = await registerPb(vis); } catch (e) { alert("Playback शुरू नहीं हुआ"); pb = null; } }
  if (tok !== drawTok) return;
  vis.forEach(c => {
    const t = document.createElement("div"); t.className = "tile";
    const key = pbm ? pbm[c.store_id + "-" + c.ch] : null;
    const [v, go] = mk(key || c.sub); t.append(v); wall.append(t); go();
    const l = document.createElement("span"); l.textContent = mode === "group" ? `${c.store} · ${c.name}` : `${c.ch}. ${c.name}`; t.append(l);
    const b = document.createElement("button"); b.className = "x grp";
    if (mode === "group") { b.textContent = "× हटाएँ"; b.onclick = async e => { e.stopPropagation(); await api(`/api/groups/${cur.id}/cam?store_id=${c.store_id}&ch=${c.ch}`, "DELETE"); cams = cams.filter(x => x !== c); cur.cams--; drawWall(); loadGroups(); }; }
    else { b.textContent = "+ ग्रुप"; b.onclick = e => { e.stopPropagation(); addToGroup(c); }; }
    t.append(b);
    t.onclick = () => { clearTimeout(t._t); t._t = setTimeout(() => full(c, key), 250); };
    t.ondblclick = () => { clearTimeout(t._t); openPb(c); };
  });
}
async function registerPb(vis) {
  const r = await fetch("/api/playback", {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({items: vis.map(c => ({store_id: c.store_id, ch: c.ch})), start: pb.start, minutes: pb.minutes})});
  if (!r.ok) throw new Error("pb");
  const m = {}; (await r.json()).forEach(x => m[x.store_id + "-" + x.ch] = x.stream); return m;
}
$("pbBtn").onclick = () => {
  const d = new Date(Date.now() - 30 * 60000);
  $("pbDate").value = d.toLocaleDateString("en-CA"); $("pbTime").value = d.toTimeString().slice(0, 5); $("pbDlg").showModal();
};
$("pbNo").onclick = () => $("pbDlg").close();
$("pbGo").onclick = () => {
  if (!$("pbDate").value || !$("pbTime").value) return alert("तारीख और समय भरें");
  const min = +$("pbMin").value;
  pb = {start: `${$("pbDate").value}T${$("pbTime").value}`, minutes: min, label: `${$("pbDate").value} ${$("pbTime").value} · ${min} मिनट`};
  $("pbDlg").close(); drawWall();
};
$("liveBtn").onclick = () => { pb = null; drawWall(); };
const dtl = d => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
$("bkBtn").onclick = () => {
  const now = new Date(); $("bkTo").value = dtl(now); $("bkFrom").value = dtl(new Date(now - 864e5));
  $("bkProg").textContent = ""; $("bkGo").disabled = false; $("bkDlg").showModal();
};
$("bkOld").onchange = () => $("bkFrom").disabled = $("bkOld").checked;
$("bkNo").onclick = () => $("bkDlg").close();
$("bkGo").onclick = async () => {
  const n = +$("grid").value, list = $("bkScope").value === "page" ? cams.slice(page * n, page * n + n) : cams;
  if (!$("bkTo").value || (!$("bkOld").checked && !$("bkFrom").value)) return alert("तारीख़ और समय भरें");
  if (!confirm(`${list.length} कैमरों का backup शुरू करें? बड़ा हो सकता है, सर्वर की डिस्क में जगह देख लें।`)) return;
  $("bkGo").disabled = true;
  const r = await fetch("/api/backup", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({
    items: list.map(c => ({store_id: c.store_id, ch: c.ch})), start: $("bkOld").checked ? "" : $("bkFrom").value, end: $("bkTo").value})});
  if (!r.ok) { $("bkProg").textContent = "Backup शुरू नहीं हुआ"; $("bkGo").disabled = false; return; }
  const id = (await r.json()).id, gb = b => (b / 1073741824).toFixed(2);
  const t = setInterval(async () => {
    const j = await api(`/api/backup/${id}`);
    $("bkProg").innerHTML = `${j.status === "done" ? "✔ पूरा हुआ" : "⏳ चल रहा है"}<br>कैमरे: ${j.done} / ${j.total} · फ़ाइलें: ${j.files} · ${gb(j.bytes)} GB<br>सेव की जगह: ${j.dir}<br>डिस्क में खाली जगह: ${gb(j.free)} GB`
      + (j.errors.length ? `<br><span style="color:var(--bad)">${j.errors.length} कैमरों में दिक्कत: ${j.errors.slice(0, 3).join(" | ")}</span>` : "");
    if (j.status === "done") { clearInterval(t); $("bkGo").disabled = false; }
  }, 2000);
};
/* ---------- Hikvision जैसा Playback (कैमरे पर double-click) ---------- */
let pv = null;
const hms = s => [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map(x => String(x).padStart(2, "0")).join(":");
const today = () => new Date().toLocaleDateString("en-CA");
const mergeSegs = a => a.sort((x, y) => x[0] - y[0]).reduce((o, s) => { const l = o[o.length - 1]; if (l && s[0] <= l[1] + 2) l[1] = Math.max(l[1], s[1]); else o.push([...s]); return o; }, []);
const curSec = () => !pv.playing ? 0 : pv.vid ? pv.pos + pv.vid.currentTime : pv.pos + (performance.now() - pv.t0) / 1000;

function renderTl() {
  const tl = $("tl"), [v0, v1] = pv.view, span = v1 - v0; tl.innerHTML = "";
  const step = span >= 43200 ? 7200 : span >= 10800 ? 3600 : span >= 3600 ? 900 : span >= 900 ? 300 : 60;
  for (let t = Math.ceil(v0 / step) * step; t <= v1; t += step) {
    const d = document.createElement("div"); d.className = "tick"; d.style.left = ((t - v0) / span * 100) + "%"; d.textContent = hms(t).slice(0, 5); tl.append(d);
  }
  pv.segs.forEach(([s, e]) => {
    if (e <= v0 || s >= v1) return;
    const d = document.createElement("div"); d.className = "seg"; d.style.left = ((Math.max(s, v0) - v0) / span * 100) + "%"; d.style.width = ((Math.min(e, v1) - Math.max(s, v0)) / span * 100) + "%"; tl.append(d);
  });
  tl.insertAdjacentHTML("beforeend", '<div id="tlCur"></div><div id="tlHov"></div>'); updCur();
}
function updCur() {
  const c = $("tlCur"); if (!pv || !c) return;
  if (!pv.playing) { c.style.display = "none"; return; }
  const cur = curSec(), [v0, v1] = pv.view;
  c.style.display = cur >= v0 && cur <= v1 ? "block" : "none"; c.style.left = ((cur - v0) / (v1 - v0) * 100) + "%";
  $("pvTime").textContent = `${pv.date}  ${hms(Math.min(86399, Math.floor(cur)))}`;
}
setInterval(updCur, 500);

function snap(sec, dir) {
  if (pv.segs.find(s => s[0] <= sec && sec < s[1])) return sec;
  if (dir < 0) { const p = [...pv.segs].reverse().find(s => s[1] <= sec); return p ? Math.max(p[0], p[1] - 5) : null; }
  const n = pv.segs.find(s => s[0] > sec); return n ? n[0] : null;
}
const vtCache = {};
async function netSpeed(sid, ch, sec) {
  if (vtCache[sid]) return vtCache[sid].x;
  try { const c = JSON.parse(localStorage.getItem("vt_" + sid) || "null"); if (c && Date.now() - c.t < 6 * 3600e3) { vtCache[sid] = c.r; return c.r.x; } } catch (e) {}
  $("pvSkim").textContent = "⏳ NVR का नेटवर्क जाँच रहे हैं… (सिर्फ़ पहली बार, 5-15 सेकंड)";
  try {
    const r = await api(`/api/vodtest?store_id=${sid}&ch=${ch}&start=${pv.date}T${hms(sec)}&off=${pv.off}&seconds=5`);
    if (r && r.x) { vtCache[sid] = r; try { localStorage.setItem("vt_" + sid, JSON.stringify({t: Date.now(), r})); } catch (e) {} return r.x; }
  } catch (e) {}
  return 99;
}
const vodHolder = document.body.appendChild(Object.assign(document.createElement("div"), {hidden: true}));
let vodTimer = null;
const vodUrl = sec => `/api/vod?store_id=${pv.c.store_id}&ch=${pv.c.ch}&start=${pv.date}T${hms(sec)}&minutes=20&off=${pv.off}`;
function killVideo(v) { if (!v) return; v.onended = v.onerror = null; try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {} v.remove(); }
function dropVod() { if (!pv) return; killVideo(pv.vid); killVideo(pv.next); pv.vid = pv.next = null; }
function makeVod(sec, hold) {
  const v = document.createElement("video"); v.autoplay = false; v.preload = "auto"; v.muted = true; v.controls = true; v.playsInline = true;
  v.style.cssText = "width:100%;height:100%;background:#000;object-fit:contain";
  v._pos = sec; v._hold = hold; v.src = vodUrl(sec);
  v.defaultPlaybackRate = pv.rate; v.playbackRate = pv.rate;
  v.onloadedmetadata = () => { v.playbackRate = pv.rate; };
  v.onended = () => {
    if (!pv || pv.vid !== v) return;
    if (v.currentTime < 1) { $("pvInfo").textContent = "आगे रिकॉर्डिंग नहीं मिली"; return; }
    if (pv.next) swapVod(pv.next); else pvSeek(v._pos + Math.floor(v.currentTime) + 1);
  };
  v.onerror = async () => {
    if (v._hold) { if (pv && pv.next === v) pv.next = null; return; }
    let m = "तेज़ मोड नहीं चला";
    try { const r = await fetch(v.src); if (!r.ok) m += ": " + ((await r.json()).detail || r.status); else { r.body.cancel(); m += " (वीडियो ब्राउज़र में नहीं चल रहा, शायद H.265 है)"; } } catch (e) {}
    $("pvInfo").textContent = m;
  };
  return v;
}
function swapVod(nv) {
  killVideo(pv.vid);
  const box = $("pvVideo"); box.innerHTML = ""; box.append(nv); nv._hold = false;
  pv.vid = nv; pv.pos = nv._pos; pv.t0 = performance.now(); pv.next = null; nv.playbackRate = pv.rate;
}
function noteStall() {
  const now = Date.now(); pv.stalls = (pv.stalls || []).filter(t => now - t < 40000); pv.stalls.push(now);
  if (pv.stalls.length >= 3 && pv.rate > 1) {
    const from = pv.rate, nr = {16: 8, 8: 4, 4: 2, 2: 1}[from]; pv.stalls = [];
    pv.rate = nr; $("pvRate").value = String(nr); pvSeek(Math.floor(curSec()));
    $("pvInfo").textContent = `${from}x पर बार-बार अटक रहा था, इसलिए ${nr}x पर चला रहे हैं`;
  }
}
function vodTick() {
  if (!pv || !pv.vid) { clearInterval(vodTimer); vodTimer = null; return; }
  const v = pv.vid, b = v.buffered, ahead = b.length ? b.end(b.length - 1) - v.currentTime : 0, fin = isFinite(v.duration);
  if (v.paused && !v.ended && (fin || ahead >= 6 + pv.rate * 1.5)) v.play().catch(() => {});
  else if (!v.paused && !fin && ahead < 0.5 + pv.rate * 0.4) { v.pause(); noteStall(); }
  if (fin && !pv.next && v.duration > 0) {      // यह भाग पूरा उतर चुका है: अगला भाग पहले से तैयार रखो
    const sn = snap(v._pos + Math.floor(v.duration) + 1, 1);
    if (sn !== null && sn < 86399) { pv.next = makeVod(sn, true); vodHolder.append(pv.next); }
  }
  const vt = vtCache[pv.c.store_id];
  $("pvSkim").textContent = `⚡ ${pv.rate}x तेज़ मोड · बफ़र ${Math.max(0, Math.floor(ahead))} सेकंड` + (v.paused && !v.ended && !fin ? " · ⏸ बफ़र जमा हो रहा है" : "")
    + (pv.next ? " · अगला भाग तैयार" : "") + (vt ? ` · NVR से डाउनलोड ~${vt.x}x (${vt.mbps} Mbps)` : "");
}
async function pvSeek(sec, dir = 1) {
  sec = Math.max(0, Math.min(86399, Math.floor(sec)));
  const sn = snap(sec, dir);
  if (sn === null) { $("pvInfo").textContent = dir < 0 ? "इससे पहले रिकॉर्डिंग नहीं है" : "इस समय के बाद रिकॉर्डिंग नहीं है"; return false; }
  sec = sn;
  if (!pv.err) $("pvInfo").textContent = "";
  dropVod();
  if ((pv.rate || 1) > 1) {
    const box = $("pvVideo"); box.innerHTML = ""; box.classList.remove("split"); box.style.gridTemplateColumns = box.style.gridTemplateRows = "";
    const v = makeVod(sec, false); pv.vid = v; pv.pos = sec; pv.t0 = performance.now(); pv.playing = true; pv.next = null; box.append(v);
    clearInterval(vodTimer); vodTimer = setInterval(vodTick, 250); updCur(); return true;
  }
  clearInterval(vodTimer); vodTimer = null; $("pvSkim").textContent = "";
  let mins = Math.ceil((86400 - sec) / 60);
  if (pv.date === today()) { const n = new Date(); mins = Math.ceil((n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds() - sec) / 60) + 1; }
  const r = await fetch("/api/playback", {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({items: [{store_id: pv.c.store_id, ch: pv.c.ch}], start: `${pv.date}T${hms(sec)}`, minutes: Math.max(1, Math.min(1440, mins)), off: pv.off})});
  if (!r.ok) { $("pvInfo").textContent = "Playback शुरू नहीं हुआ"; return false; }
  const stream = (await r.json())[0].stream;
  const box = $("pvVideo"); box.innerHTML = ""; box.classList.remove("split"); box.style.gridTemplateColumns = box.style.gridTemplateRows = "";
  const [v, go] = mk(stream); box.append(v); go();
  pv.pos = sec; pv.t0 = performance.now(); pv.playing = true; updCur(); return true;
}
async function pvLoad(date, autoplay) {
  skimStop(); dropVod(); pv.date = date; pv.playing = false; $("pvDate").textContent = "📅 " + date; $("pvVideo").innerHTML = ""; $("pvInfo").textContent = "टाइमलाइन लोड हो रही है…";
  pv.view = [0, 86400];
  try {
    const tr = await api(`/api/timeline?store_id=${pv.c.store_id}&ch=${pv.c.ch}&date=${date}&off=${pv.off}`);
    pv.err = tr.error || "";
    if (pv.err) { pv.segs = [[0, 86400]]; $("pvInfo").textContent = "NVR से रिकॉर्डिंग की सूची नहीं मिली: " + pv.err; }
    else { pv.segs = mergeSegs(tr.segments); $("pvInfo").textContent = pv.segs.length ? "" : "इस दिन की रिकॉर्डिंग नहीं है"; }
  } catch (e) { pv.segs = [[0, 86400]]; $("pvInfo").textContent = "NVR से रिकॉर्डिंग की सूची नहीं मिली, फिर भी समय पर क्लिक करके देख सकते हैं"; }
  renderTl();
  if (autoplay && pv.segs.length) pvSeek(Math.max(pv.segs[0][0], pv.segs[pv.segs.length - 1][1] - 300));
}
async function openPb(c) {
  let off = "0"; try { off = localStorage.getItem("pvoff_" + c.store_id) || "0"; } catch (e) {}
  pv = {c, date: today(), segs: [], view: [0, 86400], playing: false, off: +off, rate: 1, vid: null}; $("pvOff").value = off; $("pvRate").value = "1";
  $("pvTitle").textContent = `${c.store || cur?.name || ""} · ${c.name}`; $("pbView").hidden = false;
  $("cal").hidden = true;
  try { const o = (await api(`/api/oldest?store_id=${c.store_id}&ch=${c.ch}&off=${pv.off}`)).oldest; if (o) { pv.oldest = o; $("pvTime").textContent = `NVR में रिकॉर्डिंग ${o} से उपलब्ध है · टाइमलाइन पर क्लिक करें`; } } catch (e) {}
  pvLoad(today(), true);
}
const shiftDay = d => { const x = new Date(pv.date + "T00:00:00"); x.setDate(x.getDate() + d); return x.toLocaleDateString("en-CA"); };
$("pvOff").onchange = () => { if (!pv) return; pv.off = +$("pvOff").value; try { localStorage.setItem("pvoff_" + pv.c.store_id, pv.off); } catch (e) {} pvLoad(pv.date, true); };
$("pvPrev").onclick = () => pv && pvLoad(shiftDay(-1), false);
$("pvNext").onclick = () => pv && shiftDay(1) <= today() && pvLoad(shiftDay(1), false);
/* ---------- तारीख़ का calendar: जिन दिनों की रिकॉर्डिंग है वे नीले ---------- */
const calCache = {};
let calY = 0, calM = 0;
const calKey = () => `${pv.c.store_id}-${pv.c.ch}-${calY}-${calM}-${pv.off}`;
function calHtml(days, note) {
  const first = new Date(calY, calM - 1, 1).getDay(), n = new Date(calY, calM, 0).getDate(), t = today();
  const mn = new Date(calY, calM - 1, 1).toLocaleDateString("hi-IN", {month: "long", year: "numeric"});
  let s = `<div class="ch"><button id="calP">‹</button><span>${mn}</span><button id="calN">›</button></div><div class="g">`
    + ["रवि", "सोम", "मंगल", "बुध", "गुरु", "शुक्र", "शनि"].map(x => `<span class="w">${x}</span>`).join("") + "<span></span>".repeat(first);
  for (let d = 1; d <= n; d++) {
    const ds = `${calY}-${String(calM).padStart(2, "0")}-${String(d).padStart(2, "0")}`, rec = days && days.includes(d);
    s += `<button class="d${rec ? " rec" : days ? "" : " can"}${ds === pv.date ? " sel" : ""}${ds === t ? " today" : ""}" data-d="${ds}" ${ds > t ? "disabled" : ""}>${d}</button>`;
  }
  return s + `</div><small>${note}</small>`;
}
async function drawCal() {
  const key = calKey(), base = "🟦 नीली तारीख़ = रिकॉर्डिंग है" + (pv.oldest ? ` · NVR में सबसे पुरानी रिकॉर्डिंग: ${pv.oldest}` : "");
  if (calCache[key]) { $("cal").innerHTML = calHtml(calCache[key], base); return; }
  $("cal").innerHTML = calHtml(null, "रिकॉर्डिंग वाली तारीख़ें लोड हो रही हैं…");
  let days = null, note = base;
  try {
    const r = await api(`/api/days?store_id=${pv.c.store_id}&ch=${pv.c.ch}&year=${calY}&month=${calM}&off=${pv.off}`);
    if (r.error) note = "तारीख़ों की सूची नहीं मिली: " + r.error; else { days = r.days; calCache[key] = days; }
  } catch (e) { note = "तारीख़ों की सूची नहीं मिली"; }
  if (pv && !$("cal").hidden && key === calKey()) $("cal").innerHTML = calHtml(days, note);
}
$("pvDate").onclick = () => {
  if (!pv) return; const cal = $("cal");
  if (!cal.hidden) { cal.hidden = true; return; }
  [calY, calM] = pv.date.split("-").map(Number); cal.hidden = false; drawCal();
};
$("cal").onclick = e => {
  const b = e.target.closest("button"); if (!b || b.disabled) return;
  if (b.id === "calP" || b.id === "calN") { calM += b.id === "calP" ? -1 : 1; if (calM < 1) { calM = 12; calY--; } if (calM > 12) { calM = 1; calY++; } drawCal(); }
  else if (b.dataset.d) { $("cal").hidden = true; pvLoad(b.dataset.d, false); }
};
document.addEventListener("click", e => { if (!e.composedPath().includes($("cal")) && e.target.id !== "pvDate") $("cal").hidden = true; });
$("pvB30").onclick = () => pv && pv.playing && pvSeek(curSec() - 30, -1);
$("pvF30").onclick = () => pv && pv.playing && pvSeek(curSec() + 30);
/* ---------- तेज़ स्कैन, छलांग और बाँटकर देखना ---------- */
function skimStop() {}
$("pvRate").onchange = () => {
  if (!pv) return; const was = pv.playing ? Math.floor(curSec()) : null; pv.rate = +$("pvRate").value;
  if (was !== null) pvSeek(was);
};
document.querySelectorAll(".pvCtl [data-j]").forEach(b => b.onclick = () => {
  if (!pv || !pv.playing) return; skimStop(); const j = +b.dataset.j; pvSeek(curSec() + j, Math.sign(j));
});
document.addEventListener("keydown", e => {
  if (!pv || $("pbView").hidden || !pv.playing || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  const j = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (!j) return; e.preventDefault(); skimStop(); pvSeek(curSec() + j * (e.shiftKey ? 300 : 30), j);
});
/* ---------- टाइमलाइन के किनारे पर माउस रुकने पर अपने आप पिछला/अगला दिन ---------- */
const EDGE = 28, DWELL = 700;
let edgeZone = null, edgeTimer = null, edgeLock = false;
function edgeClear() { clearTimeout(edgeTimer); edgeTimer = null; edgeZone = null; $("tl").classList.remove("tl-l", "tl-r"); }
function edgeGo() {
  if (!pv || !edgeZone) return;
  const z = edgeZone, [v0, v1] = pv.view, span = v1 - v0;
  if (z === "L" && v0 > 0) { const n0 = Math.max(0, v0 - span * 0.5); pv.view = [n0, n0 + span]; renderTl(); edgeTimer = setTimeout(edgeGo, 500); return; }   // ज़ूम में हों तो पहले खिसको
  if (z === "R" && v1 < 86400) { const n1 = Math.min(86400, v1 + span * 0.5); pv.view = [n1 - span, n1]; renderTl(); edgeTimer = setTimeout(edgeGo, 500); return; }
  const d = shiftDay(z === "L" ? -1 : 1); edgeLock = true;
  if (z === "R" && d > today()) { $("pvInfo").textContent = "आज से आगे की तारीख़ नहीं है"; return; }
  if (z === "L" && pv.oldest && d < pv.oldest) { $("pvInfo").textContent = "इससे पहले की रिकॉर्डिंग NVR में नहीं है"; return; }
  skimStop(); pvLoad(d, false);
}
function edgeMove(e) {
  const r = $("tl").getBoundingClientRect(), x = e.clientX - r.left, z = x < EDGE ? "L" : x > r.width - EDGE ? "R" : null;
  if (z === null) { edgeLock = false; if (edgeZone) edgeClear(); return; }
  if (!edgeLock) { const hv = $("tlHov"); if (hv) hv.textContent = z === "L" ? "‹ पिछला दिन" : "अगला दिन ›"; }
  if (z === edgeZone || edgeLock) return;
  edgeClear(); edgeZone = z; $("tl").classList.add(z === "L" ? "tl-l" : "tl-r"); edgeTimer = setTimeout(edgeGo, DWELL);
}
$("pvAll").onclick = () => { if (pv) { pv.view = [0, 86400]; renderTl(); } };
$("pvClose").onclick = () => { skimStop(); dropVod(); $("pbView").hidden = true; $("cal").hidden = true; $("pvVideo").innerHTML = ""; pv = null; };
const tlSec = e => { const r = $("tl").getBoundingClientRect(); return pv.view[0] + (e.clientX - r.left) / r.width * (pv.view[1] - pv.view[0]); };
$("tl").onmousemove = e => { if (!pv) return; const hv = $("tlHov"); if (!hv) return; hv.style.display = "block"; hv.style.left = (e.clientX - $("tl").getBoundingClientRect().left) + "px"; hv.textContent = hms(Math.floor(tlSec(e))); edgeMove(e); };
$("tl").onmouseleave = () => { const hv = $("tlHov"); if (hv) hv.style.display = "none"; edgeClear(); edgeLock = false; };
$("tl").onclick = e => { if (pv) { skimStop(); pvSeek(tlSec(e)); } };
$("tl").onwheel = e => {
  if (!pv) return; e.preventDefault();
  const c = tlSec(e), f = e.deltaY < 0 ? 0.7 : 1 / 0.7; let n0 = c - (c - pv.view[0]) * f, n1 = c + (pv.view[1] - c) * f;
  if (n1 - n0 < 600) return;
  if (n1 - n0 >= 86400) { n0 = 0; n1 = 86400; } else { if (n0 < 0) { n1 -= n0; n0 = 0; } if (n1 > 86400) { n0 -= n1 - 86400; n1 = 86400; } }
  pv.view = [n0, n1]; renderTl();
};

/* ---------- Camera report ---------- */
let rp = null, rpTab = "s", rpPoll = null;
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const ago = t => { if (!t) return "—"; const m = Math.max(0, Math.floor((Date.now() - new Date(t)) / 60000)), d = Math.floor(m / 1440), hr = Math.floor(m % 1440 / 60);
  return d ? `${d} दिन ${hr} घंटे` : hr ? `${hr} घंटे ${m % 60} मिनट` : `${m} मिनट`; };
const byOff = (a, b) => (a.offline_since || "9").localeCompare(b.offline_since || "9");
const fmtT = t => t ? new Date(t).toLocaleString("en-IN", {dateStyle: "medium", timeStyle: "short"}) : "—";
const pct = (l, t) => t ? Math.round(l * 100 / t) : 0;
const bdg = (l, t) => { const p = pct(l, t); return `<span class="bd ${p >= 100 ? "g" : p >= 90 ? "a" : "r"}">${p}%</span>`; };
async function loadReport() { rp = await api("/api/report"); drawReport(); }
function drawReport() {
  const qs = $("rpQ").value.toLowerCase(), bad = $("rpBad").checked, st = rp.stores, ck = st.filter(s => s.checked);
  const tot = st.reduce((a, s) => a + s.total, 0), ckTot = ck.reduce((a, s) => a + s.total, 0), live = ck.reduce((a, s) => a + s.live, 0);
  const last = ck.map(s => s.checked).sort().pop();
  const card = (t, v, c, tab) => `<div${tab ? ` data-tab="${tab}" style="cursor:pointer" title="सूची देखने के लिए क्लिक करें"` : ""}><small>${t}</small><strong style="color:${c || "inherit"}">${v}</strong></div>`;
  $("rpCards").innerHTML = card("कुल कैमरे", tot) + card("चालू (live)", live, "#16a34a") + card("बंद (offline)", ckTot - live, "#dc2626", "o")
    + card("जाँच बाकी", tot - ckTot) + card("NVR बंद वाले स्टोर", ck.filter(s => !s.reachable).length, "#dc2626", "n") + card("आख़िरी जाँच", `<span style="font-size:14px">${fmtT(last)}</span>`);
  let html = "";
  if (rpTab === "s") {
    const rows = st.filter(s => `${s.name} ${s.city} ${s.zone}`.toLowerCase().includes(qs) && (!bad || (s.checked && (s.total - s.live > 0 || !s.reachable))))
      .sort((a, b) => (b.checked ? b.total - b.live : -1) - (a.checked ? a.total - a.live : -1) || a.name.localeCompare(b.name));
    html = `<table><tr><th>स्टोर</th><th>शहर</th><th>ज़ोन</th><th>NVR</th><th>कुल</th><th>चालू</th><th>बंद</th><th>चालू %</th><th>आख़िरी जाँच</th></tr>` + rows.map(s => {
      const c = !!s.checked;
      return `<tr data-id="${s.id}"><td>${esc(s.name)}</td><td>${esc(s.city)}</td><td>${esc(s.zone)}</td><td>${c ? (s.reachable ? "🟢 चालू" : "🔴 बंद" + (s.offline_since ? " · " + ago(s.offline_since) : "")) : "—"}</td><td>${s.total}</td><td>${c ? s.live : "—"}</td><td>${c ? s.total - s.live : "—"}</td><td>${c ? bdg(s.live, s.total) : '<span class="bd n">जाँच नहीं</span>'}</td><td>${fmtT(s.checked)}</td></tr>`;
    }).join("") + "</table>";
  } else if (rpTab === "g") {
    const rows = rp.groups.filter(g => g.name.toLowerCase().includes(qs) && (!bad || g.checked - g.live > 0));
    html = `<table><tr><th>ग्रुप</th><th>कुल कैमरे</th><th>चालू</th><th>बंद</th><th>चालू %</th></tr>` + rows.map(g =>
      `<tr><td>${esc(g.name)}</td><td>${g.total}</td><td>${g.live}</td><td>${g.checked - g.live}</td><td>${g.checked ? bdg(g.live, g.checked) : '<span class="bd n">जाँच नहीं</span>'}</td></tr>`).join("") + "</table>";
  } else if (rpTab === "o") {
    const rows = rp.offline.filter(o => o.reachable && `${o.store} ${o.name} ${o.grps || ""} ${o.ip} ${o.cam_ip || ""}`.toLowerCase().includes(qs)).sort(byOff), skipped = rp.offline.filter(o => !o.reachable).length;
    html = `<div class="rpHint">किसी कैमरे की लाइन पर क्लिक करें → वह कैमरा नई विंडो में खुलेगा। "बंद हुआ" = जाँच में पहली बार बंद पाए जाने का समय (जाँच जितनी जल्दी-जल्दी चलेगी, समय उतना सही होगा)।` + (skipped ? ` (NVR बंद वाले स्टोर के ${skipped} कैमरे यहाँ नहीं गिने, उन्हें "बंद NVR" टैब में देखें)` : "") + `</div>`
      + `<table><tr><th>स्टोर</th><th>चैनल</th><th>कैमरा</th><th>कैमरा IP</th><th>ग्रुप</th><th>NVR IP</th><th>बंद हुआ</th><th>कितने समय से</th><th>आख़िरी बार चालू</th></tr>` + rows.map(o =>
      `<tr data-act="cam" data-sid="${o.store_id}" data-ch="${o.ch}"><td>${esc(o.store)}</td><td>${o.ch}</td><td>${esc(o.name)}</td><td>${esc(o.cam_ip) || "—"}</td><td>${esc(o.grps)}</td><td>${esc(o.ip)}</td><td>${fmtT(o.offline_since)}</td><td><b>${ago(o.offline_since)}</b></td><td>${o.last_online ? fmtT(o.last_online) : "पता नहीं"}</td></tr>`).join("") + "</table>";
  } else {
    const rows = st.filter(s => s.checked && !s.reachable && `${s.name} ${s.city} ${s.zone} ${s.ip}`.toLowerCase().includes(qs)).sort(byOff);
    html = `<div class="rpHint">किसी NVR की लाइन पर क्लिक करें → उसका वेब पेज नई विंडो में खुलेगा। (ये NVR पिछली जाँच में नेटवर्क पर नहीं मिले: VPN, बिजली या इंटरनेट देखें।)</div>`
      + `<table><tr><th>स्टोर</th><th>शहर</th><th>ज़ोन</th><th>NVR IP</th><th>कैमरे</th><th>बंद हुआ</th><th>कितने समय से</th><th>आख़िरी बार चालू</th></tr>` + rows.map(s =>
      `<tr data-act="nvr" data-ip="${esc(s.ip)}" data-port="${s.http_port || 80}"><td>${esc(s.name)}</td><td>${esc(s.city)}</td><td>${esc(s.zone)}</td><td>${esc(s.ip)}</td><td>${s.total}</td><td>${fmtT(s.offline_since)}</td><td><b>${ago(s.offline_since)}</b></td><td>${s.last_online ? fmtT(s.last_online) : "पता नहीं"}</td></tr>`).join("") + "</table>";
  }
  $("rpBody").innerHTML = html;
}
function pollReport() {
  clearInterval(rpPoll);
  const tick = async () => {
    const s = await api("/api/report/status");
    $("rpInfo").textContent = s.running ? `जाँच चल रही है: ${s.done} / ${s.total} स्टोर` : ""; $("rpRun").disabled = s.running;
    if (!s.running) { clearInterval(rpPoll); loadReport(); }
  };
  rpPoll = setInterval(tick, 2000); tick();
}
$("repBtn").onclick = async () => { $("repView").hidden = false; await loadReport(); const s = await api("/api/report/status"); if (s.running) pollReport(); };
$("rpRun").onclick = async () => { await api("/api/report/run", "POST"); pollReport(); };
$("rpXls").onclick = () => { location.href = "/api/report.xlsx"; };
$("rpClose").onclick = () => { $("repView").hidden = true; clearInterval(rpPoll); };
$("rpQ").oninput = () => rp && drawReport(); $("rpBad").onchange = () => rp && drawReport();
function setRpTab(t) {
  rpTab = t; document.querySelectorAll(".rpBar [data-t]").forEach(x => x.classList.toggle("on", x.dataset.t === t)); if (rp) drawReport();
}
document.querySelectorAll(".rpBar [data-t]").forEach(b => b.onclick = () => setRpTab(b.dataset.t));
$("rpCards").onclick = e => { const d = e.target.closest("[data-tab]"); if (d) setRpTab(d.dataset.tab); };
$("rpBody").onclick = e => {
  const tr = e.target.closest("tr[data-act], tr[data-id]"); if (!tr) return;
  if (tr.dataset.act === "cam") { window.open(`/?view=${tr.dataset.sid}-${tr.dataset.ch}`, "_blank", "width=1100,height=700"); return; }
  if (tr.dataset.act === "nvr") { const p = tr.dataset.port; window.open(`http://${tr.dataset.ip}${p && p !== "80" ? ":" + p : ""}`, "_blank", "width=1200,height=800"); return; }
  const s = stores.find(x => x.id === +tr.dataset.id); if (!s) return;
  $("repView").hidden = true; setMode("store"); openStore(s);
};
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("repView").hidden) $("rpClose").click(); });

async function addToGroup(c) {
  await loadGroups();
  if (!groups.length) return alert("पहले 'ग्रुप' टैब में नया ग्रुप बनाएँ");
  $("dlgT").textContent = `${cur.name} · ${c.name} को किस ग्रुप में जोड़ें?`;
  $("dlgSel").innerHTML = groups.map(g => `<option value="${g.id}">${g.name}</option>`).join("");
  $("dlg").showModal();
  $("dlgOk").onclick = async () => { await api(`/api/groups/${$("dlgSel").value}/add?store_id=${c.store_id}&ch=${c.ch}`, "POST"); $("dlg").close(); loadGroups(); };
}
$("dlgNo").onclick = () => $("dlg").close();
$("newG").onclick = async () => {
  const name = prompt("ग्रुप का नाम (जैसे: Cash Counter)"); if (!name) return;
  const r = await fetch(`/api/groups?name=${encodeURIComponent(name)}`, {method: "POST"});
  if (!r.ok) alert((await r.json()).detail || "ग्रुप नहीं बना"); loadGroups();
};
$("byName").onclick = async () => {
  const kw = prompt("कैमरे के नाम में कौन सा शब्द है? (जैसे: Cash)\nसारे स्टोर के ऐसे नाम वाले कैमरे इस ग्रुप में जुड़ जाएँगे।"); if (!kw) return;
  const r = await api(`/api/groups/${cur.id}/add-by-name?keyword=${encodeURIComponent(kw)}`, "POST");
  alert(`${r.added} कैमरे जुड़े`); await loadGroups(); cur = groups.find(g => g.id === cur.id); openGroup(cur);
};
function full(c, s) {
  $("bigTitle").textContent = [c.store || (cur && cur.name) || "", c.name].filter(Boolean).join(" · ");
  const big = $("big"); big.querySelector("video-stream")?.remove();
  const [v, go] = mk(s || c.main); big.append(v); big.classList.add("on"); go();
}
$("close").onclick = () => { $("big").classList.remove("on"); $("big").querySelector("video-stream")?.remove(); };
document.addEventListener("keydown", e => { if (e.key === "Escape") { $("pvClose").click(); $("close").click(); } });

const step = d => { const pages = Math.ceil(cams.length / +$("grid").value); page = (page + d + pages) % pages; drawWall(); };
$("prev").onclick = () => step(-1); $("next").onclick = () => step(1);
$("grid").onchange = () => { page = 0; drawWall(); }; $("q").oninput = drawList;

function tick() {
  const n = +$("grid").value;
  if ((page + 1) * n < cams.length) { page++; drawWall(); return; }
  if (mode === "group") { page = 0; drawWall(); return; }
  const live = stores.filter(s => status[s.id] !== false && s.cams > 0);
  if (!live.length) return;
  const i = live.findIndex(s => s.id === cur?.id);
  openStore(live[(i + 1) % live.length]);
}
function startTour() { clearInterval(tourT); tourT = setInterval(tick, +$("sec").value * 1000); $("tour").textContent = "Tour बंद करें"; $("tour").classList.add("on"); }
$("tour").onclick = () => { if (tourT) { clearInterval(tourT); tourT = null; $("tour").textContent = "Tour चालू करें"; $("tour").classList.remove("on"); } else { startTour(); tick(); } };
$("sec").onchange = () => tourT && startTour();

$("imp").onclick = () => $("file").click();
$("file").onchange = async e => { const f = new FormData(); f.append("file", e.target.files[0]); const r = await api("/api/import", "POST", f); alert(`${r.imported} स्टोर जुड़े`); loadStores(); };
$("disc").onclick = async () => { $("disc").disabled = true; $("disc").textContent = "खोज रहे हैं…"; const r = await api("/api/discover-all", "POST"); alert(`${r.stores} स्टोर, ${r.cameras} कैमरे मिले`); $("disc").disabled = false; $("disc").textContent = "कैमरा खोजें"; loadStores(); };

let ME = {name: "", role: "viewer"};
try { ME = await api("/api/me"); } catch (e) {}
document.body.classList.toggle("viewer", ME.role !== "admin"); document.body.classList.toggle("nogrp", ME.role !== "admin" && !ME.can_groups);
$("me").textContent = "👤 " + ME.name + (ME.role === "admin" ? " (admin)" : ME.can_groups ? " (viewer + ग्रुप)" : " (viewer)"); $("usBtn").hidden = ME.role !== "admin";
let usCache = [];
async function loadUsers() {
  const us = usCache = await api("/api/users");
  $("usList").innerHTML = us.length ? us.map(u => `<div style="display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--line)"><span style="flex:1">${esc(u.username)} <small style="color:var(--mut)">${u.role === "admin" ? "admin" : "viewer"}${u.role !== "admin" && u.can_groups ? " · ग्रुप ✔" : ""}</small></span><button data-edit="${esc(u.username)}">बदलें</button><button data-del="${esc(u.username)}">हटाएँ</button></div>`).join("")
    : '<small style="color:var(--mut)">अभी कोई अतिरिक्त यूज़र नहीं है</small>';
}
$("usBtn").onclick = () => { $("usMsg").textContent = ""; loadUsers(); $("usDlg").showModal(); };
$("usNo").onclick = () => $("usDlg").close();
$("usList").onclick = async e => {
  const ed = e.target.dataset.edit;
  if (ed) { const u = usCache.find(x => x.username === ed); if (u) { $("usName").value = u.username; $("usRole").value = u.role; $("usGrp").checked = !!u.can_groups; $("usPw").value = ""; $("usPw").focus(); } return; }
  const n = e.target.dataset.del; if (!n || !confirm(`"${n}" को हटाएँ?`)) return;
  await fetch(`/api/users/${encodeURIComponent(n)}`, {method: "DELETE"}); loadUsers();
};
$("usGo").onclick = async () => {
  const r = await fetch("/api/users", {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({username: $("usName").value, password: $("usPw").value, role: $("usRole").value, can_groups: $("usGrp").checked})});
  if (!r.ok) { $("usMsg").textContent = (await r.json()).detail || "नहीं हो पाया"; return; }
  $("usMsg").textContent = ""; $("usName").value = $("usPw").value = ""; loadUsers();
};
const qv = new URLSearchParams(location.search).get("view");     // रिपोर्ट से "नई विंडो" में सिर्फ़ एक कैमरा खोलना
if (qv) {
  const [vs, vc] = qv.split("-").map(Number);
  document.querySelector(".app").hidden = true; document.querySelector(".top").hidden = true;
  $("close").textContent = "विंडो बंद करें"; $("close").onclick = () => window.close();
  try { const r = await api(`/api/cam/open?store_id=${vs}&ch=${vc}`, "POST"); document.title = `${r[0].store} · ${r[0].name}`; full(r[0]); }
  catch (e) { alert("कैमरा नहीं खुला"); }
}
api("/api/brand").then(b => { document.title = b.name || "CCTV Hub"; $("bn").textContent = b.name || ""; $("bs").textContent = b.subtitle || ""; $("bn").hidden = !b.name; $("bs").hidden = !b.subtitle; $("logo").classList.toggle("solo", !b.name); document.documentElement.style.setProperty("--brand", b.color); if (b.logo) { const l = $("logo"); l.src = "/logo?" + Date.now(); l.hidden = false; } }).catch(() => {});
const clk = () => $("clock").textContent = new Date().toLocaleString("en-IN", {dateStyle: "medium", timeStyle: "medium"}); clk(); setInterval(clk, 1000);
await loadStores(); loadStatus(); setInterval(loadStatus, 60000);
</script></body></html>

````

*End of handoff document.*
