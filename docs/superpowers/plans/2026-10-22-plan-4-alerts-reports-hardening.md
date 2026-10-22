# Alerts, Reports, Backup and Hardening (Plan 4 of 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The IT team is told when something goes down and when it recovers (e-mail, Microsoft Teams and a generic webhook), can pull fixed reports to Excel, can back up NVR recordings to a server disk, and the application gets the security hardening deferred from Plans 1 to 3, plus deployment material.

**Architecture:** Alerts are decided by the worker (a rule engine over open and closed outages) and delivered by small channel senders; secrets (webhook URLs) live in the vault. Reports read through row-level security with the signed-in person's client, so they only contain what that person may see. Backup jobs are rows the worker picks up and executes against the NVR. Hardening is a set of migrations and small code changes, each with a test.

**Tech Stack:** Next.js 16, Supabase, `nodemailer`, `exceljs`, `smtp-server` (dev only, for tests), existing worker (`tsx`).

**Spec:** `docs/superpowers/specs/2026-10-21-network-monitoring-hub-design.md` (sections 9, 12). Carry-over list: `docs/superpowers/plans/plan-1-carryover.md`. Builds on Plans 2 and 3.

## Global Constraints

- All earlier constraints apply (Next 16, Server Actions check the caller first, services return `Result`, explicit grants on every new object, egress guard and loopback fakes in tests, plain English, IST 24-hour times, no secrets in the repo, never push).
- Alerts: a problem raises an alert only after it has lasted the rule's delay (default **5 minutes**); one alert per rule and outage; a recovery message when the outage closes; repeat reminders only if the rule sets `repeat_minutes`; a camera that is down because its NVR is down (`cause = 'nvr_down'`) never alerts on its own (the NVR alert covers it).
- WhatsApp is not built (it needs a Meta business account). The generic webhook channel can be pointed at any WhatsApp gateway; say so in the README.
- Channel secrets (webhook URLs, SMTP password) never appear in a table column, response or log. SMTP settings come from environment variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`), webhook URLs go to the vault.
- Reports contain only what the requesting person may see (row-level security) and are limited to 20,000 rows with a visible "truncated" note. Exports neutralise cells that start with `=`, `+`, `-` or `@` and are audited.
- Backups: one download per NVR at a time, at most 4 NVRs at once, files under `BACKUP_DIR/<store code>/<channel>_<camera name>/<yyyymmddhhmmss>.mp4`, never overwrite an existing file, stop a job when the disk has less than 5 GB free.
- Hardening items are not optional: each has a test that fails before and passes after.
- `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration` clean at the end of every task.

## File Structure

```
supabase/migrations/20261021000008_alerts.sql  ..000008_backup.sql  ..000009_system_log.sql  ..000010_hardening.sql  (+ rollbacks)
lib/alerts/{engine,channels,messages,db}.ts   lib/actions/admin/alerts.ts   app/(app)/admin/alerts/**   Tasks 1-3
lib/reports/{queries,xlsx}.ts  app/(app)/reports/**  app/api/reports/[slug]/route.ts   Task 4
lib/monitor/backup.ts  lib/actions/admin/backup.ts  app/(app)/admin/backup/page.tsx   Task 5
lib/logging/system-log.ts  app/(app)/admin/logs/page.tsx   Task 6
lib/http/csp.ts  app/api/csp-report/route.ts  (plus edits)   Task 7
Dockerfile  Dockerfile.worker  deploy/docker-compose.yml  docs/DEPLOYMENT.md  deploy/windows/*.ps1   Task 8
```

---

### Task 1: Alert rules, events and the engine

**Files:** Create `supabase/migrations/20261021000008_alerts.sql` (+ rollback), `lib/alerts/engine.ts`, `lib/alerts/db.ts`, `lib/alerts/messages.ts`; modify `lib/monitor/runner.ts` (call the engine each poll), `lib/monitor/types.ts` if needed, `tests/setup/fixtures.ts` (delete order), `types/database.ts`; tests `tests/unit/alert-engine.test.ts`, `tests/unit/alert-messages.test.ts`, `tests/integration/alerts-db.test.ts`.

SQL (use verbatim, plus RLS: admins read rules and channels through their own client, nothing else; all writes by the server):
```sql
BEGIN;
CREATE TABLE public.notification_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  kind text NOT NULL CHECK (kind IN ('email', 'webhook', 'teams')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  recipients text[] NOT NULL DEFAULT '{}',   -- e-mail addresses (kind = email)
  secret_id uuid,                             -- vault: the webhook URL (kinds webhook, teams)
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_channels_org_name_key UNIQUE (org_id, name),
  CONSTRAINT notification_channels_id_org_key UNIQUE (id, org_id)
);
CREATE TABLE public.alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  target_types text[] NOT NULL DEFAULT '{nvr,camera,device}' CHECK (target_types <@ ARRAY['nvr','camera','device']),
  device_types text[] NOT NULL DEFAULT '{}',          -- empty = all device types (when 'device' is a target type)
  scope_kind text NOT NULL DEFAULT 'all' CHECK (scope_kind IN ('all', 'zone', 'store')),
  scope_value text,                                    -- zone name or store id
  delay_minutes integer NOT NULL DEFAULT 5 CHECK (delay_minutes BETWEEN 0 AND 1440),
  repeat_minutes integer CHECK (repeat_minutes IS NULL OR repeat_minutes BETWEEN 5 AND 10080),
  channel_ids uuid[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_rules_org_name_key UNIQUE (org_id, name),
  CONSTRAINT alert_rules_scope_check CHECK (scope_kind = 'all' OR scope_value IS NOT NULL)
);
CREATE TABLE public.alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  rule_id uuid NOT NULL REFERENCES public.alert_rules (id) ON DELETE CASCADE,
  outage_id uuid NOT NULL REFERENCES public.outages (id) ON DELETE CASCADE,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  last_repeat_at timestamptz,
  CONSTRAINT alert_events_rule_outage_key UNIQUE (rule_id, outage_id)
);
CREATE TABLE public.alert_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  event_id uuid NOT NULL REFERENCES public.alert_events (id) ON DELETE CASCADE,
  channel_id uuid REFERENCES public.notification_channels (id) ON DELETE SET NULL,
  phase text NOT NULL CHECK (phase IN ('firing', 'repeat', 'resolved', 'test')),
  ok boolean NOT NULL,
  error text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_events_open_idx ON public.alert_events (org_id) WHERE resolved_at IS NULL;
CREATE INDEX alert_deliveries_event_idx ON public.alert_deliveries (event_id);
-- RLS on, grants: authenticated SELECT only for admin and platform_owner (policy using current_user_role()); service_role ALL.
-- Vault helpers (service role only), same pattern as nvr_*: public.channel_store_secret(p_channel uuid, p_secret text) returns uuid,
-- public.channel_read_secret(p_channel uuid) returns text, public.channel_delete_secret(p_channel uuid) returns void.
COMMIT;
```
(The implementer writes the RLS, grants and the three vault helpers exactly like the existing `nvr_*` ones, and adds `alert_deliveries`, `alert_events`, `alert_rules`, `notification_channels` to the fixtures delete order; test deliveries for the `test` phase need an event, so `event_id` is nullable: make it `uuid REFERENCES ... ON DELETE CASCADE` nullable instead of NOT NULL.)

**Engine (`lib/alerts/engine.ts`) interface:**
```ts
export type AlertDb = {
  loadRules(): Promise<AlertRule[]>
  loadChannels(ids: string[]): Promise<Channel[]>
  openOutagesDue(now: Date): Promise<DueOutage[]>          // open outages, with target info, started_at + min delay <= now, cause <> nvr_down for cameras
  resolvedOutagesToNotify(): Promise<ResolvedOutage[]>     // events with resolved_at null whose outage has ended
  eventsToRepeat(now: Date): Promise<DueOutage[]>
  createEvent(ruleId: string, o: DueOutage): Promise<{ id: string } | null>   // null when it already exists (unique)
  markResolved(eventId: string, at: Date): Promise<void>
  markRepeated(eventId: string, at: Date): Promise<void>
  recordDelivery(d: Delivery): Promise<void>
}
export type Sender = (channel: Channel, message: AlertMessage) => Promise<{ ok: boolean; error?: string }>
export async function evaluateAlerts(deps: { db: AlertDb; send: Sender; clock: () => Date; appUrl: string }): Promise<{ fired: number; resolved: number; repeated: number }>
```
Rules: a rule applies to a due outage when `enabled`, the target type is in `target_types`, (for devices) `device_types` is empty or contains the device's type, the scope matches (`all`; `zone` = store zone equals `scope_value`, for a device with no store only `all` matches; `store` = store id equals), and `now - started_at >= delay_minutes`. Per rule and outage exactly one event (the unique key); a failed delivery on one channel does not stop the others and is recorded; when every channel of an event fails the event is still created (so the problem is visible in the log) and retried once on the next run for the `firing` phase (use `alert_deliveries` to see whether a firing delivery succeeded; retry only if none did, at most 3 attempts). Recovery: when an outage has ended, send phase `resolved` once and set `resolved_at`. Repeat: if `repeat_minutes` is set and `now - coalesce(last_repeat_at, fired_at) >= repeat_minutes` and still open, send `repeat`. `messages.ts` builds `AlertMessage = { subject, text, html, severity, link }` in plain words: `"[Down] Camera Entrance at store PAT1"`, with since time (IST), duration for recoveries (`"was down for 1 h 12 min"`), and a link `<appUrl>/stores/<id>` (or `/devices`).

- [ ] Tests first: unit (`MemoryAlertDb` test double in `tests/helpers/memory-alert-db.ts`): all rule-matching cases above (types, device types, zone, store, delay boundary: exactly at the delay fires, one second before does not); idempotency (second evaluation fires nothing); recovery once; repeat timing; one channel failing; all channels failing then retry up to 3; camera with cause `nvr_down` skipped; message texts (IST formatting, duration wording). Integration: the SQL (unique key, cascade, vault helpers callable only by the service role, RLS: a viewer sees no rules; an admin sees rules).
- [ ] Implement `lib/alerts/db.ts` (Supabase implementation of `AlertDb`), wire `evaluateAlerts` into `MonitorRunner.pollOnce()` after the heartbeat (errors logged, never thrown; senders injected so Plan 2 tests keep passing with a no-op sender), run all checks, commit `feat: alert rules and the alert engine`.

---

### Task 2: Channels: e-mail, Teams and webhook

**Files:** Create `lib/alerts/channels.ts`, `lib/alerts/service.ts`, `tests/unit/channels.test.ts`, `tests/integration/channels.test.ts`; add dev dependency `smtp-server` and dependency `nodemailer` (+ types).

**Interfaces:**
```ts
export function createSender(o: { env?: Record<string, string | undefined>; readSecret: (channelId: string) => Promise<string | null>; fetchImpl?: typeof fetch }): Sender
// service (admin only; Result-returning):
export async function createChannel(admin, actor, input: { kind: 'email' | 'webhook' | 'teams'; name: string; recipients?: string[]; url?: string }): Promise<Result<{ channelId: string }>>
export async function updateChannel(admin, actor, id, input: { name?: string; recipients?: string[]; url?: string; enabled?: boolean }): Promise<Result<object>>
export async function deleteChannel(admin, actor, id): Promise<Result<object>>      // also deletes the vault secret
export async function testChannel(admin, actor, id, sender): Promise<Result<object>> // sends a clearly marked test message and records a delivery with phase 'test'
export async function saveRule / deleteRule(admin, actor, ...)                      // validated with zod: delay 0-1440, repeat null or 5-10080, channel ids must belong to the org, scope value required for zone/store
```
Senders: **e-mail** via `nodemailer` using `SMTP_HOST/PORT/USER/PASS` and `EMAIL_FROM` (no auth when `SMTP_USER` is empty; TLS when port is 465 or `SMTP_SECURE=1`), one message to all recipients (BCC), 10-second timeout; **webhook** POST JSON `{ title, text, severity, link, at }` to the vault URL with a 10-second timeout, success on 2xx; **teams** POST a MessageCard (`@type: MessageCard`, `summary`, `title`, `text`, `themeColor` red for firing / green for resolved, a link action) to the vault URL. Webhook URLs must start with `https://` (or `http://` for loopback in tests, allowed only when `NODE_ENV !== 'production'`). Errors become plain messages ("The mail server did not accept the message.", "The webhook did not answer.", "The webhook refused the message (status 404).") and never include the URL or credentials.
- [ ] Tests first: against a fake SMTP server (`smtp-server` on loopback, capturing the message) and fake webhook/Teams HTTP servers on loopback: the e-mail arrives with the right subject, recipients (all in BCC) and plain/HTML parts; the webhook payload shape; the Teams card shape; failure mapping for a closed port, a 500 and a timeout; the URL never appears in returned errors; `createChannel` stores the URL only in the vault (read it back with the service role) and returns no URL; invalid e-mail addresses and non-https URLs rejected; `testChannel` records a `test` delivery; non-admin actors refused; rules validated.
- [ ] Implement, run all checks, commit `feat: e-mail, Teams and webhook alert channels`.

---

### Task 3: Alert screens

**Files:** Create `lib/actions/admin/alerts.ts`, `app/(app)/admin/alerts/page.tsx`, `components/alerts/{ChannelForm,RuleForm,TestButton}.tsx`; modify nav (item "Alerts", Admin group, admins only) and nav test.

Page `/admin/alerts` (admin and platform_owner): three sections. **Channels**: list (name, kind, recipients or "URL saved", enabled), add form (kind select; recipients textarea for e-mail; URL field for webhook/Teams, write-only, never shown again), edit/enable/disable/delete (two-click), "Send test" button with a toast. **Rules**: list and form (name; what to watch: checkboxes NVR, cameras, devices; device types; where: everywhere / a zone (select of existing zones) / a store (select); wait minutes; repeat minutes optional; which channels (checkboxes)). **Recent alerts**: the last 50 events with target name, when it fired, resolved or still open, and the delivery results (green/red per channel, error text). Plain wording ("Tell me when something has been down for 5 minutes.").
- [ ] Tests: the actions are thin; add one integration test that drives `createChannel`, `saveRule` and the engine end to end with the fake webhook (a down NVR for longer than the delay produces exactly one webhook call, and the recovery produces a second). Check the page redirects when signed out. Commit `feat: alert screens`.

---

### Task 4: Reports and Excel export

**Files:** Create `lib/reports/queries.ts`, `lib/reports/xlsx.ts`, `app/(app)/reports/page.tsx`, `app/(app)/reports/[slug]/page.tsx`, `app/api/reports/[slug]/route.ts`; add dependency `exceljs`; modify nav (item "Reports", Monitoring group; visible to everyone); tests `tests/unit/xlsx.test.ts`, `tests/integration/reports.test.ts`.

Reports (slug: columns): `nvr-down` (store code, name, city, zone, NVR address shown only to admins and managers, down since, duration); `stores-no-live-camera` (store, zone, cameras, offline since of the oldest outage); `offline-cameras` (store, channel, camera, camera address, offline since, last seen live, reason); `zone-summary` (zone, stores, cameras, live, offline, not checked, live %); `store-summary` (store, zone, NVR status, cameras live/total, uptime 24h and 7d); `devices-down` (device, type, store, address, down since, last seen); `uptime` (target kind select, 7d and 30d uptime per store, worst first); `outages` (last 30 days: kind, name, store, started, ended, duration, cause). All through the person's own client (row-level security), fetched with `fetchAll`, capped at 20,000 rows (`truncated` flag shown on screen and as a note row in Excel), times via `formatDateTime`. The page shows the table with a "Download Excel" link (`/api/reports/<slug>?format=xlsx`) and a CSV link. `xlsx.ts`: `buildWorkbook(report): Promise<Buffer>` with a bold frozen header row, auto-sized columns (max 40), a second sheet "About" with title, who exported it, when (IST) and the truncation note; every string cell that starts with `=`, `+`, `-` or `@` is prefixed with a single quote. The route requires a session, writes an audit row `report_exported` (slug, rows), rate limit 10 per minute, returns `Content-Disposition: attachment; filename="<slug>-<yyyymmdd-hhmm>.xlsx"`.
- [ ] Tests first: `xlsx` (neutralisation of the four leading characters, header styling flags, sheet names, truncation note) by reading the workbook back with exceljs; integration: seeded status data (use `monitor_apply_results`), a manager and a restricted viewer get different row sets for `offline-cameras` and `zone-summary`, NVR addresses are absent from the viewer's `nvr-down`, the export route (call the handler function directly with a faked session helper or via the service layer) audits and neutralises formulas, truncation flag at the cap (cap injected as a parameter for the test). Commit `feat: reports with Excel export`.

---

### Task 5: NVR recording backup

**Files:** Create `supabase/migrations/20261021000009_backup.sql` (+ rollback), `lib/monitor/backup.ts`, `lib/actions/admin/backup.ts`, `app/(app)/admin/backup/page.tsx`; modify `lib/monitor/runner.ts` (poll for queued jobs), `tests/helpers/fake-servers.ts` (the fake NVR's download endpoint can serve per-segment bytes), fixtures; tests `tests/unit/backup.test.ts`, `tests/integration/backup.test.ts`.

SQL: `backup_jobs (id, org_id, requested_by uuid, status text check in ('queued','running','done','failed','cancelled'), camera_ids uuid[] not null, range_start timestamptz, range_end timestamptz not null, total_cameras int, done_cameras int default 0, files int default 0, bytes bigint default 0, errors jsonb default '[]', cancel_requested boolean default false, created_at, started_at, finished_at)`; admin read policy; service writes. Behaviour (`lib/monitor/backup.ts`): `runBackupJob(deps, job)` where deps hold the DB, an NVR client factory, a file system adapter (`mkdir`, `exists`, `createWriteStream`, `freeBytes`), the clock and `backupDir`: for each camera (grouped per store, one download at a time per store, at most 4 stores in parallel) search segments in `[start, end]` (a missing start means "from the oldest recording": search back 400 days), for each segment compute the file path (`<backupDir>/<safe store code>/<channel>_<safe camera name>/<yyyymmddhhmmss>.mp4`, names sanitised to `[\w\- ]`), skip when it exists, check free disk first (stop with an error entry when under 5 GB), download through `/ISAPI/ContentMgmt/download` streaming to `<file>.part` then rename, update counters every file, honour `cancel_requested`, record per-camera errors without stopping others, set the final status. The runner picks up one queued job at a time on each poll. UI `/admin/backup` (admin): form (store select, cameras checkboxes or "all cameras of the store", from and to date-times in IST, "from the oldest" option), a table of jobs with progress bar, files, size (MB/GB), errors, and Cancel; shows the backup folder and free space.
- [ ] Tests first: unit with an in-memory file system and fake NVR client: paths and sanitising, skip existing, `.part` then rename, stop when disk is low, cancel mid-way, one camera failing, counters; integration against the fake NVR (two segments returned as files) with a temp directory, verifying the two files on disk and the job row. Commit `feat: NVR recording backup jobs`.

---

### Task 6: System log with a hash chain

**Files:** Create `supabase/migrations/20261021000010_system_log.sql` (+ rollback), `lib/logging/system-log.ts`, `app/(app)/admin/logs/page.tsx`; modify `lib/admin/audit.ts` (also append to the system log), `lib/actions/auth.ts` (log sign-in failures and successes as `security`), nav (item "Logs", admins), tests `tests/integration/system-log.test.ts`.

SQL: `system_log (seq bigint generated always as identity primary key, org_id uuid null, at timestamptz default now(), category text check in ('audit','security','error','event'), actor_id uuid, actor_label text, action text not null, entity_type text, entity_id uuid, detail jsonb default '{}', ip_hash text, prev_hash text not null, row_hash text not null)`, `system_log_head (id integer primary key check (id = 1), last_seq bigint, last_hash text)` with a seed row (`last_hash` of 64 zeros). Function `system_log_append(p_org uuid, p_category text, p_actor uuid, p_actor_label text, p_action text, p_entity_type text, p_entity_id uuid, p_detail jsonb, p_ip_hash text) returns bigint` (SECURITY DEFINER, service role only): locks the head row `FOR UPDATE`, builds `row_hash = encode(sha256(convert_to(prev_hash || '|' || seq::text || '|' || at::text || '|' || category || '|' || coalesce(actor_id::text,'') || '|' || action || '|' || coalesce(entity_type,'') || '|' || coalesce(entity_id::text,'') || '|' || detail::text, 'UTF8')), 'hex')`, inserts, updates the head. Function `system_log_verify() returns bigint` (service role only): walks the rows in `seq` order recomputing hashes and returns the first `seq` whose stored hash or `prev_hash` does not match, or null when intact. The table has no UPDATE or DELETE grants for anyone, and a trigger raises on UPDATE/DELETE even for the service role (retention moves rows to an archive in a later release). Redaction: `detail` is run through the `redact()` helper before it is sent (no passwords, tokens, keys); IP addresses are stored only as a salted hash.
Page `/admin/logs` (admin): filter by category, action text, date range; table of the newest 200; "Check integrity" button calling `system_log_verify` (shows "The log is intact." or "The log was changed at entry N."); export is not needed.
- [ ] Tests first: append twice and verify intact; tamper with a row's `detail` using a direct SQL statement that bypasses the trigger is not possible through the API, so test the verify function by inserting a row with a wrong `row_hash` through the service role with the trigger disabled for that statement in the test (use `SET session_replication_role = replica` via an RPC helper that exists only in the test, or temporarily create/drop a test-only SECURITY DEFINER function in the test and drop it afterwards) and expect `system_log_verify` to return that `seq`; concurrency: 20 parallel appends produce a gapless intact chain; UPDATE and DELETE are refused; `addAudit` also appends; the failed sign-in action path logs a `security` entry without the password or the e-mail's local part (store a hash of the e-mail); viewers cannot read the table. Commit `feat: hash-chained system log`.

---

### Task 7: Hardening bundle (migration 10 and code)

**Files:** Create `supabase/migrations/20261021000011_hardening2.sql` (+ rollback), `lib/http/csp.ts`, `app/api/csp-report/route.ts`; modify `next.config.ts`, `proxy.ts`, `lib/actions/admin/*.ts` (rate limits), `lib/queries/*` (only if a query selects a restricted column), tests `tests/integration/hardening2.test.ts`, `tests/unit/csp.test.ts`, `tests/unit/csp-report.test.ts`.

Items, each with a failing test first:
1. **Column grants on `stores`:** replace the table-wide `SELECT` for `authenticated` with a column list `(id, org_id, code, name, city, zone, state, address, is_active, expected_channels, created_at, updated_at)` (no `nvr_ip`, `rtsp_port`, `http_port`, `nvr_username`, `nvr_secret_id`). Test: a viewer's `from('stores').select('nvr_ip')` fails with 42501 while `select('id, code, name')` works; the `store_status` view, `getVisibleStore` and the dashboard still work (run the existing integration suite). Admin screens use the admin client and are unaffected. The same for `devices`? No: device address is needed by viewers (Devices page) and stays readable.
2. **Function search paths:** `ALTER FUNCTION … SET search_path = pg_catalog, public, pg_temp` for every SECURITY DEFINER function of the schema (`current_org_id`, `current_user_role`, `is_staff_all`, `granted_store_ids`, `visible_store_ids`, `visible_camera_ids`, `visible_device_ids`, `replace_user_access`, `monitor_apply_results`, `targets_uptime`, `monitor_forget_target`, `privilege_violations`, the alert vault helpers, `system_log_*`) and `pg_catalog, public, vault, pg_temp` for the `nvr_*` and channel secret helpers, `pg_catalog, public, auth, pg_temp` for `revoke_user_sessions`. Test: a catalog query through a new service-only RPC `definer_functions_without_search_path()` returns an empty set (functions in `public` that are `prosecdef` and whose `proconfig` lacks a `search_path` entry containing `pg_temp`).
3. **Rate limits on admin actions and import:** `ctx()` in `lib/actions/admin/*` applies `rateLimit('admin:<id>', 120, 60_000)` (plain error "Too many changes in a short time. Please wait a minute."); the two import actions additionally `rateLimit('import:<id>', 5, 600_000)`; import files are limited to 5,000 data rows (plain message "This file has more than 5,000 rows. Split it into smaller files."). Unit tests for the limiter use.
4. **Content-Security-Policy (report-only):** `buildCspReportOnly({ supabaseUrl, gatewayUrl, isDev })` returns `default-src 'self'; script-src 'self' 'unsafe-inline' <gateway origin>` (plus `'unsafe-eval'` only in dev), `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`, `font-src 'self' data:`, `connect-src 'self' <supabase origin> <gateway ws/http origins>`, `media-src 'self' blob:`, `frame-ancestors 'self'`, `base-uri 'self'`, `form-action 'self'`, `report-uri /api/csp-report`; added as `Content-Security-Policy-Report-Only` in `next.config.ts`. `/api/csp-report` (POST, public in the proxy's exact list) accepts bodies up to 10 KB, rate-limits 30 per minute per address hash, logs a redacted summary (`blocked-uri`, `violated-directive`, `document-uri` path only) through `logger` and appends a `security`/`csp_violation` system-log entry, and always answers 204. Unit tests for the header builder and the route (oversized body, bad JSON, rate limit).
5. **Request body limits:** `serverActions.bodySizeLimit` and `proxyClientMaxBodySize` to `6mb`.
6. **Proxy exactness:** add `/api/csp-report` to `PUBLIC_API`; confirm in a unit test that every entry is an exact path.
- [ ] Implement each with its test; run the full suites and `npm run build`. Commit `feat: hardening (column grants, search paths, rate limits, CSP report-only, body limits)`.

---

### Task 8: Deployment material

**Files:** Create `Dockerfile` (the Next.js standalone app), `Dockerfile.worker` (worker and gateway from one image, command chosen at run time), `deploy/docker-compose.yml` (app, worker, gateway, go2rtc; Supabase is external and configured by environment), `deploy/windows/install-services.ps1` (NSSM-based installation of app, worker, gateway and go2rtc as Windows services with auto-start and log folders), `deploy/windows/backup-db.ps1`, `docs/DEPLOYMENT.md`; modify `README.md`, `.env.example` (all variables, names only, grouped).
- [ ] `docs/DEPLOYMENT.md` covers: the processes and ports (3212 app, 3213 gateway, 1984 and 8555 go2rtc, the worker has no port), environment variables and secrets (`npm run env:local` equivalent for production: generate with `node -e` one-liners shown in the doc, never committed), Supabase production settings to repeat (public sign-up off, e-mail provider on, password rule 10 characters with letters and digits, site URL and redirect URLs), `TRUSTED_PROXY_HOPS`, PostgreSQL 15 or newer, applying migrations, creating the first admin, HTTPS and reverse proxy notes, `PLAYBACK_OFFSET_MIN`, `BACKUP_DIR`, `FFMPEG`, SMTP settings, log files, backups of the database and of Vault key, upgrade and rollback steps (migration rollbacks), a post-reboot checklist (app, worker heartbeat on `/api/health`, gateway `/g/health`, go2rtc). Docker compose and PowerShell scripts are reviewed for syntax; `docker build` of the app image must succeed locally (`docker build -t cctv-hub-app .`) and the result is reported. Commit `docs: deployment files and runbook`.

---

## Plan self-review

Covered: alerts with delay, recovery, repeat, NVR-down de-duplication (Tasks 1 to 3); reports and Excel (4); backup (5); hash-chained system log and security events (6); every item of the carry-over list assigned to Plan 4 (column grants, search paths, rate limits, CSP report-only, body limits, production auth settings and `TRUSTED_PROXY_HOPS` documented, rollback and Vault cleanup noted in the runbook) (7, 8). Not built: WhatsApp (needs a Meta account), SMS, in-app notification bell, scheduled report e-mails, log archiving to a second table. Real SMTP and Teams delivery cannot be exercised here; they are tested against fakes.
