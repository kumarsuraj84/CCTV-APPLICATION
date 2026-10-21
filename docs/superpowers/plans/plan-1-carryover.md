# Plan 1 carry-over: what the reviews deferred to Plans 2, 3 and 4

Source: the per-task reviews and the whole-branch review of Plan 1 (branch `feat/plan-1-foundation`). Everything here is real but was judged not to block Plan 1. Read it before writing Plans 2 to 4.

## Start of Plan 2 (monitoring)

- **Default privileges.** The `public` schema gives `anon` and `authenticated` full access to new tables and functions by default. Add a migration with `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES, SEQUENCES, FUNCTIONS FROM anon, authenticated` (then grant per table), or a catalog-driven test that fails when any new `public` table is writable by `authenticated`. New tables `check_state`, `outages`, `worker_state`, `monitor_gaps` must follow the "authenticated reads only what it may see, never writes" pattern.
- **Foreign-key indexes:** `user_store_access(store_id)`, `user_camera_access(camera_id)`, `profiles(store_id)`.
- **Device uniqueness:** unique `(org_id, ip, tcp_port)` with `NULLS NOT DISTINCT` (PostgreSQL 15+); `importDevices` ignores an error in its lookup.
- **Services never throw.** Return `Result`; `createStore`/`updateStore` were fixed in the final wave, review the rest.
- **Consolidate roles and shared types.** `Role` is defined in `lib/nav.ts` and `lib/admin/roles.ts`; `Actor`, `AdminClient`, `Result` live in `lib/admin/users.ts` but are used by inventory. Move them to one module before adding rules for `agent` (operator).
- **Credential helpers.** `nvr_store_credential` has no `FOR UPDATE`, accepts an empty secret and ignores a stale pointer; fix before the worker reads credentials. `deleteStore` should delete the store, then the secret by id, and check the result.
- **Worker and cron routes** go into `proxy.ts`'s exact public list, each protected with `getSecret`.
- **Large status tables:** wrap `current_org_id()` in `(SELECT …)` inside function bodies too.
- **Test hygiene:** `cleanupOrg` should collect errors and throw; `createUser` can orphan an auth user on partial failure; `afterAll` must tolerate an undefined org; the version test should restore `NEXT_PUBLIC_BUILD_ID`; `MobileNav` items should come from `NAV`; `EmptyState` uses hard-coded hex colours (dark mode); add negative row-security tests (a deactivated admin with a still-valid token reads 0 rows, an `agent` does not see the whole organisation, `anon` is denied) and tests for the denied calls of `replace_user_access`/`nvr_store_credential`.
- **Smaller:** `setUserAccess` matches the RPC's exception text (use a custom SQLSTATE); `createUserAction` echoes the raw form e-mail; `setRoleAction` has no UI yet; partial-failure handling in `updateUser`/`resetUserPassword` (revert result, audit row when the RPC fails, order of flag and password).
- **Import tests:** role denial for import/update/delete; a device CSV cannot link to another organisation's store code.

## Before live feeds (Plan 3)

- Column-level grants so `authenticated` cannot read `nvr_username`, `nvr_ip` and `nvr_secret_id` of the stores it can see (no viewer query selects them today, and Vault is not readable by `authenticated`; verified).
- Stream-token endpoint checks `visible_camera_ids()` through the signed-in client before minting a token.

## Plan 4 (hardening and production packaging)

- **Auth service in production:** public sign-up off (`[auth] enable_signup = false`), e-mail provider on (`[auth.email] enable_signup = true`, ruling R4), password policy `minimum_password_length = 10`, `password_requirements = "letters_digits"`, correct site URL and redirect URLs.
- **`TRUSTED_PROXY_HOPS`** must be set in the runbook; without it the sign-in lockout counter is shared by every client, so anyone can lock out any e-mail for 15 minutes (including admins). Add per-IP caps and a shared store if there is ever more than one app process.
- **SECURITY DEFINER hygiene:** `SET search_path = public` (migration 1 and 2) and `public, auth` (migration 3) do not pin `pg_temp`; use `SET search_path = ''` with qualified names, or `pg_catalog, public, pg_temp`; editing migrations in place is free until the first production deploy.
- **PostgreSQL 15+** is required (`ON DELETE SET NULL (column)`); local is 17, Desk's production is 18; confirm for this app's database.
- **Rollback script** must also delete the `nvr:%` Vault secrets.
- **Audit log:** `service_role` can change `admin_audit_log`; the hash-chained `system_log` replaces it.
- **Rate limits on admin actions and import** (spec section 4.7) and an import row cap (about 5,000 rows); lower the Server Action body limit from 30 MB to about 6 MB.
- **CSV import:** an IP error can echo a misaligned password cell back to the uploading admin; do not echo the value. Search sanitising in `lib/queries/inventory.ts` removes known-bad characters rather than allowing only safe ones (a `"` can make the search error out, no data leak).
- **Smaller:** `NewVersionBanner` does not check `res.ok` and polls while hidden; `globals.css` carries Desk leftovers; `organizations.status` (suspended, cancelled) is not enforced; env script prints a raw stack trace when the CLI fails, and `--force` regenerates the dev admin password; `getClientIp`, forged-signature and `rateLimit` eviction edge cases are untested; `en-GB` formats September as "Sept"; `npm audit` shows dev-only vulnerabilities (0 in production dependencies); test the proxy header stripping, `signIn` and `changePassword` flows automatically (they were only checked by hand).

## Environment facts learned while executing Plan 1

- Local stack: `npm run db:start` (ports 55321 API, 55322 DB, 55323 Studio, 55324 mail). `npm run db:reset` wipes the dev admin; run `node scripts/create-dev-admin.mjs` afterwards.
- `.env.local` holds generated keys and secrets, including `DEV_ADMIN_EMAIL` and `DEV_ADMIN_PASSWORD`; never print them.
- GoTrue on this CLI version ends all sessions when the admin API changes a password, but reactivating a banned user revives old tokens, so `revoke_user_sessions` is called on deactivation too.
