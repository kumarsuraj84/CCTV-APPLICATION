# CityKart Drishti — access model (capabilities × scopes × explicit grants)

Status: database layer built in P2-1 (migrations `20261021000008`…`20261021000011`, review fixes in `20261021000012`). App-wide enforcement built in P2-2 (migration `20261021000013`, sections "Enforcement in the app" and "Operation → capability" below). The administrator screen is P2-3, revoking open video sessions P2-4, locations/recorders P2-5, MFA enforcement P3. Decisions: D-1, D-2, D-2a, D-6a, D-10a, D-16 (`docs/drishti/DECISIONS.md`).

## The rules

1. **No role gives access to data, and no role alone allows an operation.** `user_role` (`user`, `operator`, `manager`, `admin`, `platform_owner`) is administrative authority only: who may manage people (`canManageRole`), who may use the admin pages (always together with an `admin.*` capability) and who may edit camera groups (`hasGroupEditingAuthority`, always together with `cctv.live`). What a person may see or do comes only from grants. The human role `agent` was renamed `operator` (AC-15).
2. **A grant is one capability at one scope**, for one person, with an optional validity window: `access_grants (capability, scope_kind, scope_id, valid_from, valid_until, revoked_at, source, needs_review, …)`.
3. **Scopes.** `organization` = everything of the organisation. `location` = every camera / asset in that location, including ones added later (until P2-5 a location is a row of `stores`). `camera` = exactly that camera. `asset` = exactly that asset (today a row of `devices`).
4. **Union, never narrowing.** A person's access for a capability is the union of their live grants. There is no deny and no rule where a narrower grant hides a wider one: adding camera grants to a location grant never takes cameras away (AC-6). To narrow, revoke the location grant and grant cameras.
5. **A grant counts** only while the person is active, has chosen their password, the grant is not revoked, `valid_from <= now() < valid_until` (no end = open), and — once `mfa_enforced()` is switched on in P3 — the session is `aal2` for capabilities with `requires_mfa`.
6. **History is append-only.** Grants are never updated or deleted by the app or the service role. Revoking sets `revoked_at/by/reason`; deleting the camera, location or asset revokes the grant and keeps the row; deleting a person keeps their grants as history (only deleting the organisation removes them). A person's `profiles.access_version` goes up with every change.
7. **Granting is monotonic.** Granting what a live grant already covers (same capability and scope, a window inside its window) changes nothing. Otherwise the live grant is replaced by one grant over both windows (earliest start, latest end, or no end if either has none). A grant can therefore never shorten, postpone or narrow access; only `revoke_grant` takes access away. The preview applies the same rule.
8. **The home store** (`profiles.store_id`) is information only and grants nothing (AC-7).
9. **CCTV never shows IT.** Devices, their status and NVR status need `it.inventory.view` or `it.monitoring.view` (AC-4). CCTV capabilities show camera rows, camera status and the plain location row.

## Catalogue (`capabilities`, read-only, seeded by migration)

| Area | Capabilities | Scope kinds |
|---|---|---|
| CCTV | `cctv.live` (low), `cctv.playback` (medium: search, calendar, 1× playback), `cctv.export` (medium, MFA: export and fast playback, D-6a) | organization, location, camera |
| IT | `it.inventory.view`, `it.monitoring.view` (low); `it.monitoring.operate` (medium); `it.remote.view`, `it.remote.control`, `it.diagnostics`, `it.script.run`, `it.software.manage`, `it.config.deploy`, `it.patch.manage`, `it.credentials.admin`, `it.os.deploy` (high, MFA) | organization, location, asset |
| Wi-Fi | `wifi.inventory.view` (low), `wifi.config.view_redacted` (medium); `wifi.profile.edit`, `wifi.deploy.approve`, `wifi.deploy.execute`, `wifi.device.reboot_upgrade`, `wifi.config.restore`, `wifi.credentials.admin` (high, MFA) | organization, location, asset |
| Admin | `admin.users`, `admin.access`, `admin.inventory`, `admin.alerts`, `admin.audit.read` (high, MFA) | organization |

`requires_mfa = (risk = 'high' or key = 'cctv.export')` is a table constraint. `mfa_enforced()` returns false until P3.

## What each kind of row needs

| Data | Visible with |
|---|---|
| `cameras` (no `camera_ip` column) | any CCTV capability covering the camera (`any_cctv_camera_ids()`) |
| `stores` (no NVR address, port, login or vault id columns) | any CCTV, IT or Wi-Fi grant inside the location (`any_grant_store_ids()`) |
| `store_nvr_endpoints`, `camera_endpoints` (addresses) | `it.inventory.view` or `it.monitoring.view` for the location (`it_view_store_ids()`) |
| `devices` (with address) | `it.inventory.view` or `it.monitoring.view` covering the asset (`it_view_device_ids()`) |
| `check_state`, `outages` | camera: as cameras; device: as devices; NVR: IT view of the location |
| `camera_groups` | at least one member camera visible; an empty group only for its creator and `admin.inventory` |
| `camera_group_items` | the member camera is visible |
| `profiles` | own row; the whole organisation with `admin.users` (P2-2 fix M-2: no role literal any more; before, `admin`/`platform_owner` by role too) |
| `check_state.error`, `check_state.method` | nobody signed in (column privileges, `20261021000014`); reasons through `status_reasons()` |
| `admin_audit_log` | `admin.audit.read` |
| `access_grants` | own grants; the organisation's with `admin.access` |

## Functions

Signed-in callers (about themselves only): `has_capability(cap)`, `has_capability_for(cap, 'camera'|'location'|'asset', id)` (a location counts only when covered whole), `capability_camera_ids(cap)`, `capability_store_ids(cap)` (locations covered whole), `capability_device_ids(cap)`, `any_cctv_camera_ids()`, `cameras_with_capability(cap, ids[])`, `any_grant_store_ids()`, `it_view_store_ids()`, `it_view_device_ids()`, `cctv_visible_group_ids()`, `mfa_enforced()`, and (P2-2, `20261021000013`, `authenticated` only) `my_access_summary()`: one row per capability that counts now, with `organization_wide` and the granted `location_ids`, `camera_ids`, `asset_ids` (the grants' scopes, not their expansion), evaluated by `access_grants_of` so status, validity, revocation and MFA rules stay in one place; and (fix round 1, `20261021000014`, `authenticated` only) `status_reasons(type, ids)`.

Server only (service role; the Server Action checks the administrator first and passes its organisation; the acting person `actor` must be an active person of that organisation): `grant_access(org, user, grants, actor, reason, expected_version)`, `revoke_grant(org, user, grant_ids, …)`, `replace_user_grants(org, user, capabilities[], scope_kinds[], grants, …)` (makes the live grants for those capabilities and scope kinds exactly the list; others untouched; a wanted description without dates matches any live grant of that scope and leaves it as it is, so nothing is re-dated), `preview_access_change(org, user, changes, at, sample)` (per capability: added/removed counts and samples, writes nothing; revocations first, then grants joined as above), `access_expiring(org, within)`, `function_privileges()`.

Reporting and diagnostics only — never for authorisation: `report_effective_camera_ids/device_ids(user, cap, at, ignore_status)` (treat every session as MFA-verified), `access_session_capabilities(user, claims, mfa_enforced)` (the capabilities that would count for given JWT claims), `access_legacy_*` (the old rules). The migration `access_migrate_legacy(run, users, force)` is for the database owner only and skips anybody who already has a report row unless `force`; tests use `access_migrate_legacy_test`, which refuses people outside organisations made by the test suite.

A grant description is `{capability, scope_kind, scope_id?, valid_from?, valid_until?}`. A change for the preview is that plus `op: 'grant'`, or `{op: 'revoke', grant_id}` (the person's own live grant). A stale `expected_version` fails with SQLSTATE `40001` (lost-update guard).

## Migration of the old model (D-2, D-2a), run once in `20261021000010`

| Before | After (`source`) |
|---|---|
| store grant, no camera grants in that store | live + playback for the location (`migrated:store`) |
| zone grant | live + playback for each store in the zone at migration time (`migrated:zone`) |
| home store, no camera grants in it | live + playback for the location (`migrated:home`, `needs_review`) |
| store / zone / home store **plus** camera grants inside (narrowed before) | live + playback for exactly those cameras (`migrated:camera`) |
| camera grants | live + playback per camera (`migrated:camera`) |
| manager role | organisation-wide `cctv.live`, `cctv.playback`, `it.inventory.view`, `it.monitoring.view` (`migrated:manager`, `needs_review`) |
| admin / platform owner | organisation-wide administrator set: `cctv.live`, `cctv.playback`, `cctv.export`, `it.inventory.view`, `it.monitoring.view`, `it.monitoring.operate`, `wifi.inventory.view`, `wifi.config.view_redacted`, `admin.*` (`migrated:admin`) |
| IT devices seen through a store / zone / home grant | **not migrated** (AC-4); listed in the report note |
| export | nobody except administrators (it did not exist; fast playback was administrators-only) |

The migration proves itself and aborts if any check fails: the legacy evaluator equals the real old functions for every person who can sign in; afterwards every person's live and playback camera sets equal their old camera set; no export outside administrators; no high-risk IT capability. One `access_migration_report` row per person holds the old model, the resulting grants and a note. The old tables `user_store_access`, `user_zone_access`, `user_camera_access` are retired: no policy, no access for signed-in people, read by no access rule; they stay one release with the `access_legacy_*` functions (migration report, VA-18 test), then go.

## Enforcement in the app (P2-2)

Two kinds of question, answered differently on purpose:

1. **"What may this person do at all, and roughly where?"** — the request's summary. `getCurrentProfile()` (`lib/auth/profile.ts`, cached per request with React `cache`) reads `my_access_summary()` once through the person's own client and exposes `profile.capabilities` (`lib/auth/capabilities.ts`: per capability `{ organization, locations, cameras, assets }`, and `failed` when it could not be read; a failure holds nothing — fail closed). It decides what to **show**: navigation (`lib/nav.ts`), page gates (`requireCapability(cap | caps)` sends home), the admin gate (`requireAdministration(admin.*)`, `mayAdminister`), buttons, links, wall tiles and index lists (`coversCamera`, `coversLocation`, `lib/queries/access.ts`). Data is still read through the person's own client (row security), so a wrong display decision can never reveal data.
2. **"May this person do THIS to THAT camera / location / asset?"** — always the database's scope-specific functions as the person, through `lib/auth/resource.ts`: `camerasFor` (`cameras_with_capability`), `cameraFor` / `locationFor` / `assetFor` (`has_capability_for`), `coversSomeLocation` (`capability_store_ids`). Never the any-scope `has_capability(cap)` for a resource, and never the `report_*` / `access_session_*` helpers (they skip MFA; tooling only). Only after an allowed answer is anything read with the service role (NVR address, login, password; camera addresses), and then scoped to the person's organisation. A refused camera looks exactly like a missing one.

**Administrative rule (one, consistent).** Every `/admin` page and admin action needs an administrative role (`admin` / `platform_owner`) **and** its `admin.*` capability for the whole organisation: people → `admin.users`; access editor → `admin.access`; stores, devices, import, the monitoring page and camera discovery → `admin.inventory`. The services behind them keep their role check as authority (`isAdminRole`, `canManageRole`). Existing administrators hold these by migration (`migrated:admin`); a new administrator needs them granted (the dev-admin script does; the P2-3 screen will).

**Camera status for CCTV-only viewers (ruling on review note 4).** Camera status is camera availability, so everybody who may see a camera sees whether it is live or offline. The checker's own reason names recorder internals, so it is shown only with the IT view of the camera's location; everybody else sees "Recorder not reachable." when the camera's NVR is down (cause `nvr_down`) and "The camera is not responding." otherwise (`cameraReason` in `lib/queries/status.ts`). NVR status, NVR login hints, NVR addresses, devices and camera addresses need the IT view (AC-4). The home page has a CCTV section and an IT section, each shown only with its capability, and "Nothing is assigned to your account yet. Ask an administrator for access." when there is nothing to monitor.

**Status reasons (fix round 1, I-1, migration `20261021000014`).** `check_state.error` and `check_state.method` are not selectable by signed-in people (column privileges: every other column is). The reason a target is offline comes from `status_reasons(type, ids)` (signed-in callers, about what they may see): a camera's reason is the checker's text only with the IT view of its location, otherwise "Recorder not reachable." (method `nvr_down`) or "The camera is not responding."; device and NVR reasons need the IT view of the device or store. `getStates` reads it for offline targets. Checked for the same class of leak: `outages.cause` can only be `nvr_down` (constraint; camera availability), `store_status` (security invoker) uses only status and time columns, devices / endpoint views already need the IT view, `stores` / `cameras` have no address columns for signed-in people.

**Recorder trouble during playback (fix I-2).** A missing or unreadable NVR login and every NVR answer problem (refused login, no answer, odd answer, slow download) during the calendar, the day search, 1x playback, fast playback and its probe is "The recordings of this camera cannot be reached right now." (fast playback: 502) unless the person has `it.inventory.view` or `it.monitoring.view` for the camera's store (`recorderDetailsAllowed`, `has_capability_for(…, 'location', store)`); the IT view gets the specific words (and fast playback's 409 for a missing login). The kind of trouble is logged on the server only.

**Unreadable summary (fix M-4).** When `my_access_summary` cannot be read, live opening, the playback actions and fast playback answer the plain "Could not check your access. Please try again." (fast playback: 503, audited as `cctv_export_denied` with reason `access_check_failed`), never "not available for your account"; pages show "Your access could not be read just now".

**Fast playback (ruling M-3).** `/api/vod` and its probe need `cctv.export` AND `cctv.playback` for the camera: it is a recording. Export alone gets the same refusal as no right at all (403 without either capability, 404 "Camera not found." when the camera is not covered by both).

**Request counts.** Each capability has its own per-person count (`lib/streams/request-limit.ts`): live (open + refresh, 30/min), playback open (30/min), recording search (60/min), export (30/min). This replaces ruling R17's single shared count. **Order (M-7):** the count is taken before the per-camera scope check, deliberately: a flood of requests for cameras one may not use costs at most the count, never one database check per request beyond it; it reveals nothing (the count is per person, not per camera). The general limiter (`lib/rate-limit.ts`, check-now 3/min, sign-in) is one table per process (`processSingleton`).

**Audit (best effort, `lib/auth/access-audit.ts`; durable audit is P5).** Actor, capability, camera or location ids, count; never a token, address, URL or password: `cctv_live_opened`, `cctv_playback_searched`, `cctv_playback_opened`, `cctv_export_started` / `cctv_export_ended` / `cctv_export_denied`, `check_requested`, `cameras_discovered`, `group_*`.

## Operation → capability

| Operation | Where | Capability and scope | Check (as the person) | Refusal |
|---|---|---|---|---|
| Open live streams, sub and main | `openStreamsAction` → `lib/streams/open.ts` | `cctv.live` per camera | `cameras_with_capability('cctv.live', ids)` | cameras left out silently (`{ ok: true, streams: [] }`); no go2rtc call |
| Refresh live tokens (every 8 min) | `refreshStreamTokensAction` → same | `cctv.live` per camera, re-checked each time | same | same |
| Recording calendar | `listRecordedDaysAction` → `listRecordedDays` | `cctv.playback` per camera | `has_capability_for('cctv.playback', 'camera', id)` | "Camera not found."; no NVR request |
| Day search (segments) | `listDaySegmentsAction` → `listDaySegments` | `cctv.playback` per camera | same | same |
| Open playback (1x) | `openPlaybackAction` → `openPlayback` | `cctv.playback` per camera | same | same; no go2rtc call |
| Fast playback 2x/4x/8x (`/api/vod`) and its probe | `app/api/vod/route.ts` → `serveVod` | `cctv.export` AND `cctv.playback` (D-6a, ruling M-3) per camera | summary holds both, then `has_capability_for` for each on the camera | 403 "Fast playback is not available for your account." / 404 "Camera not found." / 503 access check failed; audited as denied |
| Speed choice on the Playback screen | `app/(app)/playback/page.tsx` | `cctv.export` and `cctv.playback` for that camera (the page lists only playback cameras) | `has_capability_for` | only 1x offered |
| Why a camera / device / NVR is offline | `getStates` → `status_reasons()` | camera: any CCTV; checker's text only with the IT view of the location; device / NVR: IT view | the function, as the person | camera terms; nothing for device / NVR |
| Thumbnails / snapshots (not built yet) | `lib/streams/thumbnail.ts` `thumbnailAllowed` | `cctv.live` per camera | `has_capability_for('cctv.live', 'camera', id)` | not allowed |
| Live page, wall and index | `app/(app)/live/page.tsx`, `getLiveScope(…, 'cctv.live')`, `storesForCapability` | `cctv.live` | page gate on the summary; cameras through `cameras_with_capability` | sent home / camera "not found" / empty list |
| Playback page and lists | `app/(app)/playback/page.tsx`, `getLiveScope(…, 'cctv.playback')` | `cctv.playback` | same | same |
| Camera group read (list, one group, items) | `lib/queries/groups.ts` | any CCTV capability | row security `cctv_visible_group_ids`, items by `any_cctv_camera_ids` | not listed / "not found" |
| Camera group create, rename, delete, add, remove | `lib/actions/groups.ts` → `lib/groups/service.ts` | role operator/admin/owner AND `cctv.live`; every added or removed camera `cctv.live`; rename: `cctv.live` on at least one visible member (or an empty group); delete: the creator, or the admin role AND `admin.inventory` (fix M-1) | summary, then `my_access_summary` in the service and `cameras_with_capability('cctv.live', ids)` | "Changing camera groups needs live view…" / "Some of those cameras are not available to you." / "Group not found." / "That camera is not in this group." |
| Groups page | `app/(app)/groups/**` | any CCTV capability; edit controls as above; live wall link needs a camera with `cctv.live` | summary; `cameras_with_capability` | sent home |
| Stores list and store detail | `app/(app)/stores/**` | any CCTV, IT or Wi-Fi grant inside the location | row security `any_grant_store_ids` | sent home / "not found" |
| Store detail: cameras and status | same | any CCTV capability per camera | row security | not shown |
| Store detail: Live / Playback links | same | `cctv.live` / `cctv.playback` for the camera (summary) | the target screen checks again | link hidden |
| Store detail: NVR status, login hint, camera addresses, checker's camera reason | same | `it.inventory.view` or `it.monitoring.view` for the location | row security (`store_nvr_endpoints`, `camera_endpoints`, `check_state`) + summary | hidden; camera reason in camera terms |
| Device list, store detail devices, device status | `app/(app)/devices/page.tsx`, `lib/queries/inventory.ts` | `it.inventory.view` or `it.monitoring.view` (location or asset) | row security `it_view_device_ids` + page gate | sent home / not shown |
| Home: CCTV section | `app/(app)/home/page.tsx` | any CCTV capability | summary; counts through row security | section hidden |
| Home: IT section (NVRs, devices) | same | IT view | same | section hidden |
| Check now (home, monitoring page) | `requestCheckNowAction` → `lib/monitor/check-now.ts` | `it.monitoring.operate` for the organisation or at least one whole location (the button uses the same rule, `coversSomeWholeLocation`, fix M-5) | summary, then `capability_store_ids('it.monitoring.operate')` | "You are not allowed to start a check."; nothing written |
| Find cameras on an NVR (discovery) | `discoverCamerasAction` → `lib/monitor/discovery.ts` | admin role AND `admin.inventory` | `requireAdministration`, then `has_capability_for('admin.inventory', 'location', store)` | "Only administrators can look for cameras." / "Store not found."; no NVR request |
| Users page, create, activate, role, reset password | `app/(app)/admin/users/page.tsx`, `lib/actions/admin/users.ts` | admin role AND `admin.users` (+ `canManageRole`) | `requireAdministration('admin.users')` | sent home |
| Access editor page and save (interim, P2-3 replaces) | `app/(app)/admin/users/[id]/access/page.tsx`, `saveAccessAction` | admin role AND `admin.access` | `requireAdministration('admin.access')` | sent home; the Users page hides the Access link |
| Manage stores (incl. NVR addresses), manage devices, import | `app/(app)/admin/{stores,devices,import}`, `lib/actions/admin/inventory.ts` | admin role AND `admin.inventory` | `requireAdministration('admin.inventory')` | sent home |
| Monitoring page | `app/(app)/admin/monitoring/page.tsx` | admin role AND `admin.inventory`; its Check now button `it.monitoring.operate` | same | sent home |
| Audit log rows | row security | `admin.audit.read` | policy | not readable |
| Navigation | `lib/nav.ts` | Home: always; Stores: any location grant; Devices: IT view; Live: `cctv.live`; Playback: `cctv.playback`; Groups: any CCTV; admin items: role AND their `admin.*` | summary | item hidden |

## How to add a capability

1. New forward migration: `INSERT INTO public.capabilities (key, area, description, risk, requires_mfa, scope_kinds)`; `requires_mfa` must equal `risk = 'high'` (or the key is `cctv.export`), the constraint enforces it.
2. If the capability shows rows, add it to the right helper (`any_cctv_camera_ids`, `it_view_*`) or write a policy that calls `capability_*_ids('<key>')`.
3. Add the key to `CAPABILITIES` in `lib/auth/capabilities.ts` (a test compares it with the catalogue). Check the operation on the server through `lib/auth/resource.ts` (scope-specific functions, the person's own client) before any service-role read; gate the page or button on the summary; add the row to "Operation → capability" above.
4. Add a test that a person without it is refused (add the operation to `tests/integration/capability-enforcement.test.ts`), and update the count in `tests/integration/access-model.test.ts` (catalogue test).

The interim access editor (`/admin/users/<id>/access`) edits only live + playback, in effect now, for whole stores and single cameras (`replace_user_grants`); zones are turned into their current stores. Every other live grant (other capabilities, organisation-wide grants such as a migrated manager's, dated or one-sided live/playback grants) is listed read-only under "Other access" with where it came from, the review flag and its dates, and a save keeps it exactly as it is. P2-3 replaces the editor with modes, expiry and the preview.
