# CityKart Drishti — Rework Plan Proposal (section 9)

Date: 2026-10-22. Basis: `docs/audit/INITIAL-AUDIT.md` (facts, sections 1-8; requirement IDs such as AC-6, MC-4 are defined there in section 6) and `docs/drishti/REQUIREMENTS-DIRECTIVE.md`.
This is a proposal. It changes no code. Decisions marked **Owner decision** need a yes/no from the product owner; everything else follows the directive and can proceed as routine.

---

## 9.1 Principles

1. **Continue, do not restart.** Plans 1-3 are kept. Pre-directive behaviour is replaced by forward migrations and code changes with tests, not by rewriting history.
2. **Forward migrations only** (`20261021000008` onward, each with a rollback). Nothing is deployed, so editing old migrations would be allowed, but the directive asks to "migrate existing data without silently losing grants, camera identities or monitoring history". Forward migrations make that migration itself testable.
3. **Security corrections come before new features**: the access model, revocation and credential exposure (phase 2) come before alerts, agents and fleet work.
4. **Every directive line has a test or an explicit "external dependency" note.** No mock success.
5. **One branch per phase**, stacked locally, never pushed (directive "Development and validation").

---

## 9.2 Branch and plan disposition

### Branches

| Branch | Disposition |
|---|---|
| `feat/plan-1-foundation`, `feat/plan-2-monitoring` | **Keep** as they are (history). Do not rebase. |
| `feat/plan-3-live-feeds` | **Finish and freeze.** Task 8 (fast playback) was committed during the audit (`3fc5c1f`) with camera visibility as its only check. Add one interim change: `/api/vod` returns a savable `video/mp4`, so until phase 2 it should be limited to administrators. Do Task 9 (wire-up/docs). Commit, then freeze. Update the stale status in `docs/ARCHITECTURE-AND-DESIGN-FOR-REVIEW.md` §6.4/§10 (playback screen is built). |
| New `feat/drishti-p2-access-location` | Branch from the frozen plan-3 tip, for phase 2. Later phases branch from the phase before. |

### Existing plan documents

| Plan | Disposition | What changes |
|---|---|---|
| Plan 1 (foundation) | **Kept** (built) | Access functions, grant tables, the `agent` role, the home-store grant and the manager-sees-all rule are replaced in phase 2 |
| Plan 2 (monitoring) | **Kept** (built) | State machine, worker guard and NVR keying change in phases 2 and 4 (recorders, lease/fencing, observation states) |
| Plan 3 (live feeds) | **Kept**; Task 8 re-gated; Task 9 done before the freeze | Stream/playback/VOD permission checks, the session registry and recorder lookup change in phase 2 |
| Plan 4 (alerts, reports, backup, hardening) | **Revise and split** | Hardening (CSP, column grants, search_path, rate limits, admin limits) moves **forward** into phases 2-3. Alerts are rebuilt on the observation and incident model (phase 5) with acknowledgement, escalation, maintenance and a dev sink. "NVR backup" becomes **scheduled evidence backup**, kept separate from **user clip exports** (phase 4). `system_log` becomes durable audit with external checkpoints (phase 5). Deployment material goes to phase 5 |
| Plan 5 (remote screen) | **Revise** (phase 7) | Separate `it.remote_view` and `it.remote_control` permissions instead of `profiles.remote_access`; sessions in the shared session registry (≤60 s revocation); a controlled migration to rotate VNC passwords; RDP files labelled "no Drishti-enforced controls" |
| Plan 6 (agent and fleet) | **Rewrite and split** | Phase 6 is a read-only agent: enrolment with a key pair on the device, inventory and health, no commands. Phase 7 is controlled fleet work: a command-signing authority with public keys (replacing HMAC with the token hash), a journal, leases, reconciliation, re-checking queued commands, supersession, approval of the exact payload, canaries, batches, failure-stop and rollback. Windows LAPS for joined machines. `enable_admin_account` is no longer a default fleet action |
| Plan 7 (Windows deployment) | **Keep design, defer** (phase 8, lab only) | Split in-place repair from clean install; add the lab validation checklist; destructive steps stay off outside the validated pilot |
| Plan 8 (extras) | **Distribute** | SNMP read-only checks go to phase 5 (topology, UPS, printer, switch). Regional outage correlation is **replaced** by the parent-dependency model (phase 4). Wake-on-LAN and recurring commands go to phase 7. Security posture: read-only in phase 6, "fix" actions in phase 7. Ticket hand-off is optional in phase 5 |

---

## 9.3 Key design decisions (with recommendations)

### D-1 Permission model shape (AC-1…AC-8, AC-11, AC-12)

**Recommendation:** org roles × capabilities × scopes. Grants are explicit and only add access. Nothing narrows silently.

- `user_role` enum stays for **administrative authority only**: who may manage users, grants, inventory and settings. Values: `user`, `operator` (renamed from `agent`, see D-16), `manager`, `admin`, `platform_owner`. No role gives data access by itself. `manager` loses `is_staff_all`.
- `capabilities` catalogue (seeded, read-only), grouped:
  - CCTV: `cctv.live`, `cctv.playback` (search, calendar, timeline, playback), `cctv.export`.
  - IT: `it.inventory.view`, `it.monitoring.view`, `it.monitoring.operate` (check now, maintenance), `it.remote.view`, `it.remote.control`, `it.diagnostics`, `it.script.run`, `it.software.manage`, `it.config.deploy`, `it.patch.manage`, `it.credentials.admin`, `it.os.deploy`.
  - Admin: `admin.users`, `admin.access`, `admin.inventory`, `admin.alerts`, `admin.audit.read`.
  - Each entry has `risk` and `requires_mfa`.
- `access_grants` (append-only history): `id, org_id, user_id, capability, scope_kind ∈ {organization, location, camera, asset}, scope_id, valid_from, valid_until null, granted_by, granted_at, reason, revoked_at, revoked_by, revoke_reason, source ∈ {manual, migrated:*}`. Index `(user_id, capability) WHERE revoked_at IS NULL`.
- **Assignment modes** (the five directive cases): a `location` scope means "all cameras (or assets) in that location, including ones added later". A `camera` or `asset` scope means "exactly this item". Several locations means several grants. Different live, playback and export rights for the same coverage means one grant per capability. An admin UI preset ("Store CCTV viewer = live + playback for the chosen stores") expands into explicit grants. It is never a runtime role.
- **Overlap rule:** effective access for a capability is the **union** of active grants. There is no deny and no narrowing. To narrow, the admin revokes the location grant and adds camera grants, and the preview shows the result.
- **Zones:** the migration converts existing zone grants into per-location grants (exact current access). A dynamic "region" scope is added later only if the owner asks for it.
- **Home store** (`profiles.store_id`) becomes an informational `home_location_id` and grants nothing (AC-7).
- **Effective-access functions** (STABLE, SECURITY DEFINER, `SET search_path = ''`, qualified names):
  - `has_capability(cap, kind, id) → boolean`
  - `capability_camera_ids(cap)`, `capability_asset_ids(cap)`, `capability_location_ids(cap)`
  - `any_cctv_camera_ids()`, used for camera **metadata** row visibility.
  - Every one checks `is_active`, `NOT must_reset_password`, `valid_from ≤ now() < coalesce(valid_until, 'infinity')`, `revoked_at IS NULL` and, for `requires_mfa` capabilities, `auth.jwt()->>'aal' = 'aal2'`.
- **RLS:**
  - cameras: visible through `any_cctv_camera_ids()`.
  - devices/assets: visible only through `it.inventory.view` or `it.monitoring.view`. A CCTV grant never reveals IT devices (AC-4, VA-4).
  - stores/locations: a location is visible if the person holds any grant inside it, but its columns are restricted (D-14).
  - check_state and outages: per target type with the matching capability.
  - camera groups: name visible only if at least one member is visible to the reader. The creator gets no exception once they lose access. Duplicate-name errors become generic.
- **Effective-access preview (AC-9):** `preview_access_change(p_user, p_changes jsonb)` returns the per-capability added and removed counts and the first N items. The UI shows them before saving. Saving checks an `expected_version` to prevent lost updates.

### D-2 Migration of existing grants (AC-6, AC-7, AL-7)

**Recommendation:** keep each person's current **CCTV** access exactly, but make it explicit. Write an `access_migration_report` table for review.

| Today | Migrated to |
|---|---|
| store grant, no camera grants in that store | `cctv.live` + `cctv.playback` at location scope (reason `migrated:store`) |
| store/zone/home grant **plus** camera grants in that store (narrowed today) | camera-scope grants for exactly those cameras, so access does not grow |
| zone grant | location grants for the stores currently in the zone |
| camera grants | camera-scope `cctv.live` + `cctv.playback` |
| IT device visibility gained through a store grant | **not migrated** (directive); each affected person is listed in the report |
| export | nobody, because it did not exist |

**Owner decision (D-2a):** for home-store access and manager-wide access, either (a) migrate to explicit grants flagged for review (recommended: nobody loses access silently, and the access becomes visible and revocable), or (b) drop them, with the report listing who lost access.

### D-3 Active-session revocation ≤ 60 s (AC-14, VA-6)

**Recommendation:** a session registry in the database, checked by the gateway at connect and every 15 s. If the database cannot be reached for 45 s, the gateway closes the sessions (fails closed).

- `media_sessions (id, org_id, user_id, kind ∈ {live, playback, vod, export_download, remote_view, remote_control}, camera_id/asset_id, capability, created_at, connect_by, expires_at, revoked_at, revoke_reason, last_validated_at, closed_at)`.
- Opening a stream checks the capability, inserts a session and signs a token `{sid, u, c, k, exp}`. The connect window drops from 10 min to 90 s.
- Gateway at connect: `media_session_open(sid)` checks the session and recomputes `has_capability`. Every 15 s: `media_sessions_still_valid(sid[])` (one batched call). Invalid sessions close with code 4403 "Access changed".
- Admin actions that change access (deactivation, grant revocation or expiry, role change, password reset) also set `revoked_at` on that person's open sessions at once. Grant expiry is caught by the periodic check.
- The VOD route and the export download use the same session and a timer inside the response stream. Plan 5's VNC uses the same registry.
- Worst case: 15 s poll + 5 s RPC timeout = 20 s, well inside 60 s. A test (fake go2rtc, real local DB) revokes a grant while a socket is open and expects the socket to close within 25 s. A second test stops the DB and expects closure within 60 s.
- Why polling: the app and gateway reach the DB only through PostgREST, and Realtime is excluded from the local stack. A 15 s batched poll is cheap: 300 sockets means one RPC every 15 s.

### D-4 Location, NVR (recorder) and channel schema (AL-1…AL-7)

**Recommendation:** rename in place so ids stay the same, and make recorders explicit.

- `stores` → `locations`: add `kind ∈ {store, head_office, dc, warehouse, other}`. The NVR columns become nullable and are then dropped after they move. Ids are unchanged (grants, cameras and history keep working).
- `devices` → `assets` (ids unchanged): add `serial, mac, model, vendor, firmware, owner, criticality, lifecycle_state, warranty_until, last_inventory_at, parent_asset_id`. Extend `asset_type` with `sdwan_edge, switch, access_point, ups, printer, desktop, laptop`, keeping `nvr`.
- `recorders` (1:1 extension of an asset with type `nvr`): `http_port, rtsp_port, username, secret_id` (Vault name `recorder:<id>`), `clock_offset_sec`, `clock_offset_source ∈ {measured, manual}`, `vendor_capabilities jsonb`, `expected_channels`.
- `camera_channel_mappings (camera_id, recorder_id, channel, valid_from, valid_to)`:
  - unique `(recorder_id, channel) WHERE valid_to IS NULL`
  - unique `(camera_id) WHERE valid_to IS NULL`
  - The `cameras` unique `(store_id, channel)` constraint is dropped. A camera's identity no longer depends on its channel, so remapping keeps grants, groups and history.
- `address_spaces (id, org_id, name, kind ∈ {global, location_nat, vrf}, location_id)` and `asset_endpoints (asset_id, address_space_id, host, port, protocol, purpose)`:
  - unique `(org_id, address_space_id, host, port)`
  - Until the SD-WAN answer is known (external dependency), every endpoint sits in one `global` space, which keeps today's uniqueness.
- **Data migration**, one transaction per org, with tests:
  1. Each store with an NVR gets an asset and a recorder.
  2. Its Vault pointer moves to the recorder (the secret is renamed, not re-encrypted).
  3. Each camera gets a mapping `(store, channel) → recorder`.
  4. `check_state`/`outages` rows of type `nvr` are re-keyed to `recorder`/recorder id.
  5. `nvr`-type devices with the same IP as the store NVR are merged.
  6. Delete triggers change to soft delete and archive, so history is never removed.
- **Code paths to update:** every path in INITIAL-AUDIT §5.1 (worker jobs per recorder, streams and playback through the mapping, discovery per recorder, admin recorder screens). CSV import keeps the legacy columns as the "primary recorder".

### D-5 Parent dependency model (AL-4, MC-3…MC-5)

**Recommendation:** `asset_dependencies (child_asset_id, parent_asset_id, kind ∈ {network, power, recording})` plus `locations.uplink_asset_id` (the SD-WAN edge or a designated "location sentinel" target).

- Cameras depend on their recorder through the mapping.
- The worker evaluates in order: location uplink → switch → recorder/endpoint → cameras.
- When a parent is `failed` or `unreachable`, child results are stored as **observations** with state `unknown_parent`. No child outage opens. A correlated incident is raised on the parent, and child observations are kept.

### D-6 Exports, fast playback and evidence backup (CC-4, CC-11…CC-14)

**Recommendation:**

- **User clip export** is a job (`export_jobs`) produced by the media service (D-14), not by the web process. It needs `cctv.export` and fresh authentication.
  - The file goes to a quarantine folder with SHA-256, size and a per-user and per-org quota.
  - It expires after 7 days by default. Downloads use a short-lived link bound to that user and job, with a maximum download count and a session (D-3).
  - Every request, creation, download and deletion is audited. A cleanup job runs in the worker.
- **Scheduled evidence backup** (formerly Plan 4 "NVR backup") is a separate admin feature with its own retention and legal-hold flag. It is never available to viewers.
- **Fast playback** (Task 8 `/api/vod`) returns a savable MP4, so **Owner decision (D-6a):**
  - (a) require `cctv.export` for 2×/4×/8× (recommended), or
  - (b) treat it as playback but deliver it through the gateway/MSE path instead of a plain URL.
  - Until phase 2 lands: administrators only.

### D-7 Observation-state model (MC-3, MC-4, MC-6, MC-13, CC-16)

**Recommendation:**

- `check_state.state` (replacing up/down/unknown) is one of:
  - `healthy`, `degraded`
  - `failed`: confirmed by positive evidence, e.g. the NVR reports the channel offline, a service is stopped, or the agent reports an error
  - `unreachable`: the head-office probe failed and nothing shows the parent is at fault
  - `unknown_parent`
  - `maintenance`: from `maintenance_windows`
  - `unsupported`, `not_checked`
  - `stale` is computed when read: no fresh result inside the freshness window.
- `evidence jsonb` (method, source asset, raw result).
- Per camera, separate facets: **reachability**, **stream availability** (RTSP/decode) and **recording health** (NVR record status/HDD), each with its own state.
- `outages` becomes `incidents (kind ∈ {failure, unreachable}, parent_incident_id, cause_asset_id)`.
- `targets_uptime` is replaced by `targets_availability` returning `up_s, down_s, unknown_s` (parent, maintenance, stale, gap) and `coverage_pct`. The UI shows **availability over observed time** and **coverage** separately. Unknown time never counts as healthy or as down.
- `monitor_gaps` gets `source` (worker or lease id) and optional `location_id`, so a location unreachable from head office is recorded as a coverage gap, not as downtime.

### D-8 Worker lease and fencing (SO-14)

**Recommendation:**

- `worker_leases (name, holder uuid, lease_until, fencing_token bigint)` with `worker_acquire_lease(name, holder, ttl_sec)` as one atomic `UPDATE … WHERE lease_until < now() OR holder = p_holder`. A takeover increments the token. Renewal happens every 5 s with a TTL of 20 s.
- `monitor_apply_results` (and every worker write RPC) takes `p_fencing_token` and rejects a stale one.
- SQL guard: a result with `at < last_checked_at` is skipped (closes the per-process-only gap).
- `check_requested_at` moves to a per-org `monitor_requests` row.
- Later: one lease per shard (location hash) for horizontal scale.
- Tests: two workers started together, so exactly one holds the lease. A paused worker that resumes after takeover has its writes rejected.

### D-9 Command-signing authority (EA-4…EA-6, RM-7)

**Recommendation:** asymmetric signatures from a separate signer process. Device credentials are separate keys.

- **Algorithm:** ECDSA P-256 / SHA-256. PowerShell 5.1 runs on .NET Framework 4.x, which has ECDsaCng and RSACng but **no Ed25519**. If the agent later becomes a compiled .NET 8 service, Ed25519 is possible.
- **Signer:** a separate Windows service with its key in the CNG key storage provider, non-exportable, ideally TPM-backed. A root key held offline signs rotating signer certificates. Agents pin the root public key at enrolment.
- **What the signer checks before signing**, from the DB:
  - a requester with the capability and fresh MFA
  - approvals by distinct approvers, each referencing the **payload hash**
  - the current policy version
  - the target device enrolled and not revoked
- **Envelope:** `{cmd_id, device_id, job_id, action, artifact {kind, id, version, sha256}, params_canonical_sha256, params, not_before, expires_at, policy_version, approval_ids, nonce, signer_key_id}`.
- **Device identity:** a per-device ECDSA key pair generated on the device (machine key store, ACL SYSTEM). The server stores only the public key. Check-ins are signed or use mTLS. Stolen device credentials cannot sign commands or approve.
- **Agent:** verifies signer chain, device id, expiry, local policy (allowed actions) and replay (local journal of `cmd_id`).

### D-10 MFA and fresh authentication (SO-1)

**Recommendation:**

- Enable GoTrue TOTP (`[auth.mfa.totp] enroll_enabled = true, verify_enabled = true`). TOTP works on the local/self-hosted stack.
- MFA is required for `admin`, `platform_owner` and any `requires_mfa` capability (IT actions, `cctv.export`, `admin.*`). It is enforced in two places: in SQL (D-1 functions check `aal2`) and in Server Actions (`requireAal2()`).
- **Fresh authentication:** `requireFreshAuth(600)` reads the JWT `amr` timestamps on the server. Sensitive actions require a TOTP re-verify within 10 min: grant changes, credential reveal, exports, remote control, fleet approval.
- **Recovery:** an admin can reset a factor (audited, needs the actor's own fresh auth). A second enrolled factor is recommended for administrators.
- **Owner decision (D-10a):** apply MFA to CCTV-only viewers too (recommended: optional, not required).

### D-11 Shared rate limiting (SO-7)

**Recommendation:**

- `rate_limit_hit(key, limit, window_sec) → boolean` (service-only RPC, atomic upsert on `(key, window_start)`). The worker prunes it.
- Used by sign-in, password reset, admin actions and import (none of these have limits today), stream and playback opening, VOD and exports, and agent enrolment and check-in.
- In-process limiters stay as a cheap first filter.
- Sign-in changes from a hard 15-min lockout per e-mail to rising delays keyed by e-mail and IP, with `TRUSTED_PROXY_HOPS` documented. This removes the lockout denial of service noted in the carry-over.

### D-12 Strict CSP compatible with the player (SO-8)

**Recommendation:** a per-request nonce set in `proxy.ts`, following `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md` (Next 16: Proxy, dynamic rendering).

- **Vendor the pinned go2rtc 1.9.9 player scripts** (`video-stream.js`, `video-rtc.js`) into the app origin with an SRI hash. Then `script-src` needs no cross-origin host: `'self' 'nonce-…' 'strict-dynamic'`. The gateway then serves video sockets only (its script endpoints and CORS can be removed).
- Remaining directives:
  - `connect-src 'self' wss://<gateway>`
  - `media-src 'self' blob:`
  - `worker-src blob:`
  - `img-src 'self' data: blob:`
  - `style-src 'self' 'nonce-…'`, plus `style-src-attr 'unsafe-inline'` for React `style` props such as the timeline offsets
  - `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`
  - a report endpoint.
- Tests: header present on every page, and the player works in a real browser under the CSP (phase 3 visual QA).

### D-13 go2rtc hardening (SO-9, SO-10)

**Recommendation:**

- **Listeners:**
  - remove the WebRTC listener (`webrtc: listen: ""`) and its loopback port publishing, since it is unused
  - keep `rtsp: listen: ""` in production and the demo RTSP only in the demo override
  - explicitly disable `srtp`, `rtmp`, `homekit`, `hass` and any module the pinned version enables by default
  - verify by reading `GET /api/config` and the container's listening sockets in an integration test
- **API:** keep the loopback publish. Add go2rtc API credentials from a dedicated secret (server to loopback only; record this as an accepted exception to ruling R6, which is about NVRs). Restrict API paths if 1.9.9 supports it, otherwise front it with the media service only.
- **Sources:** the only registrar (the media service) may register only `rtsp://` sources whose host:port is a **registered recorder endpoint**, plus the demo `ffmpeg:virtual` in dev. Never `ffmpeg:`-wrapped arbitrary inputs, `exec:` or `echo:`.
- **Separation:** go2rtc and ffmpeg run in the media service, separate from fleet execution (no shared credentials and no shared host process).

### D-14 Least-privilege service separation and credential broker (SO-2, SO-3, AC-10)

**Recommendation:**

- Use PostgREST role switching with service-specific JWTs (custom `role` claim) instead of the single `service_role` key in every process:

  | Role | May do |
  |---|---|
  | `app_web` | no Vault; writes through narrow RPCs |
  | `monitor_worker` | read recorder credentials for monitoring; write observations |
  | `media_service` | read recorder credentials for video; manage `media_sessions` and `export_jobs` |
  | `video_gateway` | EXECUTE only on `media_session_open`/`_still_valid` |
  | `fleet_service` | phase 7 |

  Each Vault read function logs the read.
- **Credential exposure fix:** recorder address, username and secret id move to `recorders`, which has no grant for `authenticated` at all. `cameras.camera_ip` and asset endpoints are readable only with an IT capability (column privileges or a separate table). `open.ts`/`playback.ts` stop reading NVR columns through the RLS client.
- `SET search_path = ''` on every SECURITY DEFINER function.
- Extend `privilege_violations()` to cover function EXECUTE grants, sequences and the global function default ACL.
- **Owner decision (D-14a):** accept the added operational complexity of per-service roles (recommended), or keep one service key but split credential reads into a broker process.

### D-15 Durable audit and tamper evidence (SO-11, CC-11)

**Recommendation:**

- `audit_events` is append-only: no UPDATE/DELETE grant to any runtime role, a per-org hash chain, insert through one RPC. It covers grants, sign-ins, MFA, video sessions (open/close/revoke), searches, exports, credential reads and admin changes. Tokens and credentials are never stored.
- **Checkpoint job:** every hour the worker writes the chain head (signed) **outside the database**: a file on separate storage and the Windows Event Log of the hub host. A verifier tool re-walks the chain.
- An audit write failure fails the sensitive action ("fail closed") for exports, grants and fleet actions. Elsewhere it is logged.

### D-16 Rename `agent` → `operator` (AC-15)

**Recommendation:** `ALTER TYPE public.user_role RENAME VALUE 'agent' TO 'operator'` in the first phase-2 migration. It keeps rows and needs no data copy. Update `lib/admin/roles.ts`, UI maps, seed (`demo.operator`), `types/database.ts` and the 17 files listed in INITIAL-AUDIT §4.9. Done before Plan 6's endpoint "agent" appears.

### D-17 Time handling (CC-7, CC-8)

**Recommendation:**

- Per-recorder `clock_offset_sec`, measured through ISAPI system time each monitoring round (drift becomes a monitoring check, MC-7), with a manual override. It replaces the global `PLAYBACK_OFFSET_MIN`.
- Replace the internal "shown time" (fake-UTC holding the IST wall clock) with true UTC instants. Convert only at the recorder boundary (UTC → NVR local using the recorder's time zone and offset) and at display (IST).
- Tests for recordings crossing midnight in IST, and for offsets of ±5 min and ±1 h.
- This is a larger playback refactor. Schedule it in phase 4.

### D-18 Design system (BR-1…BR-4)

**Recommendation:**

- Inspect the reference in `D:\ANKUR AI PROJECTS\Asset Management\.claude\worktrees\brave-euler-07879a\frontend\` (`design-tokens/tokens.json`, `src/components/ui/*`, auth pages). If it can be served from `release-packages/*/frontend-dist`, render it locally for screenshots.
- Map the tokens onto Tailwind 4 CSS variables in `app/globals.css`. Reuse the visual patterns only (no business logic, auth or secrets).
- If the reference cannot be rendered, document that limitation, use a consistent provisional light theme and record the single missing item, as the directive says.

---

## 9.4 Sequenced implementation plan (directive order)

Sizes: S ≤ 1 day, M 2-4 days, L 1-2 weeks of agent-driven work, including tests and reviews.

### Phase 1 — Audit and design (this document plus the items below)

| WP | Content | Size |
|---|---|---|
| WP-1.1 | Initial audit | done |
| WP-1.2 | Freeze plan-3: interim admin-only gate on the committed `/api/vod` (Task 8, `3fc5c1f`); Task 9; architecture-doc status fixes; commit | S |
| WP-1.3 | Asset Management design inspection report (tokens, shell, auth pages, form-field contrast, screenshots, or a documented limitation). A parallel session has started this as `docs/design/ASSET-MANAGEMENT-DESIGN-REFERENCE.md` with `reference-screenshots/`; review it against D-18 | S-M, can run in parallel |
| WP-1.4 | ADRs for D-1…D-18 (`docs/drishti/adr/`) with owner decisions D-2a, D-6a, D-10a, D-14a recorded | S |
| WP-1.5 | Directive acceptance tests written first and marked `todo`/failing: VA-2…VA-7 (playback denied with live only; export denied; store-grant CCTV user sees no devices; no narrowing; home store gives nothing; manager without grants sees nothing; multiple NVRs per location; revocation closes a socket within 25 s; parent-unknown camera not counted as failed) | S |

### Phase 2 — Permissions, location/NVR model, session revocation (plus pulled-forward hardening)

| WP | Content | Size |
|---|---|---|
| WP-2.1 Access model | Migration: capabilities, `access_grants`, effective-access functions, RLS rewrite, `agent`→`operator`, removal of home-store/manager rules, migration report (D-1, D-2, D-16). Server enforcement of the specific capability in every CCTV operation (open live, refresh, calendar, segments, playback, `/api/vod`, later thumbnails/exports). IT data visible only with IT capabilities (devices page, store detail, dashboard, status). Group metadata filtering. Admin UI: assignment modes, expiry, revocation, effective-access preview. Tests replacing the old-behaviour assertions (INITIAL-AUDIT §3.9) | L |
| WP-2.2 Session revocation | `media_sessions`, sid tokens with a 90 s connect window, gateway open/periodic check with fail-closed, revocation hooks in user and grant admin, VOD timer, timing tests (D-3) | M |
| WP-2.3 Location/recorder model | `locations.kind`, `assets`, `recorders`, `camera_channel_mappings`, `address_spaces`/`asset_endpoints`, history re-keying, soft delete, all code paths in INITIAL-AUDIT §5.1, admin recorder screens, CSV compatibility, multi-NVR tests (D-4) | L |
| WP-2.4 Credential and SQL hardening | Credential columns removed from RLS-readable tables (D-14 exposure fix), `search_path = ''`, extended `privilege_violations()`, outbound target restriction (only registered endpoints are probed or streamed; refuse loopback/link-local outside demo) (SO-3, SO-4) | M |
| WP-2.5 Worker lease/fencing | D-8, together with the recorder-keyed worker changes in WP-2.3 | M |

### Phase 3 — Application shell, authentication, logo, MFA, CSP

| WP | Content | Size |
|---|---|---|
| WP-3.1 | Design tokens and shell from WP-1.3; navigation by capability; product name "CityKart Drishti" / "CKDRISHTI" (`lib/brand.ts`, metadata, package name optional) | M |
| WP-3.2 | Auth pages (login, forgot, reset, change password) with the full transparent logo (aspect ratio kept, no crop), visible labelled fields, focus rings, error and empty states; compact mark for the nav and favicon (check the 32/64 px edge clipping) | M |
| WP-3.3 | MFA enrolment and challenge UI, `aal2` enforcement, `requireFreshAuth` (D-10) | M |
| WP-3.4 | Nonce CSP, vendored player scripts, header tests (D-12) | S-M |
| WP-3.5 | Visual QA: screenshots of every page incl. auth and error states at 1366×768, 1920×1080 and 2560×1440/3840×2160 (control room), contrast check, logo rendering on light and dark backgrounds | S |

### Phase 4 — Complete CCTV and core monitoring

| WP | Content | Size |
|---|---|---|
| WP-4.1 | Observation-state model, facets (reachability/stream/recording), parent dependencies, incidents, availability plus coverage, maintenance windows, UI states (D-5, D-7) | L |
| WP-4.2 | Control-centre overview (affected locations, outages, recording failures, degraded cameras, critical IT problems, coverage/stale, incidents awaiting action, recoveries and changes) and investigation views with filter preservation | L |
| WP-4.3 | CCTV completion: per-recorder offsets and UTC refactor (D-17); unavailable intervals on the timeline; DB-shared concurrency caps per user, recorder and org; media service separation (go2rtc registration plus ffmpeg out of the web process) and go2rtc hardening (D-13); export jobs, expiring downloads, retention, quotas (D-6); audit of sessions, searches and exports (D-15 subset) | L |
| WP-4.4 | Browser and codec matrix: H.264 and H.265 sub/main, MSE/MP4/MJPEG fallbacks on Chrome, Edge, Firefox, Safari/iOS, with go2rtc transcoding decisions recorded; resource cleanup tests (hidden tabs, abandoned sockets, go2rtc producer counts) | M |

### Phase 5 — Alerts, recording health, topology, operational readiness

| WP | Content | Size |
|---|---|---|
| WP-5.1 | Alerts on incidents: channels (e-mail, Teams, webhook, WhatsApp adapter if infrastructure exists), **dev sink** (no external sends in development), deduplication, parent suppression, maintenance suppression, acknowledgement, escalation, recovery | L |
| WP-5.2 | Recording health: ISAPI HDD/storage status, record status, recording gaps, retention estimate, clock drift; "unsupported" where firmware lacks the endpoint | M |
| WP-5.3 | Topology checks: SD-WAN edge reachability, latency and loss (and tunnels/failover through the vendor API if available); SNMP read-only for switch/AP/PoE/UPS/printer; attendance and footfall data freshness through available integrations | L |
| WP-5.4 | Operational readiness: durable audit and checkpoints (D-15), health/visibility pages for worker leases, queues, gateway sessions and DB; shared rate limiting (D-11) if not done in phase 2/3; TLS (HTTPS/WSS) for app and gateway; backup and restore runbook **tested** including the Vault/pgsodium root key and configuration; deployment packaging (tsx out of production) | L |

### Phase 6 — Read-only endpoint agent and inventory

| WP | Content | Size |
|---|---|---|
| WP-6.1 | Enrolment (limited-use token, then a device key pair, the server keeps the public key), rotation, revocation, upgrade channel design; local credential protection | M |
| WP-6.2 | Collection (computer name, serial, hardware; edition/version/build, join state; installed applications; CPU, RAM, disks, uptime, services; security/update status, pending reboot) and ingest with health rules; inventory and posture views gated by `it.inventory.view`/`it.monitoring.view` | L |
| WP-6.3 | WinRM/SSH/SNMP/vendor adapter interface (read-only), for where agents are not installable | M |

### Phase 7 — Controlled remote support and fleet changes

| WP | Content | Size |
|---|---|---|
| WP-7.1 | Signing authority and envelope (D-9), agent verification, local journal | L |
| WP-7.2 | Job lifecycle: leases, acknowledgements, reconciliation (no blind rerun), revalidation of queued commands when a PC returns, supersession, action-specific expiry, maintenance windows, approvals bound to the payload hash, canaries, bounded batches, pause/cancel, failure-stop thresholds, rollback/recovery per action, result verification | L |
| WP-7.3 | Actions in stages: approved scripts, software install/uninstall, wallpaper and screensaver (per-user settings correct under SYSTEM), patch management; Windows LAPS for eligible joined devices; a separate workgroup password design; no default "enable local admin" | L |
| WP-7.4 | Remote screen: VNC through the gateway with `it.remote.view` / `it.remote.control` enforced in the protocol path, the shared session registry, a controlled VNC credential rotation migration, RDP file download labelled "no Drishti-enforced controls"; WoL and schedules | L |

### Phase 8 — Lab Windows deployment

| WP | Content | Size |
|---|---|---|
| WP-8.1 | In-place repair kept separate from clean install; preflight, approvals, windows, staging, local safeguards; destructive execution disabled outside the validated pilot | L |
| WP-8.2 | Lab validation (boot/recovery, backups, BitLocker, drivers, licensing, application restore, network identity, failure recovery) recorded as evidence; nothing is presented as automated until validated | M |

---

## 9.5 Recommended first three work packages

1. **WP-A: freeze and design.** WP-1.2, WP-1.4 and WP-1.5, with WP-1.3 in parallel.
   - Put the already-committed Task 8 (`3fc5c1f`) behind an admin-only interim gate, do Task 9, and fix the stale architecture-doc status.
   - Write ADRs D-1…D-18 and get the four owner decisions.
   - Add the failing directive acceptance tests.
   - Outcome: a stable base and an agreed target, so phase 2 does not collide with the active builder.
2. **WP-B: capability access model (WP-2.1 + WP-2.4 credential exposure fix).**
   - Removes the four directive contradictions: hidden narrowing, home-store grants, global manager, CCTV grants exposing IT devices.
   - Separates live, playback and export; adds expiry and the preview; renames `agent` → `operator`.
   - Stops exposing recorder address and user columns to viewers.
3. **WP-C: session registry and ≤60 s revocation (WP-2.2).**
   - Closes the largest live security gap (about 41 minutes of continued viewing after revocation today).
   - Uses the WP-B capability functions.
   - Then WP-2.3 (location/recorder model) and WP-2.5 (lease/fencing) complete phase 2.

---

## 9.6 Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | An active builder is changing `lib/streams/playback.ts`, `lib/nvr/client.ts` and the VOD files, while phase 2 rewrites the same paths | Freeze plan-3 first (WP-A); phase 2 starts from the committed tip |
| R2 | RLS rewrite regressions or slow effective-access functions at 8,000 cameras × hundreds of users | Partial indexes on active grants; `EXPLAIN` tests on a seeded 300-location / 8,000-camera dataset; keep `(SELECT fn())` per-query evaluation; a per-request cache in the app |
| R3 | A grant migration that silently changes who sees what | `access_migration_report`; before/after effective-set equality tests per user on the CCTV capabilities; owner decision D-2a |
| R4 | Revocation polling load, or a DB outage stopping video | Batched 15 s checks; fail closed after 45 s, by design (security over availability), documented |
| R5 | PostgREST custom roles and GoTrue MFA behave differently on the pinned Supabase CLI | Spike first (S) in WP-B/WP-3.3; fallback for D-14a: a credential broker process |
| R6 | Unknown SD-WAN addressing (overlapping ranges, NAT) | `address_spaces` with a single global space until answered; **external dependency** |
| R7 | Real Hikvision variance (storage/record-status endpoints, H.265, firmware quirks); browsers that cannot decode | Capability flags per recorder, "unsupported" state, codec matrix in WP-4.4; a **lab NVR and cameras are an external dependency** |
| R8 | Windows hosting: Docker Desktop networking limits go2rtc isolation; several services on one host | Media service as its own Windows service; loopback-only publishing; listener tests; document the host hardening |
| R9 | PowerShell 5.1 crypto limits (no Ed25519) | ECDSA P-256 via CNG (D-9) |
| R10 | `next dev` listens on all interfaces over HTTP, so dev data is reachable over the VPN | Bind explicitly (`--hostname 127.0.0.1` or the lab IP) when the owner confirms; report the bind address at handover |
| R11 | Scope: eight phases for a small team; fleet work could start before CCTV and monitoring are solid | Phase gates with acceptance tests; phases 6-8 only after phase 5 exit criteria |
| R12 | The "shown time" refactor may break playback correctness | Do it in phase 4 behind tests that pin current behaviour, including midnight and offset cases |
| R13 | Existing tests encode the old access behaviour; rewriting them could hide regressions | Replace assertions one by one, cross-referenced to directive IDs; keep negative tests |
| R14 | The design reference exists only in a worktree branch of another repo and may differ from what the owner means | Confirm with the owner that branch `claude/brave-euler-07879a` is the reference; otherwise record the single missing reference (directive) |

---

## 9.7 External dependencies to record (not to be filled with mock success)

1. SD-WAN addressing plan (unique routed ranges or overlapping with NAT/VRF), SD-WAN edge monitoring access (SNMP or vendor API), tunnel/failover telemetry.
2. A lab Hikvision NVR (and ideally a second vendor/firmware) with cameras including H.265; firmware versions in the estate.
3. WhatsApp provider and approved templates (if WhatsApp is wanted); an SMTP relay; Teams/webhook endpoints. All disabled in development.
4. TLS certificates (internal CA or public) for the app and gateway host names.
5. Domain/Entra join inventory and Windows LAPS eligibility; the workgroup credential policy.
6. Lab Windows 10/11 endpoints (domain and workgroup) for agent and fleet tests; a hub server specification.
7. Attendance and footfall system integrations (APIs or data-freshness sources).
8. Owner decisions D-2a, D-6a, D-10a, D-14a, and confirmation of the design reference (R14).

---

## 9.8 Traceability (directive item → phase / work package)

| ID | Requirement (short) | Status now | Phase / WP |
|---|---|---|---|
| AU-1 | Repository audit, functionality to preserve, port check, plan | done | P1 / WP-1.1 |
| AU-2 | Progress kept in repository docs; dependencies recorded | P | all phases (`docs/drishti/PROGRESS.md`, §9.7) |
| BR-1 | Asset Management design language (inspected) | M | P1 / WP-1.3, P3 / WP-3.1 |
| BR-2 | Visible fields, labels, focus, contrast | P | P3 / WP-3.2, WP-3.5 |
| BR-3 | Full transparent logo on login and where space allows | M | P3 / WP-3.2 |
| BR-4 | Compact mark for nav/favicon only | P | P3 / WP-3.2 |
| BR-5 | Name "CityKart Drishti" / "CKDRISHTI" | C | P3 / WP-3.1 |
| BR-6 | Dev app on port 3212 | I | keep; bind address in handover (R10) |
| AC-1 | Roles vs scopes vs actions separated | C | P2 / WP-2.1 (D-1) |
| AC-2 | Live / playback / export assignable | C | P2 / WP-2.1 |
| AC-3 | IT actions assignable separately | M | P2 / WP-2.1 (catalogue), enforced P6-P7 |
| AC-4 | CCTV grant ≠ IT access | C | P2 / WP-2.1 |
| AC-5 | Five assignment cases | P | P2 / WP-2.1 |
| AC-6 | No hidden narrowing; explicit modes; overlap rules | C | P2 / WP-2.1 (D-1, D-2) |
| AC-7 | No access from home store | C | P2 / WP-2.1 (D-2a) |
| AC-8 | Manager not global | C | P2 / WP-2.1 (D-2a) |
| AC-9 | Effective-access preview | M | P2 / WP-2.1 |
| AC-10 | Enforce on searches, thumbnails, streams, clip jobs, downloads | P | P2 / WP-2.1, P4 / WP-4.3 |
| AC-11 | Groups never expand; metadata filtered | P | P2 / WP-2.1 |
| AC-12 | Grant expiry | M | P2 / WP-2.1 |
| AC-13 | Deactivation | I | keep; P2 / WP-2.2 adds session kill |
| AC-14 | Revocation ≤60 s for video and remote, tested | C | P2 / WP-2.2 (D-3); remote P7 / WP-7.4 |
| AC-15 | Rename `agent` → `operator` | M | P2 / WP-2.1 (D-16) |
| AL-1 | Location kinds (store, HO, DC, other) | M | P2 / WP-2.3 |
| AL-2 | Multiple NVRs per location | C | P2 / WP-2.3 |
| AL-3 | Explicit recorder-channel mappings; stable camera identity | M | P2 / WP-2.3 (D-4) |
| AL-4 | Parent dependencies | M | P2 / WP-2.3 (schema), P4 / WP-4.1 (logic) (D-5) |
| AL-5 | Asset identity attributes | M | P2 / WP-2.3, populated P6 |
| AL-6 | IP as attribute; overlapping SD-WAN | C | P2 / WP-2.3 (address spaces); external dependency 1 |
| AL-7 | Migration without loss | M | P2 / WP-2.1, WP-2.3 |
| CC-1 | Live viewing | I | keep; re-gated P2 |
| CC-2 | Camera groups | I | keep; metadata P2 |
| CC-3 | Playback | I | keep; re-gated P2; time refactor P4 |
| CC-4 | Authorised clip exports | M | P4 / WP-4.3 (D-6) |
| CC-5 | Substreams for grids, main on demand | I | keep |
| CC-6 | Timeline with unavailable intervals | P | P4 / WP-4.3 |
| CC-7 | IST display; explicit NVR clock offsets | P | P4 / WP-4.3 (D-17), drift P5 / WP-5.2 |
| CC-8 | Recordings crossing midnight tested | P | P4 / WP-4.3, lab dependency 2 |
| CC-9 | Bounded concurrency | P | P4 / WP-4.3 (+ D-11) |
| CC-10 | Stop hidden/abandoned streams | P | P2 / WP-2.2, P4 / WP-4.4 |
| CC-11 | Audit sessions, searches, exports | M | P4 / WP-4.3 (D-15) |
| CC-12 | Expiring authorised downloads | M | P4 / WP-4.3 |
| CC-13 | Export retention, cleanup, quotas | M | P4 / WP-4.3 |
| CC-14 | User export vs evidence backup | M | P4 / WP-4.3 (exports), P5 (evidence backup) |
| CC-15 | Real codec/browser combinations | M | P4 / WP-4.4 |
| CC-16 | Reachability, stream, recording health separate | C | P4 / WP-4.1, P5 / WP-5.2 |
| MC-1 | Compact operational overview | P | P4 / WP-4.2 |
| MC-2 | Investigation drill-down, filters preserved | P | P4 / WP-4.2 |
| MC-3 | Six-way state distinction | C | P4 / WP-4.1 (D-7) |
| MC-4 | Cameras not "failed" because of NVR/WAN | C | P4 / WP-4.1 |
| MC-5 | Parent correlation, duplicate suppression, child observations kept | P | P4 / WP-4.1, P5 / WP-5.1 |
| MC-6 | Availability, unknown time and coverage reported separately | P | P4 / WP-4.1 |
| MC-7 | NVR storage, recording errors, gaps, retention, drift | M | P5 / WP-5.2 |
| MC-8 | Decode, frozen and black frame checks | M | P5 / WP-5.2 (where supported) |
| MC-9 | SD-WAN latency, loss, tunnels, failover | M | P5 / WP-5.3; external dependency 1 |
| MC-10 | Switch/AP/PoE, UPS/printer | M | P5 / WP-5.3 |
| MC-11 | Windows perf, disk, services, security, patch, reboot | M | P6 / WP-6.2 |
| MC-12 | Attendance and footfall freshness | M | P5 / WP-5.3; external dependency 7 |
| MC-13 | Unsupported shown as unsupported | P | P4 / WP-4.1 |
| AR-1…AR-6 | Channels, dedup, maintenance, ack, escalation, recovery | M | P5 / WP-5.1 |
| AR-7 | WhatsApp/webhook configurable | M | P5 / WP-5.1; external dependency 3 |
| AR-8 | No external messages in development | I (vacuous) | P5 / WP-5.1 (dev sink, test) |
| EA-1 | Outbound agent primary; adapters kept | M | P6 / WP-6.1, WP-6.3 |
| EA-2 | Read-only inventory/health first | M | P6 / WP-6.2 |
| EA-3 | Enrolment, auth, rotation, revocation, upgrade, local protection | M | P6 / WP-6.1 |
| EA-4 | Signing authority with public keys | C | P7 / WP-7.1 (D-9) |
| EA-5 | Command binding (device, job, version, params, expiry, policy) | P (design) | P7 / WP-7.1 |
| EA-6 | Device credential cannot create/approve | P (design) | P6 / WP-6.1, P7 / WP-7.1 |
| RM-1 | Versioned approved library; no free fleet box | P (design) | P7 / WP-7.3 |
| RM-2 | Persistent local journal | P (design) | P7 / WP-7.1 |
| RM-3 | Leases, acks, reconciliation; no blind rerun | C (design) | P7 / WP-7.2 |
| RM-4 | Revalidate queued commands on return | C (design) | P7 / WP-7.2 |
| RM-5 | Supersede obsolete config jobs | M | P7 / WP-7.2 |
| RM-6 | Action expiry, maintenance windows | P (design) | P7 / WP-7.2 |
| RM-7 | Approval bound to exact payload | P (design) | P7 / WP-7.1, WP-7.2 |
| RM-8 | Canaries, batches, pause/cancel, failure-stop | P (design) | P7 / WP-7.2 |
| RM-9 | Rollback/recovery per action | M | P7 / WP-7.2 |
| RM-10 | Install/uninstall, wallpaper, screensaver, scripts, patching | P (design) | P7 / WP-7.3 |
| RM-11 | Per-user settings under SYSTEM | M | P7 / WP-7.3 |
| RM-12 | Verify state, not just exit code | M | P7 / WP-7.2, WP-7.3 |
| RM-13 | Windows LAPS; workgroup design | C (design) | P7 / WP-7.3; external dependency 5 |
| RM-14 | No default enable-local-admin action | C (design) | P7 / WP-7.3 |
| RM-15 | View vs control separate; enforced in protocol | P (design) | P7 / WP-7.4 |
| RM-16 | Controlled VNC credential rotation | P (design) | P7 / WP-7.4 |
| RM-17 | RDP files: no enforcement claimed | P (design) | P7 / WP-7.4 |
| SO-1 | Privileged MFA and fresh authentication | M | P3 / WP-3.3 (D-10) |
| SO-2 | Least-privilege service separation | C | P2 / WP-2.4 (D-14), P4 / WP-4.3 (media), P7 (fleet) |
| SO-3 | RLS, grants, safe SECURITY DEFINER | P | P2 / WP-2.4 |
| SO-4 | Registered-target restriction on outbound connections | M | P2 / WP-2.4 |
| SO-5 | HTTPS/WSS; secret/token redaction | P | P5 / WP-5.4 (TLS); token-in-query removed with sid tokens P2 / WP-2.2 |
| SO-6 | Strong signing secrets and rotation | P | P2 / WP-2.2 (key ids for stream tokens), P7 (signer) |
| SO-7 | Shared rate limiting | M | P3 (D-11), at the latest P5 / WP-5.4 |
| SO-8 | Strict CSP with the player | M | P3 / WP-3.4 (D-12) |
| SO-9 | go2rtc listener review and restriction | P | P4 / WP-4.3 (D-13); quick wins (drop WebRTC publish) in P2 / WP-2.4 |
| SO-10 | Media isolated from fleet execution | P | P4 / WP-4.3 |
| SO-11 | Durable audit and independent checkpoints | M | P4 (video audit) / P5 / WP-5.4 (D-15) |
| SO-12 | Health and visibility for workers, queues, gateway, DB | P | P5 / WP-5.4 |
| SO-13 | Tested backup/restore incl. Vault material | M | P5 / WP-5.4 |
| SO-14 | Lease/fencing worker | C | P2 / WP-2.5 (D-8) |
| WD-1…WD-4 | Repair vs clean install, no placeholders, lab validation, safeguards | P/M | P8 / WP-8.1, WP-8.2 |
| VA-1 | Regression, typecheck, lint, build | I | every WP gate |
| VA-2 | Cross-user/store/camera/action boundaries | P | P1 / WP-1.5 → P2 / WP-2.1 |
| VA-3 | Playback/export denied despite live | M | P1 / WP-1.5 → P2 / WP-2.1 |
| VA-4 | Camera-only (and CCTV-only) users see no IT devices | P | P1 / WP-1.5 → P2 / WP-2.1 |
| VA-5 | Multiple NVRs per location | M | P1 / WP-1.5 → P2 / WP-2.3 |
| VA-6 | Active-session revocation | M | P1 / WP-1.5 → P2 / WP-2.2 |
| VA-7 | WAN/NVR/monitor failure distinctions | P | P1 / WP-1.5 → P4 / WP-4.1 |
| VA-8 | Queue replay, lost acks, expiry, cancellation | M | P7 / WP-7.2 |
| VA-9 | Browser video compatibility and cleanup | P | P4 / WP-4.4 |
| VA-10 | Load: streams, bitrates, agent traffic | M | P4 (video), P6 (agents), P5 (monitoring scale) |
| VA-11 | Rendered pages incl. auth/error at desktop and control-room sizes; fields; logo | M | P3 / WP-3.5, repeated each phase |
| VA-12 | Local only; fakes by default; no real stores or PCs | I | every phase (egress guard, dev sink, lab-only flags) |
| HO-1 | Final handover with the app running on 3212 (URL, bind, commands, verified features, screenshots, tests, migrations, services/ports, outstanding hardware validation, mocked/deferred, blockers) | — | end of each phase (interim) and final |
