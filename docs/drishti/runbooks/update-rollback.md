# Runbook: update and roll back (P5.4)

Applies to: a Windows installation made as in `windows-services.md`. Script: `deploy/windows/update.ps1` (`-DryRun` / `-WhatIf`).
**Verification status:** the plan, its order and the three roll-back plans are tested as dry runs (`tests/unit/windows-scripts.test.ts`);
a real update has not been run on a production-like server yet (record the first one in the tracker, LG-37).

## 1. One command

```powershell
# from an elevated PowerShell on the server; the new source is a checkout of the release branch or an unpacked release
.\deploy\windows\update.ps1 -SourcePath C:\Drishti\incoming\drishti-<version> -DryRun   # read the plan
.\deploy\windows\update.ps1 -SourcePath C:\Drishti\incoming\drishti-<version>
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
| 8 Check | `/api/version` = the new build id AND `/api/health` = `ok`, within `HealthTimeoutSec` (180 s; the worker needs up to 20 s to take its lease) | roll back |

After a good update the newest `KeepReleases` (3) releases are kept; the open pages show "A new version is available" (the version
banner compares their build id with `/api/version`) and people refresh.

## 2. The automatic roll back

On a failure in steps 4–8 the script: stops the services; when the database level changed (migrations applied, even part of them)
restores the step 3 backup into the live database (`restore.ps1 -AllowLiveDatabase`, its checks included; `-RollbackDatabase None`
skips this and leaves the new level, which works only when the new migrations are additive); points `app\current` back to the previous
release; starts it and checks it the same way. Exit code 1 either way, with the reason in the output and in the service logs.

Data written between step 7 and the failure (minutes at most: sign-ins, audit rows, monitoring results) is lost by the database
restore; the backup of step 3 itself is kept. The restore into the live database is the unvalidated path of `backup-restore.md` 5b.

## 3. Rolling back by hand (after a "good" update that turns out bad later)

1. `drishti-services.ps1 -Action Stop`.
2. Database: if the new release's migrations must go, run their rollback scripts **newest first**, each dry-run first:
   `psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f supabase\rollback\<file>` then without `drishti_dry_run`
   (inside the container: `docker exec -i <db container> psql -U postgres -d postgres ... < <file>`). Or restore the `pre-update-<id>`
   backup (`backup-restore.md` 5b) when no data since the update matters.
3. Code: point `C:\Drishti\app\current` at the previous release folder
   (`cmd /c rmdir C:\Drishti\app\current` then `cmd /c mklink /J C:\Drishti\app\current C:\Drishti\app\releases\<previous id>`).
4. `drishti-services.ps1 -Action Start`; Health page: "Database version" OK (a database newer than the code shows "Needs attention").

## 4. Migrations 0041 (P5.4) specifically

`20261021000041_p54_ops_audit.sql` adds `housekeeping_runs`, `ops_health_status()`, the Vault canary secret `drishti_vault_canary`, and
makes `admin_audit_log` append-only. Its rollback `supabase/rollback/20261021000041_p54_ops_audit_rollback.sql` (dry run as above) puts
the prune functions back, gives the service role UPDATE/DELETE/TRUNCATE on `admin_audit_log` again and removes the canary; the code of
P5.4 then reports the database part of the Health page as "could not be read".
