# CityKart Drishti — access model (capabilities × scopes × explicit grants)

Status: database layer built in P2-1 (migrations `20261021000008`…`20261021000011`). App-wide enforcement is P2-2, the administrator screen P2-3, revoking open video sessions P2-4, locations/recorders P2-5, MFA enforcement P3. Decisions: D-1, D-2, D-2a, D-6a, D-10a, D-16 (`docs/drishti/DECISIONS.md`).

## The rules

1. **No role gives access to data.** `user_role` (`user`, `operator`, `manager`, `admin`, `platform_owner`) is administrative authority only: who may manage people (`canManageRole`), and, until P2-2, who may press Check now or edit camera groups. What a person may see or do comes only from grants. The human role `agent` was renamed `operator` (AC-15).
2. **A grant is one capability at one scope**, for one person, with an optional validity window: `access_grants (capability, scope_kind, scope_id, valid_from, valid_until, revoked_at, source, needs_review, …)`.
3. **Scopes.** `organization` = everything of the organisation. `location` = every camera / asset in that location, including ones added later (until P2-5 a location is a row of `stores`). `camera` = exactly that camera. `asset` = exactly that asset (today a row of `devices`).
4. **Union, never narrowing.** A person's access for a capability is the union of their live grants. There is no deny and no rule where a narrower grant hides a wider one: adding camera grants to a location grant never takes cameras away (AC-6). To narrow, revoke the location grant and grant cameras.
5. **A grant counts** only while the person is active, has chosen their password, the grant is not revoked, `valid_from <= now() < valid_until` (no end = open), and — once `mfa_enforced()` is switched on in P3 — the session is `aal2` for capabilities with `requires_mfa`.
6. **History is append-only.** Grants are never updated or deleted by the app or the service role. Revoking sets `revoked_at/by/reason`; changing dates revokes and adds a new row; deleting the camera, location or asset revokes the grant and keeps the row. A person's `profiles.access_version` goes up with every change.
7. **The home store** (`profiles.store_id`) is information only and grants nothing (AC-7).
8. **CCTV never shows IT.** Devices, their status and NVR status need `it.inventory.view` or `it.monitoring.view` (AC-4). CCTV capabilities show camera rows, camera status and the plain location row.

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
| `profiles` | own row; the whole organisation for `admin`/`platform_owner` (administrative authority) or with `admin.users` |
| `admin_audit_log` | `admin.audit.read` |
| `access_grants` | own grants; the organisation's with `admin.access` |

## Functions

Signed-in callers (about themselves only): `has_capability(cap)`, `has_capability_for(cap, 'camera'|'location'|'asset', id)` (a location counts only when covered whole), `capability_camera_ids(cap)`, `capability_store_ids(cap)` (locations covered whole), `capability_device_ids(cap)`, `any_cctv_camera_ids()`, `cameras_with_capability(cap, ids[])`, `any_grant_store_ids()`, `it_view_store_ids()`, `it_view_device_ids()`, `cctv_visible_group_ids()`, `mfa_enforced()`.

Server only (service role; the Server Action checks the administrator first and passes its organisation): `grant_access(org, user, grants, actor, reason, expected_version)`, `revoke_grant(org, user, grant_ids, …)`, `replace_user_grants(org, user, capabilities[], scope_kinds[], grants, …)` (makes the live grants for those capabilities and scope kinds exactly the list; others untouched; identical grants kept), `preview_access_change(user, changes, at, sample)` (per capability: added/removed counts and samples, writes nothing), `access_expiring(within)`, `access_effective_camera_ids/device_ids(user, cap, at, ignore_status)`, the migration helpers and `function_privileges()`.

A grant description is `{capability, scope_kind, scope_id?, valid_from?, valid_until?}`. A change for the preview is that plus `op: 'grant'`, or `{op: 'revoke', grant_id}`. A stale `expected_version` fails with SQLSTATE `40001` (lost-update guard).

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

## How to add a capability

1. New forward migration: `INSERT INTO public.capabilities (key, area, description, risk, requires_mfa, scope_kinds)`; `requires_mfa` must equal `risk = 'high'` (or the key is `cctv.export`), the constraint enforces it.
2. If the capability shows rows, add it to the right helper (`any_cctv_camera_ids`, `it_view_*`) or write a policy that calls `capability_*_ids('<key>')`.
3. Check the operation on the server with `has_capability_for` (or `cameras_with_capability`) through the person's own client before any service-role read.
4. Add a test that a person without it is refused, and update the count in `tests/integration/access-model.test.ts` (catalogue test).

The interim access editor (`/admin/users/<id>/access`) edits only live + playback for whole stores and single cameras (`replace_user_grants`); zones are turned into their current stores. P2-3 replaces it with modes, expiry and the preview.
