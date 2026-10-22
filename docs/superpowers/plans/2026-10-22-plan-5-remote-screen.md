# Remote Screen through the Hub (Plan 5 of 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** IT staff open the screen of a PC or server in the browser (TightVNC today, RDP file for machines with Remote Desktop), with control or view-only access given per person, a log of every session, and per-machine VNC passwords kept in the vault so people never see them.

**Architecture:** The browser runs the noVNC client and connects to the existing gateway (port 3213). The gateway checks a signed token, loads the machine's address and VNC password (vault) with the service role, performs the VNC login to the machine itself, and presents a password-less session to the browser. In view-only mode it drops every keyboard, mouse and clipboard message. Every session is recorded. Because the hub performs the login, the password never reaches a browser, and later the machines can be set to accept VNC only from the gateway's address.

**Tech Stack:** Next.js 16, Supabase (Vault), `ws`, `@novnc/novnc` (browser client), a pure-TypeScript DES for the VNC challenge (Node's OpenSSL 3 has DES disabled), a fake VNC server for tests and the demo.

**Spec:** `docs/superpowers/specs/2026-10-21-network-monitoring-hub-design.md` plus the chat decisions of 2026-10-22 (TightVNC on more than 1,000 PCs and servers, all on the VPN; RDP where enabled). Builds on Plans 2 to 4.

## Global Constraints

- All earlier constraints apply (Next 16, Server Actions check the caller first, services return `Result`, explicit grants on every new object and function, egress guard and loopback fakes in tests, plain English, IST 24-hour times, no secrets in the repo, never push).
- VNC passwords exist only in the vault (`remote:<deviceId>`), are written through a write-only field, and are never returned, logged or shown. No real machine is contacted by any test.
- Who may open a screen: `admin` and `platform_owner` (control); anyone else only with `profiles.remote_access` set to `view` or `control` by an administrator; and in every case only for devices they may see (row-level security). A person with `view` is always view-only, even if they ask for control.
- One control session per machine at a time (a second attempt gets "Someone else is controlling this computer right now."); at most 3 view-only sessions per machine; a session ends after 60 minutes (the person can open a new one) or after 10 minutes without any traffic.
- A remote token names one person, one device and one mode, lives 2 minutes (it only has to survive the connection set-up), and is signed with the `stream_token` secret (a different claim shape than video tokens, so one cannot be used for the other).
- Every session is recorded in `remote_sessions` (who, which machine, mode, start, end, why it ended, bytes each way); every failed attempt to open one is a `security` system-log entry.
- The DES implementation must pass the standard test vector (key `133457799BBCDFF1`, plaintext `0123456789ABCDEF`, ciphertext `85E813540F0AB405`); the VNC key rule (each key byte bit-reversed, password padded with zeros or cut at 8 bytes) has its own test.
- `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration` clean at the end of every task.

## File Structure

```
supabase/migrations/20261021000012_remote_access.sql (+ rollback)             Task 1
lib/remote/{service,policy}.ts                                                  Task 1
lib/vnc/{des,rfb,proxy}.ts  tests/helpers/fake-vnc.ts                           Task 2
lib/streams/token.ts (remote claims)  lib/streams/gateway.ts (+/vnc)  services/gateway/index.ts   Task 3
lib/actions/remote.ts  app/(app)/devices/[id]/remote/page.tsx  components/remote/RemoteScreen.tsx  app/api/devices/[id]/rdp/route.ts   Task 4
admin screens: device remote settings, user remote access, app/(app)/admin/remote-sessions/page.tsx   Task 5
scripts/fake-vnc.ts  README section                                             Task 6
```

---

### Task 1: Remote settings, vault passwords, sessions table, permission rules

**Files:** Create the migration and rollback, `lib/remote/policy.ts`, `lib/remote/service.ts`; modify `types/database.ts`, `tests/setup/fixtures.ts` (delete order: `remote_sessions` first), `lib/admin/roles.ts` only if useful; tests `tests/unit/remote-policy.test.ts`, `tests/integration/remote-db.test.ts`.

SQL (use verbatim and add the grants/RLS described):
```sql
BEGIN;
ALTER TABLE public.profiles ADD COLUMN remote_access text NOT NULL DEFAULT 'none' CHECK (remote_access IN ('none', 'view', 'control'));
ALTER TABLE public.devices
  ADD COLUMN remote_protocol text CHECK (remote_protocol IN ('vnc', 'rdp')),
  ADD COLUMN remote_port integer CHECK (remote_port BETWEEN 1 AND 65535),
  ADD COLUMN remote_secret_id uuid;
-- People may read device rows but not the pointer to the secret.
REVOKE SELECT ON public.devices FROM authenticated;
GRANT SELECT (id, org_id, store_id, type, name, ip, tcp_port, notes, enabled, created_at, updated_at, remote_protocol, remote_port) ON public.devices TO authenticated;

CREATE TABLE public.remote_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  device_id uuid NOT NULL,
  user_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('view', 'control', 'rdp-file')),
  protocol text NOT NULL CHECK (protocol IN ('vnc', 'rdp')),
  started_at timestamptz NOT NULL DEFAULT now(),
  connected_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  bytes_up bigint NOT NULL DEFAULT 0,
  bytes_down bigint NOT NULL DEFAULT 0,
  FOREIGN KEY (device_id, org_id) REFERENCES public.devices (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, org_id) REFERENCES public.profiles (id, org_id) ON DELETE CASCADE
);
CREATE INDEX remote_sessions_device_idx ON public.remote_sessions (device_id, started_at DESC);
CREATE INDEX remote_sessions_open_idx ON public.remote_sessions (device_id) WHERE ended_at IS NULL;
-- plus: UNIQUE (id, org_id) on devices if not present (it is not: add `ALTER TABLE public.devices ADD CONSTRAINT devices_id_org_key UNIQUE (id, org_id);` first),
-- RLS: admin/platform_owner read all rows of the org; everyone else reads only their own rows; SELECT only for authenticated; ALL for service_role.
-- Vault helpers, service role only, pg_catalog/public/vault/pg_temp search path, same pattern as nvr_*:
--   device_store_remote_secret(p_device uuid, p_secret text) returns uuid   (name 'remote:' || p_device; refuses an empty secret; locks the row; recovers from a stale pointer)
--   device_read_remote_secret(p_device uuid) returns text
--   device_delete_remote_secret(p_device uuid) returns void
-- Trigger: deleting a device deletes its vault secret (AFTER DELETE ... SECURITY DEFINER), so no secret is left behind.
COMMIT;
```
Rollback reverses all of it (restore the table-wide `SELECT` on devices).

**Policy (`lib/remote/policy.ts`, pure):**
```ts
export type RemoteMode = 'view' | 'control'
export function maxRemoteMode(role: Role, remoteAccess: 'none' | 'view' | 'control'): RemoteMode | null   // admin/platform_owner -> 'control'; others -> remoteAccess or null for 'none'
export function effectiveMode(allowed: RemoteMode | null, wanted: RemoteMode): RemoteMode | null          // view-only people get 'view' even when 'control' is wanted; null when not allowed
```
**Service (`lib/remote/service.ts`, `Result`-returning, admin only):** `setRemoteSettings(admin, actor, deviceId, { protocol: 'vnc' | 'rdp' | null, port?: number | null, password?: string | null })` (validates, default ports 5900 for vnc and 3389 for rdp, the password goes to the vault only and is never returned, `null` password leaves it unchanged, an explicit `clearPassword: true` deletes it; audit `remote_settings_changed` without the password); `setUserRemoteAccess(admin, actor, userId, level)` (cannot change oneself; uses `canManageRole`; audit).
- [ ] Tests first: unit for the two policy functions (all role/level combinations); integration: columns and constraints; a viewer cannot read `remote_secret_id` (42501) but can read `remote_protocol`; `select('*')` on devices by a viewer fails (documented behaviour); vault helpers callable only by the service role; empty secret refused; deleting a device removes its vault secret (`device_read_remote_secret` for that id returns null and the vault row is gone: check with a service-role-only helper or the RPC); `remote_sessions` RLS (admin sees all, a user sees only their own, another org none); `setRemoteSettings` validations and that the password is not in any return value or audit detail; `setUserRemoteAccess` rules.
- [ ] Implement, regenerate types (`npm run db:reset`, `node scripts/create-dev-admin.mjs`, `npm run db:types`), fix any query that selected `*` from devices, run all checks. Commit `feat: remote access settings, vault passwords and session log table`.

---

### Task 2: DES, the RFB handshake and the proxy

**Files:** Create `lib/vnc/des.ts`, `lib/vnc/rfb.ts`, `lib/vnc/proxy.ts`, `tests/helpers/fake-vnc.ts`; tests `tests/unit/des.test.ts`, `tests/unit/rfb.test.ts`, `tests/unit/vnc-proxy.test.ts`.

**Interfaces:**
```ts
// des.ts: single-block DES (ECB, encrypt) in plain TypeScript
export function desEncryptBlock(key8: Uint8Array, block8: Uint8Array): Uint8Array
export function vncResponse(password: string, challenge16: Uint8Array): Uint8Array   // key = first 8 bytes of the password padded with 0, each byte bit-reversed; encrypts the two 8-byte halves
// rfb.ts
export type RfbServerInfo = { version: '3.3' | '3.7' | '3.8'; authenticated: boolean }
export async function authenticateToServer(conn: ByteStream, password: string | null): Promise<RfbServerInfo>   // reads the server's version, answers with the same or 3.8, picks VNC auth (2) or None (1), performs the challenge, reads SecurityResult; throws RfbError with a plain `reason` ('refused' | 'unsupported' | 'timeout' | 'closed')
export async function presentNoAuthToClient(conn: ByteStream): Promise<void>                      // sends 'RFB 003.008\n', reads the client's version, offers only security type None (1), reads the choice, sends SecurityResult OK
export function createViewOnlyFilter(): (chunk: Buffer) => Buffer                                // drops KeyEvent(4), PointerEvent(5), ClientCutText(6) after ClientInit; passes 0, 2, 3, 150; closes (throws) on an unknown message type; handles messages split across chunks
// proxy.ts
export async function proxyRfb(o: { client: ByteStream; server: ByteStream; password: string | null; viewOnly: boolean; idleMs?: number; onBytes?: (up: number, down: number) => void }): Promise<{ reason: string }>
```
`ByteStream` is a small interface (`read(n): Promise<Buffer>`, `write(b: Buffer): void`, `onData`, `close()`, `closed: Promise<void>`) implemented for a TCP socket and for a `ws` WebSocket (binary frames) in the same file so tests can use sockets on both sides.

RFB message sizes for the view-only filter (after the 1-byte ClientInit): type 0 SetPixelFormat 20 bytes; type 2 SetEncodings 4 + 4·count; type 3 FramebufferUpdateRequest 10; type 4 KeyEvent 8; type 5 PointerEvent 6; type 6 ClientCutText 8 + length; type 150 EnableContinuousUpdates 10. Anything else in view-only mode ends the session.

**Fake VNC server (`tests/helpers/fake-vnc.ts`):** `startFakeVnc({ password?: string | null, version?: '3.3'|'3.7'|'3.8', width?, height?, port? })` listening on 127.0.0.1: sends the version, offers VNC auth (or None when `password` is null; for 3.3 sends the 4-byte type), sends a random 16-byte challenge and verifies the response with its own copy of the DES (import `desEncryptBlock`) so a wrong password gets SecurityResult 1 with a reason (3.8), then reads ClientInit, sends ServerInit (width, height, a 32-bit true-colour pixel format, name "Fake PC"), answers each FramebufferUpdateRequest with one Raw rectangle covering the screen (a horizontal gradient), and records every client message type it receives (`received: number[]`) and the bytes counters.
- [ ] Tests first: DES standard vector; `vncResponse` against a known vector computed independently (use the widely published example: password `"password"`, challenge bytes `00..0F`; if you cannot find an independent vector, assert the key-reversal rule on its own and rely on the fake server cross-check plus the DES vector); `authenticateToServer` against the fake server for versions 3.3, 3.7, 3.8, a wrong password (`reason: 'refused'`), a None server, a server that closes at once, a timeout; `presentNoAuthToClient` with a scripted client; the view-only filter on every allowed and dropped type, on a message split byte by byte across chunks, on a ClientCutText with a long payload, and on an unknown type; `proxyRfb` end to end: client (a scripted noVNC-like client over sockets) ↔ proxy ↔ fake server: after the handshake the client receives ServerInit and a framebuffer update; in control mode the fake sees the client's key and pointer events; in view-only mode it sees none of them but still sees update requests; idle timeout ends the session with the reason `idle`; counters report both directions.
- [ ] Implement, run all checks. Commit `feat: VNC proxy with DES login and view-only filter`.

---

### Task 3: The gateway's `/vnc` endpoint

**Files:** Modify `lib/streams/token.ts` (add `signRemoteToken`/`verifyRemoteToken`), `lib/streams/gateway.ts`, `services/gateway/index.ts`; tests `tests/unit/remote-token.test.ts`, `tests/integration/gateway-vnc.test.ts`.

**Interfaces:**
```ts
export type RemoteClaims = { kind: 'remote'; u: string; d: string; m: 'view' | 'control'; s: string; exp: number }   // s = remote_sessions.id, exp in seconds, lifetime 120
export function signRemoteToken(claims: RemoteClaims, secret?: string | null): string
export function verifyRemoteToken(token: string, nowMs?: number, secret?: string | null): RemoteClaims | null
// GatewayOptions gains:
resolveRemote?: (deviceId: string) => Promise<{ host: string; port: number; password: string | null } | null>
sessions?: { begin(sessionId: string): Promise<boolean>; connected(sessionId: string): Promise<void>; end(sessionId: string, reason: string, up: number, down: number): Promise<void> }
```
Video tokens must not verify as remote tokens and the reverse (the payload carries `kind: 'remote'`; video tokens carry `k`). Gateway behaviour on `WS /g/vnc?token=…`: same Origin and token checks as `/g/ws` (close 1008 on failure); `sessions.begin` must accept the session id (the row exists, is not ended, belongs to the token's person and device; one control session per device and at most 3 view sessions; otherwise close 1013 with the plain reason "Someone else is controlling this computer right now." or "Too many people are watching this computer."); `resolveRemote` gives the address and password (null device → close 1008); the gateway opens the TCP connection (10-second connect timeout → close 1011 "The computer did not answer."), runs `proxyRfb` between the WebSocket and the socket (view-only when `m = 'view'`), sets a 60-minute limit and a 10-minute idle limit, and always calls `sessions.end` with the reason and the byte counters. Errors from the RFB login are mapped to plain close reasons ("The remote screen refused the password." / "The remote screen uses a login this hub does not support." / "The computer closed the connection."). Passwords and addresses never appear in close reasons or logs. `services/gateway/index.ts` wires `resolveRemote` and `sessions` to the Supabase admin client (reads `devices` + `device_read_remote_secret`; updates `remote_sessions`) and requires the Supabase environment variables.
- [ ] Tests first (all on loopback with the fake VNC server): token round trip, tampering, expiry, cross-kind rejection; gateway end to end with a WebSocket client playing noVNC (None-auth handshake, then reading ServerInit): good token works and the fake VNC saw the right password; wrong Origin, bad token, expired token, unknown session, an ended session, wrong person all close with 1008 and the fake VNC sees no connection; view-only drops key/pointer messages; a second control session for the same device is refused with the plain message while a view session is allowed; the fourth view session is refused; unreachable device (closed port) closes with the plain message; the wrong password closes with the plain message; `sessions.end` is called once with a reason and counters in every case; no password in any close reason. Commit `feat: gateway endpoint for remote screens`.

---

### Task 4: Opening a remote screen

**Files:** Create `lib/actions/remote.ts`, `lib/remote/open.ts`, `app/(app)/devices/[id]/remote/page.tsx`, `components/remote/RemoteScreen.tsx`, `app/api/devices/[id]/rdp/route.ts`; add dependency `@novnc/novnc`; modify the Devices page (a "Remote" link for devices with a protocol the person may use), nav not needed; tests `tests/integration/remote-open.test.ts`.

**Interfaces:**
```ts
export async function openRemote(deps: { admin: AdminClient; rls: AdminClient; now?: () => number }, actor: { id: string; orgId: string; role: Role }, deviceId: string, wanted: 'view' | 'control'):
  Promise<Result<{ token: string; mode: 'view' | 'control'; deviceName: string; sessionId: string }>>
```
Behaviour: reads the person's `remote_access` with the admin client; `effectiveMode(maxRemoteMode(...), wanted)`; the device must be readable through `rls` (else "Computer not found."), must have `remote_protocol = 'vnc'` and a stored password (else plain messages: "Remote screen is not set up for this computer."); inserts a `remote_sessions` row (`mode`, `protocol`) and signs a remote token (120 s); failures (not allowed, not visible, not set up, no secret configured) append a `security` system-log entry when Plan 4's log exists (if it does not exist yet, log through `logger`). `lib/actions/remote.ts`: `openRemoteAction(deviceId, wanted)` with `requireProfile()` and a rate limit of 20 per minute. RDP: `GET /api/devices/<id>/rdp` (session required) returns a `.rdp` text file (`full address:s:<ip>:<port>`, `prompt for credentials:i:1`, `authentication level:i:2`, `screen mode id:i:2`) with `Content-Disposition: attachment; filename="<device name>.rdp"` for devices with `remote_protocol = 'rdp'` the person may open (same policy; view-only people may not use RDP), and records a `rdp-file` session row with `ended_at` set at once.
Page `/devices/[id]/remote`: calls `openRemoteAction` on load (mode from `?mode=view` or control by default when allowed), shows a header (device name, store, mode badge, Disconnect and "Ctrl+Alt+Del" buttons, full-screen toggle), and the `RemoteScreen` client component, which dynamically imports `@novnc/novnc` (client only), connects to `<gateway ws base>/g/vnc?token=…` with `new RFB(element, url, { })` (no credentials needed: the gateway logs in), sets `scaleViewport = true`, `clipViewport = false`, `viewOnly` for view mode, shows plain messages for connecting, "The connection was closed: <reason>" and a Reconnect button that asks for a new token. If bundling `@novnc/novnc` fails under Next 16 (top-level await in some builds), vendor `core/` into `public/novnc/` and load it as a module script; document the choice.
- [ ] Tests first (integration, service layer): an admin may open control and view; a viewer with `remote_access = 'view'` asking for control gets a view token; `none` is refused; an invisible device refused; a device without protocol or password refused; the token verifies with the right claims and the session row exists; failure attempts are logged; the RDP route's handler returns the file for an rdp device and refuses a vnc device or a view-only person. Check the pages redirect when signed out. Commit `feat: open a remote screen in the browser`.

---

### Task 5: Admin screens

**Files:** Create `components/remote/{DeviceRemoteForm,UserRemoteSelect}.tsx`, `lib/actions/admin/remote.ts`, `app/(app)/admin/remote-sessions/page.tsx`; modify the admin devices page (per-row "Remote settings" panel), the admin users page (a select for remote access next to the role), `lib/import/devices-csv.ts` and `lib/import/apply.ts` (optional columns `remote_protocol`, `remote_port`, `vnc_password`; the password goes to the vault and is never echoed in errors), `public/samples/devices-sample.csv`, nav (item "Remote sessions", admins); tests extend `tests/unit/devices-csv.test.ts` and `tests/integration/inventory-admin.test.ts`.
Behaviour: device remote settings form: protocol select (none, VNC, RDP), port (default shown), VNC password write-only (placeholder "Saved" when one exists, with a "Remove saved password" checkbox); users page select (None, View only, Control) disabled for oneself and for roles that already have control (admins); the sessions page lists the last 200 sessions (person, computer, mode, started, duration, ended reason, MB up/down) with filters for person and computer and shows currently open ones first. CSV import: rows with an unknown protocol or a port outside 1 to 65535 are reported with line numbers; an empty `vnc_password` keeps the saved one.
- [ ] Tests first for the CSV parser and applier (password stored in the vault, never in errors or audit; protocol validation); the actions are thin. Commit `feat: remote settings screens, sessions log and CSV columns`.

---

### Task 6: Demo VNC server and documentation

**Files:** Create `scripts/fake-vnc.ts`; modify `package.json` (script `fake:vnc`), `README.md` (a "Remote screen" section: how it works, the permission levels, where passwords live, how to roll out per-machine passwords and restrict TightVNC to the gateway address, firewall note, that RDP is an `.rdp` download), `scripts/seed-demo.ts` (a demo device with `remote_protocol = 'vnc'`, port 5901 and the demo password stored in the vault; also an RDP demo device).
- [ ] `scripts/fake-vnc.ts` reuses `startFakeVnc` to listen on `127.0.0.1:5901` with password `demo` and an animated gradient (it sends a new Raw update every second with a moving stripe and a clock-like counter so a person can see the screen is live; mouse and key events are printed to the console, proving control works and view-only blocks them). Run all checks and `npm run build`. Commit `feat: demo VNC server and remote screen documentation`.

---

## Plan self-review

Covered: noVNC in the browser through the gateway, hub-side VNC login with vault passwords, per-person view/control, session limits and log, `.rdp` files for RDP machines, CSV rollout of VNC settings, and a demo server so the feature can be shown without any real PC. Not built here: recording the session video, an RDP web client (Guacamole), clipboard transfer UI, pushing new VNC passwords to machines and restricting TightVNC to the gateway address (that is an agent job in Plan 6), and testing against a real TightVNC server (only the fake server is available here).
