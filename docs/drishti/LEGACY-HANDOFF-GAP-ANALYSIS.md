# Legacy CCTV Hub handoff — gap analysis against CityKart Drishti

Source: `CCTV_Hub_Project_Handoff (1).md` (owner's file, snapshot 21 Oct 2026; copy kept at `docs/reference/cctv-hub-handoff-2026-10-21.md`). It describes the legacy FastAPI + SQL Server app that Drishti replaces (its source is also in `reference/cctv-hub-legacy/`). This document lists, feature by feature, what the legacy app does, what Drishti has TODAY (verified in the code), and what is missing and where it will be built. Statuses use the tracker vocabulary; the tracker rows are LG-1…LG-40 in `docs/drishti/DELIVERY-STATUS.md`. Items marked **Decision** need the owner.

Not copied from the handoff (and why): its stack and delivery method (Python, SQL Server, zip-copy updates), its "reply in Hindi/Hinglish" instruction to another AI, and its "single-file frontend" constraint. The owner's hard preferences ARE honoured: free/open-source only; real fast playback (no "skim" or split-period emulation); Hikvision-like playback UX; offline items findable with "since when" and openable in a new window; view-only access for team members with the owner choosing who edits groups.

## A. Live wall

| ID | Legacy behaviour | Drishti today | Gap / plan |
|---|---|---|---|
| LG-1 | Wall by store or by cross-store group; search box over stores | Wall by location or group (`/live?store|group|camera`); location list (search on Stores page) | Search box and status dots on the Live chooser/sidebar list (P4-L1) |
| LG-2 | Grid sizes 1 / 4 / 9 / 16 / 25 | 1 / 2×2 / 3×3 / 4×4 | Add 5×5 (25) (cap stays ≤ 36 streams per request) (P4-L1) |
| LG-3 | **Tour mode**: cycle pages then locations at a chosen interval, skipping locations whose NVR is down; inside a group it cycles the group's pages | Missing | Implement with pause on hover, interval 5–300 s, skips recorder-down locations, honours permissions, stops hidden/abandoned streams (P4-L1) |
| LG-4 | Click a tile → fullscreen live (main stream); double-click → playback | Click → enlarge dialog (main); playback link per tile | Double-click → playback at the camera's last-hour/day view; keep the link (P4-L1) |
| LG-5 | Hover buttons on a tile: "+ group" / "× remove" | Group editing only on the Groups screens | Add tile hover actions for people with group-editing authority (P4-L1) |
| LG-6 | Single-camera popup window (`/?view=<store>-<ch>`) opened from reports | `/live?camera=<id>` exists | Add "open in new window" everywhere a camera is listed (reports, incidents) and a minimal popup layout (P4-L1/P4-L3) |
| LG-7 | Status dots per NVR, refreshed every 60 s | Badges on Stores list and tiles | Auto-refreshing status in the location list on the Live/Playback choosers (P4-L1) |

## B. Playback

| ID | Legacy behaviour | Drishti today | Gap / plan |
|---|---|---|---|
| LG-8 | **Same-time playback on all visible wall cameras** (5–480 min) | Single-camera playback only | Synchronised multi-camera playback (up to the playback concurrency cap, e.g. 4–9 tiles) with one shared time control (P4-L2) |
| LG-9 | Calendar with recorded days highlighted; "oldest recording" hint | Calendar with recorded-day dots (NVR calendar days); no oldest hint | Add oldest-recording lookup (search back up to retention) and show it (P4-L2) |
| LG-10 | 24 h timeline: blue = recorded, hour ticks, hover time, **click = start there (snaps to nearest recording)** | Timeline with segments, click/drag and HH:MM entry | Add snap-to-nearest-recording and hover time tooltip; show unavailable intervals explicitly (P4-L2) |
| LG-11 | **Mouse-wheel zoom** on the timeline and "full day" reset | Missing | Zoom/pan with wheel, pinch and keyboard (+/−), reset (P4-L2) |
| LG-12 | **Edge-dwell** at the left/right edge pans (if zoomed) or switches to the previous/next day (guarded) | Missing | Implement with the same guards (not beyond today/oldest) (P4-L2) |
| LG-13 | Jump buttons −10/−5/−1/+1/+5/+10 min; ←/→ = ±30 s, Shift = ±5 min | Continue-from-here only | Add the buttons and keyboard shortcuts (P4-L2) |
| LG-14 | Speeds **1x / 2x / 4x / 8x / 16x** | 1x via go2rtc; 2x/4x/8x via fast playback (export right) | Add 16x; reconsider the right needed (see Decision D-L1) (P4-L2) |
| LG-15 | Fast mode: buffer gating, **next-chunk prefetch for gapless switching**, **auto-downshift after 3 stalls in 40 s**, cursor from `video.currentTime`, cancel old downloads | One ≤ 30 min conversion per request; no prefetch; no stall downshift | Chunked fast playback with prefetch and downshift; tests with the fake NVR (P4-L2) |
| LG-16 | NVR time **Local/UTC** toggle per store (stored in browser) | Global `PLAYBACK_OFFSET_MIN`; per-recorder offset planned (D-17) | Per-recorder clock offset **measured automatically** from the NVR (ISAPI system time) with manual override; no browser-side toggle; drift is a monitoring check (P4-L2 + P5 WP-5.2) |
| LG-17 | If the timeline fetch fails, falls back to "whole day recorded" + shows NVR error | Shows a neutral error; unavailable states explicit | Keep neutral wording for non-IT viewers; add the fallback with a visible "recording list unavailable" banner (P4-L2) |
| LG-18 | H.265 main streams can't play in Chrome via fast mode/RTSP→MSE (known issue, no transcode path) | Codec message on failure; hvc1 tag; no transcode | **Transcode option** (ffmpeg libx264) per camera/recorder when the browser can't decode HEVC, bounded by a CPU/concurrency cap; browser/codec matrix (P4-L5, WP-4.4). The handoff notes NVRs may serve H.265 main streams, so this matters. |

## C. Reports, offline views and Excel

| ID | Legacy behaviour | Drishti today | Gap / plan |
|---|---|---|---|
| LG-19 | **Camera Report** overlay: totals, live, offline, not-checked, NVRs down, last check | Home dashboard counts and Monitoring page | Dedicated Reports area with the same cards (P4-L3) |
| LG-20 | Tabs: **Store-wise**, **Group-wise**, **Offline cameras**, **Offline NVRs** | Missing (only Home "recent problems") | Four views with search (location, camera, group, camera IP, NVR IP), "only problems" filter, sorting, paging (P4-L3) |
| LG-21 | Offline cameras list: camera IP, NVR IP, offline since, **for how long**, last seen online; only cameras whose NVR is reachable | Offline-since on location page; no list | Offline list with those columns; cameras whose recorder/location is unreachable are shown as "unknown", not "offline", per the directive (P4-L3 + WP-4.1) |
| LG-22 | Row click: camera opens in a **new window**; offline NVR row opens the **NVR's own web page** in a new window | Missing | Camera → popup window; recorder → its web page link only for people with the IT view of that location (registered target only) (P4-L3) |
| LG-23 | **Check now** (admin) with progress | Check now with progress (monitoring page) | Done; extend to the report view (P4-L3) |
| LG-24 | **Excel export** (Store-wise / Group-wise / Offline cameras sheets) | Missing | Excel export respecting row-level rights, row limit with a visible "truncated" note, CSV-injection-safe, audited (P4-L3 / WP-5) |
| LG-25 | Report accuracy caveat: ~1 offline camera per store looked suspicious (health = ISAPI online OR RTSP DESCRIBE) | Same two-source check | Validate against ground truth in the pilot; add per-camera evidence/"why offline" detail; recording-health and decode checks (WP-5.2) |
| LG-26 | `offline_since` = first detection; suggested improvement: exact outage start from the last recording time | Outage start = first failed check | Add last-recording-time evidence for offline channels (WP-5.2) |

## D. Admin, import, backup

| ID | Legacy behaviour | Drishti today | Gap / plan |
|---|---|---|---|
| LG-27 | CSV import of stores (name, city, zone, ip, port, http_port, user, password, channels) upserting by name, passwords encrypted | CSV import exists (location + primary recorder + channels); real estate NOT imported yet | **Dependency**: the owner's real CSV/export (about 200+ stores, 4,603 cameras) — import after the locations/recorders package; validation with row errors already planned (P2-5c) |
| LG-28 | "Find the camera" for ALL stores in one action (discover-all) | Per-location "Find cameras" | Add bulk discovery with progress, bounded concurrency, per-recorder results and error list (P2-5c) |
| LG-29 | Backup recordings to the server disk (selective), admin only | Missing | Two distinct features (directive): **user clip export** (jobs, quotas, expiring downloads) and **scheduled evidence backup** with the ffmpeg remux fix (the handoff warns the NVR download may be a PS-wrapped stream that Windows players cannot open); jobs persisted, cancel, resume `.part`, real disk-space check (P4-L4, WP-4.3/5) |
| LG-30 | Groups: cross-store membership, add by camera-name keyword | Done (groups + keyword add) | Done; group edit permission is per capability + role instead of one global flag (better than legacy) |
| LG-31 | Users: admin / viewer + `can_groups` flag | Capability model (live/playback/export/IT/admin) with scopes, expiry, preview | Done and superior; legacy users must be re-created and granted explicit access (a migration list can be produced if the owner supplies the user list) |
| LG-32 | Branding: logo + `brand.json` name/colour in the header | Drishti logo and name (P3-0 in progress); fixed brand | Optional: keep a configurable brand block only if the owner wants a second brand; default is fixed CityKart Drishti (**Decision D-L2**) |

## E. Security, operations, deployment

| ID | Legacy item | Drishti today | Status |
|---|---|---|---|
| LG-33 | go2rtc API leaks NVR credentials unless bound to localhost; proxy player scripts | Gateway proxy; go2rtc on 127.0.0.1; credentials only server→go2rtc | Done in design; go2rtc API credentials + listener review in P2-6/WP-4.3 |
| LG-34 | No HTTPS, no login throttling, no audit log, no session expiry | Throttling in-process, audit best-effort, GoTrue sessions; HTTPS/CSP/shared limits planned | P2-6 (shared limits), P3 (CSP, MFA), P5.4 (TLS, durable audit) |
| LG-35 | XSS: names interpolated into innerHTML | React escapes by default | Done by framework; add a test that hostile names render as text |
| LG-36 | Passwords in `run.bat`; secret hygiene | Per-purpose secrets, Vault, generated by script | Done / P2-6 rotation runbook |
| LG-37 | Deployment: manual zip copy, no version in UI, no auto-start (NSSM/Task Scheduler), outdated README, unpinned requirements | Version bar exists; Windows services packaging planned | P5.4: Windows services (hub, worker, gateway, go2rtc) with auto-start and a one-command update script; a visible version string; pinned dependencies (done by lockfile) |
| LG-38 | Fragility: replacing `app.py` without installing a new dependency crashed startup | Single build artifact with lockfile; health checks | P5.4 packaging + startup self-check page |
| LG-39 | Blocking synchronous DB calls inside async endpoints | PostgREST over HTTP, async | Not applicable |
| LG-40 | Chrome auto-translation alters UI text | — | Mark non-translatable tokens (`translate="no"`) for codes, IDs, times; see D-L3 |

## F. Owner decisions needed

- **D-L1 — Fast playback rights (DECIDED: playback right → browser-stream fast playback; export right → downloads).** The legacy app lets every viewer use 2x–16x. We ruled (D-6a) that fast playback returns a saveable MP4 and therefore needs the export right. Option: give normal viewers fast playback through a non-downloadable path (MSE stream through the gateway, same re-validation) and keep saveable downloads for export only. Recommended for usability: playback right → fast playback via the stream path; export right → downloadable clips. Needs your yes/no.
- **D-L2 — Brand block (DECIDED: fixed Drishti brand).** Keep the fixed Drishti brand (default) or support a configurable name/colour as in `brand.json`.
- **D-L3 — Hindi/Hinglish UI (DECIDED: no Hindi, English only).** The legacy UI used Hindi strings (the owner works in Hindi/Hinglish). Drishti is English with plain wording per the directive. A Hindi (or bilingual) interface is a separate internationalisation package; say if you want it and which screens come first.
- **D-L4 — Real data.** Provide the CSV export (or permission to read the legacy SQL Server `stores`/`cameras`/`cam_groups`/`app_users` tables in a copy) to import the real estate and users. Without it Drishti only holds demo data.

## G. What Drishti already does that the legacy app does not
Capability-scoped access (live/playback/export separately, expiry, effective-access preview), explicit ≤ 60 s revocation design, location/NVR model, observation states (confirmed failure vs unreachable vs unknown vs stale), parent dependencies, worker leases, signed asymmetric command design, endpoint inventory, Wi-Fi management plan, durable audit plan, MFA, strict CSP, load-tested design — see the delivery tracker.

## H. Work packages created from this analysis (inserted in Phase 4, after the foundation)
- **P4-L1 Live wall parity**: LG-1…LG-7.
- **P4-L2 Playback parity**: LG-8…LG-18 (timeline zoom/pan/edge-dwell/jumps/snap, 16x, chunked prefetch + downshift, multi-camera synchronised playback, auto clock offset, H.265 transcode option).
- **P4-L3 Reports and offline views**: LG-19…LG-26 (+ Excel).
- **P4-L4 Clip export and evidence backup**: LG-29.
- **P2-5c** (already planned; also regions/clusters tree editor) covers LG-27/LG-28 (import and discover-all).
Everything stays subject to the new permission model (live/playback/export are separate), recorder-based paths, and the "Location" wording.
