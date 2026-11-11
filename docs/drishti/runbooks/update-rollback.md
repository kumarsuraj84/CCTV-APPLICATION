# Runbook: update and roll back (P5.4)

Applies to: a Windows installation made as in `windows-services.md`. Script: `deploy/windows/update.ps1` (`-DryRun` / `-WhatIf`).
**Verification status:** the plan, its order and the roll-back plans (health, start, a failed restore that ends STOPPED, migrate) are
tested as dry runs through the real calls to the services script (`tests/unit/windows-scripts.test.ts`); the live restore path on a
disposable database (`tests/integration/backup-restore.test.ts`). A real update has not been run on a production-like server yet
(record the first one in the tracker, LG-37).

## 1. One command

```powershell
# from an elevated PowerShell on the server; the new source is a checkout of the release branch or an unpacked release
# (the admin-only copy of the scripts; the update refreshes it from the new release once that release is healthy)
C:\Drishti\scripts\update.ps1 -SourcePath C:\Drishti\incoming\drishti-<version> -DryRun   # read the plan
C:\Drishti\scripts\update.ps1 -SourcePath C:\Drishti\incoming\drishti-<version>
```

What it does, in order (and why):

| Step | What | If it fails |
|---|---|---|
| 1 Preflight | administrator, configuration, source (`package.json`), 5 GB free, the build id `yyyyMMdd-HHmm-<git sha>` (or `-BuildId`) | nothing changed |
| 2 Build | copy the source to `app\releases\<id>` (without `.git`, `node_modules`, `.next`, `.env*`), `npm ci`, `npm run build` with `CK_BUILD_ID=<id>` and the `NEXT_PUBLIC_*` lines of `web.env` (they are built into the pages: HSTS, the gateway address), copy `public\` and `.next\static\` next to the standalone server, write `release.json` (build id, migration level it needs: the Health page compares it with the database) | nothing that runs is changed; remove the half-made release folder |
| 3 Back up | `backup.ps1 -Tag pre-update-<id>` (dump in one snapshot, manifest, Vault key hash) | nothing stopped |
| 4 Stop | web app, gateway, worker (go2rtc keeps running; `-RestartGo2rtc` to include it) | roll back |
| 5 Migrate | `npx supabase migration up` of the new release (forward migrations only; each has its rollback script in `supabase/rollback/`) | roll back |
| 6 Switch | `app\current` → the new release (a junction) | roll back |
| 7 Start | worker, gateway, web app | roll back |
| 8 Check | the new release (final review C-I5): `/api/version` = the new build id within `HealthTimeoutSec` (180 s), every started service running (a start-up self-check that refused stops its service), the gateway answering `/g/health`, the database at the level the release needs | roll back |
| 8b Health | `/api/health`: `ok`; `degraded` for a reason of the server (disk, a worker stopped or in standby, the Vault canary, the clocks, a missed backup) | **no roll back**: the new release is kept, the update says so and ends with exit code 3; look at the Health page |

After a good update the newest `KeepReleases` (3) releases are kept; the open pages show "A new version is available" (the version
banner compares their build id with `/api/version`) and people refresh.

Only one update (or live restore) runs at a time: the script holds `C:\Drishti\drishti.lock` and a second run refuses (and an install
that was never done is refused: the lock is never made in an unlocked new folder). It also refuses while `drishti.config.psd1` or
`C:\Drishti\scripts` may be written by non-administrators (`drishti-services.ps1 -Action RepairAcl`), when the database mode and the
migration mode do not fit (review M-13), and, fix round 2 (re-review N-2), while the database's test fixture switch is on: that
database was seeded for tests (`supabase/seed.sql`), which a production database must never be; the test helpers would run on it.
Nothing is changed then; the message gives the statement to switch it off as the database owner, and asks you to find out how the
seed was applied. After the migrations, the update marks the database as a production one (`test_fixture_switch.production`, migration
0046): from then on the switch cannot be turned on there by anybody's UPDATE, so `seed.sql` fails loudly on it, and the mark cannot be
taken back. The production web app also refuses to start, and the Health page shows "Test fixture switch: Problem", while it is on.
The Supabase CLI reads the password from `PGPASSWORD` with a password-free `--db-url` (verified with the pinned CLI 2.121.0 against
the local stack, read only: `migration list` with the right `PGPASSWORD` connects, with a wrong one it fails with "password
authentication failed"; the CLI's own `SUPABASE_DB_PASSWORD` would also work).
The services are stopped and started by calling `drishti-services.ps1` inside the same PowerShell (review C-1), and for `DbUrl`
migrations the password goes to the Supabase CLI as `PGPASSWORD` of that one child process, never on its command line (review I-2).

## 2. The automatic roll back

A worker kept stopped on purpose (a pilot without monitoring): `WorkerExpected = $false` in the configuration; the update then
neither starts nor counts it (and `DRISHTI_WORKER_EXPECTED=false` in `web.env` makes the Health page say "stopped on purpose").
`app\current` is taken as the running release only when it is a junction to a folder directly under `app\releases`; anything else
is refused before anything changes (review 2 N-3). `MigrationMode = 'Local'` (the Supabase CLI's seeded stack) is refused by the
update even on a test server (review 2 m1): there, apply the migrations by hand (`npx supabase migration up --local`) and point
`app\current` at the new release; never switch the test fixture switch off to get past the refusal (the update would then mark the
test database as a production one for good). Verification status: verified by design and unit-tested; the behaviour on real folders (locks, junctions, hard links) is checked by the Windows lab suite on the production server before the install (`windows-services.md` section 7.0), not yet run there.

On a failure in steps 4–8 the script:

1. stops **every** Drishti service, go2rtc included (a restore refuses while anything runs);
2. when the database level changed (migrations applied, even part of them), restores the step 3 backup with
   `restore.ps1 -AllowLiveDatabase -PreRestoreBackup`:
   - first a backup of the database as it is now (`before-restore-…`, so nothing written since step 3 is thrown away for good);
   - the backup is restored into a NEW database (`<name>_restored_<time>`), with every `pg_restore` error stopping it;
   - that copy is proven (row counts against the manifest, migration level, Vault canary, root key hash);
   - only then the two are swapped by renaming: the live database becomes `<name>_before_restore_<time>` (kept, never dropped) and the
     proven copy takes its name, owner, rights and settings. If anything fails before the swap, the live database is not changed;
3. points `app\current` back to the previous release, starts every service and checks it the same way.

Exit code 1 when the roll back worked. When any part of the roll back fails (the restore, the switch back, or there is no earlier
release), the script stops everything again and prints **THE SYSTEM IS STOPPED**, the reason, each service's real state as Windows
reports it (and "NOT stopped: …" with what to do when a stop timed out; re-review M-new-4), the restore's own lines on where the
databases are, and the folder of the pre-update backup, then ends with exit code 2. It never starts the old release on the new
database level in that case: follow section 3 by hand.

`-RollbackDatabase None` skips the database restore and starts the old release on the new level, with a loud WARNING: use it only when
the new migrations are additive.

**What is lost (review M-2).** The database goes back to the moment of the step 3 snapshot. Everything written after it is not in the
restored database: what people and the worker wrote while the services were still running between steps 3 and 4 (seconds to a minute:
sign-ins, audit rows, monitoring results), and anything written after step 7. It is not gone: it is in the `before-restore-…` backup and
in the kept `<name>_before_restore_<time>` database, from which a person can copy rows back if one matters.

**Verification status.** The copy, prove and swap restore is tested end to end on a disposable database of the local server
(`tests/integration/backup-restore.test.ts`: swapped, counts back, the kept database holds what was written after the backup, the
before-restore backup exists; a forged manifest is refused and leaves the live database unchanged). It has **not** been run against a
live production database. Rehearse it once on the test server (section 7 of `windows-services.md`).

## 3. Rolling back by hand (after THE SYSTEM IS STOPPED, or a "good" update that turns out bad later)

1. `drishti-services.ps1 -Action Stop` (after THE SYSTEM IS STOPPED they are stopped already; leave them so). Read the update's last
   lines: they say whether the database was restored (`swapped`) or not changed.
2. Database: if the new release's migrations must go, run their rollback scripts **newest first**, each dry-run first:
   `psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f supabase\rollback\<file>` then without `drishti_dry_run`
   (inside the container: `docker exec -i <db container> psql -U postgres -d postgres ... < <file>`). Or restore the `pre-update-<id>`
   backup (`backup-restore.md` 5b: `restore.ps1 -AllowLiveDatabase -PreRestoreBackup`) when no data since the update matters.
3. Code: point `C:\Drishti\app\current` at the previous release folder
   (`cmd /c rmdir C:\Drishti\app\current` then `cmd /c mklink /J C:\Drishti\app\current C:\Drishti\app\releases\<previous id>`).
4. `drishti-services.ps1 -Action Start`; Health page: "Database version" OK (a database newer than the code shows "Needs attention").

## 4. Migrations 0041 (P5.4) specifically

`20261021000041_p54_ops_audit.sql` adds `housekeeping_runs`, `ops_health_status()`, the Vault canary secret `drishti_vault_canary`, and
makes `admin_audit_log` append-only. Its rollback `supabase/rollback/20261021000041_p54_ops_audit_rollback.sql` (dry run as above) puts
the prune functions back, gives the service role UPDATE/DELETE/TRUNCATE on `admin_audit_log` again and removes the canary; the code of
P5.4 then reports the database part of the Health page as "could not be read".

`20261021000045_p54_review_fixes.sql` (review round 1) changes two function bodies only: `audit_purge_test_org` refuses unless the test
fixture switch is on (the local test stack) and the organisation was made as a test one (`created_as_test`, migration 0044), and
`media_sessions_prune` records its run only for the whole clean-up. Its rollback puts back the 0041 bodies (dry run as above).

`20261021000046_p54_fixture_guards.sql` (fix round 2) adds `organizations.created_as_demo` (fixed when the organisation is made; an API
role cannot rename an organisation into `demo-sample-data`), makes every test helper need the test fixture switch on AND an organisation
made as a test one (or as the demo one, for the clean-ups), adds the production mark of the switch (`test_fixture_switch.production`:
then the switch can never be turned on, and the mark and the row cannot go), `test_fixtures_enabled()` for the web app, and the switch
in `ops_health_status()`. Its rollback (dry run as above) puts back the earlier bodies and drops what it added. Roll back 0046 before
0045, and both before 0044.
