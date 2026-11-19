# CityKart Drishti — accepted design decisions

Status: accepted 2026-10-22 by the lead engineer under the owner's standing authorisation ("proceed through the whole local delivery without waiting for continuation prompts"). Sources: docs/drishti/REQUIREMENTS-DIRECTIVE.md, docs/drishti/REQUIREMENTS-SUPPLEMENT-WIFI.md, docs/audit/INITIAL-AUDIT.md, docs/audit/REWORK-PLAN-PROPOSAL.md (sections 9.3 D-1…D-18 hold the full text of each decision; this file records acceptance, rulings on the four open owner decisions, and changes). The owner may overrule any of these; each is isolated so it can be changed.

## Owner decisions — rulings
| ID | Question | Ruling | Consequence if the owner disagrees |
|---|---|---|---|
| D-2a | Home-store access and manager-wide access | (a) Migrate to **explicit grants flagged "migrated:review"**, listed in `access_migration_report`; nobody loses access silently and every such grant is visible and revocable. New accounts get neither implicit rule. | Switch to (b): mark the migrated grants revoked; the report already lists who is affected |
| D-6a | Fast playback (2×/4×/8×) returns a savable MP4 | (a) Requires **`cctv.export`**. 1× playback (go2rtc/MSE) requires `cctv.playback`. Interim until the capability model lands: admin/platform_owner only | Change one capability constant |
| D-10a | MFA for CCTV-only viewers | **Optional** for viewers; **required** for `admin`, `platform_owner` and every capability flagged `requires_mfa` (IT actions, export, admin.*) | Flip the flag per capability in the catalogue |
| D-14a | Per-service database roles | **Accept** per-service roles via PostgREST role-switching JWTs, after a short spike (risk R5). Fallback if the pinned Supabase CLI cannot do it: keep one service key and put all credential reads behind a broker process with its own narrow RPC surface | Fallback is already designed |
| R14 | Design reference | Asset Management code, design docs and stored screenshots (local copy) are the reference. Live rendered pages were not available; visual parity is not claimed until a live signed-in session can be compared (the one missing item) | — |

## Accepted as recommended (no change)
D-1 capability × scope access model (grants only add access; union rule; `operator` rename in the same migration; `manager` not global); D-2 explicit migration of current access with before/after equality tests; D-3 media/remote session registry with 15 s validation and fail-closed after 45 s (target ≤ 60 s, tested); D-4 `locations` / `assets` / `recorders` / `camera_channel_mappings` / `address_spaces` + `asset_endpoints` by in-place renames that keep ids; D-5 `asset_dependencies` + location uplink with `unknown_parent` observations; D-6 exports as jobs in a media service with quotas, expiry and audited, person-bound links, separate from scheduled evidence backup; D-7 observation states + facets (reachability / stream / recording) + availability with unknown and coverage reported separately; D-8 atomic worker leases with fencing tokens; D-9 ECDSA P-256 command signing by a separate signer with public-key verification at endpoints and per-device key pairs (replaces HMAC-with-token-hash); D-10 TOTP MFA + fresh-auth window; D-11 shared database rate limiter; D-12 nonce CSP with vendored player scripts; D-13 go2rtc hardening (only registered recorder endpoints, no exec/ffmpeg sources, WebRTC listener removed, API credentials); D-15 append-only hash-chained audit with external checkpoints; D-16 `agent` → `operator`; D-17 per-recorder clock offsets and true-UTC refactor; D-18 design system from the reference.

## Additions for the Wi-Fi module (supplement)
- **W-1** APs, routers and switches are `assets` (D-4) with `role`, `vendor`, `model`, `firmware`, `management_mode`; per-location `network_definitions` (management CIDR, gateway/DNS, management VLAN, VLAN mappings, approved discovery ranges). No IP is copied between locations; IP stays an attribute (address spaces).
- **W-2** A `device_capabilities` matrix (per vendor/model/firmware/management mode, per operation: supported / unsupported / unverified, with documentation reference and verification state). Rollout planning refuses unsupported or unverified operations unless the model adapter is marked `lab_validated`.
- **W-3** Wi-Fi configuration reuses the fleet-job machinery of phase 7 (immutable payload hash, approvals bound to it, leases, acknowledgement reconciliation, canaries, bounded batches, failure thresholds, verification) with a Wi-Fi-specific adapter interface. Adapters: `fake` (orchestration tests), `snmpv3-readonly` (telemetry), and vendor adapters only where official documentation supports them (isolated, `experimental` until lab-validated). No browser automation as a fleet dependency.
- **W-4** Profiles are versioned (baseline → location override → device override), resolved per device with a redacted preview; passphrases and admin credentials live in Vault and never appear in diffs/exports/logs; unique settings (management IP, radio channel/power plans) are separate from shared policy.
- **W-5** Permissions: `wifi.inventory.view`, `wifi.config.view_redacted`, `wifi.profile.edit`, `wifi.deploy.approve`, `wifi.deploy.execute`, `wifi.device.reboot_upgrade`, `wifi.config.restore`, `wifi.credentials.admin`, all location-scoped (D-1 scopes) and enforced server-side.
- **W-6** Wi-Fi phase placement: schema + inventory/capability work in phase 2 (with the location/asset model); monitoring in phase 5; configuration profiles/rollouts after the fleet-job machinery (phase 7). All real-device behaviour is `unverified` until the owner authorises hardware; a first-hardware-pilot checklist is a deliverable.

## Delivery rules
- One branch per phase, stacked locally, never pushed or merged into main.
- One builder at a time for anything that touches migrations or shared screens; parallelism only for read-only analysis, docs, the PowerShell agent, and load tooling.
- Old and new permission models must never coexist in different routes: the capability model replaces every route check in WP-2.1.
- Tracker: docs/drishti/DELIVERY-STATUS.md (one row per requirement, honest statuses). Architecture: docs/ARCHITECTURE-AND-DESIGN-FOR-REVIEW.md is superseded by docs/drishti/ARCHITECTURE.md as each phase lands.

## Ruling P-1 (2026-10-22, owner statement): platform owner = full rights
The owner stated that the platform owner is the administrator who holds full rights over everything in the application. Ruling: every ACTIVE `platform_owner` holds EVERY catalogue capability at organisation scope as explicit grants (source `manual`, reason "Platform owner: all capabilities"), so the access model stays explicit, auditable and revocable. Applied now to all existing platform owners in the local database (28 capabilities). Still required later, not yet built: (a) a migration/trigger so every capability added to the catalogue in future is granted to active platform owners automatically; (b) creating or promoting a platform owner through the admin UI grants the full set as one preset; (c) platform owners remain subject to MFA (D-10: required for admin, platform_owner and requires_mfa capabilities), fresh authentication for sensitive actions and a recorded reason for high-risk actions — "full rights" does not mean exempt from audit or MFA; (d) other roles (admin, manager, operator, user) keep scoped, explicit grants only. Tracker rows AC-1/AC-8 note the platform-owner exception.
Clarification (owner, same day): treat the platform owner as the **super administrator**. UI wording: the role is shown as "Super administrator" (stored value stays `platform_owner`); it can open every screen, manage every user and grant, and holds every current and future capability (Ruling P-1 mechanism). Safety rails that still apply to it: MFA, fresh authentication for sensitive actions, audit of every action, and a recorded reason for high-risk actions; it cannot be deleted/demoted by anyone except another super administrator, and the system must always keep at least one active super administrator (enforced in the admin actions).

## Ruling T-1 (2026-10-22, owner): "Location", not "Store"
Cameras and devices belong to locations (a location can be a store, head office, DC, warehouse or office). All user-visible wording changes from "store(s)" to "location(s)": navigation ("Stores" → "Locations", "Manage stores" → "Manage locations"), page titles, table columns, forms, help text, toasts, errors, reports, emails and docs for users. Route `/stores` becomes `/locations` (old URLs redirect permanently); `/admin/stores` becomes `/admin/locations`. Code identifiers and database tables are renamed in P2-5a (schema) — the terminology pass (T-1 package) renames user-visible text and routes first. The location KIND (Store, Head office, DC, Warehouse, Office, Other) is shown as an attribute where useful. Demo data names ("Demo Store Patna") are renamed to "Demo location …" in the seed. Existing tests that assert on visible text are updated, not weakened.

## Rulings from the legacy-handoff review (owner, 2026-10-22)
- **D-L1 (fast playback rights) — accepted as recommended:** 2x/4x/8x/16x fast playback is available to anyone holding `cctv.playback` for that camera, delivered ONLY as a non-downloadable browser stream through the gateway/MSE path (same session registry, ≤ 60 s revocation, concurrency caps, audit). Saveable files (clip exports / downloads) require `cctv.export`. This supersedes D-6a's "fast playback needs cctv.export" and the P2-2 rule "/api/vod requires cctv.export AND cctv.playback"; the P4-L2 package must move fast playback off the plain `/api/vod` MP4 URL (which returns a savable file) to the stream path, keeping `/api/vod` (or its replacement) for export only.
- **D-L2 (brand) — fixed:** design and logo stay as implemented now (the Drishti logo, "CityKart Drishti" name, fixed theme); no configurable brand block.
- **D-L3 (language) — English only:** no Hindi/bilingual interface; UI stays plain English. Non-translatable tokens (`translate="no"`) for codes/IDs/times remain in P3.5.
- **D-L4 (real data):** still open — needs the owner's CSV/database export to import the real estate.

## Proposal C-1 (2026-10-22, owner request; PROPOSED — awaiting owner confirmation of the three questions at the end)
Owner need: groups by NVR, and **clusters** (e.g. 5 locations in one cluster) so a person who handles a cluster is given rights once, sees those 5 locations only, and opens any location to see all its cameras.
Design:
1. **Hierarchy**: Organisation → Cluster → Location → Recorder (NVR) → Camera. A *cluster* is a named, managed set of locations (optional parent cluster for Region → Cluster → … nesting, depth ≤ 3). Table `clusters(id, org_id, name, code, parent_cluster_id null, archived_at)` and `cluster_locations(cluster_id, location_id, added_at, added_by)` (many-to-many so a location can be in "Cluster 3" and also "Bihar"; the admin UI warns when a location is in several clusters). Existing free-text `zone`/`state` stay as attributes and can be used to bulk-fill a cluster.
2. **Access scopes** (extends D-1): new grant scope kinds `cluster` (all locations currently in the cluster AND any added later — dynamic, like location scope includes later cameras) and `recorder` (all cameras currently mapped to that NVR, plus later mappings). Union rule unchanged. Examples: "cluster manager" = cctv.live + cctv.playback (+ it.monitoring.view) at cluster scope; a person holding only cluster A cannot see cluster B; opening a location in the cluster shows all its cameras (and, only with an IT capability, its recorders/devices). Cluster membership changes take effect immediately: removing a location from a cluster revokes that person's open sessions for it via the ≤ 60 s revalidation (P2-4); adding one extends their access and writes an audit event listing affected people.
3. **Effective-access preview** shows cluster expansion ("Cluster East: 5 locations, 132 cameras; 0 added/removed") and warns when a membership change would add or remove access for N people.
4. **Camera groups** (viewing convenience; never expand access): groups may be STATIC (chosen cameras) or DYNAMIC rules — all cameras of recorder X, of location L, of cluster C (or name pattern); dynamic groups resolve at read time and are always intersected with what the viewer may see; a person sees a group's name only if at least one resolved member is visible to them.
5. **UI**: Admin → Clusters (create, add/remove locations by search/zone/city/state/kind, see who has access, archive); access editor gets assignment modes "A cluster" and "NVR(s)"; Live/Playback choosers navigate Cluster → Location → camera wall; cluster wall (paged, ≤ 36 streams per request); dashboards and reports filter and group by cluster; incidents can correlate by cluster (regional outage = one incident, per the parent-dependency model).
6. **Placement**: schema (`clusters`, `cluster_locations`, grant scope kinds `cluster` and `recorder`, effective-access functions, migration of old zone grants to cluster-or-location grants as chosen) in P2-5a with the recorder model; admin clusters screens and editor modes in P2-5c; Live/Playback cluster navigation in P4-L1; dynamic groups in P4-L1/P4-L2; cluster dashboards in P4-L3/P5.
Questions: (a) may a location belong to more than one cluster (recommended yes), (b) should cluster access be dynamic so new locations added to the cluster are included automatically (recommended yes, with the audit/preview safeguards), (c) do you also want a parent level (Region → Cluster) (recommended: allow, depth ≤ 3).

## Ruling C-1 (CONFIRMED by owner, 2026-10-22) — fixed hierarchy: Organization → Region → Cluster → Location → NVR → Camera
Owner statement: "We have organization, then region, then cluster, then location, then NVR, then camera. Some locations have 2–3 NVRs, that's why location, then NVR, then cameras." This replaces the optional-nesting / many-to-many wording of Proposal C-1 above with a strict tree:
- `regions(id, org_id, name, code, archived_at)`; `clusters(id, org_id, region_id, name, code, archived_at)` (each cluster belongs to exactly ONE region; region may be set later — an 'Unassigned' bucket is shown for migration only); `locations.cluster_id` (each location belongs to exactly ONE cluster; nullable only during migration/import, flagged in the UI); recorders (NVRs) belong to exactly one location (a location holds 1–3+ NVRs); cameras belong to exactly one active recorder mapping (D-4). IT assets/APs belong to a location (and optionally a recorder for NVR-adjacent equipment). The existing free-text `zone`/`state` stay as attributes; a tool proposes cluster/region assignment from them.
- Grant scope kinds become: organization, region, cluster, location, recorder, camera, asset. Region scope = all clusters/locations/cameras under it (dynamic: items added later are included); cluster scope = all locations in the cluster; location scope = all its recorders and cameras; recorder scope = that NVR's cameras. Union rule unchanged; a CCTV scope never reveals IT assets.
- Camera groups remain a separate viewing convenience (static camera lists or dynamic rules: region/cluster/location/recorder/name pattern), always intersected with what the viewer may see.
- Moving a location to another cluster (or a cluster to another region) takes effect immediately for everyone: holders of the old scope lose it (open sessions closed within 60 s by the P2-4 revalidation), holders of the new scope gain it; the change is audited with the list of affected people and shown in the preview before saving.
- Answers recorded: (a) a location belongs to ONE cluster (strict tree), (b) cluster/region access is dynamic, (c) Region level is required.
- UI: Admin → Regions & clusters (tree editor with drag/search, counts of locations/NVRs/cameras per node, who has access), Locations admin shows cluster/region, access editor modes "A region", "A cluster", "Locations", "NVR(s)", "Cameras"; Live/Playback/Reports navigate Region → Cluster → Location → camera (recorder shown to IT users; for viewers a location simply shows all its cameras); dashboards and incidents roll up by region/cluster (a cluster/region-wide outage correlates as one incident).
- Placement: schema + effective-access functions in P2-5a; admin screens/editor modes in P2-5c; navigation in P4-L1; roll-ups in P4-L3/P5.

Status note (2026-10-22): the P-1 items (a) catalogue trigger and (b) creation preset are BUILT in migrations 20261021000015/16 (P2-3); (c) MFA/fresh-auth still pending (P3).

## Rulings E-1 / E-2 (owner, 2026-10-22): video export
- **E-1 — Export only for IT/admin people.** Ordinary users do NOT get download rights. The `cctv.export` capability may be held only by people whose role is `admin` or `platform_owner` (the IT team administrators). Enforced in SQL by the grant rules (like `admin.*`): granting `cctv.export` to a viewer, operator or manager is refused with a plain message; the access editor does not offer it for those roles; the migration already gives export to administrators only. Presets for viewers/operators never include export. Fast playback (2x–16x) stays a stream-only playback right (D-L1) and never downloads a file.
- **E-2 — No extra cost.** No watermarking and no mandatory re-encoding: exports are a lossless remux of the NVR recording (`ffmpeg -c copy` into MP4), no transcode. A transcode (for example H.265 → H.264 for browsers that cannot play H.265) exists only as an OPTIONAL setting per recorder/camera, OFF by default, with a CPU/concurrency cap, and is never applied to exports. Export copies on the server are deleted after the first successful download or after 24 hours (whichever comes first; the retention hours are a super-administrator setting); quotas stay per person and per organisation; every request, creation, download and deletion is audited. Scheduled evidence backup remains a separate admin-only feature with its own retention.

## Ruling R-1 (2026-10-22, owner): real estate list for LOCAL testing
Owner supplied `\10.0.0.45\Store Soft\stores_sample.csv` (216 locations; columns name, city, zone, ip, port, http_port, user, password, channels; 216 distinct NVR IPs, all port 554/80, user `admin` on every row with only 15 distinct passwords; channel counts 12–28 ⇒ about 4,630 cameras; zone values are inconsistent state codes/names (UP, BR, Assam/ASSAM, JH/Jharkhand, CH, MP, RJ, HR, WB, DELHI, J&K, Odisha, Tripura, Nagaland, Arunachal Pradesh)). Rules:
1. The file is read from its location at import time. It is NEVER copied into the repository, committed, printed, logged or quoted (it contains NVR administrator passwords); automated tests never use it (tests use synthetic data only and the egress guard blocks non-loopback addresses).
2. Import goes into the LOCAL development database only, through the Drishti import path (validation, preview, row errors). NVR passwords go to the local Vault only. Imported recorders are created with `monitoring_enabled = false`: NO connection to any real NVR is made by the worker, discovery, streams or playback until the owner explicitly enables specific NVRs (per location) — at that point only read operations are used (status, channel list, live view, playback search).
3. These are NVR **administrator** accounts. Recommendation (also in the legacy handoff): create read-only NVR users (viewer role) and re-import before production. Drishti uses read operations only, but an administrator login technically allows more; the production import should use read-only accounts.
4. Hierarchy for the real estate: regions/clusters are NOT in the file. The importer proposes a Region per normalised zone/state (mapping table with the ambiguous codes listed for owner confirmation, e.g. `CH`, `JH`, `MP`, `RJ`, `HR`, `WB`) and puts every location in an 'Unassigned' cluster of its region; the owner defines real clusters (or supplies a cluster column) afterwards. Location code = `name` column (e.g. JCL), city from `city`, kind store.
5. Overlapping address ranges: all 216 IPs are unique today (192.168.x.100 style, one 10.0.x.x), so the single global address space keeps working; the address-space model stays for the future.

## Amendment to R-1 (owner, 2026-10-22): authorisation and optional hierarchy
- **Authorisation:** "You can use all. In local no issues." — the owner authorises using ALL 216 NVRs of the supplied list for LOCAL testing: after import the recorders are enabled (`monitoring_enabled = true`), so the local worker, discovery, live view and playback may contact the real NVRs (read operations only: TCP/RTSP/ISAPI status, channel list, live streams, recording search/playback; no configuration writes, no downloads of the whole estate). Probing is polite: the existing concurrency caps, the 60 s/300 s intervals and the NVR login back-off (R9) apply; a wrong-password NVR is backed off, never hammered. The file itself still must not be copied into the repo or printed; automated tests still use synthetic data only.
- **Optional hierarchy:** regions and clusters (and zone/state) are NOT mandatory for a location. A location may have no cluster and no region; the model, import, UI and access scopes work with "no cluster / no region" permanently (not just as a migration state). `cluster_id` / `region_id` stay nullable forever; screens show "No cluster" quietly (no warnings, no 'Unassigned' bucket created automatically); grouping can be done later by the administrators. Rights can still be granted at organization / location / recorder / camera scope without any region or cluster.
- **Location names:** the import creates each location with code = the CSV `name` column (e.g. JCL) and an initial display name "CODE - City" (e.g. "JCL - Jhansi"); both are editable later (rename keeps the id, grants and history). `zone` from the CSV is kept as a plain optional attribute text, not turned into regions automatically.

## Ruling PORTS-1 (owner, 2026-10-22): port plan on the shared machines
Owner's apps use: CKDesk 3210, CKAM (Asset Management) 3211, **Drishti (this app) 3212**, Spinwheel 3213. The Drishti video gateway therefore moved from 3213 to **3412** (default `GATEWAY_PORT=3412`; `NEXT_PUBLIC_STREAM_GATEWAY_URL` must be an address browsers can reach, e.g. `http://<hub-host>:3412`; in production the app and gateway sit behind one TLS address, so no browser-visible port conflicts remain). go2rtc stays loopback-only (1984, 8555, demo 8554). Historical plan/spec/audit documents still mention 3213; the current architecture and README use 3412.

## Decision point LG-4 (P4-L1 review round 1, 2026-10-23): double-click on a live tile — OWNER TO CONFIRM
The legacy CCTV Hub opened playback on a double-click. Drishti, following the P4-L1 brief ("Double-click enlarge"), opens the large
picture with the camera's main stream on a double-click; Playback is one click on the tile's own button and in the large view. Reasons:
playback is a separate right (`cctv.playback`), so a double-click → playback gesture would do nothing for the many live-only viewers;
the playback screen is being reworked in P4-L2. This is a deliberate departure from the legacy gesture, recorded on tracker row LG-4.
If the owner wants the legacy behaviour back it is a one-line change in `components/live/LiveTile.tsx` (`onDoubleClick`).

## Behaviour change P4-L1 (fix round 2, 2026-10-23; re-review N-4): an unattended video wall ends at the idle limit — OWNER TO CONFIRM
Since P4-L1 review round 1 only REAL input (a key, a pointer press or move, a touch, a wheel) keeps a sign-in alive; the wall's token
renewals and the pages' 60 s refresh no longer count as activity (`proxy.ts`, `lib/auth/input-activity.ts`), and the Live screens ask
"Are you still there?" after the same idle limit and stop their video until "Continue watching". This applies the P3-1 rule
(`lib/auth/session-policy.ts`: idle limit 60 minutes for administrators, 8 hours for everyone else) to video walls as well. **Change for
display screens:** before, a wall left running on a monitor kept an operator's sign-in alive until the 12-hour absolute limit; now an
operator's wall that nobody touches stops and is signed out after 8 hours without input (an administrator's after 60 minutes). The
reviewer had suggested applying the presence limit to administrators only; the builder applied it to everyone because P3-1 states one
idle rule for every signed-in person and a forgotten wall otherwise keeps a person's video rights open for 12 hours. The input time is
written in the server's clock (fix round 2, N-2), so a wrong PC clock does not change the limit. If the owner wants control-room screens
to run longer, the options are a per-person "display screen" exception with its own longer limit, or a longer idle limit for operators
(`SESSION_IDLE_MINUTES`, default 480, in `lib/auth/session-policy.ts`; administrators: `SESSION_IDLE_MINUTES_ADMIN`); both would be recorded here first.

## Rulings NB-1..NB-6 (final fix X, 2026-11-11): protecting real NVRs from failed-login storms, and a safe monitoring rollout
Source: release 1 final review C (Important I-1, I-2, I-3, I-4; Minor M-1, M-2, M-6, M-19, M-25, M-29, M-30 and the estate-scale
estimate). Builds on the owner's ruling R9 ("NVR login back-off so a wrong password cannot lock the account") and replaces how it was
built (two in-memory tables, one per process, a fixed 15-minute window). Where these rulings differ from older rulings, these win.

- **NB-1 One shared login back-off, in the database.** Every path that logs in to an NVR asks `nvr_login_gate` first and reports what
  the login did (`nvr_login_report`): the worker's checks, "Find cameras" (one NVR, a location, all), the connection test, live video,
  1x playback, fast playback, the calendar / day search / oldest recording and the downloads, and the video gateway. The state is one
  row per NVR for its CURRENT saved login (a hash of the vault secret, address, ports and user name; never the password), so it survives
  restarts and lease changes and is the same for the web server, the worker and the gateway. Rules (`lib/nvr/login-policy.ts`, the same
  in SQL): a refused login (401 on the Digest login, an RTSP 401 with nothing proving the login, go2rtc's "wrong user/pass") keeps every
  path away for 15 minutes, doubling to at most 6 hours (`NVR_LOGIN_BACKOFF_SEC`, `NVR_LOGIN_BACKOFF_MAX_SEC`); when a window ends, or
  a login was never proven, exactly ONE caller may try (a one-minute claim) and everyone else waits for its answer, so there is at most
  one refused login per window across all paths; the level is reset only by a new saved login (password, user name or address; re-saving
  the same password does not), a success, or an administrator's "Try again"; three refused logins within 30 minutes, whatever the login,
  pause the NVR for every login until the oldest is 30 minutes old (Hikvision locks at 5-7); an NVR without a saved password is never
  contacted; when the state cannot be read nothing is sent (fail closed). **"Forbidden" is not a refused login**: a 403 after the Digest
  login means the user name and password were accepted (a viewer account may not read the channel status); the worker then checks the
  cameras by RTSP, the first ones one at a time until one answer proves the video login. No RTSP login ever follows a refused ISAPI login.
- **NB-2 Live and playback never hammer.** Before a go2rtc source is registered (live wall, 1x playback) a login that is not proven
  within the last 10 minutes is proven with ONE RTSP DESCRIBE by the web server; an NVR whose login stands refused gets no password read,
  no source and no token: its tiles say "Login refused: ask an administrator to check the NVR password" to people with the IT view of
  that NVR and "Camera not available." to everybody else, and the wall asks again every 30 s at no cost to the NVR. The gateway asks
  `media_session_login_check` (by session id only) before it dials go2rtc, passes go2rtc's "wrong user/pass" on
  (`media_session_login_refused`), tells the tile with one fixed value (the tile then stops reconnecting until it has a new token), and
  ends a picture that sent no video for 30 s so go2rtc's own retry loop stops when the last viewer leaves. A wall of 16 tiles with a wrong
  password costs one refused login. Residual (stated honestly): if the password is changed on the NVR itself while a login was proven
  within the last 10 minutes, tiles that reconnect in the same few seconds can each fail once before the first refusal is recorded.
- **NB-3 "Try again".** Monitoring lists the NVRs whose login stands refused (from the shared state, linked to each NVR). "Try again"
  (administrators with admin.inventory for the organisation, fresh sign-in, audited `nvr_login_try_again`) ends the window and its level;
  the 3-in-30-minutes pause still holds. Fixing the password on the NVR page needs no "Try again": a new saved login is tried at once.
- **NB-4 Safe rollout.** (a) Staggered start: per camera round the worker contacts at most `MONITOR_NEW_RECORDERS_PER_ROUND` (default 10)
  NVRs whose login was never proven, doubling with the ones that succeed (10, 20, 40, 80 ...; 218 NVRs are all reached in the 5th round);
  NVRs proven before are checked every round. (b) Monitoring → Monitoring rollout switches the existing per-NVR switch
  (`recorders.monitoring_enabled`) for a whole location, cluster, region or the organisation, with a reason, each NVR audited
  (`recorder_set_monitoring_bulk`), fresh sign-in required. (c) In production (`DRISHTI_ENV=production`) a newly imported NVR whose row
  leaves "monitoring" empty starts switched off. (d) Pilot procedure: everything off before the first start, one location, then its
  cluster, then the rest by region (docs/drishti/runbooks/monitoring-rollout.md). A deliberately stopped worker is the P5.4 builder's
  health classification.
- **NB-5 Politeness defaults for 216 NVRs** (review C's estimate adopted): devices and NVR reachability every 60 s (50 at a time, 3 s
  TCP), cameras every 300 s with 10 NVRs at a time, one lane per NVR, at most 4 RTSP checks per NVR (8 s NVR and 5 s RTSP timeouts), an
  NVR called down after 3 failed reachability checks in a row (`RECORDER_FAIL_THRESHOLD`, M-6; cameras after 2), passwords read from the
  vault once per saved login and hour (M-2), run start and finish on the database clock (M-1). Shown at 218 fake NVRs: at most 10 logins
  at once, one per NVR, per round per NVR one status read, one channel list and one RTSP check per camera the NVR reports offline.
- **NB-6 Deferred, with reasons.** M-4 (Offline / Recorder not reachable never become "Not checked lately") contradicts the standing rule
  "offline stays offline however old" (lib/queries/status.ts) and changes every screen: owner decision. M-7 (estate-wide "Check now" for a
  location-scoped holder): with NB-1 an extra run can no longer cost refused logins; the per-person scope needs the shared check-now test
  rework of the other builder. M-3 / M-8: documentation only (admin guide, incidents runbook) for their owners. M-5 was fixed by P5.4.

## Rulings of the final fix round, builder Y (2026-11-11; release 1 final reviews A, B and C) — the owner may overrule any of these
- **FY-1 Two-step sign-in is enforced by checks, not by a remembered step** (A I-1, B I-1). In production (`DRISHTI_ENV=production`) the
  web app refuses to start, and the Health page's "Two-step sign-in" check fails, while any active organisation has it off without an
  audited opt-out. The opt-out is `security_set_mfa(org, actor, false, reason)`: a super administrator on the Health page (fresh sign-in)
  or the database owner / service key with no person, with a reason of 10 to 500 characters; every change, also one made by hand in psql,
  is written to the audit log with the actor and the reason, and an opt-out shows as a warning on the Health page and at start-up. On a
  database marked as a production one (`test_fixture_switch.production`, set by update.ps1) an organisation without settings and a new
  settings row are enforced by default; the local stack stays off by default. `ops_health_status()` reports the counts (`mfa`).
  Chosen over the reviewer's environment-variable opt-out (`DRISHTI_MFA_OFF_OK`) because the reason and who gave it must be in the
  audit log. First production start: create the first super administrator after the database is marked, or switch it on with the SQL
  line the refusal prints (runbook-tls section 5).
- **FY-2 Ceiling on code guessing** (B I-2). Consecutive failed codes per person in `mfa_code_failures`; a try is counted before the code
  is checked (row lock: tries at the same moment never pass the limit) and given back only when the auth server could not judge it; a
  right code resets the count. 10 wrong codes in a row lock the code step for 15 minutes, each further 10 double it (at most 24 hours);
  100 lock it until a super administrator unlocks it on the People page (with a reason; or by resetting the person's two-step sign-in).
  Locks and unlocks are audited (auth_events `mfa_locked`, `mfa_locked_for_good`, `mfa_lock_cleared`; admin_audit_log
  `mfa_code_lock_cleared`). The functions are for the web app only and keyed by the signed-in person's own id; an unknown id gets the
  plain "go ahead" answer and nothing is stored, so nothing tells anyone who has a factor. Sessions are not ended at the lock (the locked
  person cannot reach aal2 anyway); the People page shows the count and the lock.
- **FY-3 Password resets by a plain administrator** (A M-1). Allowed only when every live grant of the person is held by the
  administrator at an equal or wider scope and for as long (the rule of giving a grant); otherwise only a super administrator may reset
  (checked in SQL, `access_check_password_reset`). The one-time password still goes to the acting administrator (no e-mail delivery in
  Release 1).
- **FY-4 Rights checked in SQL** (A M-2, M-3, M-6, M-7). Every inventory function checks "super administrator, or administrator with
  admin.inventory for the whole organisation" (the import's rule) and needs a named actor from the web app; admin.* and cctv.export are
  refused for non-administrators on every path and taken away by any role change (trigger); the row security on admin.* also needs an
  administrative role; recorder_store_credential and revoke_user_sessions take the organisation (the old forms are the service key's);
  a person is created through create_person (the web app has no INSERT on profiles). Tests that gave admin.* or export to viewers were
  rewritten to administrators or to expect the refusal.
- **FY-5 One access or people change per organisation at a time** (A M-4): a transaction advisory lock taken before the actor's own rights
  are read. Two super administrators revoking each other: the first wins, the second is refused because it no longer holds admin.access.
  No separate "last holder of admin.access" rule: the last active super administrator rule and P-1 keep one person able to manage access.
- **FY-6 Group rules** (A M-5): removing a place rule needs live view of the whole place, as adding it does; name rules as before.
- **FY-7 Request bodies** (B minor 2). Next.js 16 has one global Server Action limit and one proxy buffer limit, not one per action: both
  6 MB (was 30 MB). The proxy refuses larger bodies per page from Content-Length before any session is looked up: 64 KB on public pages,
  1 MB on signed-in pages, 6 MB only on the import page; a Server Action without a length outside the import page is refused (411).
- **FY-8 Production settings** (B minor 3): refused in production: an empty or non-https NEXT_PUBLIC_APP_URL, CSP_REPORT_ONLY, a video
  address that is neither a path of the app nor wss/https, and a gateway GATEWAY_HOST other than 127.0.0.1 / ::1 (in
  lib/security/production-checks.ts, called with one line from the web self-check and the gateway).
- **FY-9 Export downloads** (B minor 4): /api/vod answers only Sec-Fetch-Site same-origin or none (a typed address).
- **FY-10 Player scripts** (B minor 5, D-12): a pinned copy of go2rtc 1.9.9's two player files in public/vendor/go2rtc-1.9.9, loaded from
  the app's origin with a subresource integrity hash; both files pinned by a test. The gateway's script route is kept (unused by the
  app) so the gateway's own tests and older pages keep working; removing it is a later clean-up.
- **FY-11 Gateway** (B minors 6, 8): browser frames at most 4 KB (a bigger frame closes the socket, 1009); /g/health answers only a direct
  request from this computer (the Health page reads it there); through the proxy (X-Forwarded-For / Forwarded) it is "Not found".
- **FY-12 Own password change** (B minor 7): ends the open video of every sign-in too.
- **FY-13 Device import** (C I-8): strict reader, one transaction (check first, then everything or nothing), messages without cell
  values; an empty location or notes cell keeps what is saved and the token `(clear)` empties it; a device is matched by address and port
  among the five device types only, another kind of equipment or an NVR at that address is never changed. One import per organisation
  at a time (advisory lock) for the device import; the location import is not serialised yet.
- **FY-14 Manage devices** (C I-7): lists and changes only the five device types; access points, switches, routers and other kinds are
  changed under Assets. `nvr` stays a device type (non-recorder NVR boxes exist in the data); dropping it is an owner decision.
- **FY-15 Restores** (C I-9): refused under an archived parent (DR040): restore the region, then the cluster, then the location, then its
  cameras or devices. Chosen over "move to No cluster" so nothing changes place silently.
- **FY-16 Wording** (C M-15): "not checked yet" (never checked) and "not checked lately" (stale) are two states on every screen, roll-ups
  included.
