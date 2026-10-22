# P2-5 impact map — schema change for P2-5a (and what it drags into P2-5b / P2-5c)

Purpose: let the next implementer change the schema safely in one pass. Read-only analysis of the tree at `121222b` on `feat/drishti-p2-access-location`, plus the in-flight work of the other builder (see 0.1). Governing texts: `docs/drishti/DECISIONS.md` (Ruling C-1 CONFIRMED, W-1..W-6, T-1, P-1, E-1/E-2), `docs/audit/REWORK-PLAN-PROPOSAL.md` §9.3 D-4 / D-5 / D-17, `docs/audit/INITIAL-AUDIT.md` §5, `.superpowers/sdd/drishti/p2-5-brief.md` (both addenda; the CONFIRMED one wins).

Target shape: strict tree **Organization → Region → Cluster → Location → NVR (recorder) → Camera**; `stores`→`locations` (ids kept), `devices`→`assets` (ids kept), new `regions`, `clusters`, `recorders`, `camera_channel_mappings`; grant scope kinds `organization, region, cluster, location, recorder, camera, asset`; archive instead of delete; NVR history re-keyed to recorders.

---

## 0. Read this first

### 0.1 Baseline and moving parts (re-scan before starting)

* Migrations on disk: `20261021000001`..`16` committed; **`20261021000017_access_admin_fixes.sql` is untracked and still being written** (618 lines, no rollback file yet). It redefines `access_check_manager`, `access_check_grantor`, `access_put_grant`, `preview_access_change`, `grant_platform_owner_all`, `capabilities_after_insert`, `access_catalogue_probe_test`, `access_review_keep`, adds `access_merge_plan`, `access_owner_only`, `access_review_self_confirm`, `change_person_role`, `set_person_active`, `access_check_people_admin`, `access_teardown_test_org_people`, `profiles_keep_super_admin`, replaces the unique index `access_grants_active_key` by the exclusion constraint `access_grants_live_no_overlap` (gist on `user_id, capability, scope_kind, coalesce(scope_id), tstzrange(valid_from, valid_until)`), and adds trigger `capabilities_grant_platform_owners_on_scope` (fires on `UPDATE OF scope_kinds` — relevant when P2-5a widens the catalogue). Two of its functions still read `cameras.store_id` / `devices.store_id` (`access_check_grantor`, 0017:141-142). P2-5a numbering starts after the highest committed number (≥ 18) — re-check `ls supabase/migrations` first.
* Working tree modified by that builder (uncommitted): `lib/admin/access.ts`, `lib/admin/access-rules.ts`, `lib/secrets.ts`, `scripts/env-from-supabase.mjs`, `types/database.ts` (regenerated), `tests/integration/{access-editor,users-admin}.test.ts`, `tests/unit/{access-rules,nav,secrets}.test.ts`, new `tests/integration/access-{admin-fixes,entry-points}.test.ts`, `tests/unit/access-fixes.test.tsx`. All line numbers below for those files may shift; `types/database.ts` must be REGENERATED (`npm run db:types`), never hand-merged.
* Packages that land before P2-5a and touch the same objects (see 3.9): **T-1** (routes/text; `/stores`→`/locations`, `?store=`→`?location=`), **P2-4** (`media_sessions` + `media_session_*` RPCs and a `has_capability_for(p_user, …)` family that re-implements the scope rules for another person; gateway changes), P2-3 fix round (migration 17). After they land, re-run the scans in Appendix A: new references to `stores`, `store_id`, `devices`, camera/asset scope will have appeared.

### 0.2 Legend used in the tables

* **R** = breaks on rename. Postgres itself follows a table/column rename for FKs, indexes, triggers, RLS policies, views, column grants and constraints (they store object ids). It does NOT follow names inside function bodies: `LANGUAGE sql` and `plpgsql` bodies are stored as text, so a stale `public.stores` / `store_id` / `devices` is only found at the first call (runtime error `relation … does not exist`), never at creation or rename. PostgREST resource names (`.from('stores')`, embeds `stores!inner(...)`, `onConflict: 'store_id,channel'`) and magic strings (`'nvr'`) are the same class: silent until used.
* **S** = must change semantics (scope expansion for region/cluster/recorder, target type `recorder`, archive instead of delete, multi-recorder).
* **K** = can stay as is (listed so nobody wonders).

### 0.3 Decisions to settle before writing SQL (recommended answer in bold)

| # | Question | Recommendation | Why / consequence |
|---|---|---|---|
| D5-1 | What stays on `cameras`? | **Keep `location_id` (renamed `store_id`, NOT NULL, composite same-org FK) and `channel`; add nullable `recorder_id`. `channel` and `recorder_id` are a trigger-maintained cache of the single ACTIVE mapping; `camera_channel_mappings` is the truth.** A trigger also enforces: active mapping's recorder is at the camera's `location_id`. | 25+ call sites read `cameras.channel` / filter `store_id`; location expansion stays one indexed lookup; recorder scope is `cameras.recorder_id = ANY(..)`. Cost: a cache invariant that needs its own test. |
| D5-2 | Recorder identity | **`recorders.id` = `assets.id`** (1:1 extension, shared key), `recorders.location_id` denormalised with a deferrable composite FK `(id, location_id) → assets (id, location_id) ON UPDATE CASCADE`. Vault name `recorder:<id>`. | One id for the box everywhere (grants of kind `recorder`, `check_state` target, mapping). Merging an `nvr`-type device with the store NVR keeps the device's id as the recorder id. |
| D5-3 | Archive | **`archived_at timestamptz` on regions, clusters, locations, assets (and thus recorders), cameras. `CHECK (archived_at IS NULL OR NOT is_active)` (assets: `NOT enabled`).** Existing `is_active = true` / `enabled = true` filters and the existing "stop monitoring" triggers (`stores_stop`, `cameras_stop`, `devices_stop`) then keep working unchanged for archived rows. Hard `DELETE` is refused by a BEFORE DELETE trigger except for organisations whose slug starts `test-` / `demo-` (tests and the demo reset) via purge RPCs. | Avoids touching every `.eq('is_active', true)`; history can never be erased by accident; test clean-up (`tests/setup/fixtures.ts:112-133`, `scripts/seed-demo.ts` reset) needs the purge path. |
| D5-4 | Target types in `check_state` / `outages` | **Keep `'camera'`, keep `'device'` (it now means asset — a pure rename would touch ~15 strings for no gain), add `'recorder'`, drop `'nvr'` only in the contract migration.** | `'nvr'` appears in 17 places in app code (3.1/3.5/3.7). `'device'` renaming can wait for the P5 availability work. |
| D5-5 | Function and view renames | **Rename with `ALTER FUNCTION … RENAME` / `ALTER VIEW … RENAME` (ACLs, policies, view dependencies follow the object id):** `capability_store_ids→capability_location_ids`, `it_view_store_ids→it_view_location_ids`, `any_grant_store_ids→any_grant_location_ids`, `capability_device_ids→capability_asset_ids`, `it_view_device_ids→it_view_asset_ids`, `access_store_set→access_location_set`, `access_device_set→access_asset_set`, `access_stores_for→access_locations_for`, `access_devices_for→access_assets_for`, `report_effective_device_ids→report_effective_asset_ids`, `access_legacy_store_*→access_legacy_location_*`, `nvr_{store,read,delete}_credential→recorder_{store,read,delete}_credential`, `store_status→location_status`, `store_nvr_endpoints→recorder_endpoints`. | Every renamed RPC name is hard-coded in VA-19 (`tests/integration/access-model.test.ts:611-720`) and in `lib/auth/resource.ts:63`, `tests/unit/access-resource.test.ts:83-86`. Keeping old names is the lower-churn alternative; either is fine if done in one pass. |
| D5-6 | Which scope kinds each capability accepts | **cctv.\*: organization, region, cluster, location, recorder, camera. it.\*: organization, region, cluster, location, recorder (the NVR's own asset and assets attached to it), asset. wifi.\*: organization, region, cluster, location, asset. admin.\*: organization only.** Needs lead confirmation. | C-1: "a CCTV scope never reveals IT assets" holds because `cctv.*` expansion only returns cameras. |
| D5-7 | How the app keeps running between P2-5a and P2-5b | **Transitional seam, removed by the contract migration at the end of 5b** (details 2.3 and 5.2): keep the legacy NVR columns on `locations` (nullable, deprecated) with a one-way sync trigger to the primary recorder; keep `nvr_*_credential(p_store)` as thin wrappers over the recorder functions; `monitor_apply_results` maps `'nvr' + location id` to `'recorder' + primary recorder id`; history is re-keyed in 5a, so the six code sites that read `'nvr'` rows are patched in 5a. | Gates (typecheck, lint, unit, integration) must be green at the end of every package, and the owner's `next dev` on :3212 runs on the same database. Alternative = land 5a+5b as one release unit (bigger, safer for consistency, loses the "one package at a time" rule). |
| D5-8 | Recorder address and duplicates | **Host/port live on `assets.ip / tcp_port` + `asset_endpoints`; uniqueness `(org, address_space, host, port)`. The data migration must not fail on duplicate NVR addresses: a conflicting recorder gets its own `location_nat` address space and a row in `inventory_migration_report`.** | `stores.nvr_ip` has no uniqueness today; the demo seed points DEMO1 and DEMO3 at the SAME `127.0.0.1:8081/8554`; `tests/integration/access-performance.test.ts:41` gives 300 stores the same `nvr_ip`; SD-WAN addressing is an external unknown, so real stores may share private ranges. |
| D5-9 | "NVR status" of a multi-NVR location | **`location_status` keeps `nvr_status/nvr_down_since/nvr_checked_at/nvr_stale` as worst-of / earliest / oldest / any-stale over the location's recorders and adds `recorders_total/up/down/unknown`; a new `recorder_status` view is the per-recorder truth.** | Keeps `lib/queries/status.ts:108-109`, `home`, `stores` pages working in 5a. |
| D5-10 | Unassigned parents | **`locations.cluster_id` and `clusters.region_id` nullable; NULL = "Unassigned" (no synthetic rows).** A NULL parent is simply not covered by cluster/region grants; organisation, location, recorder, camera grants still cover it. | Matches C-1 ("nullable only during migration/import, flagged in the UI"). |
| D5-11 | Hierarchy moves | **Direct `UPDATE locations SET cluster_id` / `clusters SET region_id` is allowed for the service role, but a trigger bumps `profiles.access_version` of every person holding a region/cluster grant at the old or new parent (and organisation-wide holders are not touched) and writes an `admin_audit_log` row listing the affected people; a `preview_hierarchy_change` function gives the counts before saving.** | Moves take effect immediately because expansion is computed at read time; the version bump makes open access editors fail their `expected_version` check and gives P2-4 the signal. |
| D5-12 | Vault | **Rename the existing Vault row in place (`name = 'recorder:<id>'`), re-point the id, never re-encrypt or read the value to the client.** Verify with `sha256(decrypted_secret)` before and after inside the migration (never printed). | Mechanics and open points in 5.3. |

---

## 1. Database objects

Sources: all 16 committed migrations + 0017 (in flight) + `supabase/rollback/*` + `supabase/seed.sql` (4 lines: inserts organisation `citykart`; no change) + `supabase/config.toml` (`schemas = ["public","graphql_public"]`, `max_rows = 1000`, Postgres 17).

### 1.1 Tables and columns

| Object | Defined | Class | Required change |
|---|---|---|---|
| `stores` | 0002:9-31 (cols `nvr_ip` NOT NULL, `rtsp_port`, `http_port`, `nvr_username` NOT NULL, `nvr_secret_id uuid`, `expected_channels`, `zone`, `state`, `is_active`) | R, S | `RENAME TO locations`. Add `kind` (`store, head_office, dc, warehouse, other`, default `store`, NOT NULL), `cluster_id` (nullable, composite FK `(cluster_id, org_id) → clusters`), `parent_location_id` (nullable self FK, same-org), `uplink_asset_id` (nullable; FK to `assets` added later in the brief but it creates a second locations↔assets relationship — see 1.5/5.4), `archived_at`. Legacy NVR columns: make nullable (`nvr_ip`, `nvr_username` lose NOT NULL — heads, DCs have no NVR), keep for the transition (D5-7), drop in the contract migration. `zone`, `state` stay as attributes (C-1). |
| `cameras` | 0002:39-53 | R, S | Rename `store_id→location_id`. Drop `cameras_store_channel_key UNIQUE (store_id, channel)` (0002:49) **only after** the mapping uniques exist. Add `recorder_id` (D5-1), `archived_at`. `camera_ip` stays on the row (served through `camera_endpoints`). **Index gap**: the unique `(store_id, channel)` was the ONLY index with `store_id` leading (the FK has none; `cameras_org_idx` is `(org_id)`), so dropping it removes the index that every location lookup, FK check and expansion uses → add `cameras (location_id)` and `cameras (recorder_id) WHERE recorder_id IS NOT NULL` in the same migration. |
| `devices` | 0002:55-70 (`type device_type`, `ip NOT NULL`, `tcp_port`, `enabled`, `store_id`) | R, S | `RENAME TO assets`; rename `store_id→location_id`; new columns `serial, mac, vendor, model, firmware, role, owner, criticality, lifecycle_state, warranty_until, last_inventory_at, management_mode, capability_discovered_at, credential_ref, config_owner, assigned_profile_id, parent_asset_id?, archived_at` (brief + D-4). `ip` becomes nullable/legacy once `asset_endpoints` exists. All columns are readable by `authenticated` because 0002:199-200 granted whole-table SELECT and 0011 comment says "devices keep all columns": **new sensitive columns (`credential_ref`, MAC, management mode) are readable by anyone with an IT view unless the table grant is replaced by a column list** — decide now. |
| `profiles.store_id` | 0001:33; FK 0002:36-37; index 0004:46; comment 0009:63 | R | Rename to `location_id` ("home location, information only, grants nothing"), comment follows. Used by `lib/auth/profile.ts:18,23`, `lib/admin/users.ts:32,39,59-62,79,119-127,171`, `components/admin/CreateUserForm.tsx:43-46`, `tests/setup/fixtures.ts:32,46`. Read by the legacy migration functions (1.6). |
| `user_store_access`, `user_zone_access`, `user_camera_access` | 0002:72-94; indexes 0004:44-45; retired 0011:111-116 | K (FK follows rename) | Retired, no policy, read by nothing except `access_legacy_*` and tests (`access-migration.test.ts:56,155`, `access-model.test.ts:600-604`, `inventory-rls.test.ts:209`, `access-editor.test.ts:327`, `negative-rls.test.ts:52`). Column `store_id` in `user_store_access` may keep its name. Their `ON DELETE CASCADE` FKs to `stores`/`cameras` disappear in effect once hard delete is refused. Drop together with `access_legacy_*` only when the VA-18 test is retired (not part of P2-5). |
| `admin_audit_log` | 0002:96-106 | K | `entity_type` strings `'store'` (`lib/auth/access-audit.ts:50`, `lib/inventory/stores.ts:49,71,85`) — history keeps them; new rows should say `'location'`; readers must accept both. |
| `check_state` | 0005:5-22; CHECK `target_type IN (camera, device, nvr)`; comment "for 'nvr' this is the store id"; column grants 0014:12-15 | S | Widen CHECK to include `'recorder'` (constraint is anonymous: `check_state_target_type_check`); re-key `'nvr'` rows (2.2). Unique `(org_id, target_type, target_id)` is safe for the re-key (different type). Column grant list is unchanged (generic columns). |
| `outages` | 0005:24-38; CHECK `target_type`; `cause CHECK (cause IS NULL OR cause = 'nvr_down')`; partial unique `outages_one_open_idx` | S | Same CHECK widening and re-key; keep the cause token `'nvr_down'` (used in `lib/monitor/supabase-db.ts:32`, `checks.ts`, status code). Re-key must not violate `outages_one_open_idx` (type changes, ids are new, so it cannot). |
| `worker_state`, `monitor_gaps` | 0005:41-59, 0006:12-14 | K | Single-row / global tables; nothing references locations. P2-7 will change the lease. |
| `camera_groups`, `camera_group_items` | 0007 | K (S later) | Composite FK `(camera_id, org_id) → cameras ON DELETE CASCADE` (0007:19): with hard delete refused, groups survive archiving; a remap changes nothing. Dynamic groups (region/cluster/location/recorder rules) are P4-L1/L2; P2-5 must not break the static ones. |
| `capabilities` | 0009:11-56; CHECK `scope_kinds <@ ARRAY['organization','location','camera','asset']` (0009:19) | S | Widen the CHECK to the seven kinds, then `UPDATE … scope_kinds` per D5-6. The UPDATE fires `capabilities_grant_platform_owners_on_scope` (0017:483) — harmless (organisation stays in the array) but run it inside the same migration and test it. |
| `access_grants` | 0009:69-113; CHECK `scope_kind IN (…)` (0009:74), CHECK `access_grants_scope` (0009:92-100), typed columns `location_id, camera_id, asset_id`, FKs `access_grants_location_fk → stores (id, org_id) ON DELETE SET NULL (location_id)` (0009:102), `…camera_fk`, `…asset_fk → devices` (0009:104), indexes `access_grants_{location,camera,asset}_idx`, `access_grants_expiry_idx` | R(no: FKs follow), S | Add `region_id`, `cluster_id`, `recorder_id` typed columns with composite same-org FKs (`regions`, `clusters`, `recorders`), partial indexes, extend both CHECKs (scope_kind list and the per-kind column rule), extend `access_grants_before_insert` (0012:25-47) and `access_grants_before_update` (0009:139-165) so the typed column mirrors `scope_id` and a cleared typed column revokes the grant. Existing rows need no data change: their scope ids are unchanged. `source` CHECK (0009:88) lists the `migrated:*` values; add a value only if the zone→cluster conversion tool records a new source. |
| `access_grant_reviews` | 0015:22-36 (+0017:519-520) | K | FK only to `access_grants`. |
| `access_migration_report` | 0009:171-182 | K | JSON snapshots (`old_model` has `home_store_id`, `stores`); history, never rewritten. |
| `organizations` | 0001 | K | Parent of every new org-scoped table (add to `ORG_TABLES_IN_DELETE_ORDER`, 4.3). |

### 1.2 Constraints, foreign keys, indexes (what follows a rename, what must be added or dropped)

| Object | Defined | Class | Note / change |
|---|---|---|---|
| `stores_org_code_key (org_id, code)`, `stores_id_org_key (id, org_id)`, `stores_code_upper` | 0002:27-29 | K | Follow the rename; the `(id, org_id)` unique is the target of every same-org FK below. Rename for tidiness (`locations_*`). `tests/unit/sanitize-error.test.ts:9-11` uses the old constraint NAME only as a literal string. |
| `stores_org_zone_idx (org_id, zone)` | 0002:31 | K | Keep (the zone→cluster proposal tool filters on it). |
| `cameras_store_channel_key UNIQUE (store_id, channel)` | 0002:49 | S | DROP (brief). Anything using it as an `ON CONFLICT` target fails at runtime: `lib/monitor/discovery.ts:83`, `lib/inventory/stores.ts:14`, test/seed inserts that rely on it. |
| `cameras_id_org_key (id, org_id)`, `cameras_store_fk (store_id, org_id) → stores ON DELETE CASCADE`, `cameras_org_idx` | 0002:50-53 | K/S | FK follows both renames. Change `ON DELETE CASCADE` to `RESTRICT` (or keep and rely on the delete trigger) so a stray delete cannot cascade history away. |
| `devices_store_fk (store_id, org_id) → stores ON DELETE SET NULL (store_id)`, `devices_store_idx`, `devices_org_idx`, `devices_id_org_key` | 0002:67-70, 0009:59 | K | Follow renames. |
| `devices_org_ip_port_key UNIQUE NULLS NOT DISTINCT (org_id, ip, tcp_port)` | 0004:49-50 | S | Replaced by `asset_endpoints` uniqueness within an address space (AL-6). Existing tests: `tests/integration/hardening.test.ts` (uniqueness cases), `inventory-admin.test.ts`; `lib/import/apply.ts:71` looks devices up by `ip`. Drop only when the endpoints table is populated (data migration), otherwise the merge of `nvr`-typed devices with the same address conflicts. |
| `profiles_store_fk (store_id, org_id) → stores ON DELETE SET NULL (store_id)`, `profiles_id_org_key`, `profiles_store_idx` | 0002:34-37, 0004:46 | K | Follow renames. |
| `access_grants_location_fk / _camera_fk / _asset_fk` | 0009:102-104 | K (follow), S (new FKs) | Add `_region_fk`, `_cluster_fk`, `_recorder_fk` (composite, `ON DELETE SET NULL (col)`). |
| `check_state_target_key`, `check_state_status_idx`, `outages_target_idx`, `outages_recent_idx`, `outages_one_open_idx` | 0005:20-22,35-38 | K | Generic on `(org_id, target_type, target_id)`. |
| `camera_group_items` FKs and `camera_group_items_camera_idx` | 0007:18-21 | K | — |
| New | — | S | `regions (id, org_id, name, code, archived_at)` unique `(org_id, code)`, unique `(id, org_id)`; `clusters (…, region_id)` unique `(org_id, code)`, FK `(region_id, org_id)`, index `(region_id)`; `locations (cluster_id)` index; `recorders`; `camera_channel_mappings` with the two partial uniques of D-4 (`(recorder_id, channel) WHERE valid_to IS NULL`, `(camera_id) WHERE valid_to IS NULL`) and a no-overlap exclusion on `(camera_id, tstzrange(valid_from, valid_to))` and `(recorder_id, channel, tstzrange)`; `assets (location_id)`, `assets (parent_asset_id)`; composite uniques `(id, org_id)` on every new table that is an FK target. All FKs are composite `(x_id, org_id)` like the rest of the schema. |

### 1.3 Triggers

| Trigger | Defined | Class | Change |
|---|---|---|---|
| `stores_updated`, `cameras_updated`, `devices_updated` (`set_updated_at`) | 0002:108-110 | K | Follow rename; add the same trigger to every new table. |
| `stores_forget`, `cameras_forget`, `devices_forget` AFTER DELETE → `monitor_forget_target('nvr'/'camera'/'device')` | 0005:72-74 | S | They ERASE `check_state` and `outages` on delete (the history-destroying behaviour the brief removes). Replace by: BEFORE DELETE guard trigger (D5-3); keep `monitor_forget_target` only for the purge path of test/demo organisations; the `stores_forget` trigger passes the type `'nvr'` — it becomes a `recorders`/`assets` trigger with `'recorder'` or is dropped. |
| `stores_stop` (AFTER UPDATE OF is_active … → `monitor_stop_store`), `devices_stop`, `cameras_stop` | 0006:137-142 | R, S | `monitor_stop_store` body (0006:128-135) uses `cameras WHERE store_id` and type `'nvr'` → rewrite to stop the location's recorders (`'recorder'`) and cameras. Add the same for `recorders` (recorder/asset switched off or archived stops its cameras' `nvr_down` attribution, not the cameras themselves — decide: archiving a recorder with mapped cameras must be refused unless the cameras are remapped or archived). |
| `access_grants_insert` / `access_grants_update` | 0009:167-168 | S | Function bodies change (typed columns). |
| `profiles_updated`, `profiles_platform_owner_full_rights` (0016:64), `profiles_keep_super_admin` (0017:312) | — | K | — |
| `capabilities_grant_platform_owners` (0016:53), `…_on_scope` (0017:483) | — | K | Fire on the catalogue update (see 1.1). |
| New | — | S | location/cluster hierarchy move trigger (D5-11); camera↔mapping sync + same-location invariant; mapping no-overlap; asset dependency cycle prevention; archive/hard-delete guard; `recorders` consistency with its asset (type `nvr`). |

### 1.4 Views

| View | Defined | Class | Change |
|---|---|---|---|
| `store_status` (security_invoker) | 0005:190-204 → replaced 0006:147-165 (columns `store_id, org_id, cameras_total/live/down/unknown/stale, nvr_status, nvr_down_since, nvr_checked_at, nvr_stale`; joins `check_state … target_type='nvr' AND target_id = s.id`, `WHERE s.is_active`, `LEFT JOIN cameras c ON c.store_id = s.id AND c.is_active`) | S (R only via the join text, which a view stores by object id: it keeps working but returns NO nvr data after the re-key) | Rename `location_status`, column `location_id`; join recorders and `check_state target_type='recorder'`; D5-9 aggregate columns; add `archived_at IS NULL`. New `recorder_status`. Consumers: `lib/queries/status.ts:108-109`, `lib/queries/inventory.ts:25`, tests (`access-performance.test.ts:81,90`, `access-model.test.ts:152,216`, `monitoring-db.test.ts:131-137`, `monitoring-fixes-db.test.ts:131-196`, `negative-rls.test.ts:31`). |
| `store_nvr_endpoints` (owner-rights, `security_barrier`, `s.nvr_ip, rtsp_port, http_port, nvr_username`, filter `current_org_id()` and `it_view_store_ids()`) | 0011:87-90 | R, S | It selects the legacy columns: `DROP COLUMN` is refused while the view exists (loud, good). Replace by `recorder_endpoints` (per recorder; IT view of the recorder's location or of the recorder asset). No app code reads it today (grep: only docs and DB tests). |
| `camera_endpoints` (`c.id camera_id, c.org_id, c.store_id, c.camera_ip`, filter `c.store_id IN (it_view_store_ids())`) | 0011:92-95 | R, S | Column `store_id` renamed by the column rename (view follows by id, but the OUTPUT NAME stays `store_id` unless recreated) → recreate with `location_id`; filter must use the new it-view expansion (region/cluster/recorder). Consumer `lib/queries/inventory.ts:39`. |
| New | — | S | `recorder_endpoints`, `recorder_status`, optionally `camera_current_mapping` (IT only). Every view: explicit `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role; GRANT SELECT …`. |

### 1.5 RLS policies, column privileges, grants

| Object | Defined | Class | Change |
|---|---|---|---|
| `stores_select` → `id IN (SELECT any_grant_store_ids())` | 0011:29-30 | K (follows) / S (function body) | Rename policy to `locations_select`. Recommended: add `AND archived_at IS NULL` (signed-in people never need archived rows; admin screens read through the service role). |
| `cameras_select` (`any_cctv_camera_ids()`), `devices_select` (`it_view_device_ids()`) | 0011:31-34 | K / S | Rename to `assets_select`. Function bodies change. |
| `check_state_select`, `outages_select` (`target_type='nvr' AND target_id IN (it_view_store_ids())`) | 0011:37-52 | S | Replace the `'nvr'` branch by `'recorder' AND target_id IN (it_view_recorder_ids())`; keep `'nvr'` branch in the compat window only if rows remain. |
| `camera_groups_select`, `camera_group_items_select`, `profiles_select_org` (0014:50-52), `admin_audit_log_select`, `access_grants_select`, `capabilities_select`, `organizations_select`, `profiles_select_self` | 0007/0011/0014/0009/0001 | K | — |
| Column grants `stores` | 0011:78-79 `GRANT SELECT (id, org_id, code, name, city, zone, state, address, is_active, expected_channels, created_at, updated_at)` | S | **New columns get no privilege** (default privileges are closed): add `kind, cluster_id, parent_location_id, archived_at` (+ `uplink_asset_id` if shown); remove `expected_channels` when it moves to `recorders`; never grant `nvr_*`. |
| Column grants `cameras` | 0011:81-82 `(id, org_id, store_id, channel, name, is_active, created_at, updated_at)` | R(follows), S | Add `recorder_id` only if viewers may see it (Ruling C-1: "for viewers a location simply shows all its cameras; recorder shown to IT users") → **do NOT grant `recorder_id` to `authenticated`**; expose it through an IT-gated view or leave it service-side. `archived_at` not needed. `camera_ip` stays out. |
| Column grants `check_state` | 0014:12-15 (error, method excluded) | K | — |
| Whole-table grants `assets`/`devices` | 0002:199-200 | S | See 1.1. |
| Grants and privileges of every new table/view/function | convention 0004:7-11 | S | Defaults are closed: each new object needs explicit `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role` then `GRANT`. `privilege_violations()` (0004:14-38) must stay empty; VA-19 (`access-model.test.ts:611-720`) enumerates function grantees and requires `search_path = ''` for every SECURITY DEFINER function — new/rewritten functions must comply now (P2-6 item 4 will audit the old ones: 0005/0006 `monitor_*` and 0002/0004 `nvr_*` still use `SET search_path = public` / `public, vault`). |
| RLS on new tables | — | S | `regions`/`clusters`: visible to people holding a grant inside (ancestors of visible locations, names only) and to nobody else; `recorders`, `camera_channel_mappings`, `asset_endpoints`, `network_definitions`, `asset_dependencies`, `device_capabilities`, `address_spaces`: IT view of the location/asset (CCTV-only people see none — mapping rows reveal the recorder id and `recorders` hold the username). |

### 1.6 Functions (all of them; latest effective definition)

Signature changes (extra array parameters, new `RETURNS TABLE` columns) require `DROP FUNCTION` + `CREATE`, which is refused while a policy/view depends on the function: functions used by policies (`any_cctv_camera_ids`, `any_grant_store_ids`, `it_view_store_ids`, `it_view_device_ids`, `cctv_visible_group_ids`, `has_capability`, `current_org_id`, `current_user_role`) must keep signature and return type (rewrite with `CREATE OR REPLACE`, rename with `ALTER FUNCTION`), or the policy must be dropped and recreated in the same transaction. Re-grant by exact signature after every `DROP`/`CREATE` (the grants in 0009:893-934, 0012:586-602, 0013, 0014, 0015:343-352 are per signature).

**A. Rewrite required (R and/or S)**

| Function | Latest | Class | Required change |
|---|---|---|---|
| `access_camera_set(org, org_wide, locations[], cameras[])` | 0009:218-225 (`c.store_id`) | R, S | New signature adds `regions[], clusters[], recorders[]`; location expansion = `locations ∪ locations-in-clusters ∪ locations-in-regions`; recorder = `cameras.recorder_id = ANY`; exclude archived nodes in the path (rules 1.8). One shared expander `access_location_expand(org, regions[], clusters[], locations[])` used by all sets. |
| `access_device_set(org, org_wide, locations[], assets[])` → `access_asset_set` | 0009:227-234 (`devices d`, `d.store_id`) | R, S | Same expansion; recorder scope covers the recorder's own asset (+ attached assets, if modelled). |
| `access_store_set(org, org_wide, locations[])` → `access_location_set` | 0009:237-242 | R, S | "Covered whole": organisation, region, cluster, location. Recorder/camera/asset scopes never make a location whole. |
| `access_cameras_for / access_devices_for / access_stores_for` (user, caps, at, ignore_status, aal2) | 0009:244-283 | S | Bodies pass six scope arrays; signatures stay (callers K). |
| `has_capability_for(cap, kind, id)` | 0009:295-314 | R, S | `kind` ∈ camera, location, asset **+ recorder, cluster, region**; camera: org ∨ region∋location ∨ cluster∋location ∨ location ∨ recorder ∨ camera; location: whole-coverage only; asset: org ∨ region/cluster/location ∨ recorder ∨ asset. TS side: `lib/auth/resource.ts:50-59`. |
| `capability_store_ids / capability_device_ids` (→ `_location_ids / _asset_ids`), `capability_camera_ids` | 0009:316-330 | S via `*_for` | Rename only (camera one K). |
| `cameras_with_capability(cap, ids[])` | 0009:340-350 (`c.store_id`) | R, S | Per-camera ancestor test (camera → location → cluster → region, recorder) against the grant arrays — O(\|ids\|), no full expansion. Used by `lib/auth/resource.ts:43` for batches ≤ 1000. |
| `any_grant_store_ids()` → `any_grant_location_ids` | 0009:354-367 | R, S | Locations visible because of any non-admin grant: expansions of org/region/cluster/location, the location of a recorder/camera/asset grant. Add siblings `any_grant_cluster_ids`, `any_grant_region_ids` (ancestors of visible locations; names for navigation). |
| `it_view_store_ids / it_view_device_ids` | 0009:370-380 | S via `*_for` | Rename; add `it_view_recorder_ids()` for the `'recorder'` check_state/outages policy and `recorder_endpoints`. |
| `access_check_spec(org, spec)` | 0009:441-469 (validates scope id existence via `stores`/`cameras`/`devices`) | R, S | Add region/cluster/recorder existence checks (org-scoped, non-archived) and the new kinds in the `CASE`. |
| `access_items(org, cap, specs, at)` | 0009:594-628 (labels `s.code \|\| ' · ' \|\| c.name`, joins `stores`/`devices`) | R, S | Expand all kinds; labels for region/cluster/recorder grants; `wifi` area branch currently lists locations + assets. Feeds `preview_access_change`. |
| `preview_access_change(org, user, changes, at, sample)` | 0017:207-288 (committed text 0012:282-365) | S | `target` mapping at 0017:275 (`cctv→camera, it→asset, wifi→location`) unchanged; counts now include region/cluster/recorder expansion. Uses `access_merge_plan` (K). |
| `my_access_summary()` | 0013:10-21 | S | New OUT columns `region_ids, cluster_ids, recorder_ids` (and, recommended, `covered_location_ids` — the expansion of region/cluster scopes, so TS never recomputes hierarchy). Changing `RETURNS TABLE` = DROP + CREATE + `GRANT … TO authenticated` (0013:26-27). TS consumer `lib/auth/capabilities.ts:43-63`. |
| `access_grant_summary(org)` | 0015:328-341 | S | Counts per kind: add `regions, clusters, recorders` columns. TS consumer `lib/admin/access.ts:454-456,549`. |
| `access_check_grantor(org, actor, user, spec, reason)` | 0017:110-156 (0015:67-109); `c.store_id` / `d.store_id` at 0017:141-142; coverage rule 0017:149-151 | R, S | "An actor may grant a region/cluster scope only if they hold the right at an equal or wider scope": implement `access_scope_covers(held_kind, held_id, target_kind, target_id)` using ancestry (camera→location/recorder→cluster→region; recorder→location; asset→location; cluster→region) and use it here, in `access_put_grant`'s callers and in the TS copy `lib/admin/access-rules.ts:143-145`. |
| `access_grants_before_insert / _before_update` | 0012:25-47 / 0009:139-165 | S | Typed columns for the three new kinds. |
| `status_reasons(type, ids)` | 0014:20-42 (`c.store_id IN (SELECT id FROM it_stores)`, `'nvr'` branch `cs.target_id IN it_stores`) | R, S | Camera branch: IT view of the camera's location stays; `'recorder'` branch uses `it_view_recorder_ids()`; keep neutral text for CCTV-only people. TS consumer `lib/queries/status.ts:118-128`. |
| `monitor_apply_results(org, results, threshold)` | 0006:28-106 (existence gate at 52-60: `cameras JOIN stores … st.is_active`, `devices … enabled`, `'nvr' → stores … is_active`) | R, S | Validation per type: camera (camera active ∧ not archived ∧ its location active), device→asset, **`'recorder'`** (asset active ∧ recorders row ∧ location active). Compat (D5-7): accept `'nvr'` + location id → primary recorder. Keep signature `(uuid, jsonb, integer)` stable (P2-7 appends the fencing token). |
| `monitor_stop_store()` (trigger fn) | 0006:128-135 | R, S | See 1.3. |
| `monitor_forget_target()` | 0005:64-71 | S | Purge path only (D5-3). |
| `nvr_store_credential(p_store, p_secret)` | 0004:52-75 (replaces 0002:205-222); Vault name `'nvr:' \|\| p_store` at 0004:66-67; reads/writes `stores.nvr_secret_id` | R, S | New `recorder_store_credential(p_recorder, p_secret)` etc.; search_path `''` + `vault.` qualified. Old names stay as wrappers during D5-7, removed at contract. P2-6 will add Vault-read logging and per-service roles — write the new functions so that adding both is trivial. |
| `nvr_read_credential(p_store)` / `nvr_delete_credential(p_store)` | 0002:224-241 | R, S | Same. Callers: `lib/monitor/supabase-db.ts:117`, `discovery.ts:49`, `lib/streams/open.ts:84`, `playback.ts:134`, `lib/inventory/stores.ts:43,67,81`, `lib/import/apply.ts:38`, `scripts/seed-demo.ts:132`, `tests/setup/fixtures.ts:122` (+ 40 test lines). |
| `access_legacy_store_grants`, `access_legacy_camera_ids`, `access_legacy_device_ids` | 0009:703-738 | R | Bodies use `stores`, `c.store_id`, `d.store_id`, `profiles.store_id`. Update (cheap text replace) to keep the VA-18 test alive, or drop with that test. |
| `access_legacy_store_ids` | 0012:379-391 | R | Same. |
| `access_migrate_legacy(run, users, force)`, `access_migrate_legacy_test` | 0012:395-584 (uses `stores`, `s.zone`, `c.store_id`, `p.store_id`, `access_camera_set` with the OLD 4-argument signature at 0012:487-490, `v_stores`) | R | Owner-only; never re-run on real data (non-resurrecting). Still called by `tests/integration/access-migration.test.ts` (37 lines) and `access-model.test.ts`. Update the same way; note it calls `access_camera_set` → follow its new signature. |
| `access_effective_*` | dropped in 0012:108-109 | K | Gone (`report_effective_*` replaced them). |
| `report_effective_camera_ids / report_effective_device_ids` | 0012:111-120 | S via `*_for` | Rename the device one (D5-5). Used by tests (access-model/capability-lists/access-migration). |

**B. Stay, but listed because they sit next to the above or look related**

| Function | Latest | Class | Note |
|---|---|---|---|
| `set_updated_at`, `current_org_id`, `current_user_role`, `revoke_user_sessions`, `privilege_violations`, `function_privileges`, `mfa_enforced`, `access_aal2_of`, `access_caller_aal2`, `access_grants_eval`, `access_grants_of`, `access_session_capabilities`, `has_capability`, `any_cctv_camera_ids`, `cctv_visible_group_ids` | 0001/0003/0004/0009/0012 | K | Generic on `scope_kind` / `scope_id` or on cameras via `any_cctv_camera_ids`. `function_privileges` result is asserted by VA-19. |
| `access_merge_window` (0012:127), `access_merge_plan` (0017:38), `access_lock_person`, `access_bump_version`, `access_check_actor`, `access_owner_only`, `access_check_manager`, `access_put_grant` (0017:166), `grant_access`, `revoke_grant`, `replace_user_grants`, `apply_access_change`, `access_review_keep`, `access_review_self_confirm`, `access_expiring`, `change_person_role`, `set_person_active`, `access_check_people_admin`, `access_teardown_test_org_people`, `grant_platform_owner_all`, `capabilities_after_insert`, `profiles_platform_owner_after_update`, `profiles_keep_super_admin`, `access_catalogue_probe_test` | 0009–0017 | K | Scope-agnostic (they call `access_check_spec` / `access_check_grantor`). `access_catalogue_probe_test` inserts a probe capability with `scope_kinds` arrays — still valid after the CHECK is widened. Only the callers they delegate to change. |
| `monitor_stale_after_minutes`, `monitor_request_check`, `monitor_stop_targets(org, type, ids[])`, `monitor_stop_target()` (trigger, `TG_ARGV[0]`), `targets_uptime(org, type, ids[], window, now)` | 0005/0006 | K | Generic on `p_type text`; `'recorder'` works unchanged. Add a test that `targets_uptime` over a re-keyed recorder equals the pre-migration value. |

**C. New functions the change needs (checklist)**: location expander + ancestry helpers (`access_location_expand`, `access_camera_ancestry`, `access_scope_covers`); `it_view_recorder_ids`; `recorder_{store,read,delete}_credential`; mapping API (`camera_remap(camera, recorder, channel, at)` — closes the old mapping and opens the new one atomically; refuses a recorder at another location); archive/restore API (`archive_location|cluster|region|asset|camera`, cascade rules); `move_location(cluster)` / `move_cluster(region)` + `preview_hierarchy_change`; zone→cluster proposal function; address-space/endpoint validation (`asset_endpoint_in_network`), dependency cycle trigger; `inventory_effective_snapshot(org)`, `inventory_migrate_org(org)`, `inventory_verify_org(org)`; test-only purge `inventory_purge_test_org(org)` (slug `test-%` / `demo-%`, like `access_teardown_test_org_people`). All SECURITY DEFINER with `SET search_path = ''`, explicit grants, entry in VA-19.

### 1.7 Vault

* Secret per store: name `nvr:<store uuid>` (0002:214, 0004:66-67), description "NVR login for a store"; the id is stored in `stores.nvr_secret_id`. The helper deletes a stale same-name row first (`DELETE FROM vault.secrets WHERE name = 'nvr:' || p_store`, 0004:66).
* New: name `recorder:<recorder uuid>` (= asset uuid, D5-2), pointer `recorders.secret_id`. `assets.credential_ref` holds a Vault reference NAME for other assets (never a value).
* Migration: rename in place, same row id, same ciphertext (5.3). Stores without a pointer or with a dangling pointer (0004 handles dangling): recorder with `secret_id NULL`, reported.
* Retention rule to decide: archiving a recorder keeps its secret (restore); purging deletes it (`vault.secrets` row) — today `deleteStore` refuses to delete the store when the secret cannot be removed (`lib/inventory/stores.ts:80-84`).

### 1.8 Enum / types

* `device_type` ('nvr','server','attendance','footfall','other', 0002:7) is the asset type. Add `sdwan_edge, switch, access_point, router, ups, printer, desktop, laptop` — **own migration file, committed before use** (Postgres 17 permits `ADD VALUE` inside a transaction but the value cannot be used until commit). Optional `ALTER TYPE … RENAME TO asset_type` (changes the generated name `Enums['device_type']` used at `lib/queries/inventory.ts:50`, `types/database.ts:858,978`, `lib/inventory/device-types.ts:1-5`). Enum values cannot be removed: the rollback cannot undo this migration (document it).
* `user_role` unaffected.

### 1.9 Expansion rules the access functions must implement (the contract tests assert)

| Function | organization | region R | cluster C | location L | recorder X | camera | asset |
|---|---|---|---|---|---|---|---|
| camera set (cctv.*) | all cameras of org | cameras whose `location_id` is in a cluster of R | cameras whose `location_id` is in C | cameras with `location_id = L` | cameras with `recorder_id = X` (active mapping) | itself | — |
| asset set (it.*, wifi.*) | all assets | assets at locations of R | … of C | assets at L | X's own asset (+ attached) | — | itself |
| location "covered whole" | all | locations of R | locations of C | itself | never | never | never |
| visible location rows (`any_grant_location_ids`) | all | locations of R | locations of C | itself | X's location | the camera's location | the asset's location |
| visible region/cluster rows | all | itself + its clusters | itself + its region | their cluster + region | — | — | — |

Archived nodes grant nothing and are never returned: an archived region/cluster contributes no expansion through itself; archived locations/recorders/cameras/assets are excluded from every set; restoring brings them back. A location with `cluster_id IS NULL` is covered only by organisation, location, recorder, camera, asset scopes. Depth is fixed at 3 levels, so every expansion is two indexed joins (no recursion).

### 1.10 Rollbacks

`supabase/rollback/` has one file per migration (16 files). References to old names live in `…0002` (drop order), `…0004`, `…0005` (drops `store_status`, `stores_forget`), `…0006` (108 lines: old function bodies and view), `…0009` (drops legacy functions), `…0011` (146 lines: re-creates the OLD policies, `visible_*` functions and `store_nvr_endpoints`), `…0012` (406 lines: previous function bodies), `…0015`. They are correct only in reverse order: **the P2-5a rollbacks must undo the rename (and recreate the old-name function bodies) before any of these can run**. Add one rollback per new migration, in reverse order; the enum migration's rollback is a documented no-op; the data-migration rollback is possible only because `recorders.migrated_from_location_id` (recommended column) lets it re-key history back.

---

## 2. Order of operations

### 2.1 Recommended number of files: 4 forward migrations in P2-5a (+4 rollbacks), 1 contract migration in P2-5b

| # | File (suggested name, numbers after the last committed) | Content | Why separate |
|---|---|---|---|
| M1 | `…_p25_asset_type_enum.sql` | `ADD VALUE` ×8 (and optional type rename) | Enum values must be committed before use. Irreversible. Smallest risk. |
| M2 | `…_p25_locations_recorders_access.sql` — **one atomic transaction** | pre-change snapshot (2.2 step 0); renames; regions, clusters; recorders, mappings; archive columns/guards; capability CHECK widening; `access_grants` typed columns + triggers; **all function/policy/view rewrites of 1.4-1.6**; column privileges; compat seam; smoke block; `NOTIFY pgrst, 'reload schema'` | Renames break text-bodied functions at runtime, so the rename and every function rewrite must commit together: all or nothing. A self-test at the end of the same transaction (2.2 step 15) turns "found at first call" into "migration fails". |
| M3 | `…_p25_inventory_extensions.sql` | `address_spaces` (+ seeded `global` per org), `asset_endpoints`, `network_definitions`, `asset_dependencies` (+ cycle trigger), `device_capabilities` (+ seeds from `wifi-capability-research.md`, only sourced rows) with RLS/grants | Independent of access/monitoring; needed before the data migration so recorder endpoints can be created. Can be reviewed on its own. |
| M4 | `…_p25_inventory_migrate.sql` | `inventory_migration_report`; `inventory_migrate_org`, `inventory_verify_org`; execution for all organisations; history re-key; self-checks against the M2 snapshot | Data movement and history re-key; retryable if it fails (M2/M3 already committed, snapshot kept). |
| (P2-5b) M5 | `…_p25_contract.sql` | drop legacy `locations.nvr_*`/`expected_channels`, sync trigger, `nvr_*_credential` wrappers, `'nvr'` type from the two CHECKs and from `monitor_apply_results`, `store_nvr_endpoints` leftovers, snapshot table | Only after no code reads the legacy shape. |

D-4 asks for "one transaction per org": a migration file is one transaction, so isolation per organisation is not possible inside the file. Deliver `inventory_migrate_org(p_org)` as a function (tests call it per organisation) and have M4 call it for all organisations in one transaction (all or nothing).

### 2.2 Step order inside M2 and M4, with the risk of each step

M2 (atomic):

0. **Snapshot first, with the OLD functions** (before any rename): `inventory_migration_snapshot(user_id, capability, kind, ids[])` for every person × every capability × {cameras, locations-whole, assets} using `access_grants_of`/old `*_for`; row counts of cameras, devices, stores, check_state per type, open outages per target, monitor_gaps; `sha256(decrypted_secret)` per `stores.nvr_secret_id` (never output). Risk: size (200 people × 28 caps × ids) is small; do not store secrets, only hashes.
1. Rename `stores→locations`, columns `store_id→location_id` (cameras, devices, profiles), `devices→assets`; rename constraints/indexes/triggers/policies (cosmetic but tests and docs refer to names). Risk: low — Postgres follows. Anything not renamed here is found by step 15.
2. Add columns (locations kind/cluster_id/parent/archived_at; assets attributes; cameras recorder_id/archived_at); create `regions`, `clusters`; composite uniques first, FKs after. Risk: FK order.
3. Create `recorders`, `camera_channel_mappings` with the partial uniques and exclusion constraints **before** dropping `cameras_store_channel_key`.
4. Drop `cameras_store_channel_key`; create the `cameras (location_id)` index in the same statement group. Risk: forgetting the index (see 1.1).
5. Widen `capabilities.scope_kinds` CHECK, then `UPDATE` rows (D5-6); widen `access_grants` CHECKs; add typed columns/FKs/indexes. Risk: the 0017 trigger fires (harmless); the typed-column CHECK must accept existing rows.
6. Rewrite functions bottom-up: expander/ancestry → `access_*_set` → `access_*_for` → public wrappers (`has_capability_for`, `cameras_with_capability`, `*_ids`) → `access_check_spec` → `access_items` → `preview_access_change` → summaries → grantor → `status_reasons` → monitor functions → credential functions → legacy functions. Honour the DROP/policy dependency rule of 1.6.
7. Policies: recreate for renamed tables and the `'recorder'` branches (1.5); new-table policies.
8. Views: drop `store_status`, `store_nvr_endpoints`, `camera_endpoints`; create the new ones.
9. Column privileges (1.5), grants of every new object, `REVOKE` of `PUBLIC`.
10. Triggers: archive/hard-delete guard, mapping sync, hierarchy-move audit/version bump, stop triggers, `updated_at` triggers.
11. `check_state`/`outages` CHECKs accept `'recorder'` (keep `'nvr'` for the window).
12. Compat seam (D5-7): legacy NVR columns nullable + one-way sync trigger; wrappers; apply-results alias.
13. Smoke block in the same transaction: (a) `SELECT proname FROM pg_proc … WHERE prosrc ~ '\mstores\M|store_id|\mdevices\M|nvr_secret_id|nvr_ip|cameras_store_channel'` must return no rows except the intentionally kept compat/legacy functions, (b) call every rewritten function once for a throw-away organisation made inside the block, (c) `privilege_violations()` empty, (d) `function_privileges()` shows `search_path=''` for every SECURITY DEFINER function.
14. `NOTIFY pgrst, 'reload schema';` (Supabase also reloads on DDL, but a rename plus changed function signatures has produced stale caches elsewhere; belt and braces).

M3: independent additive objects; seed one `global` address space per organisation (needs a loop over `organizations`, and a trigger/default for organisations created later — otherwise new organisations (incl. every test organisation) have no space).

M4 (per organisation, inside `inventory_migrate_org`), idempotent (skip locations that already have a recorder):

1. For every location with legacy NVR data (`nvr_ip IS NOT NULL`): create the asset (type `nvr`, name e.g. "NVR", `location_id`, `enabled = is_active`) and the `recorders` row (`id` = asset id; ports, username, `expected_channels`, `secret_id`, `migrated_from_location_id`). Merge: an existing `nvr`-typed device in the same organisation whose address equals `nvr_ip` becomes THE asset (keep its id, set recorder fields) instead of creating a new one; its old `check_state`/`outages` rows of type `'device'` stay as history (they describe the same box; the generic asset probe must skip assets that have a `recorders` row, otherwise the box is probed twice — `lib/monitor/supabase-db.ts:54`). Risk: address conflicts (D5-8) → per-location address space + report row instead of a failure.
2. Endpoints: one `asset_endpoints` row per recorder (http and rtsp ports). Risk: unique violation on shared addresses (demo data, perf test, SD-WAN) → see D5-8.
3. Vault: `UPDATE vault.secrets SET name = 'recorder:' || recorder_id, description = 'Recorder login' WHERE id = <pointer>` (or `vault.update_secret` with `new_name` only — verify in 5.3), re-point `recorders.secret_id`, assert hash unchanged. Risk: name collision (unique name index) if a stale `recorder:<id>` exists; a failure here must abort the organisation.
4. Mappings: `INSERT INTO camera_channel_mappings (camera_id, recorder_id, channel, valid_from)` for every camera of the location (`valid_from` = camera `created_at`); set `cameras.recorder_id`. Locations with cameras but no NVR data (impossible today: NVR columns are NOT NULL) are reported. Risk: low.
5. History re-key: `UPDATE check_state SET target_type='recorder', target_id=<recorder id> WHERE org_id=… AND target_type='nvr' AND target_id=<location id>`, same for `outages`. The `check_state_updated` trigger bumps `updated_at` (harmless). Verify: counts equal, still at most one open outage per target, `targets_uptime(org,'recorder',…)` equals the pre-change `targets_uptime(org,'nvr',…)` for the window (snapshot it in step 0 for a sample window).
6. Grants: nothing to do (ids unchanged). Verify against the M2 snapshot: for every person and every capability the sets of cameras, whole locations and assets are identical (this is "the access effective-set equality for every person before/after"); the grant count and `access_migration_report` are untouched.
7. `ANALYZE` the touched tables; write the `inventory_migration_report` rows (per organisation: recorders created, merged devices, address conflicts, locations without cluster, cameras without mapping).

Zone→cluster/region is NOT part of the automatic migration: a proposal function suggests clusters/regions from `zone`/`state`; an administrator confirms (P2-5c screen). Existing `migrated:zone` location grants are kept (brief); converting them to cluster grants is the admin tool's job.

### 2.3 The transitional seam (D5-7) in detail

Needed only so that 5a ends green and the running app keeps working until 5b: (1) legacy columns remain on `locations` (nullable); an AFTER INSERT/UPDATE trigger copies `nvr_ip, rtsp_port, http_port, nvr_username` to the location's primary recorder/asset (first recorder by `created_at`; created on first write if none) so the old `StoreForm`/import/seed keep working; (2) `nvr_*_credential(p_store)` wrappers resolve the primary recorder and call `recorder_*_credential`; `locations.nvr_secret_id` is NOT kept in sync (the recorder owns the secret); (3) `monitor_apply_results` accepts `'nvr'` + location id; (4) `location_status` keeps the `nvr_*` columns (D5-9). Everything above is deleted by M5. Without the seam, 5a must carry the whole of 5b for the worker, streams, discovery, admin forms and import (≈ 25 more files).

---

## 3. Application code

Counts are files in the repository (excluding `node_modules`) that need a change, with the nature. "Pkg" = package that should do it under the recommended split (5.2): **5a** (forced by `tsc`/DB; mechanical), **5b** (recorder-aware logic), **5c** (UI/admin/import). Line numbers are from the current tree (see 0.1 for files that move).

Typed-client note: `types/database.ts` (generated, 96 hits) changes table/column/enum/RPC names, so `npm run typecheck` flags almost every PostgREST call. What `tsc` does NOT flag: string-typed table names in generic helpers (`lib/security/org-scope.ts:4,16` casts to `any`), `onConflict` strings, `.eq('target_type','nvr')` literals, the `TARGET_TYPES` set, embed strings inside `.select('…')` (typed loosely), `revalidatePath('/admin/stores')`, RPC argument names in untyped call sites, SQL text in `scripts/`. Those are the silent ones; each is called out below.

### 3.1 Monitor / worker — 9 files, 5b (+ type/guard edits in 5a)

| File | Lines | Change | Pkg |
|---|---|---|---|
| `lib/monitor/types.ts` | 6 `TargetType = 'camera'\|'device'\|'nvr'`; 9 `NvrJob`; 10-11 `StoreJob`; 28 `loadNvrs`; 30-33 `loadStoreJobs(storeIds, staleBefore)` | add `'recorder'`; jobs per recorder (`RecorderJob`: recorder id, location id, host, ports, username, password, cameras mapped to THIS recorder); rename `loadNvrs/loadStoreJobs` | 5a (type), 5b (shape) |
| `lib/monitor/supabase-db.ts` | 14 `TARGET_TYPES = new Set(['camera','device','nvr'])` — **silently drops every `'recorder'` result in `cleanResults` (22-37)**; 54 devices (skip assets with a recorder row); 60-66 `loadNvrs` from `stores`; 68-126 `loadStoreJobs` (75 stores select, 83-85 cameras by `store_id`, 93 `check_state target_type 'nvr'`, 117 `nvr_read_credential`); 131 apply | read recorders (join asset/location active and not archived), cameras via `recorder_id`, state `'recorder'`, credential per recorder id | 5a: line 14 and the six `'nvr'` reads (see 3.5); 5b: the rest |
| `lib/monitor/checks.ts` | 16 text; 65/90 serialised lane `'devices'`; 96-122 NVR TCP check emits `type:'nvr'` (109, 112) with `store: n.id` log; 146-163 login fingerprint/back-off keyed by store; 174-182; 184-324 `runStoreCameras` (known-down attribution 188-196, ISAPI 222, RTSP 266, back-off warnings 308-310); 326-333 lane key `store:${id}`; 338-358 `checkCameras(storeIds)`, `storeConcurrency` | per-recorder lanes, back-off, fingerprint, credentials; "NVR down" marks only that recorder's cameras (cause `nvr_down`); a location with 3 NVRs = 3 jobs; `storeIds` filter → recorder/location ids | 5b |
| `lib/monitor/runner.ts` | 14, 17 (`COUNTED` method names), 127-135, 149, 157, 182 | follows renames of the `MonitorDb` interface; progress totals per recorder | 5b |
| `lib/monitor/config.ts` | 27-29 `storeConcurrency` ← env `STORE_CONCURRENCY` (documented in `.env.example:18` and `docs/drishti/ARCHITECTURE.md:560`) | optional rename; keep the env name accepted | 5b |
| `lib/monitor/discovery.ts` | 16-88: store lookup 35/39-46, credential 49, `'This store has no NVR password saved…'` 51, channels 55, camera lookup 64, **`upsert(rows, { onConflict: 'store_id,channel' })` at 83 fails at runtime once the unique is dropped**, audit 88 | discovery per recorder; match mapping by `(recorder, channel)` first, never create a duplicate identity on remap; offer a reconciliation list for unmatched channels (brief 5b) | 5a: make it not crash (onConflict removed / lookup by mapping); 5b: full behaviour |
| `lib/monitor/check-now.ts` | 20 comment mentions `capability_store_ids` | rename follows D5-5 | 5a |
| `lib/monitor/uptime.ts` | 18, 62 `type: 'camera'\|'device'\|'nvr'` | add `'recorder'` | 5a |
| `lib/monitor/nvr-state.ts` | 3 comment | — | — |
| `services/worker/index.ts`, `lib/monitor/probes.ts`, `health.ts`, `guard.ts`, `failure-log.ts`, `last-checked.ts` | no schema references | none (P2-7 owns guard/lease) | — |

### 3.2 Streams / open / playback / vod — 4 files, 5b (5a: embed names)

| File | Lines | Change | Pkg |
|---|---|---|---|
| `lib/streams/open.ts` | 26-27 `StoreRow/CameraRow`; 64 `select('id, name, channel, store_id, stores!inner(code, nvr_ip, rtsp_port, nvr_username, is_active)')`; 68 `.eq('stores.is_active', true)`; 73; 78-86 one credential read per store (`nvr_read_credential`, 84); 93-101 RTSP URL from the store's NVR; 106 returns `storeCode`; 109 log | resolve the camera's ACTIVE mapping → recorder (host, ports, user, credential per recorder); embed `locations!inner`; demo detection per recorder host | 5a: embed/table names; 5b: mapping resolution |
| `lib/streams/playback.ts` | 43 `MSG_NO_LOGIN` text; 54-55, 92 types; 98 doc; 118 embed `stores!inner(code, nvr_ip, http_port, rtsp_port, nvr_username, is_active)`; 122; 129; 132 `isDemoStore`; 134-139 credential; 149-161 `recorderDetailsAllowed(rls, storeId)` (IT view of the LOCATION — stays location-level; allow recorder scope); 165-187; 209; 248; 266 playback URL; 276 | same as open.ts; per-recorder clock offset fields (D-17, later) | 5a/5b |
| `lib/streams/vod.ts` | 626 (headers only); 670 `camera.stores`; 698 NVR client host/port/user; 716, 739, 763, 767, 787-789 (`store.code`, `camera.store_id`) | uses `findPlayable` from playback.ts; follows its shape | 5a/5b |
| `lib/streams/source.ts` | 66-68 `isDemoStore({code, nvr_ip})` | demo detection on the recorder host | 5b |
| `lib/streams/{gateway,go2rtc,token,timeline,speed,request-limit,limiter,wall,thumbnail,calendar}.ts`, `services/gateway/index.ts`, `app/api/vod/route.ts` | only `no-store` header hits | none for P2-5 (P2-4 owns session registry, P2-6 target restriction) | — |

### 3.3 Discovery — see 3.1 (`lib/monitor/discovery.ts`) and `components/monitor/FindCamerasButton.tsx:8,17` (`storeId` prop), `lib/actions/admin/monitoring.ts:12-19` (`discoverCamerasAction(storeId)`, `revalidatePath('/admin/stores')`, `'/stores'`). 5a: names; 5b/5c: per-recorder and "discover all" (LG-28, 5c).

### 3.4 Admin inventory / import — 12 files, 5a (names) / 5c (functionality)

| File | Lines | Change |
|---|---|---|
| `lib/inventory/stores.ts` | 8 text; 11-14 `ensurePlaceholderCameras` (`store_id`, **`onConflict: 'store_id,channel', ignoreDuplicates`**); 31-51 `createStore` (insert 38-41 with `nvr_*`/`expected_channels`; credential 43; **hard delete on credential failure 45**); 54-73 `updateStore` (61-64, credential 67); 76-85 `deleteStore` (**hard delete 83**, vault delete 81) | locations + primary recorder; archive instead of delete; placeholder cameras need a mapping; rename file to `locations.ts` (5a/5b) |
| `lib/inventory/schemas.ts` | 11 `'Enter the store name.'`; 13 `zone`; 17-20 `rtsp_port/http_port/nvr_username/nvr_password`; 29 `store_id` | location + recorder schemas (5c) |
| `lib/inventory/devices.ts` | 14-18 `assertRefsInOrg(… 'stores')`, `'That store was not found.'`; 29-30, 42-43 insert/update `devices` with `store_id`; 53 **hard delete** | assets; archive (5a names, 5c) |
| `lib/inventory/device-types.ts` | 1-5 `DEVICE_TYPES`, `DeviceType`, labels | add the 8 new types; rename to asset types (5a) |
| `lib/import/stores-csv.ts` | 6-18 `StoreRow`; 24-55 parser; legacy columns name, city, zone, ip, port, http_port, user, password, channels (+ code, state, address) | stays "location + primary recorder + channels" (5c) |
| `lib/import/devices-csv.ts` | 2, 4, 9-10, 39-40 `store_code` | alias `location_code` (T-1) (5c) |
| `lib/import/apply.ts` | 5-6; 13-44 `importStores` (`stores` select 18, insert 33, **delete on failure 40**, `nvr_store_credential` 38, placeholder cameras 44); 59-79 `importDevices` (`stores` 59, `devices` 71/75/79) | recorder-aware upsert; no hard delete (5c; 5a names) |
| `lib/import/regions.ts` | `normalizeRegion` (zone/state text normaliser) | **name collision with the new `regions` table** — rename (e.g. `normalizeZone`) to avoid confusion (5a) |
| `lib/actions/admin/inventory.ts` | 7, 10 imports; 17 comment; 24-25 `STORE_FIELDS`/`DEVICE_FIELDS` (`store_id`, `nvr_username`, `channels`); 29-55 form parsing; 42, 49, 89 `revalidatePath('/admin/stores')` (**silent**); 46-49 `deleteStoreAction`; 55 `store_id` | actions for locations/recorders/assets/archive (5c; revalidatePath strings 5a/T-1) |
| `lib/actions/admin/monitoring.ts` | 12-19 | see 3.3 |
| `lib/actions/admin/users.ts` | 32, 39 `store_id` form field → home location | rename (5a) |
| `lib/security/org-scope.ts` | 4 `table: 'stores' \| 'cameras' \| 'devices' \| 'profiles'`; 16 `(admin.from(table) as any)` | **silent**: add `locations`, `assets`, `regions`, `clusters`, `recorders`; callers `lib/admin/access.ts:195`, `lib/admin/users.ts:62,127`, `lib/inventory/devices.ts:16` (5a) |
| `public/samples/stores-sample.csv`, `public/samples/devices-sample.csv` | headers `name,city,zone,ip,port,http_port,user,password,channels` / `name,type,store_code,ip,port,notes` | keep working; documented aliases (T-1/5c) |

### 3.5 Queries / status / groups / live — 5 files, 5a (names + `'nvr'` rows) / 5b (per recorder)

| File | Lines | Change |
|---|---|---|
| `lib/queries/status.ts` | 10 `store_id`; 29 `stores: {…nvrDown…}`; 31 `kind: 'camera'\|'device'\|'nvr'`; 75, 94-97 `nvrLoginProblem`; 108-109 `store_status` + `store_id`; 112 `getStates(…, 'camera'\|'device'\|'nvr', ids)`; 118-128 `status_reasons`; 149-229 recent outages (**165 `.eq('target_type','nvr')` open-NVR-outage map keyed by store; 167-171 `groupedUnderNvr(o, storeId)`**; 186-196 cameras/devices selects with `store_id`; 224-227 labels); 233-258 dashboard (`stores`, `devices`, `nvrDown` list) | `'recorder'`; grouping becomes camera → its active recorder's open outage (needs `cameras.recorder_id` in the select); dashboard counts recorders (and "locations with a recorder down"); keep return shape or version it |
| `lib/queries/inventory.ts` | 13 `StoreListItem`; 17-28 `listVisibleStores` (`stores`, `store_status`); 31-44 `getVisibleStore` (`camera_endpoints.eq('store_id')`, `devices` list, `showsAddresses`); 49 devices with embed `stores(code, name)` | **embed `assets → locations` becomes ambiguous once `locations.uplink_asset_id → assets` exists (PostgREST PGRST201) → use an FK hint `locations!assets_location_fk(...)`**; recorders listing for IT |
| `lib/queries/groups.ts` | 27-29 embed `cameras!inner(store_id, is_active, stores!inner(is_active))` + `.eq('cameras.stores.is_active')`; 33-36; 42-45, 58-61, 66-67 (`store_id`, `store_code`, `store_name`); 74-82 `listStoreCamerasForGroups` | `cameras.locations.is_active`; add `archived_at` rule; field renames |
| `lib/queries/live.ts` | 20 `LiveScope.kind 'store'`; 44 query `{store,…}`; 54-63 location scope; 68-71 embed `stores!inner`; 78-82 | `?location=` accepted (T-1); a location with several recorders shows all cameras; ordering by `(recorder, channel)` |
| `lib/queries/access.ts` | 15-30 `storesForCapability`: **copies the scope rule** (`scope.organization`, `new Set(scope.locations)`, per-camera counts from `cameras.store_id`) | with region/cluster/recorder scopes either extend with the covered location ids from `my_access_summary` (recommended) or call a SQL list function (5a) |

### 3.6 Access libraries — 9 files, 5a (explicit in the C-1 addendum)

| File | Lines | Change |
|---|---|---|
| `lib/auth/capabilities.ts` | 36 `ScopeSummary {organization, locations, cameras, assets}`; 43 `Row`; 50 `my_access_summary`; 58-63 mapping; 96-99 `coversCamera(c, cap, {id, store_id})`; 102-108 `coversLocation`; 114-117 `coversSomeWholeLocation`; 87-88 `holdsAnyLocationGrant` | add `regions, clusters, recorders` and the covered-location list; `coversCamera` takes `{id, location_id, recorder_id?}`; unit tests (`tests/unit/*capabilit*`, `access-resource.test.ts`, `profile-gates.test.ts`, `nav.test.ts`) |
| `lib/auth/resource.ts` | 50-59 `holdsFor(kind: 'camera'\|'location'\|'asset')`; 63 `rpc('capability_store_ids')` | kinds `recorder`, `cluster`, `region`; RPC rename (D5-5) |
| `lib/auth/profile.ts` | 18, 23 `store_id` (home) | rename |
| `lib/auth/access-audit.ts` | 28, 43-50 (`locationIds`, entity `'store'`) | entity `'location'`; add region/cluster/recorder ids |
| `lib/admin/access.ts` (in flux) | 48 `z.enum(['organization','location','camera','asset'])`; 115-128 `scopeLabels` (selects `stores`, `cameras … stores(code)`, `devices … stores(code)`); 170-171 error text; 188-197 `assertRefsInOrg` tables + parent maps via `store_id`; 225 preview `target`; 360-376 editor data (`stores`, `cameras.store_id`, `devices`); 454-456, 549 summary | new kinds in the enum/labels/refs; editor data gains regions, clusters, recorders, location→cluster→region (300 locations ≈ small) |
| `lib/admin/access-rules.ts` (in flux) | 6 `ScopeKind`; 36-37 presets (`'store-viewer'`, `'store-it-viewer'`); 45-62 preset expansion; 109-110; **143-145 `holdingCovers` copies the grantor rule (`location` covers camera/asset via `parentLocation`)**; 159-169 summary text | hierarchy-aware coverage (needs ancestry data), presets "cluster viewer / region viewer", wording |
| `lib/admin/users.ts` | 32, 39, 59-62, 79, 119-127, 171 (`store_id`), 177 `listStoresForAccess` (`stores … zone`) | rename; list locations |
| `lib/nav.ts` | 30, 37 hrefs `/stores`, `/admin/stores` (T-1 owns); 46, 72 use `holdsAnyLocationGrant`, `coversSomeWholeLocation` | follow the capabilities.ts rename |
| `lib/actions/monitor.ts` | 4, 21 `coversSomeWholeLocation` | follow |

### 3.7 UI pages and components — 12 pages + 10 components, 5c (names in 5a)

Pages (`app/(app)/…`): `stores/page.tsx` (9 hits: 10 `listVisibleStores`, 24, 39 column "Zone", 51 link, 57 `coversLocation(IT_VIEW)`), `stores/[id]/page.tsx` (19: 34 `getVisibleStore`, 42-45 `coversLocation/coversCamera` with `store_id`, 55 **`getStates(supabase,'nvr',[id])`**, 62 `nvrLoginProblem`, 70 link `/live?store=`, 140 devices), `home/page.tsx` (17: 32-33 `o.kind === 'nvr'`, 125-129 tiles linking `/stores`, 143-154 `d.stores.nvrStale/nvrDown`, 169 `DEVICE_TYPE_LABELS`), `live/page.tsx` (11: `?store=`), `playback/page.tsx` (12: `?store=`, `storesForCapability`), `groups/[id]/page.tsx` (6: `?store=`), `devices/page.tsx` (3: embed `stores`), `admin/stores/page.tsx` (12: 20 select with `nvr_ip, rtsp_port, http_port, nvr_username, expected_channels`, 43-44 links), `admin/devices/page.tsx` (8), `admin/monitoring/page.tsx` (11: 16 `NAMES {camera,nvr,device}`, 35-41 select `stores`/`cameras.store_id`, 50-65 **`nvrByStore` from `target_type === 'nvr'` (57)**, 131 map over `['camera','nvr','device']`), `admin/import/page.tsx` (4), `admin/users/page.tsx` (2: `listStoresForAccess`), `admin/access-review/page.tsx` (1 text).
Components: `admin/StoreForm.tsx` (18: fields `ip, rtsp_port, http_port, nvr_username, nvr_password, channels`), `admin/DeviceForm.tsx` (6), `admin/CreateUserForm.tsx` (4: `store_id`), `groups/GroupEditor.tsx` (14: `?store=` select), `monitor/FindCamerasButton.tsx` (2), `admin/AccessBuilder.tsx` (7: `CameraRef.store_id`, `AssetRef.store_id`, modes `location/camera/asset`), `admin/AccessEditor.tsx` (1 + `loc`/`cam` maps 38-40), `admin/AccessPreviewPanel.tsx` (`target` kinds), `admin/access-labels.ts` (3), `layout/icons.ts` (icon named `store`).
Routes/URLs: `/stores`, `/stores/[id]`, `/admin/stores`, query `?store=` on `/live`, `/playback`, `/groups/[id]` — **T-1 owns the rename and redirects**; P2-5 must not rename routes again. Admin screens for regions/clusters/recorders/mappings/assets/Wi-Fi are new 5c work.

### 3.8 Scripts, demo, seed, fixtures, types, docs

* `scripts/seed-demo.ts` (16 hits): 119-137 inserts `stores` with `nvr_ip/http_port/rtsp_port/nvr_username/expected_channels`, `nvr_store_credential` (132), `cameras.store_id` (136); 139-140 `devices`; 160 `scope_kind: 'location'`; 177/183 text. Needs: locations + recorders + mappings, **a location with TWO fake NVRs** (brief 5b); cleanup path must use the purge RPC (D5-3) — it imports `cleanupOrg` from tests/setup.
* `scripts/lib/demo.ts` (12 hits): 66 `zone`, 74-95 `demoPlan()` returns `{ stores, devices }` with `DemoStorePlan`; 83-86 DEMO1/DEMO3 share one fake NVR (address conflict, D5-8); 117 `DemoGrant.scope.stores`; 127-131 manager covers "BR zone" stores (a natural first cluster). T-1 renames "Demo Store …".
* `scripts/fake-nvr.ts` (89 lines, no schema refs): must serve a second NVR (port pair) for the multi-NVR demo (`parseFakeNvrArgs`, `DEFAULT_NVR_PORT`, `FAKE_RTSP_PORT` in `scripts/lib/demo.ts:11-14`).
* `scripts/create-dev-admin.mjs` (grants through `grant_access`; no schema names) — K. `scripts/env-from-supabase.mjs` — K.
* `types/database.ts` — regenerate (`npm run db:types`).
* Samples `public/samples/*.csv` — K (3.4).
* Docs to update with the change: `docs/drishti/access-model.md` (functions 46-52, migration 70, scopes), `docs/drishti/ARCHITECTURE.md` (tables 160-180, worker 560), `docs/drishti/DELIVERY-STATUS.md` rows AL-1..AL-7, WF-1..WF-4, AC-4/AC-10 notes, LG-16/LG-27/LG-28; `docs/ARCHITECTURE-AND-DESIGN-FOR-REVIEW.md` is superseded (leave).
* `agent/windows/collector/*` — no schema references.

### 3.9 Ownership by future packages (do not redo their work; coordinate)

| Package | What it will touch that P2-5 also touches | Rule for P2-5 |
|---|---|---|
| **T-1** (before 5a) | All user-visible "store" text, routes `/stores`, `/admin/stores`, `?store=`, nav labels (`lib/nav.ts:30,37`), demo names, `MSG_NO_LOGIN` (`playback.ts:43`), discovery/store messages, import help, CSV aliases, redirects, a grep test with an allow-list | P2-5 renames identifiers and data shapes only; do not retranslate text; the T-1 grep test's allow-list must be extended for code identifiers that remain. |
| **P2-4** (before 5a) | `lib/streams/{token,gateway,open,playback,vod}.ts`, `services/gateway/index.ts`, `lib/admin/users.ts` + access Server Actions (revocation hooks), new `media_sessions` and `media_session_*` + a `has_capability_for(p_user, …)` family | Require P2-4 to build on shared expander/ancestry helpers, or P2-5a must rewrite those functions too (they would otherwise silently ignore region/cluster/recorder grants → a revoked cluster member keeps video up to 60 s+). Add them to the 5a function list when P2-4 lands. |
| **P2-6** | `lib/security/targets.ts` wiring in `lib/probes.ts`, `lib/nvr/client.ts`, `lib/rtsp/describe.ts`, `lib/streams/*` source building, `lib/monitor/discovery.ts`; per-service DB roles and a GRANT matrix; Vault read logging in the credential functions; SQL hygiene audit (`search_path`) | New 5a functions already use `search_path = ''` and explicit grants; recorder credential functions are the single Vault read path so P2-6 can log there. "Registered recorder endpoints" = rows of `recorder_endpoints`/`asset_endpoints`. |
| **P2-7** | `lib/monitor/{guard,runner,supabase-db,checks,check-now,health}.ts`, `services/worker/index.ts`, fencing token on `monitor_apply_results` and other worker write RPCs | Keep `monitor_apply_results(p_org, p_results, p_threshold)` stable; P2-7 prerequisite is the recorder-keyed worker (5b). |
| P3.5 / P4-L1..L5 / P5 | navigation by region/cluster, dynamic groups, tour/popup links, recorder clock offset (columns only here), incident roll-ups, dependency evaluation | Schema only (columns, tables, indexes); no logic. |

---

## 4. Test impact

Totals: **integration** tests that create `stores` rows directly: 35 files / 81 call sites (`from('stores')`), `cameras` 32 files / 92, `devices` 17 files / 32, Vault RPCs 14 files / 40 — every one of them is rewritten. **Unit** tests that mention the old names: 28 files (excluding `jobs-*`, whose `store-1` strings and `stores(n)` helper are generic and unaffected).

### 4.1 Integration tests that assert on old names or behaviour (rewrite; never weaken)

| Test file | Lines of interest | What changes |
|---|---|---|
| `access-model.test.ts` (61 hits) | 152, 216 `store_status`; 600-604 retired tables; **611-720 VA-19 hard-codes function names and grantees** | renamed functions (D5-5), new functions in `expected`, `forPeople` allow-list, 'one signature each' for changed signatures; scope tests for new kinds |
| `access-migration.test.ts` (37) | 56, 155 `user_store_access`; `access_migrate_legacy_test` | legacy functions updated; unchanged semantics |
| `access-performance.test.ts` (11) | 41 `stores` insert with a shared `nvr_ip`; 81, 90 `store_status` | location/recorder fixtures; extend per 4.4 |
| `inventory-rls.test.ts` (53) / `inventory-admin.test.ts` (34) | direct inserts of all three tables, credential RPCs, 209 `user_store_access` | new fixtures; `deleteStore` → archive expectations |
| `status-queries.test.ts` (57) | 8 store inserts, 10 cameras, `'nvr'` check_state | re-keyed to recorders; grouping per recorder |
| `monitor-db.test.ts` (28), `monitor-db-fixes.test.ts` (13), `monitor-login.test.ts` (6), `monitoring-db.test.ts` (19), `monitoring-fixes-db.test.ts` (31), `worker-run.test.ts` (9), `store-camera-failure.test.ts` (10) | `store_status`, `monitor_apply_results('nvr')`, `monitor_stop_store`, stale NVR | recorder target type; stop triggers; location_status |
| `discovery.test.ts` (29), `open-streams.test.ts` (9), `playback-streams.test.ts` (12), `vod.test.ts` (11) | 5-7 inserts each, credential RPC | recorder + mapping fixtures; discovery by `(recorder, channel)` |
| `hardening.test.ts` (18) | 8 credential-RPC lines; device uniqueness | recorder credential functions; endpoint uniqueness |
| `negative-rls.test.ts` (11) | 31 table list incl. `stores`, `devices`, `store_status`; 52 per-table id column map incl. `user_store_access` | new tables/views in the anon/viewer denial matrix (this is also where "every table denied to anon" lives) |
| `viewer-queries.test.ts` (22), `groups.test.ts` (9), `groups-queries.test.ts` (5), `live-queries.test.ts` (4), `capability-lists.test.ts` (10), `capability-enforcement.test.ts` (13), `users-admin.test.ts` (19), `access-editor.test.ts` (9), `access-admin-db.test.ts` (5), `access-summary.test.ts` (3), `status-reasons.test.ts` (8), `entry-points.test.ts` (5), `check-now.test.ts` (4) | inserts + `store_id`/embed names | mechanical (fixtures); summary tests gain region/cluster/recorder ids; `status-reasons` gains `'recorder'` |
| `access-admin-fixes.test.ts`, `access-entry-points.test.ts` (new, in flight) | 1-5 hits each | same mechanical change after they land |
| `identity-rls`, `password-policy`, `platform-owner`, `gateway`, `health*` | none | — |

### 4.2 Unit tests

`monitor-checks.test.ts` (34), `monitor-checks-fixes.test.ts` (22), `monitor-checks-nvr.test.ts` (20), `monitor-backoff.test.ts` (11), `monitor-runner*.test.ts` (2+6+4): `StoreJob`/`NvrJob` shapes and `type: 'nvr'` expectations → recorder jobs (5b; in 5a only the shared helpers compile). `nav.test.ts` (12: `/stores`, `Manage stores` — T-1 changes these first), `demo-tools.test.ts` (9: `plan.stores`, DEMO1..3 shape), `stream-source.test.ts` (8: `isDemoStore`), `status-hints.test.ts` (7), `playback-timeline.test.ts` (5), `stores-csv.test.ts` (4), `devices-csv.test.ts` (3), `safe-next.test.ts` (4: `/stores` redirects), `fake-servers.test.ts` (2), `access-resource.test.ts` (2: asserts rpc `capability_store_ids` at 83-86), `access-editor.test.tsx` (2), and one-line mentions in `submitted-values`, `streams-action`, `regions`, `profile-gates`, `probes`, `playback-actions`, `nvr-post-stream`, `nvr-client`, `groups-actions`, `admin-action-gates` (mocks `@/lib/inventory/stores`, line 29). New: capabilities cover-helpers with hierarchy; access-rules `holdingCovers`; scope-kind enum.

### 4.3 Fixtures and helpers that must change

* `tests/setup/fixtures.ts`: `createUser(…, { storeId })` (32, 46) → `locationId`; `GrantScope` (61-65) + `atRegion/atCluster/atRecorder` and the existing `atLocation/atCamera/atAsset`; `ORG_TABLES_IN_DELETE_ORDER` (97-110) must list regions, clusters, recorders, mappings, assets, … in child-first order **and cannot hard-delete once D5-3 lands** → use `inventory_purge_test_org(org)` (guarded like `access_migrate_legacy_test` / `access_teardown_test_org_people`); `cleanupOrg` (112-133) lists stores and calls `nvr_delete_credential` per store (120-122) → recorders.
* New helpers (all server-side, via `adminClient()`): `createRegion`, `createCluster(region)`, `createLocation({ kind, cluster })`, `createRecorder(location, { host, rtspPort, httpPort, username, secret })` → `{ recorderId }`, `createCamera({ location, recorder, channel })` (does location + asset + mapping), `mapCamera(camera, recorder, channel, validFrom?)`, `createAsset({ location, type, … })`, `createLegacyStore(...)` (writes the legacy-shaped columns for the migration test while the compat columns exist), `grantAt*` wrappers, and a `snapshotEffective(org)` helper calling `inventory_effective_snapshot`.
* `tests/helpers/memory-db.ts` (`NvrJob`, `StoreJob`, `loadNvrs`, `loadStoreJobs`) and `tests/helpers/monitor-fixtures.ts` (`store()` → recorder job factory) — 5b.
* `scripts/lib/demo.ts` is imported by the fixtures (`ADMIN_BASELINE`, `tests/setup/fixtures.ts:4`).

### 4.4 New acceptance tests to add (beyond the brief's `tests/integration/locations-recorders.test.ts` list)

Hierarchy and access (new file `hierarchy-access.test.ts`):
1. Region of 3 clusters × several locations: a region-scoped person sees exactly those cameras and none outside; a location added to a cluster LATER appears immediately.
2. Cluster-scoped person sees exactly the cluster's locations and ALL cameras of each (every recorder), not a sibling cluster, and **no IT assets** (`it.*` empty), recorder rows and mappings unreadable.
3. Moving a location between clusters changes access immediately: old-cluster holder's count drops, new-cluster holder's rises (RLS counts via real JWT), `access_version` of both holders bumped, an `admin_audit_log` row lists affected people; `preview_hierarchy_change` counts equal the observed change. Same for moving a cluster between regions.
4. Recorder scope: only that NVR's cameras; remapping a camera to another recorder moves it between recorder-scope holders while a camera-scope holder keeps it; grants, group items, check_state, outages unchanged.
5. Union with other kinds (region + camera) never narrows; location "covered whole" semantics (`has_capability_for(…,'location',id)` true for region/cluster/location/org, false for recorder/camera/asset).
6. Archive: an archived region/cluster grants nothing; archived location hides its cameras; archived camera disappears from active queries but history stays; restore brings access back; archived nodes in a path cut expansion.
7. A location with `cluster_id IS NULL` is covered by org/location/recorder/camera grants only; the "unassigned" counts show in the admin summary data.
8. Capability scope-kind matrix: CHECK rejects `admin.users` at region, `it.*` at camera, `cctv.live` at asset; each allowed pair accepted; typed column mirrors `scope_id`; hard purge of a target revokes the grant (append-only trigger).
9. Grantor rule: an administrator holding cluster scope may give location/camera/recorder grants inside the cluster but not in another cluster and not a region grant; a region holder may give cluster grants; super administrator anything; the same decisions via TS `holdingCovers` (unit parity test fed from SQL).
10. `cameras_with_capability` over 1000 ids across 3 recorders and 2 clusters equals the full expansion; `my_access_summary` returns region/cluster/recorder ids and the covered locations.
11. VA-19 extended: every new function in the `expected` map, `search_path = ''`, `privilege_violations()` empty; every new table/view denied to anon (negative-rls matrix).
12. Catalogue UPDATE with the 0017 trigger does not create or remove platform-owner grants unexpectedly.

Recorders and monitoring (extend `locations-recorders.test.ts`, `monitor-recorders-db.test.ts`):
13. **Location with 3 NVRs, one down**: `monitor_apply_results` for recorder B fails twice → only B's cameras get cause `nvr_down`; A/C cameras unaffected; `location_status.recorders_down = 1`, `nvr_status` worst-of; outages grouped per recorder; a viewer sees the neutral "Recorder not reachable." only on B's cameras; an IT person sees recorder rows; stale logic per recorder.
14. Same channel number on two recorders of one location coexist; second ACTIVE mapping for a camera refused; two active mappings for `(recorder, channel)` refused; no-overlap exclusion across `valid_from/valid_to`; remap is atomic (concurrent remaps: one wins).
15. Camera remapped keeps id, grants, group membership, `camera_ip`, check_state/outages; mapping history retained; cache columns (`cameras.channel`, `recorder_id`) equal the active mapping after every operation; refused if the target recorder is at another location.
16. Recorder credentials: `recorder:<id>` Vault name, `secret_id` pointer, read only via the service function keyed by recorder, `authenticated`/`anon` denied, archive keeps the secret, purge removes it.
17. Archive semantics end-to-end: camera/asset/recorder/location archive → monitoring stopped (`monitor_stop_targets`), open outages closed, history rows remain, grants remain, hard DELETE refused for a normal organisation (and for the service role), allowed only through the purge RPC for test/demo organisations; archiving a recorder that still has mapped cameras is refused.
18. Head office with no recorder and assets only: appears in lists, no monitoring error, `location_status` zeros.
19. Hierarchy-move trigger path: direct `UPDATE locations SET cluster_id` by the service role still bumps versions and audits.
20. Address handling: duplicate NVR addresses across locations migrate into per-location spaces and are reported; within one space the unique holds; recorder with HO CIDR not applied to a store (brief); dependency cycle rejected; capability seeds carry source refs.

Migration (new `inventory-migration.test.ts`, run against fixtures while the compat columns exist):
21. Legacy-shaped dataset with every old grant shape (store, zone, home, manager, admin, camera-narrowed), an `nvr` device duplicating a store NVR, two stores sharing an NVR address, a store with no secret, a dangling secret pointer, an inactive store, `nvr` check_state + open outage + closed outages + `nvr_down` camera outages, monitor_gaps: run `inventory_migrate_org`; assert ids preserved (locations, cameras, assets), **effective sets identical for every person and every capability before/after** (cameras, whole locations, assets, IT view, status visibility), check_state/outages re-keyed with equal counts, one open outage per target, `targets_uptime` equal, Vault ciphertext untouched (hash equal) and renamed, `access_migration_report`/`admin_audit_log`/`monitor_gaps` untouched.
22. Idempotent second run changes nothing; failure injected mid-run leaves nothing changed (atomic); per-organisation isolation (org B untouched when org A migrates).
23. Source scan test: `pg_proc.prosrc` contains none of `stores`, `store_id`, `devices`, `nvr_secret_id`, `nvr_ip` outside the allow-listed compat/legacy functions; a smoke call of every function in the privileges list.
24. Code guard test (like T-1's grep test): `lib/`, `app/`, `components/`, `services/`, `scripts/` contain no `.from('stores')`, `.from('devices')`, `'store_id'`, `target_type', 'nvr'` outside an allow-list that disappears with the contract migration.

PostgREST and performance:
25. Embed smoke test: every embed string used by the app (`locations!inner`, `assets → locations` with the FK hint, `cameras → locations`) returns rows — catches renamed/ambiguous relationships that `tsc` cannot.
26. Extend `access-performance.test.ts` (VA-20): 300 locations × 27 cameras with 10 regions × 6 clusters, 2-3 recorders per location; viewers: region-wide, cluster-wide, recorder-only; medians under the same bound; assert index use for `cameras(location_id)`, mapping lookups and `locations(cluster_id)` via `EXPLAIN` (no seq scan on `camera_channel_mappings`/`locations` filter paths).
27. Concurrency: two admins move the same location / remap the same camera / archive and grant at once — no partial state, expected-version conflicts surface.
28. Worker (5b): round with two fake NVRs at one location, one down; discovery per recorder; playback and live resolve the right recorder; check-now covers the right recorders.

---

## 5. Risks, unknowns, and the recommended split

### 5.1 Risks (ordered)

1. **Silent runtime breakage** (biggest). Text-bodied SQL, PostgREST resource names, `onConflict` strings, `TARGET_TYPES`, `'nvr'` literals, `revalidatePath` strings and `any`-typed helpers are invisible to `tsc` and to Postgres at rename time. Mitigation: atomic M2 with a source scan + smoke call of every function (2.2 step 13), the embed smoke test (4.4-25), the code guard test (4.4-24), generated types, and the explicit lists in 1.6 / 3.x. Single most likely defect: a `'recorder'` result dropped by `cleanResults` (`supabase-db.ts:14`) or an RPC with the old `p_store` argument name.
2. **Overlap with in-flight and upcoming work**: migration 17 (same functions, untracked), T-1 (same files), P2-4 (new scope-evaluating functions that must use the new expanders), P2-3 fix round (uncommitted `lib/admin/access*.ts`). Order them strictly; re-scan (Appendix A); base 5a function bodies on the FINAL text of 17 and P2-4.
3. **Live database and Vault**: the owner's `next dev` uses the same local database (`db:reset` is forbidden on it; `migration up` only). Back up before running M2/M4. Vault rename is in place on the same row; verify hash equality; a failure in M4 step 3 must abort the organisation.
4. **Duplicate and shared NVR addresses** break a naive endpoint-uniqueness migration (D5-8) — real data (SD-WAN overlaps are an external unknown), the demo seed and the perf test already contain duplicates.
5. **Hierarchy-expansion correctness and the TS copies of the scope rules**: `lib/queries/access.ts:15-30`, `lib/auth/capabilities.ts:96-117`, `lib/admin/access-rules.ts:143-145` re-implement SQL rules; they must be fed by SQL-computed data (`covered_location_ids`, ancestry), not by copying the expansion into TypeScript again.
6. **History erasure paths**: `*_forget` delete triggers, `deleteStore`/`deleteDevice`/import hard deletes (`lib/inventory/stores.ts:45,83`, `devices.ts:53`, `lib/import/apply.ts:40`) and `cleanupOrg`/seed reset must all move to archive or the purge RPC, or one call erases `check_state`/`outages` again.
7. **Cache-column invariants** (`cameras.channel`, `recorder_id`, `location_id` vs the active mapping; `recorders.location_id` vs its asset): need triggers and tests; drift would silently mis-route recorder-scope access and playback.
8. **PostgREST relationship ambiguity** after `locations.uplink_asset_id → assets` and `locations.parent_location_id`: `assets → locations` and `locations → assets` become two relationships (PGRST201); every embed needs an FK hint (`lib/queries/inventory.ts:49`, `app/(app)/devices/page.tsx`).
9. **Column privilege gaps**: closed defaults mean new `locations` columns are unreadable by `authenticated` unless granted (pages would show nothing), while whole-table `assets` SELECT leaks new sensitive columns to IT viewers.
10. **Rollback realism**: enum values cannot be removed; data re-key is reversible only with `migrated_from_location_id`; old rollbacks run only after the new ones.
11. **Test rewrite volume** (~70 files, ~620 touched lines): do the fixtures first, then mechanical rewrites in one commit so the diff reviews as "rename only".
12. **Terminology/name collisions**: `lib/import/regions.ts` (zone/state normaliser) vs the new `regions`; `device` vs `asset`; `STORE_CONCURRENCY` env name; audit `entity_type 'store'` history.

### 5.2 Recommended split and exact boundaries

**P2-5a — schema, migration, access functions, mechanical compile fixes** (commits in this order)
1. M1 enum migration + rollback.
2. M2 atomic core + rollback (hierarchy, recorders/mappings, archive, scope kinds, ALL access/monitoring/credential functions, policies, views, privileges, compat seam, self-test) and `npm run db:types`.
3. M3 inventory extensions + rollback (address spaces/endpoints, network definitions with validation, dependencies, capability matrix seeds).
4. M4 data migration (`inventory_migrate_org`, report, history re-key, snapshot verification) + rollback; applied with `migration up`, never `db:reset`, on the dev DB.
5. Fixtures and DB acceptance tests: helpers (4.3), `locations-recorders.test.ts` (brief list), `hierarchy-access.test.ts`, `inventory-migration.test.ts`, VA-19/negative-rls/performance updates.
6. Mechanical application edits that the new types force: table/column/embed/RPC/enum names; the six `'nvr'` read sites (`lib/monitor/supabase-db.ts:14,93`, `lib/queries/status.ts:112,165,227`, `app/(app)/stores/[id]/page.tsx:55`, `app/(app)/admin/monitoring/page.tsx:57,131`, `app/(app)/home/page.tsx:32-33`); `discovery.ts:83` and `lib/inventory/stores.ts:14` conflict keys; `lib/security/org-scope.ts`; `lib/auth/capabilities.ts` + `resource.ts` + `lib/queries/access.ts` + `lib/admin/access*.ts` (new scope kinds; C-1 addendum names `coversCamera/coversLocation` here); `lib/import/regions.ts` rename; existing test suites updated.
Not in 5a: per-recorder worker/stream/discovery logic, admin screens, import redesign, Wi-Fi screens, URL/text renames (T-1).
Done when: migrations apply from empty and on the dev DB data, typecheck/lint/unit/integration green, `privilege_violations()` empty, equality tests pass, app and worker still run via the seam.

**P2-5b — code paths and contract**
Recorder-keyed worker (`types`, `supabase-db`, `checks`, `runner`, back-off/fingerprint/lane per recorder, `nvr_down` per recorder, config name), streams/playback/vod/source resolving the active mapping (host/ports/user/credential/offset fields), discovery per recorder with reconciliation list, `lib/queries/status.ts` / `inventory.ts` / `live.ts` / `groups.ts` per recorder, stores→locations module renames (`lib/inventory/stores.ts`), demo (`scripts/lib/demo.ts`, `seed-demo.ts`, `fake-nvr.ts` second NVR) and the multi-NVR end-to-end test (4.4-28), then **M5 contract migration** (drop legacy columns, sync trigger, wrappers, `'nvr'` type, `store_nvr_endpoints` leftovers, snapshot table) and removal of the allow-list in the code guard test.

**P2-5c — administration, import, Wi-Fi inventory UI**
Admin screens: locations (kinds, network definitions), regions and clusters tree editor (counts, who has access, archive, move with preview, zone→cluster proposal tool), recorders (add/edit/test connection, clock offset, write-only credentials via the Vault RPC), cameras (mapping editor with history), assets (new attributes, dependency picker, endpoints per address space, archive/restore), Wi-Fi inventory view (`wifi.inventory.view`), discover-all (LG-28), access-editor modes "A region / A cluster / NVR(s)" and presets, group dynamic-rule UI, CSV import for locations/recorders/cameras/assets/APs (legacy store CSV = location + primary recorder + channels), screenshots under `docs/drishti/evidence/p2-5/`, tracker rows AL-1..AL-7, WF-1..WF-4.

### 5.3 Unknowns to resolve early (cheap spikes)

* **Vault rename mechanics**: confirm on the pinned stack (Supabase CLI 2.111, Postgres 17) whether `vault.update_secret(id, new_secret := NULL, new_name := …)` keeps the ciphertext or whether a direct `UPDATE vault.secrets SET name = … WHERE id = …` as the migration owner is required; confirm the unique index on `vault.secrets.name`; confirm `vault.decrypted_secrets` is readable inside the migration to hash-verify. Never print values.
* **PostgREST cache**: whether `migration up` against the running local stack refreshes the cache for renamed tables and changed function signatures without a restart; keep `NOTIFY pgrst, 'reload schema'` regardless. Long-running `next dev`/worker processes need no restart (they hold no schema).
* **Generated types**: `npm run db:types` needs the running local stack; regenerate after M4 and commit; `types/database.ts` is currently modified by the other builder.
* **Performance at 300 locations × 8,000 cameras**: the VA-20 numbers (p2-1-report.md: org-wide camera count 6.5-15 ms, `store_status` 6-15 ms; a full scan with a hashed id set is fine to ~100k cameras) suggest no materialisation. Proposal: expansions via `= ANY(array)` on btree indexes `locations(cluster_id)`, `clusters(region_id)`, `cameras(location_id)`, `cameras(recorder_id)`, `camera_channel_mappings(recorder_id) WHERE valid_to IS NULL`, `assets(location_id)`; policy functions stay `STABLE` and are called as `(SELECT …)` so they run once per statement; per-id membership checks (`cameras_with_capability`, P2-4's 15-second batch for 300 sessions) use the ancestry join, not the expansion; `ANALYZE` after the data migration (stale statistics made `store_status` pick a nested loop at 117 ms in the P2-1 run). Only if the extended VA-20 shows a regression, add a per-person materialised cache invalidated through `access_version` bumps (hierarchy moves already bump it, D5-11); not recommended up front because of staleness risk.
* **Open product questions** (document the answer in the migration comments): recorder scope for `it.*` and "attached assets"; whether `location_status.nvr_status` worst-of is acceptable to P4-L3 reports; whether viewers may see a recorder's NAME (currently no); SD-WAN addressing (external dependency); whether a camera may ever move between locations (recommended: only via an explicit audited function); retention of archived recorders' secrets.

---

## Appendix A — re-scan commands (run before starting; they refresh every line number above)

* Database: `rg -n "\bstores\b|store_id|\bdevices\b|device_type|nvr_|'nvr'|expected_channels|rtsp_port|http_port" supabase/migrations supabase/rollback` and, after M2, the pg_proc scan of 2.2 step 13.
* Code, all areas: `rg -n "\bstores?\b|store_id|storeId|store_code|nvr_ip|nvr_username|nvr_secret_id|rtsp_port|http_port|expected_channels|'nvr'|nvr:|\bzone\b|'devices'|device_type|user_(store|zone|camera)_access|nvr_(store|read|delete)_credential|store_status|store_nvr_endpoints|capability_store_ids|it_view_store_ids|any_grant_store_ids" app lib components services scripts types public` (ignore `no-store`, `useSyncExternalStore`, `lib/jobs`, `lib/rate-limit.ts`, `lib/process-singleton.ts`, which use "store" in another sense).
* Tests: the same pattern over `tests/`, plus `rg -n "from\('(stores|cameras|devices)'\)" tests`.
* Silent-class checks: `rg -n "onConflict|target_type|TARGET_TYPES|revalidatePath|!inner|stores\(" app lib components scripts`.
* New since this document: `git log --oneline 121222b..HEAD`, `ls supabase/migrations`, P2-4/T-1 reports in `.superpowers/sdd/drishti/`.

## Appendix B — counts

* Database: 12 tables/columns families touched (+10 new tables), 11 constraints/indexes to rename or drop/add, 9 trigger families, 5 views (3 existing + 2 new), 11 policies + 5 column-grant sets, **≈ 38 functions rewritten or renamed, ≈ 45 reviewed and kept, ≈ 16 new**, 1 Vault naming scheme, 1 enum extension, 16 + 1 rollback files to keep consistent.
* Code (non-test): worker 9, streams 4, discovery/actions 3 (overlap), admin inventory/import 13, queries 5, access libs 9, pages 12, components 10, scripts 3, generated types 1, samples 2 ≈ **66 files** (≈ 40 are 5a-forced mechanical edits, ≈ 14 are 5b logic, ≈ 12 are 5c UI/admin).
* Tests: integration 35 files rewrite (+ 3 in flight), unit 28 files (11 of them recorder-job shape, 5b), 3 helper/setup files; new: 7 files, ≈ 28 acceptance scenarios listed in 4.4.
