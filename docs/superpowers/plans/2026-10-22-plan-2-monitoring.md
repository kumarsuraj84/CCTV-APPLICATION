# Monitoring (Plan 2 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worker that checks every camera, NVR and IP device on a schedule, records current status and outage periods in PostgreSQL, and screens that show live/offline status and uptime to each person for the stores they may see, with a "Check now" button for operators.

**Architecture:** State changes (two failures to go down, first success to come up, outage periods) live in one SQL function, `monitor_apply_results`, so they are atomic and tested against the real database. Uptime is computed in SQL from outages and the periods the worker was not running. The TypeScript side holds only network probes (TCP, ICMP, RTSP, Hikvision ISAPI with HTTP Digest) and the job orchestration, all with injected dependencies so they run against fake servers on loopback in tests. The worker is a long-running Node service (`tsx services/worker/index.ts`) that shares `lib/` with the app and writes through the service-role client. The web app reads status only through the signed-in person's client, so row-level security decides what each person sees.

**Tech Stack:** Next.js 16.3.8, Supabase (PostgreSQL 17 local, 15+ required), TypeScript, vitest, `tsx` (new dev dependency) for the worker. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-21-network-monitoring-hub-design.md` (sections 5 to 7 and 10). Starting point: branch `feat/plan-1-foundation`; the deferred items this plan picks up are in `docs/superpowers/plans/plan-1-carryover.md`.

## Global Constraints

- Stack and conventions as in Plan 1: Next.js 16 (`proxy.ts`, async `params`/`searchParams`), Server Actions in `lib/actions/**` that check the caller first, two Supabase clients, IST 24-hour times, plain English, no jargon.
- A target goes `down` after **2 consecutive failures** and `up` on the first success; an outage starts at the time of the first failure of the run of failures.
- Intervals: devices and NVR reachability every **60 s** (`DEVICE_CHECK_SEC`), cameras every **300 s** (`CAMERA_CHECK_SEC`); the worker polls for a "check now" request and writes its heartbeat every **5 s**.
- Check methods: servers, attendance machines, footfall counters and other devices use a TCP connect to `tcp_port`, or an ICMP ping when no port is set. The NVR is checked with a TCP connect to its RTSP port. Cameras are checked with ISAPI `InputProxy/channels/status` from the NVR; cameras the NVR does not report online are re-checked with an RTSP DESCRIBE on the sub-stream. NVR login uses HTTP Digest.
- If the NVR is down, its cameras are marked down immediately (threshold 1) with outage cause `nvr_down`, and the dashboard lists the NVR outage, not each camera.
- Uptime windows are 24h, 7d, 30d. Time while the worker was not running (`monitor_gaps`) and the time before a target was first checked are excluded; a worker stoppage shows as no data, not as downtime.
- "Check now" may be requested by `agent` (operator), `admin` and `platform_owner`; `manager` and `user` may not.
- Status is read by people only through row-level security: they see status only for the cameras, devices and stores they may see. Nobody except the service role writes `check_state`, `outages`, `worker_state` or `monitor_gaps`.
- Status wording in the UI: **Live**, **Offline**, **Not checked yet**.
- Tests never touch a real network: an egress guard loaded in every test process refuses any connection to an address other than loopback, and all fakes (NVR, RTSP, TCP) run on loopback ports. Never use a real store IP in tests or fixtures; documentation addresses (192.0.2.0/24) are only used where no connection is made.
- Services return `Result` and never throw to the caller. Every new `public` table or function must have explicit grants; after Task 1 new objects get no default access for `anon` or `authenticated`.
- NVR passwords are read only through the service-role RPC `nvr_read_credential` at check time, never cached in a table, log or response.
- `npm run typecheck`, `npm run lint`, `npm run test:unit` and `npm run test:integration` must be clean at the end of every task. Integration tests need the local Supabase stack (`npm run db:start`) and must not run while a real worker is running against the same database (the worker writes `worker_state`).
- Deliberate deviation from the spec text: the failure/outage state machine is a SQL function (tested through the database), not a TypeScript module, so the state change and the outage record are one atomic step. The TypeScript modules in `lib/nvr`, `lib/rtsp`, `lib/probes` and `lib/monitor` are pure or take injected dependencies and are unit-tested.

## File Structure

```
supabase/migrations/20261021000004_hardening.sql        Task 1
supabase/migrations/20261021000005_monitoring.sql       Task 3
supabase/rollback/20261021000004_*  20261021000005_*
lib/admin/roles.ts      (single source for roles)       Task 2
lib/admin/types.ts      (Actor, AdminClient, Result)    Task 2
lib/async/pool.ts                                       Task 7
lib/nvr/{digest,isapi,client}.ts                        Task 5
lib/probes.ts  lib/rtsp/describe.ts                     Task 6
lib/monitor/{config,types,checks,supabase-db,runner,health,discovery}.ts   Tasks 7-9
services/worker/index.ts                                Task 8
lib/queries/status.ts  lib/monitor/uptime.ts            Task 10
lib/actions/monitor.ts  lib/actions/admin/monitoring.ts Tasks 9, 11
components/monitor/{StatusBadge,CheckNowButton,FindCamerasButton}.tsx   Tasks 9-11
app/(app)/admin/monitoring/page.tsx                     Task 11
app/api/health/route.ts (extended)                      Task 8
scripts/fake-nvr.ts                                     Task 11
tests/setup/egress-guard.ts                             Task 4
tests/helpers/fake-servers.ts                           Task 4
```

---

### Task 1: Database hardening carried over from Plan 1

**Files:**
- Create: `supabase/migrations/20261021000004_hardening.sql`, `supabase/rollback/20261021000004_hardening_rollback.sql`
- Modify: `lib/inventory/stores.ts` (deleteStore), `types/database.ts` (regenerated)
- Test: `tests/integration/hardening.test.ts`

**Interfaces:**
- Produces: no default access for `anon`/`authenticated` on objects created later in `public`; RPC `privilege_violations() returns setof text` (service role only; empty when healthy); indexes on `user_store_access(store_id)`, `user_camera_access(camera_id)`, `profiles(store_id)`; unique `devices (org_id, ip, tcp_port)` that treats NULL ports as equal; a safer `nvr_store_credential`; `deleteStore` that stops when the vault secret cannot be removed.

- [ ] **Step 1: Write the failing tests**

`tests/integration/hardening.test.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/users'
import { createDevice } from '@/lib/inventory/devices'
import { createStore, deleteStore } from '@/lib/inventory/stores'
import { adminClient, cleanupOrg, createOrg, createUser } from '../setup/fixtures'

const admin = () => adminClient()

describe('database hardening', () => {
  let orgId: string
  let actor: Actor
  let storeId: string

  beforeAll(async () => {
    orgId = await createOrg()
    const u = await createUser(orgId, 'admin')
    actor = { id: u.id, orgId, role: 'admin' }
    const { data } = await admin()
      .from('stores')
      .insert({ org_id: orgId, code: 'HARD', name: 'Hardening', nvr_ip: '127.0.0.1', nvr_username: 'u' })
      .select('id')
      .single()
    storeId = data!.id
  })
  afterAll(() => cleanupOrg(orgId))

  it('no public table is writable by signed-in users or readable by anon, and default access is closed', async () => {
    const { data, error } = await admin().rpc('privilege_violations')
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('only the service role may call privilege_violations', async () => {
    const person = await createUser(orgId, 'user')
    const denied = await person.client.rpc('privilege_violations')
    expect(denied.error?.code).toBe('42501')
  })

  it('refuses two devices with the same address and port, also when the port is empty', async () => {
    const a = await createDevice(admin(), actor, { name: 'One', type: 'server', ip: '192.0.2.50', tcp_port: 443 })
    expect(a.ok).toBe(true)
    expect((await createDevice(admin(), actor, { name: 'Two', type: 'server', ip: '192.0.2.50', tcp_port: 443 })).ok).toBe(false)
    expect((await createDevice(admin(), actor, { name: 'Three', type: 'other', ip: '192.0.2.51' })).ok).toBe(true)
    expect((await createDevice(admin(), actor, { name: 'Four', type: 'other', ip: '192.0.2.51' })).ok).toBe(false)
    expect((await createDevice(admin(), actor, { name: 'Five', type: 'server', ip: '192.0.2.50', tcp_port: 8443 })).ok).toBe(true)
  })

  it('refuses an empty NVR password and copes with a stale vault pointer', async () => {
    const empty = await admin().rpc('nvr_store_credential', { p_store: storeId, p_secret: '' })
    expect(empty.error).not.toBeNull()

    const first = `Nvr-${randomUUID()}`
    expect((await admin().rpc('nvr_store_credential', { p_store: storeId, p_secret: first })).error).toBeNull()
    // Point the store at a vault row that does not exist, as after a partial failure.
    await admin().from('stores').update({ nvr_secret_id: randomUUID() }).eq('id', storeId)
    const second = `Nvr-${randomUUID()}`
    expect((await admin().rpc('nvr_store_credential', { p_store: storeId, p_secret: second })).error).toBeNull()
    expect((await admin().rpc('nvr_read_credential', { p_store: storeId })).data).toBe(second)
  })

  it('two simultaneous saves of an NVR password both succeed and leave one of them', async () => {
    const a = `Nvr-${randomUUID()}`
    const b = `Nvr-${randomUUID()}`
    const [ra, rb] = await Promise.all([
      admin().rpc('nvr_store_credential', { p_store: storeId, p_secret: a }),
      admin().rpc('nvr_store_credential', { p_store: storeId, p_secret: b }),
    ])
    expect(ra.error).toBeNull()
    expect(rb.error).toBeNull()
    const read = (await admin().rpc('nvr_read_credential', { p_store: storeId })).data
    expect([a, b]).toContain(read)
  })

  it('deleteStore keeps the store when its vault secret cannot be removed', async () => {
    const made = await createStore(admin(), actor, { name: 'Keeper', ip: '192.0.2.60', nvr_username: 'viewer', nvr_password: 'Secret-K1', channels: 0 })
    if (!made.ok) throw new Error(made.error)
    const real = admin()
    const failing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'rpc') {
          return (fn: string, args: object) =>
            fn === 'nvr_delete_credential' ? Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' } }) : (target.rpc as (f: string, a: object) => unknown)(fn, args)
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const res = await deleteStore(failing, actor, made.storeId)
    expect(res.ok).toBe(false)
    const { data } = await real.from('stores').select('id').eq('id', made.storeId)
    expect(data).toHaveLength(1)
    expect((await deleteStore(real, actor, made.storeId)).ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/integration/hardening.test.ts`
Expected: FAIL (`privilege_violations` does not exist; duplicates are accepted; and so on).

- [ ] **Step 3: Write the migration and its rollback**

`supabase/migrations/20261021000004_hardening.sql`:
```sql
-- Hardening carried over from Plan 1: closed default privileges, foreign-key indexes, device uniqueness, safer vault helper.
-- Rollback: supabase/rollback/20261021000004_hardening_rollback.sql
BEGIN;

-- New tables, sequences and functions created by this role in `public` no longer start open to anon and authenticated.
-- Every migration must grant explicitly (SELECT to authenticated where people may read, everything to service_role).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
-- Functions are executable by PUBLIC by default; close that too (global default for this role).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- A check that fails when any public table can be written by signed-in users, is readable by anon, or when default access is open.
CREATE OR REPLACE FUNCTION public.privilege_violations() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT format('%s: authenticated has %s', c.relname, a.privilege_type)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
    AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')
    AND a.privilege_type <> 'SELECT'
  UNION ALL
  SELECT format('%s: anon has %s', c.relname, a.privilege_type)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
    AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'anon')
  UNION ALL
  SELECT format('default privileges still give %s access to new objects of kind %s', r.rolname, d.defaclobjtype)
  FROM pg_default_acl d
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public' AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
    AND r.rolname IN ('anon', 'authenticated')
$$;

REVOKE EXECUTE ON FUNCTION public.privilege_violations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.privilege_violations() TO service_role;

-- Foreign-key columns without an index make deletes of stores and cameras scan these tables.
CREATE INDEX IF NOT EXISTS user_store_access_store_idx ON public.user_store_access (store_id);
CREATE INDEX IF NOT EXISTS user_camera_access_camera_idx ON public.user_camera_access (camera_id);
CREATE INDEX IF NOT EXISTS profiles_store_idx ON public.profiles (store_id);

-- One device per address and port; two devices with no port and the same address count as the same device (PostgreSQL 15+).
ALTER TABLE public.devices
  ADD CONSTRAINT devices_org_ip_port_key UNIQUE NULLS NOT DISTINCT (org_id, ip, tcp_port);

-- Safer vault helper: locks the store row, refuses an empty secret, and recovers from a pointer to a vault row that is gone.
CREATE OR REPLACE FUNCTION public.nvr_store_credential(p_store uuid, p_secret text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE
  v_existing uuid;
  v_id uuid;
BEGIN
  IF p_secret IS NULL OR btrim(p_secret) = '' THEN RAISE EXCEPTION 'empty secret'; END IF;
  SELECT nvr_secret_id INTO v_existing FROM stores WHERE id = p_store FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown store'; END IF;
  IF v_existing IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vault.secrets WHERE id = v_existing) THEN
    v_existing := NULL;
  END IF;
  IF v_existing IS NULL THEN
    DELETE FROM vault.secrets WHERE name = 'nvr:' || p_store::text;
    v_id := vault.create_secret(p_secret, 'nvr:' || p_store::text, 'NVR login for a store');
    UPDATE stores SET nvr_secret_id = v_id WHERE id = p_store;
  ELSE
    PERFORM vault.update_secret(v_existing, p_secret);
    v_id := v_existing;
  END IF;
  RETURN v_id;
END
$$;

COMMIT;
```

`supabase/rollback/20261021000004_hardening_rollback.sql`:
```sql
BEGIN;
ALTER TABLE public.devices DROP CONSTRAINT IF EXISTS devices_org_ip_port_key;
DROP INDEX IF EXISTS public.profiles_store_idx;
DROP INDEX IF EXISTS public.user_camera_access_camera_idx;
DROP INDEX IF EXISTS public.user_store_access_store_idx;
DROP FUNCTION IF EXISTS public.privilege_violations();
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
-- nvr_store_credential keeps the safer version: restoring the older one is not worth losing the lock.
COMMIT;
```

- [ ] **Step 4: Change `deleteStore`**

In `lib/inventory/stores.ts` replace the line `await admin.rpc('nvr_delete_credential', { p_store: storeId })` in `deleteStore` with:
```ts
  // Remove the NVR password from the vault first; if that fails the store is kept so the secret is never orphaned.
  const secret = await admin.rpc('nvr_delete_credential', { p_store: storeId })
  if (secret.error) return { ok: false, error: sanitizeError(secret.error, { route: 'deleteStore.credential', fallback: 'Could not remove the NVR password, so the store was not deleted. Please try again.' }) }
```

- [ ] **Step 5: Apply, regenerate types, run everything**

Run: `npm run db:reset` (this wipes the local dev admin; afterwards run `node scripts/create-dev-admin.mjs`), then `npm run db:types`.
Run: `npx vitest run tests/integration/hardening.test.ts` then `npm run test:unit`, `npm run test:integration`, `npm run typecheck`, `npm run lint`.
Expected: all green. If `privilege_violations` is not empty, the list names the table and privilege; fix the migration that granted it (editing an earlier migration in place is acceptable until the first production deploy) and re-run `npm run db:reset`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: close default privileges, add indexes and device uniqueness, harden vault helper"
```

---

### Task 2: One source for roles and shared types, test hygiene, negative row-security tests

**Files:**
- Create: `lib/admin/types.ts`, `tests/integration/negative-rls.test.ts`
- Modify: `lib/admin/roles.ts`, `lib/nav.ts`, `lib/auth/profile.ts`, `lib/admin/users.ts` and every file that imports `Actor`, `AdminClient`, `Result`, `Role` or `isAdminRole` (find them with `npm run typecheck`), `tests/setup/fixtures.ts`, `tests/unit/api-routes.test.ts`, `tests/unit/nav.test.ts`, `components/layout/MobileNav.tsx`, `components/layout/AppShell.tsx`
- Delete: `lib/auth/roles.ts`
- Test: `tests/unit/roles.test.ts` (extend), `tests/unit/nav.test.ts` (update), `tests/integration/negative-rls.test.ts`

**Interfaces:**
- Produces: `lib/admin/roles.ts` exports `ROLES`, `Role`, `canManageRole`, `SEES_EVERYTHING`, `isAdminRole(role)`, `canRunChecks(role)` (agent, admin, platform_owner); `lib/admin/types.ts` exports `AdminClient`, `Actor`, `Result<T>`; `NavItem` gains `mobile?: true`; `MobileNav` takes `items: NavItem[]`; `cleanupOrg(orgId)` throws one error listing everything it could not clean and returns at once for an empty id.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/roles.test.ts`:
```ts
import { canRunChecks, isAdminRole } from '@/lib/admin/roles'

describe('isAdminRole and canRunChecks', () => {
  it('isAdminRole is true only for admin and platform_owner', () => {
    expect(isAdminRole('admin')).toBe(true)
    expect(isAdminRole('platform_owner')).toBe(true)
    for (const r of ['user', 'agent', 'manager'] as const) expect(isAdminRole(r)).toBe(false)
  })
  it('operators, admins and owners may request a check; viewers and managers may not', () => {
    for (const r of ['agent', 'admin', 'platform_owner'] as const) expect(canRunChecks(r)).toBe(true)
    for (const r of ['user', 'manager'] as const) expect(canRunChecks(r)).toBe(false)
  })
})
```
(Put the import at the top of the file with the existing imports.)

Replace `tests/unit/nav.test.ts` expectations for the mobile bar by adding:
```ts
import { mobileNavFor } from '@/lib/nav'

describe('mobile navigation', () => {
  it('shows only the pages everybody uses, taken from the same list as the sidebar', () => {
    expect(mobileNavFor('user').map((i) => i.href)).toEqual(['/home', '/stores', '/devices'])
    expect(mobileNavFor('admin').map((i) => i.href)).toEqual(['/home', '/stores', '/devices'])
  })
})
```

`tests/integration/negative-rls.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { adminClient, cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'

describe('row security: negative cases', () => {
  let orgId: string
  let agent: TestUser
  let deactivated: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    const a = adminClient()
    const { data: s } = await a.from('stores').insert({ org_id: orgId, code: 'NEG', name: 'Neg', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    await a.from('cameras').insert({ org_id: orgId, store_id: s!.id, channel: 1, name: 'C1' })
    agent = await createUser(orgId, 'agent')
    deactivated = await createUser(orgId, 'admin')
    await a.from('profiles').update({ is_active: false }).eq('id', deactivated.id)
  })
  afterAll(() => cleanupOrg(orgId))

  it('an operator with no grants sees nothing, only managers and above see everything', async () => {
    expect((await agent.client.from('stores').select('id')).data).toEqual([])
    expect((await agent.client.from('cameras').select('id')).data).toEqual([])
  })

  it('a deactivated admin whose token is still valid reads nothing', async () => {
    expect((await deactivated.client.from('stores').select('id')).data).toEqual([])
    expect((await deactivated.client.from('profiles').select('id')).data).toEqual([])
  })

  it('anonymous callers are refused on every inventory table', async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    for (const table of ['stores', 'cameras', 'devices', 'profiles', 'organizations', 'user_store_access'] as const) {
      const res = await anon.from(table).select('id').limit(1)
      expect(res.error?.code, table).toBe('42501')
    }
  })

  it('anonymous and signed-in callers cannot call the server-only functions', async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    const calls: [string, object][] = [
      ['replace_user_access', { p_user: crypto.randomUUID(), p_stores: [], p_zones: [], p_cameras: [] }],
      ['nvr_store_credential', { p_store: crypto.randomUUID(), p_secret: 'x' }],
      ['revoke_user_sessions', { p_user: crypto.randomUUID() }],
    ]
    for (const [fn, args] of calls) {
      expect((await anon.rpc(fn, args)).error?.code, `anon ${fn}`).toBe('42501')
      expect((await agent.client.rpc(fn, args)).error?.code, `agent ${fn}`).toBe('42501')
    }
  })
})
```

- [ ] **Step 2: Run to see failures**

Run: `npx vitest run tests/unit/roles.test.ts tests/unit/nav.test.ts tests/integration/negative-rls.test.ts`
Expected: unit tests FAIL (missing exports); the integration file may already pass (it only checks existing behaviour; if a case fails, that is a real hole: stop and report it).

- [ ] **Step 3: Consolidate roles and shared types**

`lib/admin/roles.ts` (replace the whole file):
```ts
export const ROLES = ['user', 'agent', 'manager', 'admin', 'platform_owner'] as const
export type Role = (typeof ROLES)[number]

export const isAdminRole = (role: Role): boolean => role === 'admin' || role === 'platform_owner'

// A platform owner manages everyone; a plain admin manages viewers, operators and managers; nobody else manages anyone.
export function canManageRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'platform_owner') return true
  if (actorRole === 'admin') return targetRole === 'user' || targetRole === 'agent' || targetRole === 'manager'
  return false
}

// Roles that already see every store, camera and device, so an access list means nothing for them.
export const SEES_EVERYTHING: readonly Role[] = ['manager', 'admin', 'platform_owner']

// Operators and administrators may ask the worker to check everything now. Managers only read.
export const canRunChecks = (role: Role): boolean => role === 'agent' || isAdminRole(role)
```

`lib/admin/types.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { Role } from '@/lib/admin/roles'

export type AdminClient = SupabaseClient<Database>
export type Actor = { id: string; orgId: string; role: Role }
export type Result<T> = ({ ok: true } & T) | { ok: false; error: string }
```

Then, using `npm run typecheck` to find every use:
- In `lib/admin/users.ts` delete its own definitions of `AdminClient`, `Actor`, `Result` and import them from `@/lib/admin/types`; keep re-exporting them for one release by adding `export type { AdminClient, Actor, Result } from '@/lib/admin/types'` at the top, then change every other importer (`lib/inventory/*`, `lib/import/apply.ts`, `lib/actions/admin/*`, tests) to import from `@/lib/admin/types` and delete the re-export line once nothing uses it.
- Delete `lib/auth/roles.ts`; every `isAdminRole` import now comes from `@/lib/admin/roles`.
- In `lib/nav.ts` delete the local `Role` type and `ADMIN` list; `import { isAdminRole, type Role } from '@/lib/admin/roles'`, keep `export type { Role }` so existing imports keep working, and define `roles: ['admin', 'platform_owner']` using a local constant built from `ROLES.filter(isAdminRole)`. Add `mobile?: true` to `NavItem`, set `mobile: true` on the three monitoring items (Home, Stores, Devices), and add:
```ts
export function mobileNavFor(role: Role): NavItem[] {
  return navFor(role).filter((i) => i.mobile)
}
```
- `components/layout/MobileNav.tsx` takes `{ items: NavItem[] }`, renders one link per item with the same icon map as `Sidebar` (export the `ICONS` map from `Sidebar.tsx` or move it to `components/layout/icons.ts` and import it in both), and `AppShell` passes `items={mobileNavFor(profile.role)}`.

- [ ] **Step 4: Test hygiene**

`tests/setup/fixtures.ts`: replace `cleanupOrg` and add the guard in `createUser`:
```ts
export async function cleanupOrg(orgId: string | undefined): Promise<void> {
  if (!orgId) return // a failed setup must not hide its own error behind a cleanup error
  const admin = adminClient()
  const problems: string[] = []
  const note = (what: string, error: { message: string } | null) => {
    if (error) problems.push(`${what}: ${error.message}`)
  }
  // Remove the NVR passwords from the vault before their stores disappear.
  const { data: stores, error: sErr } = await admin.from('stores').select('id').eq('org_id', orgId)
  note('list stores', sErr)
  for (const s of stores ?? []) note('vault', (await admin.rpc('nvr_delete_credential', { p_store: s.id })).error)
  for (const table of ORG_TABLES_IN_DELETE_ORDER) {
    // @ts-expect-error -- table names here are plain strings on purpose
    note(table, (await admin.from(table).delete().eq('org_id', orgId)).error)
  }
  const { data: people, error: pErr } = await admin.from('profiles').select('id').eq('org_id', orgId)
  note('list profiles', pErr)
  for (const p of people ?? []) note('auth user', (await admin.auth.admin.deleteUser(p.id)).error)
  note('profiles', (await admin.from('profiles').delete().eq('org_id', orgId)).error)
  note('organization', (await admin.from('organizations').delete().eq('id', orgId)).error)
  if (problems.length) throw new Error(`cleanupOrg(${orgId}) left rows behind: ${problems.join('; ')}`)
}
```
In `createUser`, wrap everything after the `auth.admin.createUser` call in `try { … } catch (e) { await admin.auth.admin.deleteUser(data.user.id); throw e }` so a failed profile insert or sign-in does not leave an orphan auth user.

`tests/unit/api-routes.test.ts`: save `process.env.NEXT_PUBLIC_BUILD_ID` in a `beforeEach` and restore (or delete) it in `afterEach`.

- [ ] **Step 5: Run everything**

Run: `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration`.
Expected: all green, no leftover imports of `lib/auth/roles`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: single source for roles and shared types, test hygiene, negative row-security tests"
```

---

### Task 3: Monitoring schema, state function, uptime and store status view

**Files:**
- Create: `supabase/migrations/20261021000005_monitoring.sql`, `supabase/rollback/20261021000005_monitoring_rollback.sql`
- Modify: `tests/setup/fixtures.ts` (delete order), `types/database.ts` (regenerated)
- Test: `tests/integration/monitoring-db.test.ts`

**Interfaces:**
- Produces tables `check_state`, `outages` (organisation-scoped, readable by people through visibility), `worker_state` (single row id 1) and `monitor_gaps` (server only); function `monitor_apply_results(p_org uuid, p_results jsonb, p_threshold integer default 2) returns void` (service role only; each element is `{type: 'camera'|'device'|'nvr', id: uuid, ok: boolean, at: timestamptz, method?: text, error?: text, cause?: 'nvr_down'}`); function `targets_uptime(p_org uuid, p_type text, p_ids uuid[], p_window interval, p_now timestamptz default now()) returns table(target_id uuid, uptime_pct numeric)` (service role only); view `store_status` (`security_invoker`, readable by `authenticated`) with `store_id, org_id, cameras_total, cameras_live, cameras_down, cameras_unknown, nvr_status, nvr_down_since, nvr_checked_at`; triggers that remove status and outages when a camera, device or store is deleted.

- [ ] **Step 1: Update the fixtures delete order**

In `tests/setup/fixtures.ts` add `'outages'` and `'check_state'` at the start of `ORG_TABLES_IN_DELETE_ORDER` (before `'admin_audit_log'`).

- [ ] **Step 2: Write the failing test**

`tests/integration/monitoring-db.test.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'

const admin = () => adminClient()
const T0 = new Date('2026-03-10T10:00:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString()

type R = { type: 'camera' | 'device' | 'nvr'; id: string; ok: boolean; at: string; method?: string; error?: string; cause?: 'nvr_down' }
const apply = (org: string, results: R[], threshold = 2) => admin().rpc('monitor_apply_results', { p_org: org, p_results: results, p_threshold: threshold })

describe('monitoring in the database', () => {
  let orgId: string
  let otherOrg: string
  let storeId: string
  let cam1: string
  let cam2: string
  let deviceId: string
  let viewer: TestUser
  let manager: TestUser
  let foreignCam: string
  const gapIds: string[] = []

  beforeAll(async () => {
    orgId = await createOrg()
    otherOrg = await createOrg()
    const a = admin()
    storeId = (await a.from('stores').insert({ org_id: orgId, code: 'MON', name: 'Mon', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    const cams = await a.from('cameras').insert([1, 2].map((n) => ({ org_id: orgId, store_id: storeId, channel: n, name: `C${n}` }))).select('id').order('channel')
    cam1 = cams.data![0].id
    cam2 = cams.data![1].id
    deviceId = (await a.from('devices').insert({ org_id: orgId, store_id: storeId, type: 'server', name: 'ERP', ip: '127.0.0.1', tcp_port: 9 }).select('id').single()).data!.id
    const otherStore = (await a.from('stores').insert({ org_id: otherOrg, code: 'OTH', name: 'Oth', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    foreignCam = (await a.from('cameras').insert({ org_id: otherOrg, store_id: otherStore, channel: 1, name: 'F' }).select('id').single()).data!.id
    viewer = await createUser(orgId, 'user')
    manager = await createUser(orgId, 'manager')
    await a.rpc('replace_user_access', { p_user: viewer.id, p_stores: [], p_zones: [], p_cameras: [cam1] })
  })

  afterAll(async () => {
    if (gapIds.length) await admin().from('monitor_gaps').delete().in('id', gapIds)
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })

  const state = async (type: string, id: string) =>
    (await admin().from('check_state').select('*').eq('org_id', orgId).eq('target_type', type).eq('target_id', id).maybeSingle()).data
  const outagesOf = async (type: string, id: string) =>
    (await admin().from('outages').select('*').eq('org_id', orgId).eq('target_type', type).eq('target_id', id).order('started_at')).data ?? []

  it('one failure is not an outage; the second opens it at the time of the first failure', async () => {
    await apply(orgId, [{ type: 'camera', id: cam1, ok: false, at: at(0), method: 'isapi', error: 'no answer' }])
    let s = await state('camera', cam1)
    expect(s?.status).toBe('unknown')
    expect(s?.consecutive_failures).toBe(1)
    expect(await outagesOf('camera', cam1)).toHaveLength(0)

    await apply(orgId, [{ type: 'camera', id: cam1, ok: false, at: at(5), method: 'isapi', error: 'no answer' }])
    s = await state('camera', cam1)
    expect(s?.status).toBe('down')
    expect(new Date(s!.down_since!).toISOString()).toBe(at(0))
    const o = await outagesOf('camera', cam1)
    expect(o).toHaveLength(1)
    expect(new Date(o[0].started_at).toISOString()).toBe(at(0))
    expect(o[0].ended_at).toBeNull()
  })

  it('more failures do not open a second outage; the first success closes it', async () => {
    await apply(orgId, [{ type: 'camera', id: cam1, ok: false, at: at(10) }])
    expect(await outagesOf('camera', cam1)).toHaveLength(1)
    await apply(orgId, [{ type: 'camera', id: cam1, ok: true, at: at(15), method: 'isapi' }])
    const s = await state('camera', cam1)
    expect(s?.status).toBe('up')
    expect(s?.consecutive_failures).toBe(0)
    expect(s?.error).toBeNull()
    expect(new Date(s!.last_up_at!).toISOString()).toBe(at(15))
    const o = await outagesOf('camera', cam1)
    expect(new Date(o[0].ended_at!).toISOString()).toBe(at(15))
  })

  it('a flapping target (fail, ok, fail) never reaches down', async () => {
    await apply(orgId, [{ type: 'device', id: deviceId, ok: false, at: at(0) }])
    await apply(orgId, [{ type: 'device', id: deviceId, ok: true, at: at(1) }])
    await apply(orgId, [{ type: 'device', id: deviceId, ok: false, at: at(2) }])
    expect((await state('device', deviceId))?.status).toBe('up')
    expect(await outagesOf('device', deviceId)).toHaveLength(0)
  })

  it('with threshold 1 and cause nvr_down a failure opens an outage at once, with the cause', async () => {
    await apply(orgId, [{ type: 'camera', id: cam2, ok: false, at: at(20), method: 'nvr_down', cause: 'nvr_down' }], 1)
    const s = await state('camera', cam2)
    expect(s?.status).toBe('down')
    const o = await outagesOf('camera', cam2)
    expect(o).toHaveLength(1)
    expect(o[0].cause).toBe('nvr_down')
  })

  it('ignores targets that do not belong to the organisation', async () => {
    await apply(orgId, [{ type: 'camera', id: foreignCam, ok: false, at: at(0) }, { type: 'camera', id: randomUUID(), ok: true, at: at(0) }])
    const { data } = await admin().from('check_state').select('id').eq('target_id', foreignCam)
    expect(data).toEqual([])
  })

  it('deleting a camera, a device or a store removes its status and outages', async () => {
    const a = admin()
    const { data: s2 } = await a.from('stores').insert({ org_id: orgId, code: 'GONE', name: 'Gone', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    const { data: c } = await a.from('cameras').insert({ org_id: orgId, store_id: s2!.id, channel: 1, name: 'G' }).select('id').single()
    await apply(orgId, [{ type: 'nvr', id: s2!.id, ok: false, at: at(0) }, { type: 'camera', id: c!.id, ok: false, at: at(0) }], 1)
    expect((await state('nvr', s2!.id))?.status).toBe('down')
    await a.from('stores').delete().eq('id', s2!.id)
    expect(await state('nvr', s2!.id)).toBeNull()
    expect(await state('camera', c!.id)).toBeNull()
    expect(await outagesOf('camera', c!.id)).toHaveLength(0)
    expect(await outagesOf('nvr', s2!.id)).toHaveLength(0)
  })

  it('people read status only for what they may see, and nobody but the server writes it', async () => {
    // viewer was granted cam1 only
    const seen = await viewer.client.from('check_state').select('target_type, target_id')
    expect(seen.data).toEqual([{ target_type: 'camera', target_id: cam1 }])
    const seenManager = await manager.client.from('check_state').select('target_id')
    expect((seenManager.data ?? []).map((r) => r.target_id)).toEqual(expect.arrayContaining([cam1, cam2, deviceId]))
    const ins = await viewer.client.from('check_state').insert({ org_id: orgId, target_type: 'camera', target_id: cam1 })
    expect(ins.error?.code).toBe('42501')
    expect((await viewer.client.from('outages').select('target_id')).data?.map((r) => r.target_id)).toEqual([cam1])
    expect((await viewer.client.from('worker_state').select('id')).error?.code).toBe('42501')
    expect((await viewer.client.rpc('monitor_apply_results', { p_org: orgId, p_results: [], p_threshold: 2 })).error?.code).toBe('42501')
  })

  it('store_status counts what the reader may see', async () => {
    await apply(orgId, [{ type: 'nvr', id: storeId, ok: true, at: at(30) }])
    const m = await manager.client.from('store_status').select('*').eq('store_id', storeId).single()
    expect(m.data).toMatchObject({ cameras_total: 2, cameras_live: 1, cameras_down: 1, cameras_unknown: 0, nvr_status: 'up' })
    const v = await viewer.client.from('store_status').select('*').eq('store_id', storeId).single()
    expect(v.data).toMatchObject({ cameras_total: 1, cameras_live: 1, cameras_down: 0 })
  })

  describe('uptime', () => {
    const NOW = new Date('2026-04-01T20:00:00Z')
    const t = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
    let u: string // camera used for the uptime cases

    const uptime = async (windowHours: number, id = u) => {
      const { data, error } = await admin().rpc('targets_uptime', { p_org: orgId, p_type: 'camera', p_ids: [id], p_window: `${windowHours} hours`, p_now: NOW.toISOString() })
      expect(error).toBeNull()
      return data?.[0]?.uptime_pct ?? null
    }
    const makeCamera = async (n: number, createdHoursAgo: number) => {
      const a = admin()
      const { data } = await a.from('cameras').insert({ org_id: orgId, store_id: storeId, channel: 10 + n, name: `U${n}` }).select('id').single()
      await a.from('check_state').insert({ org_id: orgId, target_type: 'camera', target_id: data!.id, status: 'up', created_at: t(createdHoursAgo) })
      return data!.id
    }
    const outage = (id: string, fromH: number, toH: number | null) =>
      admin().from('outages').insert({ org_id: orgId, target_type: 'camera', target_id: id, started_at: t(fromH), ended_at: toH === null ? null : t(toH) })
    const gap = async (fromH: number, toH: number) => {
      const { data } = await admin().from('monitor_gaps').insert({ started_at: t(fromH), ended_at: t(toH) }).select('id').single()
      gapIds.push(data!.id)
    }

    it('is 90 percent for a one hour outage in a ten hour window', async () => {
      u = await makeCamera(1, 20)
      await outage(u, 6, 5)
      expect(Number(await uptime(10))).toBeCloseTo(90, 1)
    })

    it('has no value for a target that was never checked', async () => {
      expect(await uptime(10, randomUUID())).toBeNull()
    })

    it('starts counting when the target was first checked', async () => {
      const c = await makeCamera(2, 2)
      expect(Number(await uptime(24, c))).toBeCloseTo(100, 1)
    })

    it('counts an outage that is still open up to now', async () => {
      const c = await makeCamera(3, 20)
      await outage(c, 5, null)
      expect(Number(await uptime(10, c))).toBeCloseTo(50, 1)
    })

    it('leaves out the time the worker was not running', async () => {
      const c = await makeCamera(4, 20)
      await outage(c, 7.5, 6) // 1.5 hours down
      await gap(8, 7) // worker stopped from 8h to 7h ago: 0.5 of the outage is inside the gap
      // window 10h: observed = 10 - 1 = 9h; down = 1.5 - 0.5 = 1h; uptime = 8/9
      expect(Number(await uptime(10, c))).toBeCloseTo((8 / 9) * 100, 1)
    })
  })
})
```

- [ ] **Step 3: Run to see it fail**

Run: `npx vitest run tests/integration/monitoring-db.test.ts`
Expected: FAIL (tables and functions are missing).

- [ ] **Step 4: Write the migration and its rollback**

`supabase/migrations/20261021000005_monitoring.sql`:
```sql
-- Monitoring: current status, outage periods, worker state, state function, uptime function, store status view.
-- Rollback: supabase/rollback/20261021000005_monitoring_rollback.sql
BEGIN;

CREATE TABLE public.check_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  target_type text NOT NULL CHECK (target_type IN ('camera', 'device', 'nvr')),
  target_id uuid NOT NULL,  -- for 'nvr' this is the store id
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('up', 'down', 'unknown')),
  last_checked_at timestamptz,
  last_up_at timestamptz,
  first_failure_at timestamptz,
  down_since timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  method text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_state_target_key UNIQUE (org_id, target_type, target_id)
);
CREATE INDEX check_state_status_idx ON public.check_state (org_id, target_type, status);

CREATE TABLE public.outages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  target_type text NOT NULL CHECK (target_type IN ('camera', 'device', 'nvr')),
  target_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  cause text CHECK (cause IS NULL OR cause = 'nvr_down'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outages_order_check CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX outages_target_idx ON public.outages (org_id, target_type, target_id, started_at);
CREATE INDEX outages_recent_idx ON public.outages (org_id, started_at DESC);
-- At most one open outage per target.
CREATE UNIQUE INDEX outages_one_open_idx ON public.outages (org_id, target_type, target_id) WHERE ended_at IS NULL;

-- Single row: the worker's heartbeat, the "check now" request and the progress of the current run.
CREATE TABLE public.worker_state (
  id integer PRIMARY KEY CHECK (id = 1),
  last_heartbeat timestamptz,
  check_requested_at timestamptz,
  run_started_at timestamptz,
  run_finished_at timestamptz,
  progress_done integer NOT NULL DEFAULT 0,
  progress_total integer NOT NULL DEFAULT 0
);
INSERT INTO public.worker_state (id) VALUES (1);

-- Periods when the worker was not running. Excluded from uptime.
CREATE TABLE public.monitor_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  CONSTRAINT monitor_gaps_order_check CHECK (ended_at >= started_at)
);
CREATE INDEX monitor_gaps_range_idx ON public.monitor_gaps (started_at, ended_at);

CREATE TRIGGER check_state_updated BEFORE UPDATE ON public.check_state FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Status and outages disappear with the thing they describe (the target ids are not foreign keys because they point at three tables).
CREATE OR REPLACE FUNCTION public.monitor_forget_target() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM check_state WHERE org_id = OLD.org_id AND target_type = TG_ARGV[0] AND target_id = OLD.id;
  DELETE FROM outages WHERE org_id = OLD.org_id AND target_type = TG_ARGV[0] AND target_id = OLD.id;
  RETURN OLD;
END
$$;
CREATE TRIGGER cameras_forget AFTER DELETE ON public.cameras FOR EACH ROW EXECUTE FUNCTION public.monitor_forget_target('camera');
CREATE TRIGGER devices_forget AFTER DELETE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.monitor_forget_target('device');
CREATE TRIGGER stores_forget AFTER DELETE ON public.stores FOR EACH ROW EXECUTE FUNCTION public.monitor_forget_target('nvr');

-- ── The failure / outage rules, in one place ─────────────────────────────────
-- p_results: [{type, id, ok, at, method?, error?, cause?}]. A target goes down after p_threshold failures in a row and comes up on
-- the first success. An outage starts at the time of the first failure of the run of failures.
CREATE OR REPLACE FUNCTION public.monitor_apply_results(p_org uuid, p_results jsonb, p_threshold integer DEFAULT 2) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r jsonb;
  v_type text;
  v_id uuid;
  v_ok boolean;
  v_at timestamptz;
  v_method text;
  v_error text;
  v_cause text;
  s public.check_state%ROWTYPE;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(p_results) LOOP
    v_type := r ->> 'type';
    v_id := (r ->> 'id')::uuid;
    v_ok := (r ->> 'ok')::boolean;
    v_at := (r ->> 'at')::timestamptz;
    v_method := r ->> 'method';
    v_error := left(r ->> 'error', 300);
    v_cause := r ->> 'cause';

    -- Never trust ids from outside: the target must exist and belong to this organisation.
    IF NOT (
      (v_type = 'camera' AND EXISTS (SELECT 1 FROM cameras WHERE id = v_id AND org_id = p_org)) OR
      (v_type = 'device' AND EXISTS (SELECT 1 FROM devices WHERE id = v_id AND org_id = p_org)) OR
      (v_type = 'nvr' AND EXISTS (SELECT 1 FROM stores WHERE id = v_id AND org_id = p_org))
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO check_state (org_id, target_type, target_id, created_at)
    VALUES (p_org, v_type, v_id, v_at)
    ON CONFLICT (org_id, target_type, target_id) DO NOTHING;

    SELECT * INTO s FROM check_state WHERE org_id = p_org AND target_type = v_type AND target_id = v_id FOR UPDATE;

    s.last_checked_at := v_at;
    s.method := v_method;
    IF v_ok THEN
      s.status := 'up';
      s.consecutive_failures := 0;
      s.last_up_at := v_at;
      s.first_failure_at := NULL;
      s.down_since := NULL;
      s.error := NULL;
      UPDATE outages SET ended_at = greatest(v_at, started_at)
      WHERE org_id = p_org AND target_type = v_type AND target_id = v_id AND ended_at IS NULL;
    ELSE
      s.error := v_error;
      IF s.consecutive_failures = 0 THEN s.first_failure_at := v_at; END IF;
      s.consecutive_failures := s.consecutive_failures + 1;
      IF s.consecutive_failures >= p_threshold AND s.status <> 'down' THEN
        s.status := 'down';
        s.down_since := coalesce(s.first_failure_at, v_at);
        INSERT INTO outages (org_id, target_type, target_id, started_at, cause)
        VALUES (p_org, v_type, v_id, s.down_since, v_cause)
        ON CONFLICT (org_id, target_type, target_id) WHERE ended_at IS NULL DO NOTHING;
      END IF;
    END IF;

    UPDATE check_state
    SET status = s.status, last_checked_at = s.last_checked_at, last_up_at = s.last_up_at,
        first_failure_at = s.first_failure_at, down_since = s.down_since,
        consecutive_failures = s.consecutive_failures, method = s.method, error = s.error
    WHERE id = s.id;
  END LOOP;
END
$$;

-- ── Uptime ───────────────────────────────────────────────────────────────────
-- Percent of the observed time a target was up. Observed time excludes the time before the first check and the periods the
-- worker was not running; down time inside such a period is not counted either. No row = nothing observed yet.
CREATE OR REPLACE FUNCTION public.targets_uptime(
  p_org uuid, p_type text, p_ids uuid[], p_window interval, p_now timestamptz DEFAULT now()
) RETURNS TABLE (target_id uuid, uptime_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH base AS (
    SELECT cs.target_id AS tid, greatest(p_now - p_window, cs.created_at) AS ws
    FROM check_state cs
    WHERE cs.org_id = p_org AND cs.target_type = p_type AND cs.target_id = ANY (p_ids)
  ),
  obs AS (
    SELECT b.tid, b.ws,
           extract(epoch FROM (p_now - b.ws))
           - coalesce((SELECT sum(extract(epoch FROM (least(g.ended_at, p_now) - greatest(g.started_at, b.ws))))
                       FROM monitor_gaps g WHERE g.ended_at > b.ws AND g.started_at < p_now), 0) AS observed
    FROM base b
    WHERE b.ws < p_now
  ),
  dn AS (
    SELECT o.tid,
           sum(
             extract(epoch FROM (least(coalesce(ou.ended_at, p_now), p_now) - greatest(ou.started_at, o.ws)))
             - coalesce((SELECT sum(greatest(0, extract(epoch FROM (
                           least(coalesce(ou.ended_at, p_now), g.ended_at, p_now) - greatest(ou.started_at, g.started_at, o.ws)))))
                         FROM monitor_gaps g
                         WHERE g.ended_at > greatest(ou.started_at, o.ws) AND g.started_at < least(coalesce(ou.ended_at, p_now), p_now)), 0)
           ) AS down
    FROM obs o
    JOIN outages ou ON ou.org_id = p_org AND ou.target_type = p_type AND ou.target_id = o.tid
                   AND ou.started_at < p_now AND coalesce(ou.ended_at, p_now) > o.ws
    GROUP BY o.tid
  )
  SELECT o.tid,
         CASE WHEN o.observed <= 0 THEN NULL
              ELSE round(100 * greatest(0, least(o.observed, o.observed - coalesce(d.down, 0))) / o.observed, 2) END
  FROM obs o LEFT JOIN dn d ON d.tid = o.tid
$$;

-- ── Per-store summary, evaluated with the reader's own visibility ────────────
CREATE VIEW public.store_status WITH (security_invoker = true) AS
SELECT s.id AS store_id,
       s.org_id,
       count(c.id)::integer AS cameras_total,
       (count(c.id) FILTER (WHERE cs.status = 'up'))::integer AS cameras_live,
       (count(c.id) FILTER (WHERE cs.status = 'down'))::integer AS cameras_down,
       (count(c.id) FILTER (WHERE cs.status IS NULL OR cs.status = 'unknown'))::integer AS cameras_unknown,
       nvr.status AS nvr_status,
       nvr.down_since AS nvr_down_since,
       nvr.last_checked_at AS nvr_checked_at
FROM public.stores s
LEFT JOIN public.cameras c ON c.store_id = s.id
LEFT JOIN public.check_state cs ON cs.org_id = c.org_id AND cs.target_type = 'camera' AND cs.target_id = c.id
LEFT JOIN public.check_state nvr ON nvr.org_id = s.org_id AND nvr.target_type = 'nvr' AND nvr.target_id = s.id
GROUP BY s.id, s.org_id, nvr.status, nvr.down_since, nvr.last_checked_at;

-- ── Row-level security and grants ────────────────────────────────────────────
ALTER TABLE public.check_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitor_gaps ENABLE ROW LEVEL SECURITY;

-- People read the status of exactly the things they may see.
CREATE POLICY check_state_select ON public.check_state FOR SELECT TO authenticated
  USING (
    org_id = (SELECT public.current_org_id()) AND (
      (target_type = 'camera' AND target_id IN (SELECT public.visible_camera_ids())) OR
      (target_type = 'device' AND target_id IN (SELECT public.visible_device_ids())) OR
      (target_type = 'nvr' AND target_id IN (SELECT public.visible_store_ids()))
    )
  );
CREATE POLICY outages_select ON public.outages FOR SELECT TO authenticated
  USING (
    org_id = (SELECT public.current_org_id()) AND (
      (target_type = 'camera' AND target_id IN (SELECT public.visible_camera_ids())) OR
      (target_type = 'device' AND target_id IN (SELECT public.visible_device_ids())) OR
      (target_type = 'nvr' AND target_id IN (SELECT public.visible_store_ids()))
    )
  );

REVOKE ALL ON public.check_state, public.outages, public.worker_state, public.monitor_gaps, public.store_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.check_state, public.outages, public.store_status TO authenticated;
GRANT ALL ON public.check_state, public.outages, public.worker_state, public.monitor_gaps, public.store_status TO service_role;

REVOKE EXECUTE ON FUNCTION public.monitor_apply_results(uuid, jsonb, integer), public.targets_uptime(uuid, text, uuid[], interval, timestamptz),
  public.monitor_forget_target() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.monitor_apply_results(uuid, jsonb, integer), public.targets_uptime(uuid, text, uuid[], interval, timestamptz),
  public.monitor_forget_target() TO service_role;

COMMIT;
```

`supabase/rollback/20261021000005_monitoring_rollback.sql`:
```sql
BEGIN;
DROP VIEW IF EXISTS public.store_status;
DROP FUNCTION IF EXISTS public.targets_uptime(uuid, text, uuid[], interval, timestamptz);
DROP FUNCTION IF EXISTS public.monitor_apply_results(uuid, jsonb, integer);
DROP TRIGGER IF EXISTS stores_forget ON public.stores;
DROP TRIGGER IF EXISTS devices_forget ON public.devices;
DROP TRIGGER IF EXISTS cameras_forget ON public.cameras;
DROP FUNCTION IF EXISTS public.monitor_forget_target();
DROP TABLE IF EXISTS public.monitor_gaps, public.worker_state, public.outages, public.check_state;
COMMIT;
```

- [ ] **Step 5: Apply, regenerate types, run the tests**

Run: `npm run db:reset` (then `node scripts/create-dev-admin.mjs`), `npm run db:types`.
Run: `npx vitest run tests/integration/monitoring-db.test.ts` then `npm run test:integration`, `npm run typecheck`, `npm run lint`.
Expected: all green; `hardening.test.ts` still shows no privilege violations (the new tables carry explicit grants). If the uptime numbers are off, print the intermediate `obs` and `dn` rows by running the function body in `psql` against the local database and fix the SQL, not the test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: monitoring schema with state function, uptime function and store status view"
```

---

### Task 4: Test infrastructure: egress guard and fake network servers

**Files:**
- Create: `tests/setup/egress-guard.ts`, `tests/helpers/fake-servers.ts`, `tests/unit/egress-guard.test.ts`, `tests/unit/fake-servers.test.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces: every test process refuses outbound connections to anything but loopback; in `tests/helpers/fake-servers.ts`: `startFakeTcp(): Promise<Running>`, `closedPort(): Promise<number>`, `startFakeNvr(options?): Promise<FakeNvr>` (HTTP Digest ISAPI server), `startFakeRtsp(mode): Promise<FakeRtsp>`, with `Running = { port: number; close(): Promise<void> }`, `FakeNvr = Running & { requests: string[]; setStatuses(s: Record<number, boolean>): void }`, `FakeRtsp = Running & { requests: string[] }`, `FakeNvrOptions = { username?: string; password?: string; statuses?: Record<number, boolean>; channels?: {channel: number; name: string; ip?: string}[]; mode?: 'ok' | 'forbidden' | 'garbage' | 'slow' }`, `FakeRtspMode = 'open' | 'needs-auth' | 'refuse' | 'always-401'`. Defaults: user `viewer`, password `secret-pass`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/egress-guard.test.ts`:
```ts
import net from 'node:net'
import { describe, expect, it } from 'vitest'

const tryConnect = (host: string, port: number) =>
  new Promise<string>((resolve) => {
    const s = net.connect({ host, port })
    s.once('error', (e) => resolve(e.message))
    s.once('connect', () => {
      s.destroy()
      resolve('connected')
    })
  })

describe('egress guard', () => {
  it('refuses a connection to an address outside loopback', async () => {
    expect(await tryConnect('192.0.2.1', 80)).toContain('Egress guard')
    expect(await tryConnect('example.org', 80)).toContain('Egress guard')
    expect(await tryConnect('10.0.0.141', 8000)).toContain('Egress guard')
  })

  it('lets loopback connections through', async () => {
    const server = net.createServer((s) => s.end())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    expect(await tryConnect('127.0.0.1', port)).toBe('connected')
    expect(await tryConnect('localhost', port)).toMatch(/connected|ECONNREFUSED/)
    server.close()
  })
})
```

`tests/unit/fake-servers.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { closedPort, startFakeNvr, startFakeRtsp, startFakeTcp, type Running } from '../helpers/fake-servers'
import net from 'node:net'

const running: Running[] = []
afterEach(async () => {
  while (running.length) await running.pop()!.close()
})

describe('fake servers', () => {
  it('the fake NVR asks for a digest login first', async () => {
    const nvr = await startFakeNvr()
    running.push(nvr)
    const res = await fetch(`http://127.0.0.1:${nvr.port}/ISAPI/ContentMgmt/InputProxy/channels/status`)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/^Digest realm="fake-nvr", qop="auth", nonce="[0-9a-f]+"/)
  })

  it('a closed port refuses connections and an open one accepts them', async () => {
    const open = await startFakeTcp()
    running.push(open)
    const gone = await closedPort()
    const connect = (port: number) =>
      new Promise<string>((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port })
        s.once('connect', () => { s.destroy(); resolve('open') })
        s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'))
      })
    expect(await connect(open.port)).toBe('open')
    expect(await connect(gone)).toBe('ECONNREFUSED')
  })

  it('the fake RTSP server answers DESCRIBE according to its mode', async () => {
    const rtsp = await startFakeRtsp('refuse')
    running.push(rtsp)
    const answer = await new Promise<string>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: rtsp.port }, () => s.write('DESCRIBE rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n'))
      s.once('data', (d) => { s.destroy(); resolve(d.toString().split('\r\n')[0]) })
    })
    expect(answer).toBe('RTSP/1.0 404 Not Found')
    expect(rtsp.requests[0]).toContain('DESCRIBE')
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/unit/egress-guard.test.ts tests/unit/fake-servers.test.ts`
Expected: FAIL (no guard yet; the helper module is missing).

- [ ] **Step 3: Write the guard and register it**

`tests/setup/egress-guard.ts`:
```ts
// Tests must never reach a real network. This refuses every outgoing connection that is not to loopback, whatever library opens it
// (fetch, the Supabase client, raw sockets) and every ping to a non-loopback address. Fakes listen on 127.0.0.1.
import childProcess from 'node:child_process'
import net from 'node:net'

const isLoopback = (host: string) => host === 'localhost' || host === '::1' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host)

function targetHost(args: unknown[]): string | null {
  const first = args[0]
  if (first && typeof first === 'object') {
    const o = first as { host?: string; path?: string }
    return o.path ? null : (o.host ?? 'localhost')
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null // a unix socket path
  return typeof args[1] === 'string' ? (args[1] as string) : 'localhost'
}

const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const host = targetHost(args)
  if (host !== null && !isLoopback(host)) {
    const err = new Error(`Egress guard: tests may only connect to loopback addresses (refused ${host})`)
    process.nextTick(() => this.destroy(err)) // looks like an ordinary connection failure to the caller
    return this
  }
  return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args)
} as typeof net.Socket.prototype.connect

const originalSpawn = childProcess.spawn
childProcess.spawn = function (command: string, ...rest: unknown[]) {
  const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : []
  if (/(^|[\\/])ping(\.exe)?$/i.test(command) && args.some((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a) && !isLoopback(a))) {
    throw new Error('Egress guard: tests may not ping addresses outside loopback')
  }
  return (originalSpawn as (...a: unknown[]) => childProcess.ChildProcess)(command, ...rest)
} as typeof childProcess.spawn
```
In `vitest.config.ts` set `setupFiles: ['tests/setup/env.ts', 'tests/setup/egress-guard.ts']`.

- [ ] **Step 4: Write the fake servers**

`tests/helpers/fake-servers.ts`:
```ts
// Fake network for tests and for the local demo. Everything listens on 127.0.0.1 only.
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'

export type Running = { port: number; close: () => Promise<void> }

const md5 = (s: string) => createHash('md5').update(s).digest('hex')

function listen(server: net.Server | http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
}

function closer(server: net.Server | http.Server, sockets: Set<net.Socket>) {
  return () =>
    new Promise<void>((resolve) => {
      sockets.forEach((s) => s.destroy())
      server.close(() => resolve())
    })
}

/** Accepts a connection and closes it at once: enough for a TCP "is it there" check. */
export async function startFakeTcp(fixedPort = 0): Promise<Running> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('error', () => {})
    s.end()
  })
  const port = await new Promise<number>((resolve) => server.listen(fixedPort, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
  return { port, close: closer(server, sockets) }
}

/** A port nothing listens on: open a server, remember its port, close it. */
export async function closedPort(): Promise<number> {
  const s = await startFakeTcp()
  const port = s.port
  await s.close()
  return port
}

// ── Fake Hikvision NVR (ISAPI over HTTP Digest) ──────────────────────────────
export type FakeNvrOptions = {
  username?: string
  password?: string
  statuses?: Record<number, boolean>
  channels?: { channel: number; name: string; ip?: string }[]
  mode?: 'ok' | 'forbidden' | 'garbage' | 'slow'
  port?: number
}
export type FakeNvr = Running & { requests: string[]; setStatuses: (s: Record<number, boolean>) => void }

const NS = 'xmlns="http://www.hikvision.com/ver20/XMLSchema"'

const statusXml = (s: Record<number, boolean>) =>
  `<?xml version="1.0" encoding="UTF-8"?><InputProxyChannelStatusList version="2.0" ${NS}>` +
  Object.entries(s)
    .map(([ch, on]) => `<InputProxyChannelStatus><id>${ch}</id><sourceInputPortDescriptor><ipAddress>192.0.2.${ch}</ipAddress></sourceInputPortDescriptor><online>${on}</online></InputProxyChannelStatus>`)
    .join('') +
  '</InputProxyChannelStatusList>'

const channelsXml = (list: { channel: number; name: string; ip?: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><InputProxyChannelList version="2.0" ${NS}>` +
  list
    .map((c) => `<InputProxyChannel><id>${c.channel}</id><name>${c.name}</name>${c.ip ? `<sourceInputPortDescriptor><ipAddress>${c.ip}</ipAddress></sourceInputPortDescriptor>` : ''}</InputProxyChannel>`)
    .join('') +
  '</InputProxyChannelList>'

const videoInputXml = (list: { channel: number; name: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><VideoInputChannelList version="2.0" ${NS}>` +
  list.map((c) => `<VideoInputChannel><id>${c.channel}</id><name>${c.name}</name></VideoInputChannel>`).join('') +
  '</VideoInputChannelList>'

function parseAuth(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of header.replace(/^Digest\s+/i, '').matchAll(/([a-z]+)=(?:"([^"]*)"|([^\s,]+))/gi)) out[m[1].toLowerCase()] = m[2] ?? m[3]
  return out
}

export async function startFakeNvr(options: FakeNvrOptions = {}): Promise<FakeNvr> {
  const user = options.username ?? 'viewer'
  const pass = options.password ?? 'secret-pass'
  const realm = 'fake-nvr'
  let statuses = options.statuses ?? {}
  const channels = options.channels ?? Object.keys(statuses).map((n) => ({ channel: Number(n), name: `Camera ${n}` }))
  const requests: string[] = []
  const nonces = new Set<string>()
  const sockets = new Set<net.Socket>()

  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    if (options.mode === 'slow') return // never answers
    const challenge = () => {
      const nonce = randomBytes(8).toString('hex')
      nonces.add(nonce)
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="op"` })
      res.end()
    }
    const auth = req.headers.authorization
    if (!auth || !/^Digest /i.test(auth)) return challenge()
    const p = parseAuth(auth)
    const ha1 = md5(`${user}:${realm}:${pass}`)
    const ha2 = md5(`${req.method}:${p.uri}`)
    const expected = md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${ha2}`)
    if (p.username !== user || !nonces.has(p.nonce) || p.response !== expected) return challenge()
    if (options.mode === 'forbidden') {
      res.writeHead(403)
      return res.end()
    }
    const path = (req.url ?? '').split('?')[0]
    const send = (xml: string) => {
      res.writeHead(200, { 'Content-Type': 'application/xml' })
      res.end(xml)
    }
    if (options.mode === 'garbage') return send('this is not xml')
    if (path === '/ISAPI/ContentMgmt/InputProxy/channels/status') return send(statusXml(statuses))
    if (path === '/ISAPI/ContentMgmt/InputProxy/channels') return send(channelsXml(channels))
    if (path === '/ISAPI/System/Video/inputs/channels') return send(videoInputXml(channels))
    res.writeHead(404)
    res.end()
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  const port = await new Promise<number>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
  return { port, requests, setStatuses: (s) => (statuses = s), close: closer(server, sockets) }
}

// ── Fake RTSP camera endpoint ────────────────────────────────────────────────
export type FakeRtspMode = 'open' | 'needs-auth' | 'refuse' | 'always-401'
export type FakeRtsp = Running & { requests: string[] }

export async function startFakeRtsp(mode: FakeRtspMode, fixedPort = 0): Promise<FakeRtsp> {
  const requests: string[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('error', () => {})
    let buf = ''
    s.on('data', (d) => {
      buf += d.toString()
      if (!buf.includes('\r\n\r\n')) return
      requests.push(buf.split('\r\n')[0])
      const challenge = `RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="fake-cam", nonce="${randomBytes(8).toString('hex')}"\r\n\r\n`
      const hasAuth = /\r\nAuthorization:/i.test(buf)
      if (mode === 'open') s.end('RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n')
      else if (mode === 'refuse') s.end('RTSP/1.0 404 Not Found\r\nCSeq: 1\r\n\r\n')
      else if (mode === 'always-401') s.end(challenge)
      else s.end(hasAuth ? 'RTSP/1.0 200 OK\r\nCSeq: 2\r\n\r\n' : challenge)
    })
  })
  const port = await new Promise<number>((resolve) => server.listen(fixedPort, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
  return { port, requests, close: closer(server, sockets) }
}
```

- [ ] **Step 5: Run the checks**

Run: `npx vitest run tests/unit` (all unit tests, including the guard and fakes), `npm run typecheck`, `npm run lint`.
Expected: green. Also run `npm run test:integration` once: the guard must not break the Supabase client (it connects to `127.0.0.1:55321`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: egress guard and fake NVR, RTSP and TCP servers"
```

---

### Task 5: HTTP Digest, ISAPI parsing and the NVR client

**Files:**
- Create: `lib/nvr/digest.ts`, `lib/nvr/isapi.ts`, `lib/nvr/client.ts`
- Test: `tests/unit/digest.test.ts`, `tests/unit/isapi.test.ts`, `tests/unit/nvr-client.test.ts`

**Interfaces:**
- Produces: `parseDigestChallenge(header): DigestChallenge | null`, `buildDigestHeader(challenge, {username, password, method, uri, nc?, cnonce?}): string`, `digestFetch(url, {method?, headers?, body?, username, password, timeoutMs?}, fetchImpl?): Promise<Response>`; `parseChannelStatus(xml): Map<number, boolean>`, `parseChannels(xml): NvrChannel[]`, `parseVideoInputChannels(xml): NvrChannel[]` with `NvrChannel = {channel: number; name: string; ip: string | null}`; `NvrClient` (`new NvrClient({host, port, username, password}, {timeoutMs?, fetchImpl?})`, `channelStatus(): Promise<Map<number, boolean>>`, `channels(): Promise<NvrChannel[]>`), `NvrError` with `kind: 'unreachable' | 'timeout' | 'auth' | 'forbidden' | 'bad_response'`, and `describeNvrError(e): string` (plain wording for screens).

- [ ] **Step 1: Write the failing tests**

`tests/unit/digest.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildDigestHeader, digestFetch, parseDigestChallenge } from '@/lib/nvr/digest'
import { startFakeNvr } from '../helpers/fake-servers'

describe('digest challenge', () => {
  it('reads realm, nonce, qop and opaque', () => {
    const c = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')
    expect(c).toEqual({ realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', qop: 'auth', opaque: '5ccc069c403ebaf9f0171e9517f40e41', algorithm: 'MD5' })
  })
  it('refuses anything that is not Digest with MD5', () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull()
    expect(parseDigestChallenge('Digest realm="x", nonce="n", algorithm=SHA-256')).toBeNull()
    expect(parseDigestChallenge('Digest realm="x", nonce="n", qop="auth-int"')).toBeNull()
    expect(parseDigestChallenge('Digest nonce="n"')).toBeNull()
  })
})

describe('digest header', () => {
  it('matches the worked example of RFC 2617', () => {
    const challenge = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!
    const header = buildDigestHeader(challenge, { username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html', nc: 1, cnonce: '0a4f113b' })
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"')
    expect(header).toContain('nc=00000001')
    expect(header).toContain('qop=auth')
  })
})

describe('digestFetch against the fake NVR', () => {
  it('logs in with the right password', async () => {
    const nvr = await startFakeNvr({ statuses: { 1: true } })
    const res = await digestFetch(`http://127.0.0.1:${nvr.port}/ISAPI/ContentMgmt/InputProxy/channels/status`, { username: 'viewer', password: 'secret-pass' })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<online>true</online>')
    await nvr.close()
  })
  it('gets 401 with a wrong password', async () => {
    const nvr = await startFakeNvr()
    const res = await digestFetch(`http://127.0.0.1:${nvr.port}/ISAPI/ContentMgmt/InputProxy/channels/status`, { username: 'viewer', password: 'wrong' })
    expect(res.status).toBe(401)
    await nvr.close()
  })
})
```

`tests/unit/isapi.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseChannelStatus, parseChannels, parseVideoInputChannels } from '@/lib/nvr/isapi'

const NS = 'xmlns="http://www.hikvision.com/ver20/XMLSchema"'

describe('ISAPI parsing', () => {
  it('reads which channels are online', () => {
    const xml = `<InputProxyChannelStatusList ${NS}>
      <InputProxyChannelStatus><id>1</id><online>true</online></InputProxyChannelStatus>
      <InputProxyChannelStatus><id>2</id><online>false</online></InputProxyChannelStatus>
      <InputProxyChannelStatus version="2.0"><id>3</id><online> TRUE </online></InputProxyChannelStatus>
    </InputProxyChannelStatusList>`
    expect([...parseChannelStatus(xml)]).toEqual([[1, true], [2, false], [3, true]])
  })
  it('gives an empty map for an answer that is not a status list', () => {
    expect(parseChannelStatus('this is not xml').size).toBe(0)
  })
  it('reads channel names and camera addresses', () => {
    const xml = `<InputProxyChannelList ${NS}>
      <InputProxyChannel version="2.0"><id>1</id><name>Entrance</name><sourceInputPortDescriptor><ipAddress>192.0.2.11</ipAddress></sourceInputPortDescriptor></InputProxyChannel>
      <InputProxyChannel><id>2</id><name>Cash &amp; wrap</name></InputProxyChannel>
    </InputProxyChannelList>`
    expect(parseChannels(xml)).toEqual([
      { channel: 1, name: 'Entrance', ip: '192.0.2.11' },
      { channel: 2, name: 'Cash & wrap', ip: null },
    ])
  })
  it('reads the older video input list', () => {
    const xml = `<VideoInputChannelList ${NS}><VideoInputChannel><id>4</id><name>Back door</name></VideoInputChannel></VideoInputChannelList>`
    expect(parseVideoInputChannels(xml)).toEqual([{ channel: 4, name: 'Back door', ip: null }])
  })
})
```

`tests/unit/nvr-client.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { describeNvrError, NvrClient, NvrError } from '@/lib/nvr/client'
import { closedPort, startFakeNvr, type FakeNvr } from '../helpers/fake-servers'

let nvr: FakeNvr | null = null
afterEach(async () => {
  await nvr?.close()
  nvr = null
})
const client = (port: number, password = 'secret-pass', timeoutMs = 2000) => new NvrClient({ host: '127.0.0.1', port, username: 'viewer', password }, { timeoutMs })

describe('NvrClient', () => {
  it('reads channel status and channels', async () => {
    nvr = await startFakeNvr({ statuses: { 1: true, 2: false }, channels: [{ channel: 1, name: 'Door', ip: '192.0.2.11' }, { channel: 2, name: 'Till' }] })
    const c = client(nvr.port)
    expect([...(await c.channelStatus())]).toEqual([[1, true], [2, false]])
    expect(await c.channels()).toEqual([{ channel: 1, name: 'Door', ip: '192.0.2.11' }, { channel: 2, name: 'Till', ip: null }])
  })
  it('reports a wrong password as an auth problem', async () => {
    nvr = await startFakeNvr()
    await expect(client(nvr.port, 'wrong').channelStatus()).rejects.toMatchObject({ kind: 'auth' })
  })
  it('reports a user who may not read as forbidden', async () => {
    nvr = await startFakeNvr({ mode: 'forbidden' })
    await expect(client(nvr.port).channelStatus()).rejects.toMatchObject({ kind: 'forbidden' })
  })
  it('reports an unreachable NVR and a slow one', async () => {
    await expect(client(await closedPort()).channelStatus()).rejects.toMatchObject({ kind: 'unreachable' })
    nvr = await startFakeNvr({ mode: 'slow' })
    await expect(client(nvr.port, 'secret-pass', 300).channelStatus()).rejects.toMatchObject({ kind: 'timeout' })
  })
  it('reports a page that is not ISAPI XML as a bad response', async () => {
    nvr = await startFakeNvr({ mode: 'garbage' })
    await expect(client(nvr.port).channelStatus()).rejects.toMatchObject({ kind: 'bad_response' })
  })
  it('falls back to the older channel list', async () => {
    nvr = await startFakeNvr({ channels: [{ channel: 7, name: 'Yard' }] })
    // The fake serves both lists; make the first one empty by asking for a list whose proxy part is empty.
    const c = client(nvr.port)
    expect((await c.channels()).map((x) => x.channel)).toEqual([7])
  })
  it('says what went wrong in plain words', () => {
    expect(describeNvrError(new NvrError('auth', 'x'))).toBe('The NVR refused the user name or password.')
    expect(describeNvrError(new NvrError('forbidden', 'x'))).toBe('The NVR user is not allowed to read camera status.')
    expect(describeNvrError(new NvrError('unreachable', 'x'))).toBe('The NVR did not answer.')
    expect(describeNvrError(new NvrError('timeout', 'x'))).toBe('The NVR took too long to answer.')
    expect(describeNvrError(new NvrError('bad_response', 'x'))).toBe('The NVR gave an answer this app does not understand.')
    expect(describeNvrError(new Error('anything'))).toBe('The NVR check failed.')
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/unit/digest.test.ts tests/unit/isapi.test.ts tests/unit/nvr-client.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement digest**

`lib/nvr/digest.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto'

// HTTP Digest login (RFC 2617, MD5, qop=auth) for Hikvision NVRs, and the same header for RTSP.
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

export type DigestChallenge = { realm: string; nonce: string; qop: 'auth' | null; opaque: string | null; algorithm: 'MD5' }

export function parseDigestChallenge(header: string): DigestChallenge | null {
  const m = /^\s*Digest\s+(.*)$/i.exec(header)
  if (!m) return null
  const f: Record<string, string> = {}
  for (const p of m[1].matchAll(/([a-z]+)=(?:"([^"]*)"|([^\s,]+))/gi)) f[p[1].toLowerCase()] = p[2] ?? p[3]
  if (!f.realm || !f.nonce) return null
  if (f.algorithm && f.algorithm.toUpperCase() !== 'MD5') return null
  const offered = (f.qop ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (offered.length > 0 && !offered.includes('auth')) return null // only auth-int offered: not supported
  return { realm: f.realm, nonce: f.nonce, qop: offered.length ? 'auth' : null, opaque: f.opaque ?? null, algorithm: 'MD5' }
}

export type DigestCredentials = { username: string; password: string; method: string; uri: string; nc?: number; cnonce?: string }

export function buildDigestHeader(c: DigestChallenge, o: DigestCredentials): string {
  const nc = (o.nc ?? 1).toString(16).padStart(8, '0')
  const cnonce = o.cnonce ?? randomBytes(8).toString('hex')
  const ha1 = md5(`${o.username}:${c.realm}:${o.password}`)
  const ha2 = md5(`${o.method}:${o.uri}`)
  const response = c.qop ? md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:${c.qop}:${ha2}`) : md5(`${ha1}:${c.nonce}:${ha2}`)
  const parts = [`username="${o.username}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${o.uri}"`, `response="${response}"`]
  if (c.qop) parts.push(`qop=${c.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
  if (c.opaque) parts.push(`opaque="${c.opaque}"`)
  return `Digest ${parts.join(', ')}`
}

export type DigestRequest = { method?: string; headers?: Record<string, string>; body?: string; username: string; password: string; timeoutMs?: number }

/** One request with Digest login: asks, answers the challenge once, and returns the final response. Falls back to Basic if offered. */
export async function digestFetch(url: string, req: DigestRequest, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const u = new URL(url)
  const uri = u.pathname + u.search
  const method = req.method ?? 'GET'
  const timeout = req.timeoutMs ?? 8000
  const call = (headers?: Record<string, string>) =>
    fetchImpl(url, { method, headers: { ...req.headers, ...headers }, body: req.body, signal: AbortSignal.timeout(timeout), redirect: 'manual' })

  const first = await call()
  if (first.status !== 401) return first
  const header = first.headers.get('www-authenticate') ?? ''
  await first.body?.cancel()
  const challenge = parseDigestChallenge(header)
  if (challenge) return call({ Authorization: buildDigestHeader(challenge, { username: req.username, password: req.password, method, uri }) })
  if (/^\s*basic/i.test(header)) return call({ Authorization: 'Basic ' + Buffer.from(`${req.username}:${req.password}`).toString('base64') })
  return new Response(null, { status: 401 })
}
```

- [ ] **Step 4: Implement ISAPI parsing and the client**

`lib/nvr/isapi.ts`:
```ts
// Hikvision ISAPI answers are small XML documents; reading them with patterns keeps this free of an XML dependency.
export type NvrChannel = { channel: number; name: string; ip: string | null }

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const first = (block: string, tag: string) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)?.[1]?.trim() ?? null

/** channel number -> online. Empty when the answer is not a status list. */
export function parseChannelStatus(xml: string): Map<number, boolean> {
  const out = new Map<number, boolean>()
  for (const m of xml.matchAll(/<InputProxyChannelStatus\b[^>]*>([\s\S]*?)<\/InputProxyChannelStatus>/gi)) {
    const id = first(m[1], 'id')
    const online = first(m[1], 'online')
    if (id !== null && /^\d+$/.test(id) && online !== null) out.set(Number(id), online.toLowerCase() === 'true')
  }
  return out
}

export function parseChannels(xml: string): NvrChannel[] {
  const out: NvrChannel[] = []
  for (const m of xml.matchAll(/<InputProxyChannel\b[^>]*>([\s\S]*?)<\/InputProxyChannel>/gi)) {
    const id = first(m[1], 'id')
    if (id === null || !/^\d+$/.test(id)) continue
    out.push({ channel: Number(id), name: unescapeXml(first(m[1], 'name') ?? `Camera ${id}`), ip: first(m[1], 'ipAddress') })
  }
  return out
}

export function parseVideoInputChannels(xml: string): NvrChannel[] {
  const out: NvrChannel[] = []
  for (const m of xml.matchAll(/<VideoInputChannel\b[^>]*>([\s\S]*?)<\/VideoInputChannel>/gi)) {
    const id = first(m[1], 'id')
    if (id === null || !/^\d+$/.test(id)) continue
    out.push({ channel: Number(id), name: unescapeXml(first(m[1], 'name') ?? `Camera ${id}`), ip: null })
  }
  return out
}
```

`lib/nvr/client.ts`:
```ts
import { isIP } from 'node:net'
import { digestFetch } from '@/lib/nvr/digest'
import { parseChannels, parseChannelStatus, parseVideoInputChannels, type NvrChannel } from '@/lib/nvr/isapi'

export type NvrEndpoint = { host: string; port: number; username: string; password: string }
export type NvrErrorKind = 'unreachable' | 'timeout' | 'auth' | 'forbidden' | 'bad_response'

export class NvrError extends Error {
  constructor(public kind: NvrErrorKind, message: string) {
    super(message)
    this.name = 'NvrError'
  }
}

const MESSAGES: Record<NvrErrorKind, string> = {
  auth: 'The NVR refused the user name or password.',
  forbidden: 'The NVR user is not allowed to read camera status.',
  unreachable: 'The NVR did not answer.',
  timeout: 'The NVR took too long to answer.',
  bad_response: 'The NVR gave an answer this app does not understand.',
}

/** Plain wording for screens and for the stored "why" of a failed check. Never includes passwords or raw network errors. */
export function describeNvrError(e: unknown): string {
  return e instanceof NvrError ? MESSAGES[e.kind] : 'The NVR check failed.'
}

export type NvrClientOptions = { timeoutMs?: number; fetchImpl?: typeof fetch }

export class NvrClient {
  constructor(private ep: NvrEndpoint, private opts: NvrClientOptions = {}) {}

  private async get(path: string): Promise<string> {
    const host = isIP(this.ep.host) === 6 ? `[${this.ep.host}]` : this.ep.host
    let res: Response
    try {
      res = await digestFetch(`http://${host}:${this.ep.port}${path}`, { username: this.ep.username, password: this.ep.password, timeoutMs: this.opts.timeoutMs }, this.opts.fetchImpl)
    } catch (e) {
      const name = (e as { name?: string }).name
      throw new NvrError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable', 'request failed')
    }
    if (res.status === 401) throw new NvrError('auth', 'login refused')
    if (res.status === 403) throw new NvrError('forbidden', 'not allowed')
    if (res.status !== 200) throw new NvrError('bad_response', `status ${res.status}`)
    return res.text()
  }

  /** channel -> online, from the NVR's own view of its cameras. */
  async channelStatus(): Promise<Map<number, boolean>> {
    const map = parseChannelStatus(await this.get('/ISAPI/ContentMgmt/InputProxy/channels/status'))
    if (map.size === 0) throw new NvrError('bad_response', 'no channel status in the answer')
    return map
  }

  /** Channel numbers, names and (when the NVR knows them) camera addresses. */
  async channels(): Promise<NvrChannel[]> {
    try {
      const list = parseChannels(await this.get('/ISAPI/ContentMgmt/InputProxy/channels'))
      if (list.length > 0) return list
    } catch (e) {
      if (!(e instanceof NvrError) || e.kind !== 'bad_response') throw e
    }
    return parseVideoInputChannels(await this.get('/ISAPI/System/Video/inputs/channels'))
  }
}
```

- [ ] **Step 5: Run the checks**

Run: `npx vitest run tests/unit/digest.test.ts tests/unit/isapi.test.ts tests/unit/nvr-client.test.ts`, then `npm run test:unit`, `npm run typecheck`, `npm run lint`.
Expected: green. The "falls back" test only proves the fake serves the older list when asked; the real fallback branch is exercised by the garbage-mode test (bad response on the first list).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: HTTP Digest, ISAPI parsing and the NVR client"
```

---

### Task 6: Network probes (TCP, ICMP) and the RTSP check

**Files:**
- Create: `lib/probes.ts`, `lib/rtsp/describe.ts`
- Test: `tests/unit/probes.test.ts`, `tests/unit/rtsp.test.ts`

**Interfaces:**
- Produces: `tcpCheck(host, port, timeoutMs?): Promise<ProbeResult>` and `icmpCheck(host, timeoutMs?, deps?): Promise<ProbeResult>` with `ProbeResult = {ok: boolean; error?: string}`; `buildPingArgs(platform, host, timeoutMs): string[]`; `rtspDescribe(target): Promise<{code: number; trace: string[]}>` and `rtspOk(target): Promise<boolean>` with `RtspTarget = {host, port, username, password, channel, timeoutMs?}` (sub-stream URL `rtsp://host:port/Streaming/Channels/<channel>02`).

- [ ] **Step 1: Write the failing tests**

`tests/unit/probes.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { buildPingArgs, icmpCheck, tcpCheck } from '@/lib/probes'
import { closedPort, startFakeTcp, type Running } from '../helpers/fake-servers'

const running: Running[] = []
afterEach(async () => {
  while (running.length) await running.pop()!.close()
})

describe('tcpCheck', () => {
  it('is ok when something listens', async () => {
    const s = await startFakeTcp()
    running.push(s)
    expect(await tcpCheck('127.0.0.1', s.port)).toEqual({ ok: true })
  })
  it('says the port refused when nothing listens', async () => {
    expect(await tcpCheck('127.0.0.1', await closedPort())).toEqual({ ok: false, error: 'The port refused the connection.' })
  })
  it('gives a plain message for an address outside the test network (egress guard)', async () => {
    const r = await tcpCheck('192.0.2.1', 80, 500)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Egress guard')
  })
})

describe('ping', () => {
  it('builds the right arguments for each system', () => {
    expect(buildPingArgs('win32', '192.0.2.5', 2000)).toEqual(['-n', '1', '-w', '2000', '192.0.2.5'])
    expect(buildPingArgs('linux', '192.0.2.5', 2000)).toEqual(['-c', '1', '-W', '2', '192.0.2.5'])
    expect(buildPingArgs('linux', '192.0.2.5', 300)).toEqual(['-c', '1', '-W', '1', '192.0.2.5'])
    expect(buildPingArgs('darwin', '192.0.2.5', 2000)).toEqual(['-c', '1', '-W', '2000', '192.0.2.5'])
  })
  it('refuses anything that is not an IP address, so it can never be a command option', async () => {
    expect(await icmpCheck('-n 100 evil')).toEqual({ ok: false, error: 'That is not an IP address.' })
    expect(await icmpCheck('example.org')).toEqual({ ok: false, error: 'That is not an IP address.' })
  })
  it('reads the exit code of the ping program', async () => {
    const fake = (code: number | 'enoent') => () => {
      const { EventEmitter } = require('node:events') as typeof import('node:events')
      const p = new EventEmitter() as import('node:events').EventEmitter & { kill: () => void }
      p.kill = () => {}
      setTimeout(() => (code === 'enoent' ? p.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })) : p.emit('close', code)), 5)
      return p
    }
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'linux', spawn: fake(0) as never })).toEqual({ ok: true })
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'linux', spawn: fake(1) as never })).toEqual({ ok: false, error: 'No reply to the ping.' })
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'linux', spawn: fake('enoent') as never })).toEqual({ ok: false, error: 'The ping program is not available on this computer.' })
  })
})
```

`tests/unit/rtsp.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { rtspDescribe, rtspOk } from '@/lib/rtsp/describe'
import { closedPort, startFakeRtsp, type Running } from '../helpers/fake-servers'

const running: Running[] = []
afterEach(async () => {
  while (running.length) await running.pop()!.close()
})
const target = (port: number) => ({ host: '127.0.0.1', port, username: 'viewer', password: 'pw', channel: 3, timeoutMs: 1500 })

describe('rtsp check', () => {
  it('is ok when the camera answers 200', async () => {
    const s = await startFakeRtsp('open')
    running.push(s)
    expect(await rtspOk(target(s.port))).toBe(true)
    expect(s.requests[0]).toBe('DESCRIBE rtsp://127.0.0.1:' + s.port + '/Streaming/Channels/302 RTSP/1.0')
  })
  it('answers the login challenge with Digest and then succeeds', async () => {
    const s = await startFakeRtsp('needs-auth')
    running.push(s)
    const r = await rtspDescribe(target(s.port))
    expect(r.code).toBe(200)
    expect(r.trace).toHaveLength(2)
    expect(s.requests).toHaveLength(2)
  })
  it('is not ok when the stream is missing or the login is refused', async () => {
    const missing = await startFakeRtsp('refuse')
    const refused = await startFakeRtsp('always-401')
    running.push(missing, refused)
    expect((await rtspDescribe(target(missing.port))).code).toBe(404)
    expect(await rtspOk(target(refused.port))).toBe(false)
  })
  it('gives code 0 when nothing is listening', async () => {
    const r = await rtspDescribe(target(await closedPort()))
    expect(r.code).toBe(0)
    expect(r.trace[0]).toMatch(/refused|failed/i)
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/unit/probes.test.ts tests/unit/rtsp.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the probes**

`lib/probes.ts`:
```ts
import childProcess from 'node:child_process'
import net, { isIP } from 'node:net'

export type ProbeResult = { ok: boolean; error?: string }

/** Is something listening on this address and port? Never throws. */
export function tcpCheck(host: string, port: number, timeoutMs = 3000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let done = false
    const finish = (r: ProbeResult) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(r)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish({ ok: true }))
    socket.once('timeout', () => finish({ ok: false, error: 'No answer in time.' }))
    socket.once('error', (e: NodeJS.ErrnoException) => {
      if (e.message.startsWith('Egress guard')) return finish({ ok: false, error: e.message })
      if (e.code === 'ECONNREFUSED') return finish({ ok: false, error: 'The port refused the connection.' })
      if (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') return finish({ ok: false, error: 'The address cannot be reached.' })
      finish({ ok: false, error: `The connection failed (${e.code ?? 'error'}).` })
    })
  })
}

export function buildPingArgs(platform: NodeJS.Platform | string, host: string, timeoutMs: number): string[] {
  if (platform === 'win32') return ['-n', '1', '-w', String(timeoutMs), host]
  if (platform === 'darwin') return ['-c', '1', '-W', String(timeoutMs), host]
  return ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host]
}

export type IcmpDeps = {
  platform?: NodeJS.Platform | string
  spawn?: (cmd: string, args: string[]) => Pick<childProcess.ChildProcess, 'on' | 'kill'>
}

/** One ping. Only for devices with no port to test. The address must be a literal IP so it can never act as a command option. */
export function icmpCheck(host: string, timeoutMs = 2000, deps: IcmpDeps = {}): Promise<ProbeResult> {
  if (isIP(host) === 0) return Promise.resolve({ ok: false, error: 'That is not an IP address.' })
  const spawn = deps.spawn ?? ((cmd: string, args: string[]) => childProcess.spawn(cmd, args, { stdio: 'ignore' }))
  return new Promise((resolve) => {
    let child: ReturnType<NonNullable<IcmpDeps['spawn']>>
    let done = false
    const finish = (r: ProbeResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      child?.kill()
      finish({ ok: false, error: 'No reply to the ping.' })
    }, timeoutMs + 1000)
    try {
      child = spawn('ping', buildPingArgs(deps.platform ?? process.platform, host, timeoutMs))
    } catch {
      return finish({ ok: false, error: 'The ping program is not available on this computer.' })
    }
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish({ ok: false, error: e.code === 'ENOENT' ? 'The ping program is not available on this computer.' : 'The ping could not be run.' }),
    )
    child.on('close', (code) => finish(code === 0 ? { ok: true } : { ok: false, error: 'No reply to the ping.' }))
  })
}
```

`lib/rtsp/describe.ts`:
```ts
import net from 'node:net'
import { buildDigestHeader, parseDigestChallenge } from '@/lib/nvr/digest'

export type RtspTarget = { host: string; port: number; username: string; password: string; channel: number; timeoutMs?: number }

/** One DESCRIBE on the camera's sub-stream (Hikvision: channel*100 + 2). Returns the final status code (0 = no answer) and what happened. */
export async function rtspDescribe(t: RtspTarget): Promise<{ code: number; trace: string[] }> {
  const uri = `rtsp://${t.host}:${t.port}/Streaming/Channels/${t.channel}02`
  const timeout = t.timeoutMs ?? 5000

  const ask = (auth?: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: t.host, port: t.port })
      let buf = ''
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')) }, timeout)
      const end = (fn: () => void) => { clearTimeout(timer); socket.destroy(); fn() }
      socket.once('connect', () => socket.write(`DESCRIBE ${uri} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: network-hub\r\n${auth ? `Authorization: ${auth}\r\n` : ''}\r\n`))
      socket.on('data', (d) => {
        buf += d.toString()
        if (buf.includes('\r\n\r\n') || buf.length > 8192) end(() => resolve(buf))
      })
      socket.once('close', () => end(() => resolve(buf)))
      socket.once('error', (e: NodeJS.ErrnoException) => end(() => reject(e)))
    })

  const code = (text: string) => Number(/^RTSP\/1\.\d (\d+)/.exec(text)?.[1] ?? 0)
  const line = (text: string) => text.split('\r\n')[0]
  const trace: string[] = []
  try {
    let text = await ask()
    trace.push(line(text))
    if (code(text) === 401) {
      const header = /WWW-Authenticate:\s*(Digest[^\r\n]*)/i.exec(text)?.[1] ?? ''
      const challenge = parseDigestChallenge(header)
      if (challenge) {
        text = await ask(buildDigestHeader(challenge, { username: t.username, password: t.password, method: 'DESCRIBE', uri }))
        trace.push('digest: ' + line(text))
      }
      if (code(text) === 401) {
        text = await ask('Basic ' + Buffer.from(`${t.username}:${t.password}`).toString('base64'))
        trace.push('basic: ' + line(text))
      }
    }
    return { code: code(text), trace }
  } catch (e) {
    const c = (e as NodeJS.ErrnoException).code
    trace.push(c === 'ECONNREFUSED' ? 'The camera port refused the connection.' : `The check failed (${c ?? (e as Error).message}).`)
    return { code: 0, trace }
  }
}

export async function rtspOk(t: RtspTarget): Promise<boolean> {
  return (await rtspDescribe(t)).code === 200
}
```

- [ ] **Step 4: Run the checks**

Run: `npx vitest run tests/unit/probes.test.ts tests/unit/rtsp.test.ts`, `npm run test:unit`, `npm run typecheck`, `npm run lint`.
Expected: green. (`require` inside the ping test is allowed there; if lint objects, import `EventEmitter` at the top of the test file instead.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: TCP, ICMP and RTSP probes"
```

---

### Task 7: Job orchestration and the Supabase data layer

**Files:**
- Create: `lib/async/pool.ts`, `lib/monitor/config.ts`, `lib/monitor/types.ts`, `lib/monitor/checks.ts`, `lib/monitor/probes.ts`, `lib/monitor/supabase-db.ts`, `tests/helpers/memory-db.ts`
- Test: `tests/unit/pool.test.ts`, `tests/unit/monitor-config.test.ts`, `tests/unit/monitor-checks.test.ts`, `tests/integration/monitor-db.test.ts`

**Interfaces:**
- Produces: `mapLimit(items, limit, fn)`; `loadMonitorConfig(env?) : MonitorConfig`; in `lib/monitor/types.ts`: `CheckResult`, `DeviceJob`, `NvrJob`, `StoreJob`, `MonitorDb` (the data interface), `Probes`; in `lib/monitor/checks.ts`: `Deps = {db, probes, cfg, clock}`, `checkDevices(deps)`, `checkNvrs(deps)`, `checkCameras(deps, onProgress?, storeIds?)`, `checkStoreCameras(deps, job)`; `realProbes` in `lib/monitor/probes.ts`; `SupabaseMonitorDb` (implements `MonitorDb` with the service-role client); `MemoryDb` test double.

Definitions (exact):
```ts
// lib/monitor/types.ts
import type { ProbeResult } from '@/lib/probes'
import type { NvrChannel, } from '@/lib/nvr/isapi'
import type { NvrEndpoint } from '@/lib/nvr/client'
import type { RtspTarget } from '@/lib/rtsp/describe'

export type TargetType = 'camera' | 'device' | 'nvr'
export type CheckResult = { type: TargetType; id: string; ok: boolean; at: string; method?: string; error?: string; cause?: 'nvr_down' }
export type DeviceJob = { id: string; org_id: string; ip: string; tcp_port: number | null }
export type NvrJob = { id: string; org_id: string; ip: string; rtsp_port: number }
export type StoreJob = {
  id: string; org_id: string; code: string; ip: string; rtsp_port: number; http_port: number; username: string; password: string
  nvr_status: 'up' | 'down' | 'unknown'
  cameras: { id: string; channel: number; camera_ip: string | null }[]
}
export type WorkerRequest = { requestedAt: Date | null; runStartedAt: Date | null }

export interface MonitorDb {
  loadDevices(): Promise<DeviceJob[]>
  loadNvrs(): Promise<NvrJob[]>
  loadStoreJobs(storeIds?: string[]): Promise<StoreJob[]>
  applyResults(orgId: string, results: CheckResult[], threshold: number): Promise<void>
  saveCameraIps(orgId: string, rows: { cameraId: string; ip: string }[]): Promise<void>
  touchHeartbeat(now: Date): Promise<void>
  recordStartupGap(now: Date, maxSilenceMs: number): Promise<boolean>
  readRequest(): Promise<WorkerRequest>
  markRunStarted(at: Date, total: number): Promise<void>
  markProgress(done: number, total: number): Promise<void>
  markRunFinished(at: Date): Promise<void>
}

export type Probes = {
  tcp: (host: string, port: number, timeoutMs?: number) => Promise<ProbeResult>
  icmp: (host: string, timeoutMs?: number) => Promise<ProbeResult>
  rtsp: (t: RtspTarget) => Promise<boolean>
  nvr: (ep: NvrEndpoint) => { channelStatus(): Promise<Map<number, boolean>>; channels(): Promise<NvrChannel[]> }
}

export type MonitorConfig = {
  deviceCheckSec: number; cameraCheckSec: number; pollSec: number; failThreshold: number
  deviceConcurrency: number; storeConcurrency: number; rtspPerStore: number; tcpTimeoutMs: number; nvrTimeoutMs: number
}
```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/pool.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { mapLimit } from '@/lib/async/pool'

describe('mapLimit', () => {
  it('keeps the order of the results and never runs more than the limit at once', async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBe(3)
  })
  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapLimit([], 5, async (n: number) => n)).toEqual([])
    expect(await mapLimit([1], 5, async (n) => n + 1)).toEqual([2])
  })
})
```

`tests/unit/monitor-config.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { loadMonitorConfig } from '@/lib/monitor/config'

describe('loadMonitorConfig', () => {
  it('has the spec defaults', () => {
    expect(loadMonitorConfig({})).toMatchObject({ deviceCheckSec: 60, cameraCheckSec: 300, pollSec: 5, failThreshold: 2 })
  })
  it('reads numbers from the environment and ignores nonsense', () => {
    const c = loadMonitorConfig({ DEVICE_CHECK_SEC: '30', CAMERA_CHECK_SEC: 'abc', FAIL_THRESHOLD: '0' })
    expect(c.deviceCheckSec).toBe(30)
    expect(c.cameraCheckSec).toBe(300)
    expect(c.failThreshold).toBe(2)
  })
  it('never goes below a safe minimum', () => {
    expect(loadMonitorConfig({ DEVICE_CHECK_SEC: '1' }).deviceCheckSec).toBe(10)
  })
})
```

`tests/helpers/memory-db.ts`:
```ts
import type { CheckResult, DeviceJob, MonitorDb, NvrJob, StoreJob, WorkerRequest } from '@/lib/monitor/types'

/** In-memory MonitorDb: remembers every call so tests can look at what the checks decided. */
export class MemoryDb implements MonitorDb {
  devices: DeviceJob[] = []
  nvrs: NvrJob[] = []
  stores: StoreJob[] = []
  applied: { orgId: string; results: CheckResult[]; threshold: number }[] = []
  ipsSaved: { orgId: string; rows: { cameraId: string; ip: string }[] }[] = []
  heartbeats: Date[] = []
  request: WorkerRequest = { requestedAt: null, runStartedAt: null }
  started: { at: Date; total: number }[] = []
  progress: [number, number][] = []
  finished: Date[] = []
  gapRecorded = false

  async loadDevices() { return this.devices }
  async loadNvrs() { return this.nvrs }
  async loadStoreJobs(ids?: string[]) { return ids ? this.stores.filter((s) => ids.includes(s.id)) : this.stores }
  async applyResults(orgId: string, results: CheckResult[], threshold: number) { this.applied.push({ orgId, results, threshold }) }
  async saveCameraIps(orgId: string, rows: { cameraId: string; ip: string }[]) { this.ipsSaved.push({ orgId, rows }) }
  async touchHeartbeat(now: Date) { this.heartbeats.push(now) }
  async recordStartupGap() { return this.gapRecorded }
  async readRequest() { return this.request }
  async markRunStarted(at: Date, total: number) { this.started.push({ at, total }); this.request = { ...this.request, runStartedAt: at } }
  async markProgress(done: number, total: number) { this.progress.push([done, total]) }
  async markRunFinished(at: Date) { this.finished.push(at) }
  results() { return this.applied.flatMap((a) => a.results) }
}
```

`tests/unit/monitor-checks.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { checkCameras, checkDevices, checkNvrs, type Deps } from '@/lib/monitor/checks'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { NvrError } from '@/lib/nvr/client'
import type { Probes, StoreJob } from '@/lib/monitor/types'
import { MemoryDb } from '../helpers/memory-db'

const NOW = new Date('2026-05-01T08:00:00Z')
const cfg = loadMonitorConfig({})

function deps(db: MemoryDb, probes: Partial<Probes> = {}): Deps {
  const base: Probes = {
    tcp: async () => ({ ok: true }),
    icmp: async () => ({ ok: true }),
    rtsp: async () => false,
    nvr: () => ({ channelStatus: async () => new Map(), channels: async () => [] }),
  }
  return { db, probes: { ...base, ...probes }, cfg, clock: () => NOW }
}

const store = (over: Partial<StoreJob> = {}): StoreJob => ({
  id: 's1', org_id: 'o1', code: 'S1', ip: '127.0.0.1', rtsp_port: 554, http_port: 80, username: 'viewer', password: 'pw', nvr_status: 'up',
  cameras: [{ id: 'c1', channel: 1, camera_ip: null }, { id: 'c2', channel: 2, camera_ip: null }, { id: 'c3', channel: 3, camera_ip: null }],
  ...over,
})

describe('checkDevices', () => {
  it('uses TCP when a port is set and ping when it is not, and records why a device failed', async () => {
    const db = new MemoryDb()
    db.devices = [
      { id: 'd1', org_id: 'o1', ip: '127.0.0.1', tcp_port: 443 },
      { id: 'd2', org_id: 'o1', ip: '127.0.0.2', tcp_port: null },
      { id: 'd3', org_id: 'o2', ip: '127.0.0.3', tcp_port: 80 },
    ]
    const calls: string[] = []
    await checkDevices(deps(db, {
      tcp: async (h, p) => { calls.push(`tcp ${h}:${p}`); return h === '127.0.0.3' ? { ok: false, error: 'The port refused the connection.' } : { ok: true } },
      icmp: async (h) => { calls.push(`icmp ${h}`); return { ok: true } },
    }))
    expect(calls.sort()).toEqual(['icmp 127.0.0.2', 'tcp 127.0.0.1:443', 'tcp 127.0.0.3:80'])
    const byOrg = Object.fromEntries(db.applied.map((a) => [a.orgId, a.results]))
    expect(byOrg.o1).toEqual([
      { type: 'device', id: 'd1', ok: true, at: NOW.toISOString(), method: 'tcp', error: undefined },
      { type: 'device', id: 'd2', ok: true, at: NOW.toISOString(), method: 'icmp', error: undefined },
    ])
    expect(byOrg.o2[0]).toMatchObject({ id: 'd3', ok: false, error: 'The port refused the connection.' })
    expect(db.applied.every((a) => a.threshold === 2)).toBe(true)
  })
})

describe('checkNvrs', () => {
  it('checks the NVR video port of every store', async () => {
    const db = new MemoryDb()
    db.nvrs = [{ id: 's1', org_id: 'o1', ip: '127.0.0.1', rtsp_port: 8554 }, { id: 's2', org_id: 'o1', ip: '127.0.0.2', rtsp_port: 554 }]
    await checkNvrs(deps(db, { tcp: async (h) => ({ ok: h === '127.0.0.1' }) }))
    expect(db.results().map((r) => [r.type, r.id, r.ok])).toEqual([['nvr', 's1', true], ['nvr', 's2', false]])
  })
})

describe('checkCameras', () => {
  it('trusts the NVR for cameras it says are online and re-checks the others with RTSP', async () => {
    const db = new MemoryDb()
    db.stores = [store()]
    const rtspCalls: number[] = []
    await checkCameras(deps(db, {
      nvr: () => ({
        channelStatus: async () => new Map([[1, true], [2, false], [3, false]]),
        channels: async () => [{ channel: 1, name: 'A', ip: '192.0.2.1' }, { channel: 2, name: 'B', ip: '192.0.2.2' }, { channel: 3, name: 'C', ip: null }],
      }),
      rtsp: async (t) => { rtspCalls.push(t.channel); return t.channel === 2 },
    }))
    expect(rtspCalls.sort()).toEqual([2, 3])
    expect(db.results().map((r) => [r.id, r.ok, r.method])).toEqual([['c1', true, 'isapi+rtsp'], ['c2', true, 'isapi+rtsp'], ['c3', false, 'isapi+rtsp']])
    expect(db.results()[2].error).toBe('The camera did not answer.')
    expect(db.ipsSaved[0].rows).toEqual([{ cameraId: 'c1', ip: '192.0.2.1' }, { cameraId: 'c2', ip: '192.0.2.2' }])
  })

  it('does not use RTSP when the NVR says every camera is online', async () => {
    const db = new MemoryDb()
    db.stores = [store()]
    let rtsp = 0
    await checkCameras(deps(db, {
      nvr: () => ({ channelStatus: async () => new Map([[1, true], [2, true], [3, true]]), channels: async () => [] }),
      rtsp: async () => { rtsp++; return false },
    }))
    expect(rtsp).toBe(0)
    expect(db.results().every((r) => r.ok && r.method === 'isapi')).toBe(true)
  })

  it('falls back to RTSP for every camera when the NVR cannot be asked, and says why', async () => {
    const db = new MemoryDb()
    db.stores = [store()]
    await checkCameras(deps(db, {
      nvr: () => ({ channelStatus: async () => { throw new NvrError('auth', 'x') }, channels: async () => { throw new NvrError('auth', 'x') } }),
      rtsp: async (t) => t.channel === 1,
    }))
    expect(db.results().map((r) => [r.id, r.ok, r.method])).toEqual([['c1', true, 'rtsp'], ['c2', false, 'rtsp'], ['c3', false, 'rtsp']])
    expect(db.results()[1].error).toBe('The NVR refused the user name or password.')
  })

  it('marks every camera down at once, with the NVR as the cause, when the NVR is down, and asks nothing', async () => {
    const db = new MemoryDb()
    db.stores = [store({ nvr_status: 'down' })]
    let asked = 0
    await checkCameras(deps(db, {
      nvr: () => { asked++; return { channelStatus: async () => new Map(), channels: async () => [] } },
      rtsp: async () => { asked++; return true },
    }))
    expect(asked).toBe(0)
    expect(db.applied).toHaveLength(1)
    expect(db.applied[0].threshold).toBe(1)
    expect(db.results().every((r) => !r.ok && r.cause === 'nvr_down' && r.method === 'nvr_down')).toBe(true)
  })

  it('skips camera addresses that did not change and reports progress per store', async () => {
    const db = new MemoryDb()
    db.stores = [
      store({ id: 's1', cameras: [{ id: 'c1', channel: 1, camera_ip: '192.0.2.1' }] }),
      store({ id: 's2', cameras: [{ id: 'c9', channel: 1, camera_ip: null }] }),
    ]
    const progress: [number, number][] = []
    await checkCameras(deps(db, {
      nvr: () => ({ channelStatus: async () => new Map([[1, true]]), channels: async () => [{ channel: 1, name: 'A', ip: '192.0.2.1' }] }),
    }), (d, t) => progress.push([d, t]))
    expect(db.ipsSaved.flatMap((i) => i.rows)).toEqual([{ cameraId: 'c9', ip: '192.0.2.1' }])
    expect(progress).toEqual([[1, 2], [2, 2]])
  })

  it('one failing store does not stop the others', async () => {
    const db = new MemoryDb()
    db.stores = [store({ id: 's1', cameras: [{ id: 'c1', channel: 1, camera_ip: null }] }), store({ id: 's2', cameras: [{ id: 'c2', channel: 1, camera_ip: null }] })]
    let n = 0
    await checkCameras(deps(db, {
      nvr: () => {
        if (n++ === 0) throw new Error('boom')
        return { channelStatus: async () => new Map([[1, true]]), channels: async () => [] }
      },
    }))
    expect(db.results().map((r) => r.id)).toEqual(['c2'])
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/unit/pool.test.ts tests/unit/monitor-config.test.ts tests/unit/monitor-checks.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement pool, config, types and probes**

`lib/async/pool.ts`:
```ts
/** Like Promise.all(items.map(fn)) but never runs more than `limit` at once. The results keep the order of the items. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}
```

`lib/monitor/config.ts`:
```ts
import type { MonitorConfig } from '@/lib/monitor/types'

const int = (v: string | undefined, fallback: number, min: number): number => {
  const n = Number(v)
  return Number.isInteger(n) && n >= min ? n : v !== undefined && Number.isInteger(n) ? min : fallback
}

export function loadMonitorConfig(env: Record<string, string | undefined> = process.env): MonitorConfig {
  const dev = int(env.DEVICE_CHECK_SEC, 60, 10)
  const cam = int(env.CAMERA_CHECK_SEC, 300, 10)
  const threshold = Number(env.FAIL_THRESHOLD)
  return {
    deviceCheckSec: dev,
    cameraCheckSec: cam,
    pollSec: 5,
    failThreshold: Number.isInteger(threshold) && threshold >= 1 ? threshold : 2,
    deviceConcurrency: 50,
    storeConcurrency: 10,
    rtspPerStore: 4,
    tcpTimeoutMs: 3000,
    nvrTimeoutMs: 8000,
  }
}
```
(The first unit test expects `loadMonitorConfig({ CAMERA_CHECK_SEC: 'abc' })` to give 300: `Number('abc')` is `NaN`, not an integer, so the fallback applies; `DEVICE_CHECK_SEC: '1'` is an integer below the minimum, so `min` 10 applies; `FAIL_THRESHOLD: '0'` gives 2.)

`lib/monitor/types.ts`: exactly the definitions shown under **Interfaces** above.

`lib/monitor/probes.ts`:
```ts
import { NvrClient } from '@/lib/nvr/client'
import { icmpCheck, tcpCheck } from '@/lib/probes'
import { rtspOk } from '@/lib/rtsp/describe'
import type { Probes } from '@/lib/monitor/types'

export const realProbes: Probes = {
  tcp: tcpCheck,
  icmp: icmpCheck,
  rtsp: rtspOk,
  nvr: (ep) => new NvrClient(ep),
}
```

- [ ] **Step 4: Implement the checks**

`lib/monitor/checks.ts`:
```ts
import { mapLimit } from '@/lib/async/pool'
import { describeNvrError } from '@/lib/nvr/client'
import { logger } from '@/lib/observability/logger'
import type { CheckResult, MonitorConfig, MonitorDb, Probes, StoreJob } from '@/lib/monitor/types'

export type Deps = { db: MonitorDb; probes: Probes; cfg: MonitorConfig; clock: () => Date }

type WithOrg = CheckResult & { org: string }

const CHUNK = 200

async function applyGrouped(deps: Deps, results: WithOrg[], threshold: number): Promise<void> {
  const byOrg = new Map<string, CheckResult[]>()
  for (const { org, ...r } of results) byOrg.set(org, [...(byOrg.get(org) ?? []), r])
  for (const [org, list] of byOrg) {
    for (let i = 0; i < list.length; i += CHUNK) await deps.db.applyResults(org, list.slice(i, i + CHUNK), threshold)
  }
}

/** Servers, attendance machines, footfall counters and other devices: a TCP connect, or a ping when there is no port. */
export async function checkDevices(deps: Deps): Promise<number> {
  const devices = await deps.db.loadDevices()
  const results = await mapLimit(devices, deps.cfg.deviceConcurrency, async (d): Promise<WithOrg> => {
    const r = d.tcp_port ? await deps.probes.tcp(d.ip, d.tcp_port, deps.cfg.tcpTimeoutMs) : await deps.probes.icmp(d.ip)
    return { org: d.org_id, type: 'device', id: d.id, ok: r.ok, at: deps.clock().toISOString(), method: d.tcp_port ? 'tcp' : 'icmp', error: r.error }
  })
  await applyGrouped(deps, results, deps.cfg.failThreshold)
  return devices.length
}

/** The NVR itself: can its video port be reached? */
export async function checkNvrs(deps: Deps): Promise<number> {
  const nvrs = await deps.db.loadNvrs()
  const results = await mapLimit(nvrs, deps.cfg.deviceConcurrency, async (n): Promise<WithOrg> => {
    const r = await deps.probes.tcp(n.ip, n.rtsp_port, deps.cfg.tcpTimeoutMs)
    return { org: n.org_id, type: 'nvr', id: n.id, ok: r.ok, at: deps.clock().toISOString(), method: 'tcp', error: r.error }
  })
  await applyGrouped(deps, results, deps.cfg.failThreshold)
  return nvrs.length
}

/** All cameras of one store. Asks the NVR first; cameras it does not report online get an RTSP check. */
export async function checkStoreCameras(deps: Deps, s: StoreJob): Promise<void> {
  if (s.cameras.length === 0) return
  const at = deps.clock().toISOString()

  // A store whose NVR is already known to be down: its cameras are down for the same reason, at once, with nothing else to ask.
  if (s.nvr_status === 'down') {
    await deps.db.applyResults(
      s.org_id,
      s.cameras.map((c): CheckResult => ({ type: 'camera', id: c.id, ok: false, at, method: 'nvr_down', error: 'The NVR is not reachable.', cause: 'nvr_down' })),
      1,
    )
    return
  }

  const online = new Map<number, boolean>()
  const addresses = new Map<number, string>()
  let method = 'rtsp'
  let nvrProblem: string | undefined
  const nvr = deps.probes.nvr({ host: s.ip, port: s.http_port, username: s.username, password: s.password })
  try {
    for (const [ch, on] of await nvr.channelStatus()) online.set(ch, on)
    method = 'isapi'
  } catch (e) {
    nvrProblem = describeNvrError(e)
  }
  try {
    for (const c of await nvr.channels()) if (c.ip) addresses.set(c.channel, c.ip)
  } catch {
    // Camera addresses are a bonus here; names and channels come from discovery.
  }

  const unconfirmed = s.cameras.filter((c) => online.get(c.channel) !== true)
  if (unconfirmed.length > 0) {
    await mapLimit(unconfirmed, deps.cfg.rtspPerStore, async (c) => {
      online.set(c.channel, await deps.probes.rtsp({ host: s.ip, port: s.rtsp_port, username: s.username, password: s.password, channel: c.channel }))
    })
    method = method === 'isapi' ? 'isapi+rtsp' : 'rtsp'
  }

  const results = s.cameras.map((c): CheckResult => {
    const ok = online.get(c.channel) === true
    return { type: 'camera', id: c.id, ok, at, method, error: ok ? undefined : (nvrProblem ?? 'The camera did not answer.') }
  })
  await deps.db.applyResults(s.org_id, results, deps.cfg.failThreshold)

  const changed = s.cameras.filter((c) => addresses.has(c.channel) && addresses.get(c.channel) !== c.camera_ip)
  if (changed.length > 0) await deps.db.saveCameraIps(s.org_id, changed.map((c) => ({ cameraId: c.id, ip: addresses.get(c.channel)! })))
}

export async function checkCameras(deps: Deps, onProgress?: (done: number, total: number) => void, storeIds?: string[]): Promise<number> {
  const stores = await deps.db.loadStoreJobs(storeIds)
  let done = 0
  await mapLimit(stores, deps.cfg.storeConcurrency, async (s) => {
    try {
      await checkStoreCameras(deps, s)
    } catch (e) {
      // One broken store must never stop the others.
      logger.error({ event: 'store_check_failed', store: s.code, error: e })
    }
    onProgress?.(++done, stores.length)
  })
  return stores.length
}
```

- [ ] **Step 5: Write the Supabase data layer and its test**

`lib/monitor/supabase-db.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { mapLimit } from '@/lib/async/pool'
import type { Database, Json } from '@/types/database'
import { logger } from '@/lib/observability/logger'
import { fetchAll } from '@/lib/supabase/fetch-all'
import type { CheckResult, DeviceJob, MonitorDb, NvrJob, StoreJob, WorkerRequest } from '@/lib/monitor/types'

type Admin = SupabaseClient<Database>

/** MonitorDb on the service-role client. NVR passwords are read from the vault one store at a time and only held in memory. */
export class SupabaseMonitorDb implements MonitorDb {
  constructor(private admin: Admin) {}

  loadDevices(): Promise<DeviceJob[]> {
    return fetchAll((from, to) => this.admin.from('devices').select('id, org_id, ip, tcp_port').eq('enabled', true).order('id').range(from, to))
  }

  loadNvrs(): Promise<NvrJob[]> {
    return fetchAll((from, to) =>
      this.admin.from('stores').select('id, org_id, nvr_ip, rtsp_port').eq('is_active', true).order('id').range(from, to),
    ).then((rows) => rows.map((r) => ({ id: r.id, org_id: r.org_id, ip: r.nvr_ip, rtsp_port: r.rtsp_port })))
  }

  async loadStoreJobs(storeIds?: string[]): Promise<StoreJob[]> {
    const stores = await fetchAll((from, to) => {
      let q = this.admin.from('stores').select('id, org_id, code, nvr_ip, rtsp_port, http_port, nvr_username').eq('is_active', true).order('id')
      if (storeIds) q = q.in('id', storeIds)
      return q.range(from, to)
    })
    if (stores.length === 0) return []
    const wanted = new Set(stores.map((s) => s.id))
    const cameras = await fetchAll((from, to) =>
      this.admin.from('cameras').select('id, store_id, channel, camera_ip').eq('is_active', true).order('store_id').order('channel').range(from, to),
    )
    const states = await fetchAll((from, to) =>
      this.admin.from('check_state').select('target_id, status').eq('target_type', 'nvr').order('target_id').range(from, to),
    )
    const nvrStatus = new Map(states.map((s) => [s.target_id, s.status as 'up' | 'down' | 'unknown']))
    const byStore = new Map<string, StoreJob['cameras']>()
    for (const c of cameras) {
      if (!wanted.has(c.store_id)) continue
      byStore.set(c.store_id, [...(byStore.get(c.store_id) ?? []), { id: c.id, channel: c.channel, camera_ip: c.camera_ip }])
    }
    const jobs = await mapLimit(stores, 10, async (s): Promise<StoreJob> => {
      const { data } = await this.admin.rpc('nvr_read_credential', { p_store: s.id })
      return {
        id: s.id, org_id: s.org_id, code: s.code, ip: s.nvr_ip, rtsp_port: s.rtsp_port, http_port: s.http_port,
        username: s.nvr_username, password: data ?? '', nvr_status: nvrStatus.get(s.id) ?? 'unknown', cameras: byStore.get(s.id) ?? [],
      }
    })
    return jobs
  }

  async applyResults(orgId: string, results: CheckResult[], threshold: number): Promise<void> {
    if (results.length === 0) return
    const { error } = await this.admin.rpc('monitor_apply_results', { p_org: orgId, p_results: results as unknown as Json, p_threshold: threshold })
    if (error) throw new Error(`monitor_apply_results failed: ${error.message}`)
  }

  async saveCameraIps(orgId: string, rows: { cameraId: string; ip: string }[]): Promise<void> {
    for (const r of rows) {
      const { error } = await this.admin.from('cameras').update({ camera_ip: r.ip }).eq('id', r.cameraId).eq('org_id', orgId)
      if (error) logger.error({ event: 'camera_ip_save_failed', error })
    }
  }

  async touchHeartbeat(now: Date): Promise<void> {
    const { error } = await this.admin.from('worker_state').update({ last_heartbeat: now.toISOString() }).eq('id', 1)
    if (error) throw new Error(`heartbeat failed: ${error.message}`)
  }

  /** At start-up: if the last heartbeat is older than maxSilenceMs, the worker was not running in between. Remember that period. */
  async recordStartupGap(now: Date, maxSilenceMs: number): Promise<boolean> {
    const { data } = await this.admin.from('worker_state').select('last_heartbeat').eq('id', 1).single()
    let recorded = false
    const last = data?.last_heartbeat ? new Date(data.last_heartbeat) : null
    if (last && now.getTime() - last.getTime() > maxSilenceMs) {
      await this.admin.from('monitor_gaps').insert({ started_at: last.toISOString(), ended_at: now.toISOString() })
      recorded = true
    }
    await this.admin.from('worker_state').update({ last_heartbeat: now.toISOString() }).eq('id', 1)
    return recorded
  }

  async readRequest(): Promise<WorkerRequest> {
    const { data } = await this.admin.from('worker_state').select('check_requested_at, run_started_at').eq('id', 1).single()
    return {
      requestedAt: data?.check_requested_at ? new Date(data.check_requested_at) : null,
      runStartedAt: data?.run_started_at ? new Date(data.run_started_at) : null,
    }
  }

  async markRunStarted(at: Date, total: number): Promise<void> {
    await this.admin.from('worker_state').update({ run_started_at: at.toISOString(), run_finished_at: null, progress_done: 0, progress_total: total }).eq('id', 1)
  }

  async markProgress(done: number, total: number): Promise<void> {
    await this.admin.from('worker_state').update({ progress_done: done, progress_total: total }).eq('id', 1)
  }

  async markRunFinished(at: Date): Promise<void> {
    await this.admin.from('worker_state').update({ run_finished_at: at.toISOString() }).eq('id', 1)
  }
}
```

`tests/integration/monitor-db.test.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { adminClient, cleanupOrg, createOrg } from '../setup/fixtures'

const admin = () => adminClient()

describe('SupabaseMonitorDb', () => {
  let orgId: string
  let storeId: string
  let camIds: string[]
  let db: SupabaseMonitorDb
  const gapIds: string[] = []
  let savedHeartbeat: string | null

  beforeAll(async () => {
    orgId = await createOrg()
    db = new SupabaseMonitorDb(admin())
    const a = admin()
    storeId = (await a.from('stores').insert({ org_id: orgId, code: 'DB1', name: 'Db1', nvr_ip: '127.0.0.1', rtsp_port: 8554, http_port: 8081, nvr_username: 'viewer' }).select('id').single()).data!.id
    await a.rpc('nvr_store_credential', { p_store: storeId, p_secret: 'secret-pass' })
    camIds = (await a.from('cameras').insert([1, 2].map((n) => ({ org_id: orgId, store_id: storeId, channel: n, name: `C${n}` }))).select('id').order('channel')).data!.map((c) => c.id)
    await a.from('devices').insert([
      { org_id: orgId, store_id: storeId, type: 'server', name: 'On', ip: '127.0.0.1', tcp_port: 9, enabled: true },
      { org_id: orgId, store_id: storeId, type: 'server', name: 'Off', ip: '127.0.0.1', tcp_port: 10, enabled: false },
    ])
    savedHeartbeat = (await a.from('worker_state').select('last_heartbeat').eq('id', 1).single()).data!.last_heartbeat
  })

  afterAll(async () => {
    if (gapIds.length) await admin().from('monitor_gaps').delete().in('id', gapIds)
    await admin().from('worker_state').update({ last_heartbeat: savedHeartbeat, check_requested_at: null, run_started_at: null, run_finished_at: null }).eq('id', 1)
    await cleanupOrg(orgId)
  })

  it('loads only enabled devices and the NVR of active stores', async () => {
    const devices = (await db.loadDevices()).filter((d) => d.org_id === orgId)
    expect(devices.map((d) => d.tcp_port)).toEqual([9])
    expect((await db.loadNvrs()).find((n) => n.id === storeId)).toMatchObject({ ip: '127.0.0.1', rtsp_port: 8554 })
  })

  it('loads a store with its decrypted password, cameras and NVR state', async () => {
    const [job] = await db.loadStoreJobs([storeId])
    expect(job).toMatchObject({ id: storeId, org_id: orgId, code: 'DB1', http_port: 8081, rtsp_port: 8554, username: 'viewer', password: 'secret-pass', nvr_status: 'unknown' })
    expect(job.cameras.map((c) => c.channel)).toEqual([1, 2])
    await db.applyResults(orgId, [{ type: 'nvr', id: storeId, ok: false, at: new Date().toISOString() }], 1)
    expect((await db.loadStoreJobs([storeId]))[0].nvr_status).toBe('down')
  })

  it('applies results, records camera addresses, and surfaces database errors', async () => {
    await db.applyResults(orgId, [{ type: 'camera', id: camIds[0], ok: true, at: new Date().toISOString() }], 2)
    const { data } = await admin().from('check_state').select('status').eq('target_id', camIds[0]).single()
    expect(data?.status).toBe('up')
    await db.saveCameraIps(orgId, [{ cameraId: camIds[0], ip: '192.0.2.77' }])
    expect((await admin().from('cameras').select('camera_ip').eq('id', camIds[0]).single()).data?.camera_ip).toBe('192.0.2.77')
    await expect(db.applyResults(randomUUID(), [{ type: 'camera', id: 'not-a-uuid' as never, ok: true, at: new Date().toISOString() }], 2)).rejects.toThrow('monitor_apply_results failed')
  })

  it('keeps the heartbeat, notes a gap after a long silence and not after a short one', async () => {
    const now = new Date()
    await admin().from('worker_state').update({ last_heartbeat: new Date(now.getTime() - 60_000).toISOString() }).eq('id', 1)
    expect(await db.recordStartupGap(now, 30_000)).toBe(true)
    const { data: gaps } = await admin().from('monitor_gaps').select('id').gte('ended_at', now.toISOString())
    gaps?.forEach((g) => gapIds.push(g.id))
    expect(gaps?.length).toBeGreaterThanOrEqual(1)
    expect(await db.recordStartupGap(new Date(now.getTime() + 10_000), 30_000)).toBe(false)
  })

  it('reads the check request and tracks the progress of a run', async () => {
    const t0 = new Date()
    await admin().from('worker_state').update({ check_requested_at: t0.toISOString(), run_started_at: null }).eq('id', 1)
    expect(await db.readRequest()).toEqual({ requestedAt: t0, runStartedAt: null })
    await db.markRunStarted(new Date(t0.getTime() + 1000), 3)
    await db.markProgress(2, 3)
    const { data } = await admin().from('worker_state').select('progress_done, progress_total, run_finished_at').eq('id', 1).single()
    expect(data).toEqual({ progress_done: 2, progress_total: 3, run_finished_at: null })
    await db.markRunFinished(new Date(t0.getTime() + 5000))
    expect((await admin().from('worker_state').select('run_finished_at').eq('id', 1).single()).data?.run_finished_at).not.toBeNull()
  })
})
```

- [ ] **Step 6: Run the checks**

Run: `npx vitest run tests/unit` (pool, config, checks), `npx vitest run tests/integration/monitor-db.test.ts`, `npm run test:integration`, `npm run typecheck`, `npm run lint`.
Expected: green. If `monitor_apply_results` rejects the non-UUID id differently from the test's expectation, change only the expected message fragment, not the function.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: check orchestration and the Supabase data layer for the worker"
```

---

### Task 8: The worker, health endpoint and heartbeat

**Files:**
- Create: `lib/monitor/runner.ts`, `lib/monitor/health.ts`, `services/worker/index.ts`
- Modify: `package.json` (add `tsx` as a dev dependency, add scripts), `app/api/health/route.ts`, `tests/unit/api-routes.test.ts`, `.env.example`
- Test: `tests/unit/monitor-runner.test.ts`, `tests/unit/api-routes.test.ts`, `tests/integration/worker-run.test.ts`, `tests/integration/health.test.ts`

**Interfaces:**
- Consumes: `Deps`, `checkDevices`, `checkNvrs`, `checkCameras` (Task 7); `MonitorDb`; `SupabaseMonitorDb`; `realProbes`; fake servers (Task 4).
- Produces: `MonitorRunner` (`new MonitorRunner(deps)`, `runDevices()`, `runCameras(onProgress?)`, `runFull()`, `pollOnce()`, `start()`, `stop()`); `getWorkerHealth(admin, now?, maxAgeSec?)` returning `{ok, heartbeatAgeSec}` and `getWorkerStatus(admin, now?)` returning `{ok, heartbeatAgeSec, requestedAt, runStartedAt, runFinishedAt, running, progressDone, progressTotal}`; `GET /api/health` returning `{status: 'ok' | 'degraded', db: boolean, worker: {ok, heartbeatAgeSec}}`; npm scripts `worker` and `worker:dev`.

- [ ] **Step 1: Add `tsx` and the scripts**

Run: `npm install --save-dev tsx@^4`
In `package.json` `scripts` add:
```json
    "worker": "tsx services/worker/index.ts",
    "worker:dev": "tsx watch services/worker/index.ts",
```
Append to `.env.example`:
```
# Monitoring worker (seconds; defaults shown)
DEVICE_CHECK_SEC=60
CAMERA_CHECK_SEC=300
FAIL_THRESHOLD=2
```

- [ ] **Step 2: Write the failing unit tests**

`tests/unit/monitor-runner.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { MonitorRunner } from '@/lib/monitor/runner'
import type { Probes } from '@/lib/monitor/types'
import { MemoryDb } from '../helpers/memory-db'

const NOW = new Date('2026-05-01T08:00:00Z')
const probes: Probes = {
  tcp: async () => ({ ok: true }),
  icmp: async () => ({ ok: true }),
  rtsp: async () => true,
  nvr: () => ({ channelStatus: async () => new Map([[1, true]]), channels: async () => [] }),
}
const runnerFor = (db: MemoryDb) => new MonitorRunner({ db, probes, cfg: loadMonitorConfig({}), clock: () => NOW })

afterEach(() => vi.useRealTimers())

describe('MonitorRunner', () => {
  it('writes a heartbeat on every poll and does not run anything without a request', async () => {
    const db = new MemoryDb()
    const r = runnerFor(db)
    await r.pollOnce()
    await r.pollOnce()
    expect(db.heartbeats).toHaveLength(2)
    expect(db.started).toHaveLength(0)
  })

  it('runs everything once for a new check request and not again until there is a newer one', async () => {
    const db = new MemoryDb()
    db.request = { requestedAt: new Date('2026-05-01T07:59:00Z'), runStartedAt: null }
    const r = runnerFor(db)
    await r.pollOnce()
    expect(db.started).toHaveLength(1)
    expect(db.finished).toHaveLength(1)
    await r.pollOnce()
    expect(db.started).toHaveLength(1)
    db.request = { requestedAt: new Date('2026-05-01T08:00:30Z'), runStartedAt: NOW }
    await r.pollOnce()
    expect(db.started).toHaveLength(2)
  })

  it('ignores a request that is older than the last run', async () => {
    const db = new MemoryDb()
    db.request = { requestedAt: new Date('2026-05-01T07:00:00Z'), runStartedAt: new Date('2026-05-01T07:30:00Z') }
    await runnerFor(db).pollOnce()
    expect(db.started).toHaveLength(0)
  })

  it('reports progress per store and always marks the run finished, even when a step fails', async () => {
    const db = new MemoryDb()
    db.stores = [{ id: 's1', org_id: 'o', code: 'S1', ip: '127.0.0.1', rtsp_port: 554, http_port: 80, username: 'u', password: 'p', nvr_status: 'up', cameras: [{ id: 'c1', channel: 1, camera_ip: null }] }]
    await runnerFor(db).runFull()
    expect(db.progress).toEqual([[1, 1]])
    expect(db.finished).toHaveLength(1)

    const broken = new MemoryDb()
    broken.loadDevices = async () => { throw new Error('database is down') }
    await expect(runnerFor(broken).runFull()).rejects.toThrow('database is down')
    expect(broken.finished).toHaveLength(1)
  })

  it('does not start a second run while one is in progress', async () => {
    const db = new MemoryDb()
    let release: () => void = () => {}
    db.loadDevices = () => new Promise((resolve) => { release = () => resolve([]) })
    const r = runnerFor(db)
    const first = r.runFull()
    await r.runFull() // returns at once
    release()
    await first
    expect(db.started).toHaveLength(1)
  })

  it('start() records a possible gap, then polls and checks on its own timers until stopped', async () => {
    vi.useFakeTimers()
    const db = new MemoryDb()
    const r = runnerFor(db)
    await r.start()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(db.heartbeats.length).toBeGreaterThanOrEqual(3)
    r.stop()
    const seen = db.heartbeats.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(db.heartbeats.length).toBe(seen)
  })
})
```

Replace `tests/unit/api-routes.test.ts` with:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    throw new Error('no database in a unit test')
  },
}))

import { GET as health } from '@/app/api/health/route'
import { GET as version } from '@/app/api/version/route'

const saved = process.env.NEXT_PUBLIC_BUILD_ID
beforeEach(() => delete process.env.NEXT_PUBLIC_BUILD_ID)
afterEach(() => {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_BUILD_ID
  else process.env.NEXT_PUBLIC_BUILD_ID = saved
})

describe('health and version routes', () => {
  it('health reports degraded, with the database and the worker marked down, when the database cannot be reached', async () => {
    const res = await health()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'degraded', db: false, worker: { ok: false, heartbeatAgeSec: null } })
  })

  it('version reports the build id', async () => {
    process.env.NEXT_PUBLIC_BUILD_ID = 'abc123'
    expect(await (await version()).json()).toEqual({ build: 'abc123' })
  })

  it('version falls back to dev', async () => {
    expect(await (await version()).json()).toEqual({ build: 'dev' })
  })
})
```

- [ ] **Step 3: Write the failing integration tests**

`tests/integration/health.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getWorkerHealth, getWorkerStatus } from '@/lib/monitor/health'
import { adminClient } from '../setup/fixtures'

describe('worker health', () => {
  let saved: Record<string, unknown>
  beforeAll(async () => {
    saved = (await adminClient().from('worker_state').select('*').eq('id', 1).single()).data!
  })
  afterAll(async () => {
    await adminClient().from('worker_state').update(saved).eq('id', 1)
  })

  it('is ok with a fresh heartbeat and not ok with an old or missing one', async () => {
    const a = adminClient()
    const now = new Date('2026-06-01T10:00:00Z')
    await a.from('worker_state').update({ last_heartbeat: new Date(now.getTime() - 4000).toISOString() }).eq('id', 1)
    expect(await getWorkerHealth(a, now)).toEqual({ ok: true, heartbeatAgeSec: 4 })
    await a.from('worker_state').update({ last_heartbeat: new Date(now.getTime() - 120_000).toISOString() }).eq('id', 1)
    expect(await getWorkerHealth(a, now)).toEqual({ ok: false, heartbeatAgeSec: 120 })
    await a.from('worker_state').update({ last_heartbeat: null }).eq('id', 1)
    expect(await getWorkerHealth(a, now)).toEqual({ ok: false, heartbeatAgeSec: null })
  })

  it('shows whether a run is in progress', async () => {
    const a = adminClient()
    const now = new Date('2026-06-01T10:00:00Z')
    await a.from('worker_state').update({
      last_heartbeat: now.toISOString(), run_started_at: new Date(now.getTime() - 20_000).toISOString(), run_finished_at: null, progress_done: 3, progress_total: 10,
    }).eq('id', 1)
    expect(await getWorkerStatus(a, now)).toMatchObject({ ok: true, running: true, progressDone: 3, progressTotal: 10 })
    await a.from('worker_state').update({ run_finished_at: new Date(now.getTime() - 1000).toISOString() }).eq('id', 1)
    expect((await getWorkerStatus(a, now)).running).toBe(false)
  })
})
```

`tests/integration/worker-run.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { realProbes } from '@/lib/monitor/probes'
import { MonitorRunner } from '@/lib/monitor/runner'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { adminClient, cleanupOrg, createOrg } from '../setup/fixtures'
import { closedPort, startFakeNvr, startFakeRtsp, startFakeTcp, type FakeNvr, type FakeRtsp, type Running } from '../helpers/fake-servers'

const admin = () => adminClient()

describe('the worker against a fake network', () => {
  let orgId: string
  let storeId: string
  let cams: string[]
  let devUp: string
  let devDown: string
  let nvr: FakeNvr
  let rtsp: FakeRtsp
  let tcp: Running
  let runner: MonitorRunner
  let saved: Record<string, unknown>

  const state = async (type: string, id: string) => (await admin().from('check_state').select('*').eq('org_id', orgId).eq('target_type', type).eq('target_id', id).maybeSingle()).data
  const openOutage = async (type: string, id: string) =>
    (await admin().from('outages').select('*').eq('org_id', orgId).eq('target_type', type).eq('target_id', id).is('ended_at', null).maybeSingle()).data

  beforeAll(async () => {
    saved = (await admin().from('worker_state').select('*').eq('id', 1).single()).data!
    orgId = await createOrg()
    nvr = await startFakeNvr({
      statuses: { 1: true, 2: false, 3: true },
      channels: [{ channel: 1, name: 'Door', ip: '192.0.2.11' }, { channel: 2, name: 'Till', ip: '192.0.2.12' }, { channel: 3, name: 'Yard', ip: '192.0.2.13' }],
    })
    rtsp = await startFakeRtsp('refuse')
    tcp = await startFakeTcp()
    const downPort = await closedPort()
    const a = admin()
    storeId = (await a.from('stores').insert({ org_id: orgId, code: 'RUN', name: 'Run', nvr_ip: '127.0.0.1', rtsp_port: rtsp.port, http_port: nvr.port, nvr_username: 'viewer' }).select('id').single()).data!.id
    await a.rpc('nvr_store_credential', { p_store: storeId, p_secret: 'secret-pass' })
    cams = (await a.from('cameras').insert([1, 2, 3].map((n) => ({ org_id: orgId, store_id: storeId, channel: n, name: `Camera ${n}` }))).select('id').order('channel')).data!.map((c) => c.id)
    devUp = (await a.from('devices').insert({ org_id: orgId, store_id: storeId, type: 'server', name: 'Up', ip: '127.0.0.1', tcp_port: tcp.port }).select('id').single()).data!.id
    devDown = (await a.from('devices').insert({ org_id: orgId, store_id: storeId, type: 'attendance', name: 'Down', ip: '127.0.0.1', tcp_port: downPort }).select('id').single()).data!.id
    runner = new MonitorRunner({ db: new SupabaseMonitorDb(a), probes: realProbes, cfg: { ...loadMonitorConfig({}), nvrTimeoutMs: 2000 }, clock: () => new Date() })
  })

  afterAll(async () => {
    await nvr.close()
    await rtsp.close()
    await tcp.close()
    await admin().from('worker_state').update(saved).eq('id', 1)
    await cleanupOrg(orgId)
  })

  it('two full runs find what is up and what is down, with outages only after the second failure', async () => {
    await runner.runFull()
    expect((await state('camera', cams[1]))?.status).toBe('unknown') // one failure is not an outage yet
    await runner.runFull()
    expect((await state('nvr', storeId))?.status).toBe('up')
    expect((await state('camera', cams[0]))?.status).toBe('up')
    expect((await state('camera', cams[2]))?.status).toBe('up')
    expect((await state('camera', cams[1]))?.status).toBe('down')
    expect(await openOutage('camera', cams[1])).not.toBeNull()
    expect((await state('device', devUp))?.status).toBe('up')
    expect((await state('device', devDown))?.status).toBe('down')
    expect(await openOutage('device', devDown)).not.toBeNull()
    expect((await state('camera', cams[1]))?.error).toBe('The camera did not answer.')
    expect(rtsp.requests.length).toBeGreaterThanOrEqual(2) // the offline camera was confirmed with RTSP
    const { data: camera } = await admin().from('cameras').select('camera_ip').eq('id', cams[0]).single()
    expect(camera?.camera_ip).toBe('192.0.2.11')
    expect((await admin().from('worker_state').select('run_finished_at, progress_done, progress_total').eq('id', 1).single()).data).toMatchObject({ progress_done: 1, progress_total: 1 })
  })

  it('a camera that comes back closes its outage', async () => {
    nvr.setStatuses({ 1: true, 2: true, 3: true })
    await runner.runCameras()
    expect((await state('camera', cams[1]))?.status).toBe('up')
    expect(await openOutage('camera', cams[1])).toBeNull()
  })

  it('when the NVR goes down its cameras go down at once with the NVR as the cause', async () => {
    await rtsp.close() // the NVR video port is gone
    await runner.runDevices()
    await runner.runDevices()
    expect((await state('nvr', storeId))?.status).toBe('down')
    await runner.runCameras()
    for (const c of cams) {
      expect((await state('camera', c))?.status).toBe('down')
      expect((await openOutage('camera', c))?.cause).toBe('nvr_down')
    }
  })

  it('a check-now request makes the worker run everything once', async () => {
    const a = admin()
    await a.from('worker_state').update({ check_requested_at: new Date().toISOString(), run_started_at: null, run_finished_at: null }).eq('id', 1)
    await runner.pollOnce()
    const first = (await a.from('worker_state').select('run_started_at, run_finished_at, last_heartbeat').eq('id', 1).single()).data!
    expect(first.run_started_at).not.toBeNull()
    expect(first.run_finished_at).not.toBeNull()
    expect(Date.now() - new Date(first.last_heartbeat!).getTime()).toBeLessThan(15_000)
    await runner.pollOnce()
    const second = (await a.from('worker_state').select('run_started_at').eq('id', 1).single()).data!
    expect(second.run_started_at).toBe(first.run_started_at)
  })
})
```

- [ ] **Step 4: Run to see them fail**

Run: `npx vitest run tests/unit/monitor-runner.test.ts tests/unit/api-routes.test.ts tests/integration/health.test.ts tests/integration/worker-run.test.ts`
Expected: FAIL (modules and behaviour missing).

- [ ] **Step 5: Implement the runner, health and the entry point**

`lib/monitor/runner.ts`:
```ts
import { logger } from '@/lib/observability/logger'
import { checkCameras, checkDevices, checkNvrs, type Deps } from '@/lib/monitor/checks'

const MAX_SILENCE_MS = 30_000

/** Runs the checks on their schedules, answers "check now" requests and keeps the heartbeat. */
export class MonitorRunner {
  private timers = new Set<NodeJS.Timeout>()
  private stopped = false
  private busy = { devices: false, cameras: false, full: false }

  constructor(private deps: Deps) {}

  async runDevices(): Promise<void> {
    if (this.busy.devices) return
    this.busy.devices = true
    try {
      await checkDevices(this.deps)
      await checkNvrs(this.deps)
    } finally {
      this.busy.devices = false
    }
  }

  async runCameras(onProgress?: (done: number, total: number) => void): Promise<void> {
    if (this.busy.cameras) return
    this.busy.cameras = true
    try {
      await checkCameras(this.deps, onProgress)
    } finally {
      this.busy.cameras = false
    }
  }

  /** Everything now: devices, NVRs, then every store's cameras, with progress for the Monitoring page. */
  async runFull(): Promise<void> {
    if (this.busy.full) return
    this.busy.full = true
    const { db, clock } = this.deps
    let writes: Promise<void> = Promise.resolve()
    try {
      await db.markRunStarted(clock(), 0)
      await this.runDevices()
      await this.runCameras((done, total) => {
        writes = writes.then(() => db.markProgress(done, total)).catch((e) => logger.error({ event: 'progress_write_failed', error: e }))
      })
    } finally {
      await writes
      await db.markRunFinished(clock())
      this.busy.full = false
    }
  }

  /** One beat: heartbeat, then run everything if someone asked for a check since the last run began. */
  async pollOnce(): Promise<void> {
    await this.deps.db.touchHeartbeat(this.deps.clock())
    const req = await this.deps.db.readRequest()
    if (req.requestedAt && (!req.runStartedAt || req.requestedAt > req.runStartedAt)) await this.runFull()
  }

  async start(): Promise<void> {
    await this.deps.db.recordStartupGap(this.deps.clock(), MAX_SILENCE_MS)
    this.loop(() => this.pollOnce(), this.deps.cfg.pollSec * 1000)
    this.loop(() => this.runDevices(), this.deps.cfg.deviceCheckSec * 1000)
    this.loop(() => this.runCameras(), this.deps.cfg.cameraCheckSec * 1000)
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  private loop(fn: () => Promise<void>, ms: number): void {
    const tick = async () => {
      if (this.stopped) return
      try {
        await fn()
      } catch (e) {
        logger.error({ event: 'worker_loop_failed', error: e })
      }
      if (!this.stopped) {
        const t = setTimeout(() => {
          this.timers.delete(t)
          void tick()
        }, ms)
        this.timers.add(t)
      }
    }
    void tick()
  }
}
```

`lib/monitor/health.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

export type WorkerHealth = { ok: boolean; heartbeatAgeSec: number | null }
export type WorkerStatus = WorkerHealth & {
  requestedAt: string | null
  runStartedAt: string | null
  runFinishedAt: string | null
  running: boolean
  progressDone: number
  progressTotal: number
}

type Admin = SupabaseClient<Database>

async function readState(admin: Admin) {
  const { data, error } = await admin.from('worker_state').select('*').eq('id', 1).single()
  if (error || !data) throw new Error('Could not read the worker state.')
  return data
}

const age = (heartbeat: string | null, now: Date) => (heartbeat ? Math.max(0, Math.round((now.getTime() - new Date(heartbeat).getTime()) / 1000)) : null)

/** The worker beats every 5 seconds; no beat for 30 seconds means it is not running. */
export async function getWorkerHealth(admin: Admin, now = new Date(), maxAgeSec = 30): Promise<WorkerHealth> {
  const s = await readState(admin)
  const heartbeatAgeSec = age(s.last_heartbeat, now)
  return { ok: heartbeatAgeSec !== null && heartbeatAgeSec < maxAgeSec, heartbeatAgeSec }
}

export async function getWorkerStatus(admin: Admin, now = new Date()): Promise<WorkerStatus> {
  const s = await readState(admin)
  const heartbeatAgeSec = age(s.last_heartbeat, now)
  return {
    ok: heartbeatAgeSec !== null && heartbeatAgeSec < 30,
    heartbeatAgeSec,
    requestedAt: s.check_requested_at,
    runStartedAt: s.run_started_at,
    runFinishedAt: s.run_finished_at,
    running: !!s.run_started_at && (!s.run_finished_at || new Date(s.run_finished_at) < new Date(s.run_started_at)),
    progressDone: s.progress_done,
    progressTotal: s.progress_total,
  }
}
```

`app/api/health/route.ts` (replace):
```ts
import { getWorkerHealth } from '@/lib/monitor/health'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

// Public: says whether the app, the database and the worker are alive. No counts, names or addresses.
export async function GET() {
  let db = false
  let worker: { ok: boolean; heartbeatAgeSec: number | null } = { ok: false, heartbeatAgeSec: null }
  try {
    worker = await getWorkerHealth(createAdminClient())
    db = true
  } catch {
    db = false
  }
  return Response.json({ status: db && worker.ok ? 'ok' : 'degraded', db, worker })
}
```

`services/worker/index.ts`:
```ts
import { existsSync } from 'node:fs'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { realProbes } from '@/lib/monitor/probes'
import { MonitorRunner } from '@/lib/monitor/runner'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { logger } from '@/lib/observability/logger'
import { createAdminClient } from '@/lib/supabase/admin'

// The monitoring worker: a long-running process next to the web app. Run it with `npm run worker`.
async function main() {
  if (existsSync('.env.local')) process.loadEnvFile('.env.local') // development; in production the service sets the environment
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    logger.error({ event: 'worker_config_missing', message: 'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required' })
    process.exit(1)
  }
  const cfg = loadMonitorConfig()
  const runner = new MonitorRunner({ db: new SupabaseMonitorDb(createAdminClient()), probes: realProbes, cfg, clock: () => new Date() })
  await runner.start()
  logger.info({ event: 'worker_started', deviceCheckSec: cfg.deviceCheckSec, cameraCheckSec: cfg.cameraCheckSec, failThreshold: cfg.failThreshold })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      runner.stop()
      logger.info({ event: 'worker_stopped', signal })
      process.exit(0)
    })
  }
}

main().catch((e) => {
  logger.error({ event: 'worker_crashed', error: e })
  process.exit(1)
})
```

- [ ] **Step 6: Run the checks**

Run: `npx vitest run tests/unit` (all), `npx vitest run tests/integration/health.test.ts tests/integration/worker-run.test.ts`, then `npm run test:integration`, `npm run typecheck`, `npm run lint`.
Expected: green. Make sure no real worker is running against this database while the integration tests run.

Also start the worker for ten seconds to prove the entry point boots: `npm run worker` in the background, wait about 8 seconds, then check `worker_state.last_heartbeat` moved (through Studio at http://127.0.0.1:55323 or a one-off `node -e` query that prints only the timestamp), then stop it (Windows: `netstat` is not needed; stop the background task with the tool that started it, or `taskkill //F //IM node.exe` only if no other node process of yours is needed; prefer stopping the specific process id).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: monitoring worker with heartbeat, check-now polling and health endpoint"
```

---

### Task 9: Finding cameras on an NVR

**Files:**
- Create: `lib/monitor/discovery.ts`, `lib/actions/admin/monitoring.ts`, `components/monitor/FindCamerasButton.tsx`
- Modify: `app/(app)/admin/stores/page.tsx`
- Test: `tests/integration/discovery.test.ts`

**Interfaces:**
- Consumes: `NvrClient`, `describeNvrError`, `realProbes.nvr`, `Actor`, `Result`, `addAudit`, `isAdminRole`.
- Produces: `discoverStoreCameras(admin, actor, storeId, deps?)` returning `Result<{cameras: number; created: number; updated: number}>`; Server Action `discoverCamerasAction(storeId)`; a "Find cameras" button on each row of the admin stores page.

- [ ] **Step 1: Write the failing test**

`tests/integration/discovery.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { discoverStoreCameras } from '@/lib/monitor/discovery'
import { adminClient, cleanupOrg, createOrg, createUser } from '../setup/fixtures'
import { closedPort, startFakeNvr, type FakeNvr } from '../helpers/fake-servers'

const admin = () => adminClient()

describe('finding cameras on the NVR', () => {
  let orgId: string
  let actor: Actor
  let storeId: string
  let nvr: FakeNvr

  beforeAll(async () => {
    orgId = await createOrg()
    const u = await createUser(orgId, 'admin')
    actor = { id: u.id, orgId, role: 'admin' }
    nvr = await startFakeNvr({
      channels: [{ channel: 1, name: 'Entrance', ip: '192.0.2.11' }, { channel: 2, name: 'Billing counter', ip: '192.0.2.12' }, { channel: 3, name: 'Stockroom' }],
      statuses: { 1: true, 2: true, 3: true },
    })
    const a = admin()
    storeId = (await a.from('stores').insert({ org_id: orgId, code: 'DISC', name: 'Disc', nvr_ip: '127.0.0.1', http_port: nvr.port, nvr_username: 'viewer', expected_channels: 2 }).select('id').single()).data!.id
    await a.rpc('nvr_store_credential', { p_store: storeId, p_secret: 'secret-pass' })
    await a.from('cameras').insert([1, 2].map((n) => ({ org_id: orgId, store_id: storeId, channel: n, name: `Camera ${n}` })))
  })
  afterAll(async () => {
    await nvr.close()
    await cleanupOrg(orgId)
  })

  it('replaces placeholder names, adds new channels and keeps camera ids', async () => {
    const before = (await admin().from('cameras').select('id, channel').eq('store_id', storeId).order('channel')).data!
    const res = await discoverStoreCameras(admin(), actor, storeId)
    expect(res).toEqual({ ok: true, cameras: 3, created: 1, updated: 2 })
    const after = (await admin().from('cameras').select('id, channel, name, camera_ip').eq('store_id', storeId).order('channel')).data!
    expect(after.map((c) => [c.channel, c.name, c.camera_ip])).toEqual([[1, 'Entrance', '192.0.2.11'], [2, 'Billing counter', '192.0.2.12'], [3, 'Stockroom', null]])
    expect(after.slice(0, 2).map((c) => c.id)).toEqual(before.map((c) => c.id))
    expect((await admin().from('admin_audit_log').select('action').eq('org_id', orgId)).data?.map((r) => r.action)).toContain('cameras_discovered')
  })

  it('says plainly what went wrong', async () => {
    const a = admin()
    const wrongPassword = (await a.from('stores').insert({ org_id: orgId, code: 'BADPW', name: 'Bad', nvr_ip: '127.0.0.1', http_port: nvr.port, nvr_username: 'viewer' }).select('id').single()).data!.id
    await a.rpc('nvr_store_credential', { p_store: wrongPassword, p_secret: 'not-the-password' })
    expect(await discoverStoreCameras(a, actor, wrongPassword)).toEqual({ ok: false, error: 'The NVR refused the user name or password.' })

    const gone = (await a.from('stores').insert({ org_id: orgId, code: 'GONE', name: 'Gone', nvr_ip: '127.0.0.1', http_port: await closedPort(), nvr_username: 'viewer' }).select('id').single()).data!.id
    await a.rpc('nvr_store_credential', { p_store: gone, p_secret: 'secret-pass' })
    expect(await discoverStoreCameras(a, actor, gone)).toEqual({ ok: false, error: 'The NVR did not answer.' })
  })

  it('is for administrators only and only for stores of the own organisation', async () => {
    expect((await discoverStoreCameras(admin(), { ...actor, role: 'agent' }, storeId)).ok).toBe(false)
    const other = await createOrg()
    const { data } = await admin().from('stores').insert({ org_id: other, code: 'OTH', name: 'Oth', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    expect(await discoverStoreCameras(admin(), actor, data!.id)).toEqual({ ok: false, error: 'Store not found.' })
    await cleanupOrg(other)
  })

  it('reports an NVR with no cameras', async () => {
    const empty = await startFakeNvr({ channels: [], statuses: {} })
    const a = admin()
    const id = (await a.from('stores').insert({ org_id: orgId, code: 'EMPTY', name: 'Empty', nvr_ip: '127.0.0.1', http_port: empty.port, nvr_username: 'viewer' }).select('id').single()).data!.id
    await a.rpc('nvr_store_credential', { p_store: id, p_secret: 'secret-pass' })
    expect(await discoverStoreCameras(a, actor, id)).toEqual({ ok: false, error: 'The NVR did not list any cameras.' })
    await empty.close()
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/integration/discovery.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement discovery**

`lib/monitor/discovery.ts`:
```ts
import { addAudit } from '@/lib/admin/audit'
import { isAdminRole } from '@/lib/admin/roles'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { realProbes } from '@/lib/monitor/probes'
import type { Probes } from '@/lib/monitor/types'
import { describeNvrError } from '@/lib/nvr/client'
import { sanitizeError } from '@/lib/observability/sanitize-error'

/** Reads the camera list from the store's NVR and saves names and addresses. Cameras are matched by (store, channel), so their ids stay the same. */
export async function discoverStoreCameras(
  admin: AdminClient,
  actor: Actor,
  storeId: string,
  deps: { nvr: Probes['nvr'] } = { nvr: realProbes.nvr },
): Promise<Result<{ cameras: number; created: number; updated: number }>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: 'Only administrators can look for cameras.' }
  const { data: store } = await admin
    .from('stores')
    .select('id, nvr_ip, http_port, nvr_username')
    .eq('id', storeId)
    .eq('org_id', actor.orgId)
    .maybeSingle()
  if (!store) return { ok: false, error: 'Store not found.' }

  const { data: password } = await admin.rpc('nvr_read_credential', { p_store: store.id })
  let channels
  try {
    channels = await deps.nvr({ host: store.nvr_ip, port: store.http_port, username: store.nvr_username, password: password ?? '' }).channels()
  } catch (e) {
    return { ok: false, error: describeNvrError(e) }
  }
  if (channels.length === 0) return { ok: false, error: 'The NVR did not list any cameras.' }

  const { data: existing } = await admin.from('cameras').select('channel').eq('store_id', store.id)
  const known = new Set((existing ?? []).map((c) => c.channel))
  const rows = channels.map((c) => ({
    org_id: actor.orgId,
    store_id: store.id,
    channel: c.channel,
    name: (c.name.trim() || `Camera ${c.channel}`).slice(0, 200),
    camera_ip: c.ip,
  }))
  const { error } = await admin.from('cameras').upsert(rows, { onConflict: 'store_id,channel' })
  if (error) return { ok: false, error: sanitizeError(error, { route: 'discoverStoreCameras', fallback: 'Could not save the cameras.' }) }

  const created = rows.filter((r) => !known.has(r.channel)).length
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'cameras_discovered', entityType: 'store', entityId: store.id, detail: { created, updated: rows.length - created } })
  return { ok: true, cameras: rows.length, created, updated: rows.length - created }
}
```

- [ ] **Step 4: The action, the button and the page**

`lib/actions/admin/monitoring.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth/profile'
import { discoverStoreCameras } from '@/lib/monitor/discovery'
import { createAdminClient } from '@/lib/supabase/admin'

export type DiscoverState = { message?: string; error?: string }

export async function discoverCamerasAction(storeId: string): Promise<DiscoverState> {
  const p = await requireAdmin()
  const res = await discoverStoreCameras(createAdminClient(), { id: p.id, orgId: p.org_id, role: p.role }, storeId)
  revalidatePath('/admin/stores')
  revalidatePath('/stores')
  if (!res.ok) return { error: res.error }
  return { message: `Found ${res.cameras} camera${res.cameras === 1 ? '' : 's'} (${res.created} new).` }
}
```

`components/monitor/FindCamerasButton.tsx`:
```tsx
'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { discoverCamerasAction } from '@/lib/actions/admin/monitoring'
import { Button } from '@/components/ui/button'

export function FindCamerasButton({ storeId }: { storeId: string }) {
  const [pending, start] = useTransition()
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await discoverCamerasAction(storeId)
          if (res.error) toast.error(res.error)
          else toast.success(res.message ?? 'Done.')
        })
      }
    >
      {pending ? 'Looking…' : 'Find cameras'}
    </Button>
  )
}
```

In `app/(app)/admin/stores/page.tsx` import `FindCamerasButton` and render `<FindCamerasButton storeId={s.id} />` inside the actions cell, before the Edit link.

- [ ] **Step 5: Run the checks**

Run: `npx vitest run tests/integration/discovery.test.ts`, `npm run test:integration`, `npm run test:unit`, `npm run typecheck`, `npm run lint`.
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: find cameras on the NVR and save their names and addresses"
```

---

### Task 10: Status in the screens: Home, Stores, store detail, Devices

**Files:**
- Create: `lib/monitor/uptime.ts`, `lib/queries/status.ts`, `components/monitor/StatusBadge.tsx`
- Modify: `app/(app)/home/page.tsx`, `app/(app)/stores/page.tsx`, `app/(app)/stores/[id]/page.tsx`, `app/(app)/devices/page.tsx`
- Test: `tests/unit/status-label.test.ts`, `tests/integration/status-queries.test.ts`

**Interfaces:**
- Consumes: view `store_status`, tables `check_state` and `outages` through the signed-in person's client (row-level security), RPC `targets_uptime` through the admin client for ids that came from visible rows.
- Produces: `statusLabel(s)`; `getDashboard(supabase)`; `listStoreStatus(supabase): Promise<Map<string, StoreStatusRow>>`; `getStates(supabase, type, ids): Promise<Map<string, StateRow>>`; `uptimeFor(admin, orgId, type, ids, window): Promise<Map<string, number | null>>` with `UptimeWindow = '24h' | '7d' | '30d'`; `<StatusBadge status={...} />`.

Definitions (exact):
```ts
// lib/queries/status.ts
export type Status = 'up' | 'down' | 'unknown'
export type StoreStatusRow = { store_id: string; cameras_total: number; cameras_live: number; cameras_down: number; cameras_unknown: number; nvr_status: Status | null; nvr_down_since: string | null; nvr_checked_at: string | null }
export type StateRow = { target_id: string; status: Status; down_since: string | null; last_checked_at: string | null; last_up_at: string | null; error: string | null }
export type Dashboard = {
  cameras: { total: number; live: number; down: number; unknown: number }
  stores: { total: number; nvrDown: { id: string; code: string; name: string; since: string | null }[]; noLiveCamera: number }
  devices: Record<string, { total: number; up: number; down: number; unknown: number }>
  recentOutages: { id: string; kind: 'camera' | 'device' | 'nvr'; label: string; store: string | null; startedAt: string; endedAt: string | null }[]
}
```

- [ ] **Step 1: Write the failing tests**

`tests/unit/status-label.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { statusLabel } from '@/lib/queries/status'

describe('statusLabel', () => {
  it('uses the three words the screens use', () => {
    expect(statusLabel('up')).toBe('Live')
    expect(statusLabel('down')).toBe('Offline')
    expect(statusLabel('unknown')).toBe('Not checked yet')
    expect(statusLabel(null)).toBe('Not checked yet')
    expect(statusLabel(undefined)).toBe('Not checked yet')
  })
})
```

`tests/integration/status-queries.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDashboard, getStates, listStoreStatus } from '@/lib/queries/status'
import { uptimeFor } from '@/lib/monitor/uptime'
import { adminClient, cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'

const admin = () => adminClient()
const now = () => new Date().toISOString()
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

describe('status queries', () => {
  let orgId: string
  let s1: string
  let s2: string
  let cams1: string[]
  let cam2: string
  let dev: string[]
  let manager: TestUser
  let viewer: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    const a = admin()
    const mk = async (code: string) => (await a.from('stores').insert({ org_id: orgId, code, name: `Store ${code}`, nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    s1 = await mk('ST1')
    s2 = await mk('ST2')
    cams1 = (await a.from('cameras').insert([1, 2, 3].map((n) => ({ org_id: orgId, store_id: s1, channel: n, name: `C${n}` }))).select('id').order('channel')).data!.map((c) => c.id)
    cam2 = (await a.from('cameras').insert({ org_id: orgId, store_id: s2, channel: 1, name: 'D1' }).select('id').single()).data!.id
    dev = (await a.from('devices').insert([
      { org_id: orgId, store_id: s1, type: 'server', name: 'ERP', ip: '127.0.0.1', tcp_port: 1 },
      { org_id: orgId, store_id: s1, type: 'server', name: 'Mail', ip: '127.0.0.1', tcp_port: 2 },
    ]).select('id').order('name')).data!.map((d) => d.id)
    // ST1: camera 1 up, camera 2 down (own outage), camera 3 not checked; NVR up; ERP up, Mail down.
    // ST2: NVR down, its camera down because of the NVR.
    const apply = (results: object[], threshold = 2) => a.rpc('monitor_apply_results', { p_org: orgId, p_results: results as never, p_threshold: threshold })
    await apply([{ type: 'camera', id: cams1[0], ok: true, at: ago(5) }, { type: 'nvr', id: s1, ok: true, at: ago(5) }, { type: 'device', id: dev[0], ok: true, at: ago(5) }])
    await apply([{ type: 'camera', id: cams1[1], ok: false, at: ago(20) }, { type: 'device', id: dev[1], ok: false, at: ago(20) }])
    await apply([{ type: 'camera', id: cams1[1], ok: false, at: ago(10) }, { type: 'device', id: dev[1], ok: false, at: ago(10) }])
    await apply([{ type: 'nvr', id: s2, ok: false, at: ago(8) }], 1)
    await apply([{ type: 'camera', id: cam2, ok: false, at: ago(8), cause: 'nvr_down' }], 1)
    manager = await createUser(orgId, 'manager')
    viewer = await createUser(orgId, 'user')
    await a.rpc('replace_user_access', { p_user: viewer.id, p_stores: [s1], p_zones: [], p_cameras: [] })
  })
  afterAll(() => cleanupOrg(orgId))

  it('the dashboard summarises what the reader may see', async () => {
    const d = await getDashboard(manager.client)
    expect(d.cameras).toEqual({ total: 4, live: 1, down: 2, unknown: 1 })
    expect(d.stores.total).toBe(2)
    expect(d.stores.nvrDown.map((s) => s.code)).toEqual(['ST2'])
    expect(d.stores.noLiveCamera).toBe(1)
    expect(d.devices.server).toEqual({ total: 2, up: 1, down: 1, unknown: 0 })
    const labels = d.recentOutages.map((o) => `${o.kind}:${o.label}`)
    expect(labels).toEqual(expect.arrayContaining(['camera:C2', 'device:Mail', 'nvr:Store ST2']))
    expect(labels).not.toContain('camera:D1') // listed once, as the NVR outage
  })

  it('a viewer sees the numbers of their own store only', async () => {
    const d = await getDashboard(viewer.client)
    expect(d.cameras.total).toBe(3)
    expect(d.stores.total).toBe(1)
    expect(d.stores.nvrDown).toEqual([])
    expect(d.recentOutages.map((o) => o.label)).not.toContain('Store ST2')
  })

  it('lists the status of each store and of individual targets', async () => {
    const stores = await listStoreStatus(viewer.client)
    expect([...stores.keys()]).toEqual([s1])
    expect(stores.get(s1)).toMatchObject({ cameras_total: 3, cameras_live: 1, cameras_down: 1, cameras_unknown: 1, nvr_status: 'up' })
    const states = await getStates(viewer.client, 'camera', [...cams1, cam2])
    expect(states.get(cams1[1])).toMatchObject({ status: 'down' })
    expect(states.has(cam2)).toBe(false) // not visible to the viewer
    expect(states.has(cams1[2])).toBe(false) // never checked
  })

  it('computes uptime for visible ids and gives nothing for unchecked ones', async () => {
    const up = await uptimeFor(admin(), orgId, 'camera', [cams1[0], cams1[1], cams1[2]], '24h')
    expect(up.get(cams1[0])).toBe(100)
    expect(up.get(cams1[1])).toBeLessThan(100)
    expect(up.get(cams1[2])).toBeNull()
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/unit/status-label.test.ts tests/integration/status-queries.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement uptime and the queries**

`lib/monitor/uptime.ts`:
```ts
import type { AdminClient } from '@/lib/admin/types'

export type UptimeWindow = '24h' | '7d' | '30d'
export const WINDOW_HOURS: Record<UptimeWindow, number> = { '24h': 24, '7d': 168, '30d': 720 }

/**
 * Uptime percent per target, or null when nothing has been observed yet. The ids must come from rows the caller was already allowed to
 * read (this uses the service role), and the organisation comes from the caller's profile.
 */
export async function uptimeFor(
  admin: AdminClient,
  orgId: string,
  type: 'camera' | 'device' | 'nvr',
  ids: string[],
  window: UptimeWindow,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>(ids.map((id) => [id, null]))
  if (ids.length === 0) return out
  const { data, error } = await admin.rpc('targets_uptime', { p_org: orgId, p_type: type, p_ids: ids, p_window: `${WINDOW_HOURS[window]} hours` })
  if (error) throw new Error('Could not read uptime.')
  for (const row of data ?? []) out.set(row.target_id, row.uptime_pct === null ? null : Number(row.uptime_pct))
  return out
}
```

`lib/queries/status.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchAll } from '@/lib/supabase/fetch-all'

type Client = SupabaseClient<Database>

export type Status = 'up' | 'down' | 'unknown'
export type StoreStatusRow = {
  store_id: string
  cameras_total: number
  cameras_live: number
  cameras_down: number
  cameras_unknown: number
  nvr_status: Status | null
  nvr_down_since: string | null
  nvr_checked_at: string | null
}
export type StateRow = { target_id: string; status: Status; down_since: string | null; last_checked_at: string | null; last_up_at: string | null; error: string | null }
export type Dashboard = {
  cameras: { total: number; live: number; down: number; unknown: number }
  stores: { total: number; nvrDown: { id: string; code: string; name: string; since: string | null }[]; noLiveCamera: number }
  devices: Record<string, { total: number; up: number; down: number; unknown: number }>
  recentOutages: { id: string; kind: 'camera' | 'device' | 'nvr'; label: string; store: string | null; startedAt: string; endedAt: string | null }[]
}

/** The words the screens use. */
export function statusLabel(s: Status | null | undefined): 'Live' | 'Offline' | 'Not checked yet' {
  return s === 'up' ? 'Live' : s === 'down' ? 'Offline' : 'Not checked yet'
}

// Everything below reads with the signed-in person's own client, so row-level security decides what is counted and listed.

export async function listStoreStatus(supabase: Client): Promise<Map<string, StoreStatusRow>> {
  const rows = await fetchAll((from, to) => supabase.from('store_status').select('*').order('store_id').range(from, to))
  return new Map(rows.filter((r) => r.store_id).map((r) => [r.store_id as string, r as unknown as StoreStatusRow]))
}

export async function getStates(supabase: Client, type: 'camera' | 'device' | 'nvr', ids: string[]): Promise<Map<string, StateRow>> {
  const out = new Map<string, StateRow>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase
      .from('check_state')
      .select('target_id, status, down_since, last_checked_at, last_up_at, error')
      .eq('target_type', type)
      .in('target_id', ids.slice(i, i + 100))
    for (const r of data ?? []) out.set(r.target_id, r as StateRow)
  }
  return out
}

export async function getDashboard(supabase: Client): Promise<Dashboard> {
  const [statuses, stores, devices, deviceStates, outages] = await Promise.all([
    listStoreStatus(supabase),
    fetchAll((from, to) => supabase.from('stores').select('id, code, name').order('code').order('id').range(from, to)),
    fetchAll((from, to) => supabase.from('devices').select('id, type, name, store_id').order('id').range(from, to)),
    fetchAll((from, to) => supabase.from('check_state').select('target_id, status').eq('target_type', 'device').order('target_id').range(from, to)),
    supabase.from('outages').select('id, target_type, target_id, started_at, ended_at, cause').order('started_at', { ascending: false }).limit(40),
  ])

  const cameras = { total: 0, live: 0, down: 0, unknown: 0 }
  let noLiveCamera = 0
  for (const s of statuses.values()) {
    cameras.total += s.cameras_total
    cameras.live += s.cameras_live
    cameras.down += s.cameras_down
    cameras.unknown += s.cameras_unknown
    if (s.cameras_total > 0 && s.cameras_live === 0 && s.cameras_unknown === 0) noLiveCamera++
  }
  const storeById = new Map(stores.map((s) => [s.id, s]))
  const nvrDown = [...statuses.values()]
    .filter((s) => s.nvr_status === 'down')
    .map((s) => ({ id: s.store_id, code: storeById.get(s.store_id)?.code ?? '', name: storeById.get(s.store_id)?.name ?? '', since: s.nvr_down_since }))
    .sort((a, b) => a.code.localeCompare(b.code))

  const stateOf = new Map(deviceStates.map((d) => [d.target_id, d.status as Status]))
  const deviceCounts: Dashboard['devices'] = {}
  for (const d of devices) {
    const c = (deviceCounts[d.type] ??= { total: 0, up: 0, down: 0, unknown: 0 })
    const st = stateOf.get(d.id) ?? 'unknown'
    c.total++
    c[st]++
  }

  // A camera that is down only because its NVR is down is not listed again: the NVR outage already says so.
  const rows = (outages.data ?? []).filter((o) => !(o.target_type === 'camera' && o.cause === 'nvr_down')).slice(0, 10)
  const ids = (type: string) => rows.filter((o) => o.target_type === type).map((o) => o.target_id)
  const [camRows, devRows] = await Promise.all([
    ids('camera').length ? supabase.from('cameras').select('id, name, store_id').in('id', ids('camera')) : Promise.resolve({ data: [] as { id: string; name: string; store_id: string }[] }),
    ids('device').length ? supabase.from('devices').select('id, name, store_id').in('id', ids('device')) : Promise.resolve({ data: [] as { id: string; name: string; store_id: string | null }[] }),
  ])
  const camById = new Map((camRows.data ?? []).map((c) => [c.id, c]))
  const devById = new Map((devRows.data ?? []).map((d) => [d.id, d]))
  const recentOutages = rows.map((o) => {
    const kind = o.target_type as 'camera' | 'device' | 'nvr'
    if (kind === 'camera') {
      const c = camById.get(o.target_id)
      return { id: o.id, kind, label: c?.name ?? 'Camera', store: c ? (storeById.get(c.store_id)?.code ?? null) : null, startedAt: o.started_at, endedAt: o.ended_at }
    }
    if (kind === 'device') {
      const d = devById.get(o.target_id)
      return { id: o.id, kind, label: d?.name ?? 'Device', store: d?.store_id ? (storeById.get(d.store_id)?.code ?? null) : null, startedAt: o.started_at, endedAt: o.ended_at }
    }
    const s = storeById.get(o.target_id)
    return { id: o.id, kind, label: s ? `Store ${s.code}`.replace(/^Store (.+)$/, () => s.name) : 'NVR', store: s?.code ?? null, startedAt: o.started_at, endedAt: o.ended_at }
  })

  return { cameras, stores: { total: stores.length, nvrDown, noLiveCamera }, devices: deviceCounts, recentOutages }
}
```
(The NVR outage label is the store's own name; the test seeds stores named `Store ST2`, so it expects `nvr:Store ST2`. Simplify the label line to `label: s?.name ?? 'NVR'` if you prefer; the test only needs that string for the seeded name.)

`components/monitor/StatusBadge.tsx`:
```tsx
import { cn } from '@/lib/utils'
import { statusLabel, type Status } from '@/lib/queries/status'

const STYLES: Record<Status, string> = {
  up: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  down: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  unknown: 'bg-muted text-muted-foreground',
}

export function StatusBadge({ status, className }: { status: Status | null | undefined; className?: string }) {
  const s: Status = status ?? 'unknown'
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', STYLES[s], className)}>{statusLabel(s)}</span>
}
```

- [ ] **Step 4: Update the screens**

`app/(app)/home/page.tsx` (replace):
```tsx
import Link from 'next/link'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireProfile } from '@/lib/auth/profile'
import { DEVICE_TYPE_LABELS, DEVICE_TYPES, type DeviceType } from '@/lib/inventory/device-types'
import { getDashboard } from '@/lib/queries/status'
import { createClient } from '@/lib/supabase/server'
import { formatDateTime } from '@/lib/time'

export const metadata = { title: 'Home' }

export default async function HomePage() {
  const profile = await requireProfile()
  const d = await getDashboard(await createClient())
  const nothing = d.stores.total === 0 && d.cameras.total === 0 && Object.keys(d.devices).length === 0
  const tile = (key: string, label: string, value: string | number, href: string, tone?: 'good' | 'bad') => (
    <Link key={key} href={href} className="rounded-xl border bg-card p-4 hover:bg-muted">
      <div className={`text-2xl font-semibold ${tone === 'bad' && Number(value) > 0 ? 'text-red-600 dark:text-red-400' : tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </Link>
  )
  return (
    <div className="space-y-6">
      <PageHeader title={`Welcome, ${profile.full_name || profile.email}`} description="What is working and what is not, right now." />
      {nothing ? (
        <p className="text-sm text-muted-foreground">You have not been given access to anything yet. Ask an administrator.</p>
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="font-medium">Cameras</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {tile('cam-live', 'Live', d.cameras.live, '/stores', 'good')}
              {tile('cam-down', 'Offline', d.cameras.down, '/stores', 'bad')}
              {tile('cam-unknown', 'Not checked yet', d.cameras.unknown, '/stores')}
              {tile('stores', 'Stores', d.stores.total, '/stores')}
            </div>
          </section>

          {d.stores.nvrDown.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-medium">Stores with the NVR down ({d.stores.nvrDown.length})</h2>
              <ul className="divide-y rounded-xl border bg-card text-sm">
                {d.stores.nvrDown.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <Link href={`/stores/${s.id}`} className="underline">{s.code} · {s.name}</Link>
                    <span className="text-muted-foreground">Offline since {formatDateTime(s.since)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {Object.keys(d.devices).length > 0 && (
            <section className="space-y-2">
              <h2 className="font-medium">Devices</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {DEVICE_TYPES.filter((t) => d.devices[t]).map((t) => {
                  const c = d.devices[t]
                  return (
                    <Link key={t} href={`/devices?type=${t}`} className="rounded-xl border bg-card p-4 hover:bg-muted">
                      <div className="text-sm font-medium">{DEVICE_TYPE_LABELS[t as DeviceType]}s</div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        <span className="text-emerald-600 dark:text-emerald-400">{c.up} live</span> ·{' '}
                        <span className={c.down ? 'text-red-600 dark:text-red-400' : ''}>{c.down} offline</span>
                        {c.unknown > 0 && <> · {c.unknown} not checked yet</>}
                      </div>
                    </Link>
                  )
                })}
              </div>
            </section>
          )}

          <section className="space-y-2">
            <h2 className="font-medium">Recent problems</h2>
            {d.recentOutages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No problems have been recorded yet.</p>
            ) : (
              <ul className="divide-y rounded-xl border bg-card text-sm">
                {d.recentOutages.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span>
                      {o.kind === 'nvr' ? 'NVR' : o.kind === 'camera' ? 'Camera' : 'Device'} · {o.label}
                      {o.store && o.kind !== 'nvr' ? <span className="text-muted-foreground"> · {o.store}</span> : null}
                    </span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      {formatDateTime(o.startedAt)}
                      {o.endedAt ? <StatusBadge status="up" /> : <StatusBadge status="down" />}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
```

`app/(app)/stores/page.tsx`: load `listStoreStatus(supabase)` next to `listVisibleStores`, add two columns after Zone: **NVR** (`<StatusBadge status={status?.nvr_status} />`) and **Cameras live** (`{live} / {total}` in red when `cameras_down > 0`, or "Not checked yet" when `cameras_unknown === cameras_total`), and keep the camera count column as before.

`app/(app)/stores/[id]/page.tsx`: after `getVisibleStore`, load in parallel `getStates(supabase, 'camera', cameraIds)`, `getStates(supabase, 'device', deviceIds)`, `getStates(supabase, 'nvr', [id])` and (with the admin client and `profile.org_id`) `uptimeFor(admin, orgId, 'camera', cameraIds, '24h')` and `'7d'`. Show an **NVR** line with its badge; in each camera card show `<StatusBadge />`, "Offline since …" (`formatDateTime(down_since)`) or "Last seen live …", the uptime as "Uptime 24h 99.5% · 7d 98.1%" (or "Uptime: no data yet" for null), and the stored reason (`error`) in muted text when offline. Devices get the same badge and 24h uptime.

`app/(app)/devices/page.tsx`: load `getStates(supabase, 'device', ids)` and `uptimeFor(admin, orgId, 'device', ids, '24h')`; add columns **Status** (badge, with "since …" under it when offline) and **Uptime 24h**.

(Use `createAdminClient()` only for `uptimeFor`, after `requireProfile()`; the ids already came from rows row-level security let the person read.)

- [ ] **Step 5: Run the checks and look at the pages**

Run: `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration`.
Expected: green.
Start `npm run dev` and, with the dev admin (read from `.env.local`, never printed), open Home, Stores, a store and Devices; with no worker running everything shows "Not checked yet". Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: show live status, outages and uptime on Home, Stores and Devices"
```

---

### Task 11: Check now, the Monitoring page, demo tools and the final run

**Files:**
- Create: `lib/monitor/check-now.ts`, `lib/actions/monitor.ts`, `components/monitor/CheckNowButton.tsx`, `app/(app)/admin/monitoring/page.tsx`, `scripts/fake-nvr.ts`, `scripts/seed-demo.ts`
- Modify: `lib/nav.ts`, `components/layout/Sidebar.tsx`, `app/(app)/home/page.tsx`, `package.json` (scripts), `README.md`, `tests/unit/nav.test.ts`
- Test: `tests/integration/check-now.test.ts`, `tests/unit/nav.test.ts`

**Interfaces:**
- Consumes: `canRunChecks`, `getWorkerStatus`, `addAudit`, `rateLimit`, fake servers (Task 4), `SupabaseMonitorDb` and `realProbes`.
- Produces: `requestCheckNow(admin, actor): Promise<Result<object>>`; Server Action `requestCheckNowAction()`; `<CheckNowButton />`; the page `/admin/monitoring`; nav item "Monitoring" (admins); npm scripts `fake:nvr` and `demo:seed`.

- [ ] **Step 1: Write the failing tests**

`tests/integration/check-now.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requestCheckNow } from '@/lib/monitor/check-now'
import { adminClient, cleanupOrg, createOrg, createUser } from '../setup/fixtures'

describe('check now', () => {
  let orgId: string
  let saved: Record<string, unknown>
  beforeAll(async () => {
    saved = (await adminClient().from('worker_state').select('*').eq('id', 1).single()).data!
    orgId = await createOrg()
  })
  afterAll(async () => {
    await adminClient().from('worker_state').update(saved).eq('id', 1)
    await cleanupOrg(orgId)
  })

  it('operators, admins and owners may ask; viewers and managers may not', async () => {
    for (const role of ['user', 'manager'] as const) {
      expect((await requestCheckNow(adminClient(), { id: crypto.randomUUID(), orgId, role })).ok).toBe(false)
    }
    const before = (await adminClient().from('worker_state').select('check_requested_at').eq('id', 1).single()).data!.check_requested_at
    const person = await createUser(orgId, 'agent')
    const res = await requestCheckNow(adminClient(), { id: person.id, orgId, role: 'agent' })
    expect(res.ok).toBe(true)
    const after = (await adminClient().from('worker_state').select('check_requested_at').eq('id', 1).single()).data!.check_requested_at
    expect(after).not.toBe(before)
    expect(Date.now() - new Date(after!).getTime()).toBeLessThan(10_000)
    const audit = await adminClient().from('admin_audit_log').select('action, actor_id').eq('org_id', orgId)
    expect(audit.data).toEqual([{ action: 'check_requested', actor_id: person.id }])
  })
})
```

Update `tests/unit/nav.test.ts`: the admin list now also contains `/admin/monitoring`; add `expect(h).toContain('/admin/monitoring')` to the admin test and `expect(hrefs('user')).not.toContain('/admin/monitoring')`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/integration/check-now.test.ts tests/unit/nav.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement check now, the page and the navigation**

`lib/monitor/check-now.ts`:
```ts
import { addAudit } from '@/lib/admin/audit'
import { canRunChecks } from '@/lib/admin/roles'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { sanitizeError } from '@/lib/observability/sanitize-error'

/** Asks the worker to check everything now. The worker picks the request up within a few seconds. */
export async function requestCheckNow(admin: AdminClient, actor: Actor): Promise<Result<object>> {
  if (!canRunChecks(actor.role)) return { ok: false, error: 'You are not allowed to start a check.' }
  const { error } = await admin.from('worker_state').update({ check_requested_at: new Date().toISOString() }).eq('id', 1)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'requestCheckNow', fallback: 'Could not ask for a check. Please try again.' }) }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'check_requested' })
  return { ok: true }
}
```

`lib/actions/monitor.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireProfile } from '@/lib/auth/profile'
import { requestCheckNow } from '@/lib/monitor/check-now'
import { rateLimit } from '@/lib/rate-limit'
import { createAdminClient } from '@/lib/supabase/admin'

export type CheckNowState = { ok?: boolean; error?: string }

export async function requestCheckNowAction(): Promise<CheckNowState> {
  const p = await requireProfile()
  const { limited } = await rateLimit(`checknow:${p.id}`, 3, 60_000)
  if (limited) return { error: 'Please wait a minute before asking again.' }
  const res = await requestCheckNow(createAdminClient(), { id: p.id, orgId: p.org_id, role: p.role })
  revalidatePath('/home')
  revalidatePath('/admin/monitoring')
  return res.ok ? { ok: true } : { error: res.error }
}
```

`components/monitor/CheckNowButton.tsx`:
```tsx
'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { requestCheckNowAction } from '@/lib/actions/monitor'
import { Button } from '@/components/ui/button'

export function CheckNowButton() {
  const [pending, start] = useTransition()
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await requestCheckNowAction()
          if (res.error) toast.error(res.error)
          else toast.success('Check requested. New results appear within a minute.')
        })
      }
    >
      {pending ? 'Asking…' : 'Check now'}
    </Button>
  )
}
```

`app/(app)/admin/monitoring/page.tsx`:
```tsx
import { CheckNowButton } from '@/components/monitor/CheckNowButton'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireAdmin } from '@/lib/auth/profile'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { getWorkerStatus } from '@/lib/monitor/health'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { formatDateTime } from '@/lib/time'

export const metadata = { title: 'Monitoring' }
export const dynamic = 'force-dynamic'

export default async function MonitoringPage() {
  const me = await requireAdmin()
  const admin = createAdminClient()
  const [worker, states] = await Promise.all([
    getWorkerStatus(admin),
    fetchAll((from, to) => admin.from('check_state').select('target_type, status').eq('org_id', me.org_id).order('id').range(from, to)),
  ])
  const cfg = loadMonitorConfig()
  const counts: Record<string, { up: number; down: number; unknown: number }> = {}
  for (const s of states) {
    const c = (counts[s.target_type] ??= { up: 0, down: 0, unknown: 0 })
    c[s.status as 'up' | 'down' | 'unknown']++
  }
  const NAMES: Record<string, string> = { camera: 'Cameras', nvr: 'NVRs', device: 'Devices' }
  return (
    <div className="space-y-6">
      <PageHeader title="Monitoring" description="Is the checker running, and what did it find?" />
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="font-medium">The checker</h2>
            <StatusBadge status={worker.ok ? 'up' : 'down'} />
            <span className="text-sm text-muted-foreground">{worker.ok ? 'Running' : 'Not running'}</span>
          </div>
          <CheckNowButton />
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <dt className="text-muted-foreground">Last sign of life</dt>
          <dd>{worker.heartbeatAgeSec === null ? 'Never' : `${worker.heartbeatAgeSec} seconds ago`}</dd>
          <dt className="text-muted-foreground">Last full check finished</dt>
          <dd>{formatDateTime(worker.runFinishedAt)}</dd>
          <dt className="text-muted-foreground">Now</dt>
          <dd>{worker.running ? `Checking: ${worker.progressDone} of ${worker.progressTotal} stores done` : 'Waiting for the next round'}</dd>
          <dt className="text-muted-foreground">Rounds</dt>
          <dd>Devices and NVRs every {cfg.deviceCheckSec} seconds, cameras every {cfg.cameraCheckSec} seconds</dd>
        </dl>
        {!worker.ok && (
          <p className="text-sm text-destructive">
            The checker is not running, so the status shown elsewhere may be out of date. Start it with <code className="font-mono">npm run worker</code> on the server.
          </p>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="font-medium">What it found</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {(['camera', 'nvr', 'device'] as const).map((t) => {
            const c = counts[t] ?? { up: 0, down: 0, unknown: 0 }
            return (
              <div key={t} className="rounded-xl border bg-card p-4">
                <div className="text-sm font-medium">{NAMES[t]}</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  <span className="text-emerald-600 dark:text-emerald-400">{c.up} live</span> ·{' '}
                  <span className={c.down ? 'text-red-600 dark:text-red-400' : ''}>{c.down} offline</span>
                  {c.unknown > 0 && <> · {c.unknown} not checked yet</>}
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
```

`lib/nav.ts`: add `'activity'` to the `icon` union and the item
`{ href: '/admin/monitoring', label: 'Monitoring', icon: 'activity', group: 'Admin', roles: ADMIN_ROLES }` after "Users" (use whatever name the admin-roles constant has after Task 2). In `components/layout/Sidebar.tsx` (or the shared icons module from Task 2) add `Activity` from `lucide-react` to the icon map under `activity`.

In `app/(app)/home/page.tsx` render `<CheckNowButton />` next to the page header for people allowed to run checks (`canRunChecks(profile.role)`), and under the header a one-line "Last checked …" using `getWorkerStatus(createAdminClient()).runFinishedAt` through `formatDateTime`.

- [ ] **Step 4: Demo tools**

`scripts/fake-nvr.ts`:
```ts
// A pretend NVR, camera port and devices on loopback, so the whole app can be shown without any hardware.
// Run: npm run fake:nvr      (add --flip to make one camera go off and on every 90 seconds)
import { startFakeNvr, startFakeRtsp, startFakeTcp } from '../tests/helpers/fake-servers'

const NAMES = ['Entrance', 'Billing counter', 'Stockroom', 'Back door', 'Parking', 'Trial room']
const flip = process.argv.includes('--flip')

async function main() {
  const statuses: Record<number, boolean> = { 1: true, 2: true, 3: false, 4: true, 5: true, 6: true }
  const nvr = await startFakeNvr({
    port: 8081,
    username: 'viewer',
    password: 'demo-pass',
    statuses,
    channels: NAMES.map((name, i) => ({ channel: i + 1, name, ip: `192.0.2.${11 + i}` })),
  })
  const rtsp = await startFakeRtsp('refuse', 8554)
  const erp = await startFakeTcp(9101)
  const attendance = await startFakeTcp(9102)
  console.log(`Fake NVR on 127.0.0.1:${nvr.port} (user viewer), camera port ${rtsp.port}, devices on ${erp.port} and ${attendance.port}.`)
  console.log('Camera 3 is offline. Press Ctrl+C to stop.')
  if (flip) {
    setInterval(() => {
      statuses[5] = !statuses[5]
      nvr.setStatuses({ ...statuses })
      console.log(`Camera 5 is now ${statuses[5] ? 'online' : 'offline'}.`)
    }, 90_000)
  }
  process.on('SIGINT', async () => {
    await Promise.all([nvr.close(), rtsp.close(), erp.close(), attendance.close()])
    process.exit(0)
  })
}

main()
```

`scripts/seed-demo.ts`:
```ts
// Puts three demo stores and four demo devices into the LOCAL database so the app has something to show.
// Run: npm run demo:seed   (needs the local stack; run `npm run fake:nvr` and `npm run worker` next to it)
import { existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

if (existsSync('.env.local')) process.loadEnvFile('.env.local')
const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://invalid.invalid')
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '55321') {
  console.error('Refusing to run: this script only works against the local Supabase stack on port 55321.')
  process.exit(1)
}
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

async function main() {
  const { data: org } = await admin.from('organizations').select('id').eq('slug', 'citykart').single()
  if (!org) throw new Error('The CityKart organisation is missing. Run npm run db:reset first.')
  const orgId = org.id

  // Start clean: remove earlier demo data.
  const { data: old } = await admin.from('stores').select('id').eq('org_id', orgId).like('code', 'DEMO%')
  for (const s of old ?? []) await admin.rpc('nvr_delete_credential', { p_store: s.id })
  await admin.from('devices').delete().eq('org_id', orgId).like('name', 'Demo %')
  await admin.from('stores').delete().eq('org_id', orgId).like('code', 'DEMO%')

  const stores = [
    { code: 'DEMO1', name: 'Demo Store Patna', city: 'Patna', zone: 'BR', http: 8081, rtsp: 8554, cams: 6 },
    { code: 'DEMO2', name: 'Demo Store Ranchi', city: 'Ranchi', zone: 'Jharkhand', http: 8082, rtsp: 8555, cams: 4 }, // nothing listens here: NVR down
    { code: 'DEMO3', name: 'Demo Store Gaya', city: 'Gaya', zone: 'BR', http: 8081, rtsp: 8554, cams: 4 },
  ]
  const ids: Record<string, string> = {}
  for (const s of stores) {
    const { data, error } = await admin
      .from('stores')
      .insert({ org_id: orgId, code: s.code, name: s.name, city: s.city, zone: s.zone, nvr_ip: '127.0.0.1', http_port: s.http, rtsp_port: s.rtsp, nvr_username: 'viewer', expected_channels: s.cams })
      .select('id')
      .single()
    if (error || !data) throw new Error(`store ${s.code}: ${error?.message}`)
    ids[s.code] = data.id
    await admin.rpc('nvr_store_credential', { p_store: data.id, p_secret: 'demo-pass' })
    await admin.from('cameras').insert(Array.from({ length: s.cams }, (_, i) => ({ org_id: orgId, store_id: data.id, channel: i + 1, name: `Camera ${i + 1}` })))
  }
  await admin.from('devices').insert([
    { org_id: orgId, store_id: null, type: 'server', name: 'Demo ERP server', ip: '127.0.0.1', tcp_port: 9101 },
    { org_id: orgId, store_id: ids.DEMO1, type: 'attendance', name: 'Demo attendance machine', ip: '127.0.0.1', tcp_port: 9102 },
    { org_id: orgId, store_id: ids.DEMO1, type: 'footfall', name: 'Demo footfall counter', ip: '127.0.0.1', tcp_port: 9199 }, // nothing listens: offline
    { org_id: orgId, store_id: ids.DEMO3, type: 'attendance', name: 'Demo attendance Gaya', ip: '127.0.0.1', tcp_port: 9102 },
  ])
  console.log('Demo data added: stores DEMO1, DEMO2, DEMO3 and 4 devices. Use "Find cameras" on the Manage stores page to read real camera names from the fake NVR.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```
Add to `package.json` scripts: `"fake:nvr": "tsx scripts/fake-nvr.ts"`, `"demo:seed": "tsx scripts/seed-demo.ts"`. Add a "Monitoring (worker)" section to `README.md` explaining: `npm run worker`, the fake NVR and demo seed, the health endpoint, and that integration tests must not run while a worker uses the same database.

- [ ] **Step 5: Run the checks**

Run: `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration`, `npm run build`.
Expected: all green, build succeeds.

- [ ] **Step 6: Run the demo end to end (what the person asked to see)**

1. Start, each in its own background process: `npm run fake:nvr -- --flip`, `npm run demo:seed` (once), `npm run worker`, `npm run dev`.
2. In the Browser pane open http://localhost:3212, sign in as the dev admin (read from `.env.local`, never print it).
3. On **Manage stores** press **Find cameras** for DEMO1: the six placeholder cameras get their real names.
4. On **Monitoring** press **Check now** and wait about a minute: the checker shows Running, counts appear.
5. Check **Home** (live, offline and not-checked tiles; DEMO2 listed under "Stores with the NVR down"; recent problems), **Stores** (NVR badge and "live / total"), a store page (camera cards with status, offline since, uptime), and **Devices** (one footfall counter offline).
6. Take screenshots of Home, Stores, a store, Devices and Monitoring at desktop width and Home at 375 px.
7. Stop the dev server, the worker and the fake NVR (find their process ids with `netstat -ano | grep LISTENING` for ports 3212, 8081 and kill them, or stop the background tasks that started them) and leave the local database as it is.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: check now, monitoring page, demo tools and README section"
```

---

## Plan self-review

**Spec coverage (spec sections 7, 10, 14 for this plan).** Check targets and intervals: Tasks 6, 7, 8. TCP/ICMP/RTSP/ISAPI with Digest: Tasks 5 and 6. Two failures, outage start time, `nvr_down` cause, uptime with worker gaps: Task 3 (SQL, tested) and Task 7 (orchestration). Worker, heartbeat, check now, progress: Tasks 8 and 11. Camera discovery by `(store_id, channel)`: Task 9. Visibility of status through row-level security: Task 3 policies and Task 10 queries. Home dashboard, store and device status, uptime: Task 10. Monitoring page and `/api/health` with worker heartbeat: Tasks 8 and 11. Egress guard and fakes: Task 4. Carry-over items from `plan-1-carryover.md` assigned to Plan 2: Tasks 1 and 2 (default privileges, indexes, device uniqueness, vault helper, role consolidation, test hygiene, negative row-security tests, `deleteStore` order). Items left for Plans 3 and 4 stay in the carry-over file (column grants for NVR fields before live feeds, `search_path`, production auth settings, rate limits, and so on).

**Placeholders.** None: every step has code or an exact command. Task 10 Step 4 describes the Stores, store detail and Devices page edits in words because they extend existing pages with small, mechanical additions (one column, one badge, one line of text per item) using functions defined in the same task; the interfaces they use are fully specified.

**Type consistency.** `CheckResult`, `MonitorDb`, `Probes`, `StoreJob` are defined once (Task 7 Interfaces) and used by Tasks 7, 8, 9. `Deps` is defined in `lib/monitor/checks.ts` and used by the runner. `Actor`, `AdminClient`, `Result` move to `lib/admin/types` in Task 2 and are imported from there in Tasks 9 and 11. `canRunChecks` is defined in Task 2 and used in Task 11. The RPC argument names (`p_org`, `p_results`, `p_threshold`, `p_type`, `p_ids`, `p_window`, `p_now`) match the SQL in Task 3. The status words (Live, Offline, Not checked yet) come from `statusLabel` only.

**Known risks to watch while executing.** (1) Task 1: `privilege_violations` is a catalog check; if the local Supabase image grants something the test does not expect, read the printed list before changing anything. (2) Task 3: the uptime SQL is the most delicate piece; the five cases in the test are the specification, and the numbers must be right, not the tolerance. (3) Task 4: patching `net.Socket.prototype.connect` must not break the Supabase client; Task 4 Step 5 runs the integration suite once for exactly that reason. (4) Tasks 8 and 11: integration tests and a real worker both write `worker_state`; never run them at the same time. (5) The `ON CONFLICT … WHERE ended_at IS NULL` form in Task 3 needs PostgreSQL 15 or later, which is already a requirement from Plan 1.
