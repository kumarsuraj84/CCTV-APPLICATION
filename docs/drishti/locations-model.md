# CityKart Drishti — locations, recorders and assets (P2-5a)

Status: database layer built in P2-5a (migrations `20261021000018`…`20261021000021`, rollbacks in `supabase/rollback/`). The application still runs on a transitional seam (section 7) until the P2-5b code paths and contract migration; the administration and import screens are P2-5c. Decisions: D-4, D-5 (schema), D5-1…D5-12 of `docs/drishti/p2-5-impact-map.md`, ruling C-1 (CONFIRMED), ruling R-1 and its amendment, the owner addition on switching monitoring off (2026-10-22). Access rules: `docs/drishti/access-model.md`.

## 1. The tree

```
Organization ─ Region ─ Cluster ─ Location ─ NVR (recorder) ─ Camera
                                     └──── IT assets (switch, AP, SD-WAN edge, UPS, printer, desktop, …)
```

- **Strict tree** (ruling C-1): a cluster is in at most one region, a location in at most one cluster, a camera on at most one NVR at a time.
- **Region and cluster are optional, permanently** (owner amendment to R-1): `clusters.region_id` and `locations.cluster_id` are nullable; no "Unassigned" rows are made and nothing warns. The UI shows "No cluster". Organisation, location, recorder, camera and asset scopes work for such a location; region and cluster scopes simply do not reach it.
- **Code and name.** `code` is the stable short code (upper case, e.g. `JCL`; unique among the organisation's non-archived rows); `name` is a freely editable display name. Renaming keeps the id, grants, groups and history. `zone` and `state` stay plain optional attributes of a location; `inventory_propose_hierarchy(org)` proposes cluster / region codes from them for an administrator to confirm (nothing is changed automatically).
- **Location kinds:** `store`, `head_office`, `dc`, `warehouse`, `other`. A head office or DC needs no NVR. Optional `parent_location_id`; `uplink_asset_id` (the SD-WAN edge, D-5) has no foreign key yet — a second locations↔assets relationship would make PostgREST embeds ambiguous (PGRST201); the key comes with hinted embeds in P2-5c.

## 2. Renames (ids unchanged)

`stores` → `locations`, `devices` → `assets`, `cameras.store_id` / `devices.store_id` / `profiles.store_id` → `location_id`. Done in place, so every id — and so every grant, camera group item, check_state / outage row and monitor gap — keeps pointing at the same row. No compatibility views (the impact map does not recommend them; every caller was updated). The enum type keeps its name `device_type`; P2-5a adds `sdwan_edge`, `switch`, `access_point`, `router`, `ups`, `printer`, `desktop`, `laptop` in its own migration (`20261021000018`, enum values must be committed before use).

## 3. Recorders and channel mappings

- **`recorders`** is a 1:1 extension of an `assets` row of type `nvr` with the **same id** (D5-2): `http_port`, `rtsp_port`, `username`, `secret_id` (Vault, name `recorder:<id>`; never readable by signed-in people), `expected_channels`, `clock_offset_sec` / `clock_offset_source`, `vendor_capabilities`, the monitoring switch (section 6), `migrated_from_location_id` and `created_asset`. A location may have several recorders; the **primary** one is the oldest (`recorder_primary_of(location)`).
- **`camera_channel_mappings (camera_id, recorder_id, channel, valid_from, valid_to)`** is the truth for "which NVR channel shows this camera". The two partial uniques of D-4 — one active mapping per camera, one active camera per recorder channel — plus no-overlap exclusions keep the history consistent. `cameras.recorder_id` and `cameras.channel` are a cache of the active row, kept by triggers. A camera may only map to a recorder at its own location (SQLSTATE `DR006`).
- **Camera identity is independent of the channel**: `UNIQUE (store_id, channel)` is gone. `camera_remap(org, camera, recorder, channel, at, actor)` closes the active mapping and opens a new one; the camera keeps its id, grants, group membership and monitoring history. Two NVRs at one location may both have channel 1.
- **Credentials:** `recorder_store_credential`, `recorder_read_credential`, `recorder_delete_credential` (service role), `recorder_credential_status(org, recorder)`. The old `nvr_store_credential(store)` / `nvr_read_credential` / `nvr_delete_credential` are thin wrappers keyed by the location's primary recorder (seam).

## 4. Addresses and the SD-WAN unknown

- **`address_spaces`**: one `global` space per organisation ("Company network", made by a trigger for every new organisation); `location_nat` spaces for a location whose addresses overlap others; `sdwan` / `other` reserved.
- **`asset_endpoints (asset, space, host, port, purpose, retired_at)`**: one live address (host + port, a missing port counting as one value) per space. This **replaces the organisation-wide `UNIQUE (org_id, ip, tcp_port)`** (AL-6): the address is an attribute, not the identity. Endpoints are kept in step with `assets.ip` / `tcp_port` (management) and the recorder's RTSP port by triggers.
- **External unknown (dependency 1):** whether the SD-WAN gives every location unique routed ranges or overlapping ranges behind NAT/VRF is not known yet. Until the network team answers, everything is in the one global space; the migration and the seam move a recorder into its location's own `location_nat` space only when its address is already taken in the global space (reported as `address_conflict`). When the answer comes, more spaces are modelled — no identity changes.
- **`network_definitions (location, management_cidr, gateway, dns[], management_vlan, vlan_map, discovery_ranges, sdwan_context)`**: validated on write (gateway inside the CIDR, VLAN ids 1–4094 and the staff/guest/device keys, discovery ranges inside the CIDR). `network_validate_address(org, asset, host)` answers `ok`, `outside_location_network`, `no_network_defined`, `not_an_address` or `no_location` — a head office CIDR never applies to a store. `network_address_conflicts(org)` lists every endpoint outside its location's network. Conflicts are flagged, never silently allowed (the screens of P2-5c show them).

## 5. Dependencies, capabilities and archive

- **`asset_dependencies (child, parent, kind ∈ network / power / recording)`**: the schema for D-5 (evaluation in WP-4.1). A cycle is refused (SQLSTATE `DR005`, checked under an advisory lock so two concurrent inserts cannot close a loop).
- **`device_capabilities`**: the vendor × model × firmware × operation matrix, seeded only with what `docs/drishti/wifi-capability-research.md` sources (NETGEAR WAX615/610/620/630, WBE750, WAX214, WAC510; each row has its `source_ref`); nothing is `lab_validated`; everything else is `unverified` by absence. Server only in P2-5a.
- **Archive instead of delete.** Regions, clusters, locations, assets (and so recorders), cameras and mappings have `archived_at`; a hard `DELETE` is refused (SQLSTATE `DR003`) except by `inventory_purge_test_org` for `test-…` and demo organisations. `inventory_archive(org, kind, id, actor)` / `inventory_restore(…)`: archiving closes the active mapping and an archived node grants nothing; restoring reopens the latest mapping. A recorder with active cameras cannot be archived (`DR004`). An archived location frees its code. The Vault secret is kept on archive and removed by the purge. **Deactivation keeps its tested meaning**: a location made inactive, an asset disabled or a camera deactivated still forgets its current state and closes its open outage; history rows stay (the old delete triggers that erased history are gone).

## 6. Switching monitoring off per NVR (owner addition, 2026-10-22)

`recorders.monitoring_enabled` (default **true**), `monitoring_disabled_reason`, `monitoring_disabled_at`, `monitoring_disabled_by`; a reason of at least 3 characters is required while off (table check). When off, **nothing contacts the NVR or its cameras**: the worker makes no NVR or camera probe for it and writes no check_state; discovery, opening live streams, opening playback and fast playback refuse with "Monitoring is switched off for this NVR." before any outbound request or password read. Tests prove zero sockets with a counting TCP server (`tests/integration/worker-run.test.ts`, `discovery.test.ts`, `open-streams.test.ts`, `playback-streams.test.ts`, `vod.test.ts`, `monitor-db.test.ts`). Switching on again resumes everything. Summaries and status views show **"Switched off"** (`location_status.cameras_monitoring_off` / `recorders_monitoring_off`, `recorder_status`, `getStates` status `off`). Only a super administrator, or an administrator holding `admin.inventory` organisation-wide, may change it (`recorder_set_monitoring`), audited. The owner authorised all real NVRs for local use (amendment to R-1); the importer of P2-5c sets the flag explicitly per NVR.

## 7. Transitional seam (ruling D5-7; removed by the P2-5b contract migration)

- The legacy NVR columns stay on `locations` (`nvr_ip`, `rtsp_port`, `http_port`, `nvr_username`, `expected_channels`; nullable, deprecated) with a **one-way sync** to the primary recorder (trigger `locations_seam` → `recorder_ensure_primary`; an `nvr` asset at the same address is adopted instead of making a second identity). `nvr_secret_id` is always NULL after the migration (the recorder owns the secret).
- `monitor_apply_results` still accepts `{type: 'nvr', id: <location>}` and writes `('recorder', <primary recorder>)`; `check_state` / `outages` accept both kinds.
- The app reads the primary recorder for NVR status and, for live, playback and the worker, uses only cameras on the primary recorder (cameras on another NVR are not opened through the wrong box until P2-5b resolves the recorder per camera). NVR recorder assets (`assets.is_recorder`) are not listed or probed as devices.

## 8. Data migration (`inventory_migrate_org`, report in `inventory_migration_report`)

Per organisation, idempotent: each location with an NVR gets its recorder (adopting an `nvr` device at the same address: `device_merged`), its Vault secret is **renamed in place** from `nvr:<location>` to `recorder:<id>` (`vault.update_secret` with a new name only — same ciphertext, verified by hash inside the transaction; never decrypted into any output), every camera gets a mapping on its location's NVR and channel, `check_state` / `outages` rows `('nvr', location)` are re-keyed to `('recorder', recorder)` (respecting the one-open-outage index), and the report lists `recorder_created`, `device_merged`, `address_conflict`, `secret_missing`, `secret_dangling`, `camera_unmapped` plus an `org_summary`. Before anything changes, `20261021000019` snapshots every person's effective sets with the **old** functions; `20261021000021` verifies against it and aborts on any difference: camera and location sets equal, asset sets equal except the NVR assets the migration made for locations the person already covered whole. `inventory_unmigrate_org` reverses one organisation (database owner only; used by the rollback and, through `inventory_unmigrate_org_test`, by the tests to build legacy-shaped data).

Local result (2026-10-22, `npx supabase migration up --local` on the owner's dev data after a data-only backup): the CityKart organisation got 1 recorder with its 31 cameras mapped and its secret renamed in place; the second local organisation's store got a recorder with 1 check_state and 1 outage re-keyed and no secret saved (`secret_missing`). Every effective set was unchanged.

## 9. Performance (VA-20, ruling C-1 size)

Throw-away organisation: 3 regions × 10 clusters, 300 locations (every fifth with 2 NVRs, every tenth with 3; 390 recorders), 8,100 cameras, 200 people with mixed organisation / region / cluster / location / recorder / camera grants (`tests/integration/access-performance.test.ts`, medians through PostgREST as the person, ms):

| Viewer | count cameras | list locations | one camera check | batch of 1000 | location status (before → after the fix) | summary |
|---|---|---|---|---|---|---|
| organisation | 14.0 | 4.5 | 2.3 | 6.1 | 103 → 12.5 | 2.7 |
| region | 10.4 | 4.2 | 2.3 | 5.3 | 99 → 9.0 | 4.0 |
| cluster | 7.8 | 3.7 | 2.2 | 5.5 | 97 → 7.0 | 4.6 |
| ten locations | 8.5 | 4.3 | 3.0 | 7.2 | 98 → 8.2 | 4.5 |
| three recorders | 7.3 | 3.7 | 2.2 | 5.3 | 97 → 6.9 | 3.8 |
| fifty cameras | 8.5 | 4.0 | 2.4 | 8.8 | 99 → 6.5 | 2.9 |

`EXPLAIN ANALYZE` as the signed-in person (`role authenticated` + JWT claims) found one hot spot: `location_status` computed the camera figures per location with a LATERAL that walked the whole visible-camera set (8,100) for each of the 300 locations (192 ms organisation-wide). It now groups the visible cameras once and joins by location: **192 → 13 ms** (organisation-wide), **29 → 9 ms** (region). Camera counts 6–8 ms, `has_capability_for` 0.7 ms, a 1000-camera batch 6 ms, `my_access_summary` 1 ms in SQL. Remaining sequential scans are on small tables (locations, recorders, check_state of one organisation) feeding hash joins; no further index was needed (new indexes: `cameras_location_idx`, `cameras_recorder_idx`, `recorders_location_idx`, the partial mapping indexes, `access_grants_region_idx` / `_cluster_idx` / `_recorder_idx`, `locations_cluster_idx`, `clusters_region_idx`). The full plans are kept with the P2-5a report; the test prints the medians as one `access_perf` JSON line on every run.

## 10. Rollback

`supabase/rollback/20261021000021…` (unmigrate every organisation: recorders of the migration removed, secrets renamed back to `nvr:<location>`, history re-keyed back), then `…20` (network definitions, dependencies, capability matrix), then `…19` (old tables, functions, policies, views and triggers verbatim from the pre-migration schema; it refuses while recorders, region / cluster / recorder grants, archived rows, locations without an NVR or assets without an address exist), `…18` is a no-op (enum values cannot be dropped). Dry-run in one rolled-back transaction: the schema's functions, tables, views, policies, triggers, keys and indexes equal the pre-migration dump, `privilege_violations()` is empty, and the forward migrations then apply again with the equality check passing.
