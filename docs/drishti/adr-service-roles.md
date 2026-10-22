# ADR: per-service database roles (D-14, D-14a; P2-6)

Status: accepted 2026-10-22 (spike passed; implemented in migration `20261021000033_p26_service_roles.sql`).

## Question

Can PostgREST on the pinned local Supabase stack switch to service-specific database roles through JWTs that carry a custom
`role` claim, so that every server process uses its own least-privilege identity instead of the one `service_role` key (D-14)?
If not, the fallback of decision D-14a applies (one service key, every credential read behind a broker process).

## Spike (2026-10-22)

Stack: Supabase CLI local stack, PostgREST image `public.ecr.aws/supabase/postgrest:v16.4` (OpenAPI reports 16.4), Kong 2.8.1,
GoTrue v2.197.0, PostgreSQL 17.11. The project JWT secret was read from `supabase status -o env` by the spike script into memory
only (never printed); only HTTP status codes and the spike's own function result were printed.

Steps (script in the session scratchpad, not committed; every object it made was dropped again):

1. `CREATE ROLE drishti_spike NOLOGIN NOINHERIT; GRANT drishti_spike TO authenticator; GRANT USAGE ON SCHEMA public TO drishti_spike;`
2. A function `public.drishti_spike_ping()` returning `current_user`, EXECUTE revoked from PUBLIC/anon/authenticated/service_role and
   granted to `drishti_spike` only; `NOTIFY pgrst, 'reload schema'`.
3. An HS256 JWT `{ role: 'drishti_spike', iss, iat, exp: +5 min }` signed with the project JWT secret, sent through Kong
   (`/rest/v1/...`) as `apikey` and `Authorization: Bearer`.

Results:

| Call | Answer |
|---|---|
| `POST /rest/v1/rpc/drishti_spike_ping` (apikey = the JWT, bearer = the JWT) | **200 `"drishti_spike"`** — PostgREST switched to the role of the claim |
| the same with apikey = the anon key, bearer = the JWT | 200 `"drishti_spike"` (Kong passes the bearer through) |
| `GET /rest/v1/profiles` as the spike role | 403, `42501 permission denied for table profiles` |
| `POST /rest/v1/rpc/media_session_close` as the spike role | 403, `42501 permission denied for function media_session_close` |
| a JWT naming a role that does not exist | 401, `22023 role "…" does not exist` |
| the JWT with a changed signature | 401, `PGRST301` (no key could decode it) |

Facts found on the way (they shape the design):

- `postgres` (the migration owner) has `CREATEROLE` and `BYPASSRLS`, so a migration can create service roles with `BYPASSRLS`
  (PostgreSQL 16+ requires the creator to hold the attribute itself).
- The `vault` schema is not exposed through PostgREST (`[api] schemas = public, graphql_public`); `service_role` has SELECT on
  `vault.decrypted_secrets` in the database, but through the API secrets are reachable only through SECURITY DEFINER functions.
- GoTrue's admin API (`/auth/v1/admin/*`: create user, set password, ban) accepts only a `service_role` JWT on this stack
  (`GOTRUE_JWT_ADMIN_ROLES` is not configurable through `supabase/config.toml`). The web app therefore keeps the service key for
  user administration ONLY (see "Remaining risks").

## Decision

**Per-service roles through role-switching JWTs** (D-14a accepted; the broker-process fallback is not needed). Migration
`20261021000033_p26_service_roles.sql` creates the roles and their grants; `scripts/gen-secrets.mjs` signs one long-lived JWT per role
with the project JWT secret and writes it to `.env.local` (never printed).

| Role | Env key (JWT) | Process | `BYPASSRLS` | May do (summary; exact grants in the migration and in p2-6-report.md) |
|---|---|---|---|---|
| `app_web` | `SUPABASE_APP_WEB_KEY` | web app (`createAdminClient`) | yes (server-side reads after the person's own check, always org-scoped in code) | the tables and RPCs the web code uses; **no credential read**, no observation writes, no worker or gateway RPCs, no test or diagnostic functions; may WRITE an NVR password through `recorder_store_credential` (write-only) |
| `media_service` | `SUPABASE_MEDIA_SERVICE_KEY` | the video/credential path of the web process today (`createMediaClient`: open live, playback, fast playback, NVR discovery and connection test); its own process in WP-4.3 | yes | read cameras/recorders/mappings/locations/assets; `media_session_create/open/still_valid/close`; `recorder_credential_read` for purposes `live`, `playback`, `vod`, `export`, `discovery`, `connection_test`; write the access audit rows of video |
| `monitor_worker` | `SUPABASE_MONITOR_WORKER_KEY` | worker | yes | read the monitoring inputs; `monitor_apply_results`; heartbeat/progress columns of `worker_state`; `monitor_gaps` insert; `cameras.camera_ip` update; `recorder_credential_read` for `monitoring`; `media_sessions_prune`, `rate_limit_prune` (housekeeping); lease RPCs in P2-7 |
| `video_gateway` | `SUPABASE_VIDEO_GATEWAY_KEY` | gateway | **no** | EXECUTE on `media_session_open`, `media_sessions_still_valid`, `media_session_close` only — no table, no other function |
| `fleet_service` | — | phase 7 | — | not created yet |

Every credential read goes through `recorder_credential_read(recorder, purpose)` (or the legacy `recorder_read_credential`, kept for
the service role's tooling and tests) and writes a row to `vault_reads` (who/role, recorder, purpose, time, outcome — never a value).
The import's saved-password comparison logs its reads too (`import_compare`).

Compatibility (the owner's running processes): when a service key is missing, development falls back to `SUPABASE_SERVICE_ROLE_KEY`
with a loud one-time warning per role; production refuses to start the service without its own key. The service role keeps its
privileges (it is the administrator's break-glass key for scripts, seeding and tests); per organisation,
`security_settings.service_role_credential_reads = false` makes the database refuse credential reads by the service role, so a process
that holds the service key for GoTrue only cannot read NVR passwords (default `true` so nothing running today breaks).

**Production mode (review round 1, I-1, M-3, M-4, M-16).** "Production" is one switch for every process: `DRISHTI_ENV=production`
(or `NODE_ENV=production`; any `DRISHTI_ENV` other than `development` too), read through `lib/runtime-mode.ts` /
`scripts/lib/runtime-mode.mjs`. NODE_ENV alone was not enough: the worker and the gateway run under tsx, which sets none, so they
silently stayed on the full service key. At start-up (`lib/startup-checks.ts`; the web app through `instrumentation.ts`) each process
refuses with one plain line and exit code 1 when, in production: its own key is missing, is for another role, or has ended (a warning
30 days before); the full service key is in the worker's or the gateway's environment (each process gets its own env file:
`deploy/production.env.example`); a shared secret it needs is missing; go2rtc's API login is missing (web app, gateway) or go2rtc
answers without it (gateway and web app probe it); `OUTBOUND_TARGET_ALLOWLIST` names a special or loopback address; `DEMO_VIDEO` is
set; or (web app) an organisation in use has not locked the service key out of NVR logins (`security_unlocked_organizations()`).
Development only warns.

**Grants after review round 1** (migration `20261021000035_p26_review_fixes.sql`): `app_web` updates only
`recorders(clock_offset_sec, clock_offset_source)` and `profiles(full_name, location_id, must_reset_password)` (the monitoring switch,
NVR logins, ports, roles, organisation and status go through their audited functions); `media_service` no longer holds the rate-limit
functions; `service_role_grants()` lists every table, column and schema grant of the four roles and a test compares it with an exact
snapshot; a trigger on `auth.users` refuses any account role but `authenticated` (PostgREST would otherwise switch a person's session to
a service role the authenticator belongs to).

## Consequences

- Each process gets its own key; rotating one role's key is: generate, restart that process (runbook
  `docs/drishti/runbooks/secret-rotation.md`). A JWT cannot be revoked one by one: an exposed key is cut off by rotating the project
  JWT secret (all keys, including anon/service) or, at once, by `REVOKE <role> FROM authenticator` (stops every key of that role).
- Keys are signed with the project's legacy HS256 JWT secret. If the stack moves to asymmetric signing keys only, the script must sign
  with the new key (recorded as a risk).

## Remaining risks

1. The web process still holds `SUPABASE_SERVICE_ROLE_KEY` for GoTrue's admin API (users: create, set password, ban). Mitigation: it is
   used only by `createAuthAdminClient()` in the user-administration actions; with `service_role_credential_reads = false` it cannot
   read NVR passwords; a separate identity service is future work.
2. The media path (`media_service`) runs inside the web process until the media service of WP-4.3 exists, so the web process holds both
   keys. The separation is enforced at the database (each code path uses its own key and grants), not by the operating system yet.
3. `app_web` still writes several tables directly (inventory forms, groups, profiles); "writes only through narrow RPCs" is reached
   step by step as the screens are reworked (P4/P5). Its table grants are limited to the tables and operations the web code uses, and
   since review round 1 to the columns the code writes on `recorders` and `profiles`.
4. Service JWTs cannot be revoked one by one before their `exp` (a `jti` allow-list checked by a PostgREST pre-request function was
   considered in review round 1, M-4, and left for later: it needs the authenticator's settings, which only the platform owner can
   change). Start-up warns 30 days before a key ends and refuses after.
