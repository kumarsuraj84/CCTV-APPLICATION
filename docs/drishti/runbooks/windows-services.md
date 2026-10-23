# Runbook: Drishti as Windows services (P5.4)

Applies to: the production server of CityKart Drishti (Windows Server 2019/2022 or Windows 10/11 Pro). Written 2026-10-23 with P5.4.

**Verification status (honest).** Nothing was installed on the development computer: no service, account, firewall rule, scheduled task
or registry entry. What is verified, by tests: every script parses (`[System.Management.Automation.Language.Parser]`), the review rules
PSScriptAnalyzer would apply (it is not installed here, and nothing was installed for this), the dry runs (`-WhatIf`) of install,
update with its roll back, and backup retention (`tests/unit/windows-scripts.test.ts`); the service host compiled with the computer's
own C# compiler and run in its console mode with a stand-in program: settings from the env file, clean stop by Ctrl+C, restart after a
crash, log rolling, forced end of a program that ignores the stop together with what it started (`tests/integration/windows-service-host.test.ts`);
backup and restore in a disposable database (`tests/integration/backup-restore.test.ts`, runbook `backup-restore.md`). The first real
installation must follow section 7 and record the result in `docs/drishti/DELIVERY-STATUS.md` (LG-37, SO-12).

**Fix round 1 (review of 2026-10-23).** The install now locks every Drishti folder before it writes anything into it (section 3), and
`-Action Audit` checks those locks at any time. update.ps1 calls the services script in the same PowerShell (an array of services could
not pass through `powershell -File`), and a failed update stops everything rather than start the old release on a newer database. The
host keeps running when its log cannot be rolled. The ACL plan, the empty-root install plan, the audit, the update and its three roll
back plans, the retention junction trap and the host's log-roll failure are tested; the ACLs themselves were only applied to temporary
folders of the test run, never to a real `C:\Drishti`.

**Fix round 2 (re-review of 2026-10-23).** A lock now takes ownership and rebuilds the list from nothing (a foreign entry, read or
write, does not survive RepairAcl), and the Audit also reports foreign owners and any read entry on the secret paths (tested on real
scratch folders: an explicit `Authenticated Users:M`, `Users:R` on `web.env` and `Everyone:F` below are all gone after a second lock;
a planted junction is refused). Taking ownership needs elevation, so in the tests (not elevated) that step is shown in the plan only.
The web account may read the free space of the data and backup disks (proved with a real `statfs` call under the same entry). The
install and the update refuse a database mode and migration mode that do not fit, the update refuses a database seeded for tests and
marks a production database, and every Windows tool is called by its full path.

## 1. What runs

| Service | Program | Listens | Env file | Account |
|---|---|---|---|---|
| `DrishtiGo2rtc` | `go2rtc.exe -config C:\Drishti\config\go2rtc.yaml` | 127.0.0.1:1984 (API only) | `go2rtc.env` | `NT SERVICE\DrishtiGo2rtc` |
| `DrishtiWorker` | `node tsx services\worker\index.ts` | nothing | `worker.env` | `NT SERVICE\DrishtiWorker` |
| `DrishtiGateway` | `node tsx services\gateway\index.ts` (depends on go2rtc) | 127.0.0.1:3412 | `gateway.env` | `NT SERVICE\DrishtiGateway` |
| `DrishtiWeb` | `node .next\standalone\server.js` | 127.0.0.1:3212 | `web.env` | `NT SERVICE\DrishtiWeb` |
| Caddy (runbook-tls.md) | `caddy.exe run` | 443 (and 80 for the redirect) | — | its own service account |

Start order: go2rtc, worker, gateway, web app. Stop order: web app, gateway, worker, go2rtc (`deploy/windows/lib/Drishti.Common.ps1`).
The Supabase stack (PostgreSQL, PostgREST, GoTrue) runs separately: self-hosted Supabase in Docker on this server or another one, or a
hosted project (runbook-tls.md section 3: its API stays private).

Folders (all in `deploy/windows/drishti.config.example.psd1`, copied to `C:\Drishti\config\drishti.config.psd1`):

```
C:\Drishti\app\releases\<build id>\   one folder per release (source, node_modules, .next\standalone, release.json)
C:\Drishti\app\current               a junction to the release that runs (switched by update.ps1)
C:\Drishti\bin\DrishtiServiceHost.exe the service host (compiled on install)
C:\Drishti\scripts\                  the administrators' copy of deploy\windows (install and every update refresh it); the nightly
                                     backup task runs from here, never from a checkout people can write to
C:\Drishti\services\<name>.conf      what the host runs (no secret: it names the env file)
C:\Drishti\config\*.env              one env file per service; go2rtc.yaml; drishti.config.psd1
C:\Drishti\data\                     DataDir (the Health page reports its disk)
C:\Drishti\logs\<name>\<name>.log    each service's output, rolled at 10 MB, 10 files kept
C:\Drishti\drishti.lock              held while an update or a live restore runs (a second one does not wait: it refuses)
D:\DrishtiBackups\                   database backups (runbook backup-restore.md); E:\DrishtiKeys\ the Vault root key copies
```

## 2. Why sc.exe with the Drishti service host, not NSSM

Node.js and go2rtc do not answer the Service Control Manager, so `sc.exe create` cannot run them directly (Windows ends such a service
after 30 s with error 1053). Two ways were considered:

| | NSSM | sc.exe + `DrishtiServiceHost` (chosen) |
|---|---|---|
| Install | separate download, a global tool on PATH | none: compiled from `deploy/windows/service-host/DrishtiServiceHost.cs` by the .NET Framework 4 compiler every Windows 10/11 and Server has (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`) |
| Secrets | the environment is stored in the registry (`AppEnvironmentExtra`) | read at each start from the service's own env file, restricted to its account by ACL; never logged, never in the registry |
| Clean stop | Ctrl+C, then kill | Ctrl+C on a private hidden console (the worker hands back its lease, the gateway closes its sockets), then the whole process tree ends (a Job Object: no ffmpeg left behind) |
| Logs | rotation options | `<name>.log`, rolled by size (`LogMaxBytes`, `LogKeep`) |
| Restart | yes | the host restarts the program (5 s doubling to 60 s); the Service Control Manager restarts the host (`sc failure`: 5 s, 10 s, 60 s) |
| Review | third-party binary | ~350 lines of C# in this repository |

NSSM was not present on the development computer and nothing was downloaded; the scripts do not use it.

## 3. Accounts (least privilege)

Default: one **virtual service account** per service, `NT SERVICE\<service name>`. Windows creates it with the service; there is no
password and nothing to create or rotate. Network access from a virtual account uses the computer's account: enough for the database on
this server and for the NVRs (RTSP/HTTP over the VPN).

**Folder locks (review C-2; fix round 2: N-1).** On Windows 10/11 `C:\` lets every signed-in user create and change files below it,
and the services run what is in these folders (as their accounts, and the nightly task as SYSTEM). So before the install writes
anything, every Drishti folder is created if missing and locked:

- ownership is taken for the Administrators (`takeown /A`, with everything below a folder): a folder somebody else made before the
  install (`C:\Drishti`, `C:\Drishti\bin`, `D:\DrishtiBackups`…) no longer lets them change its rules. Such a folder is named in a
  WARNING ("existed already and belongs to …"): look at what is in it;
- the access list is rebuilt from nothing, in one call: no inherited entry and no explicit entry of anybody else survives. SYSTEM and
  Administrators get full control (by their SIDs `*S-1-5-18` and `*S-1-5-32-544`, so it works on a Windows in any language), then
  only the entries below. Everything inside the folder loses its own entries and inherits the new list (`icacls /reset /T`); the
  sub-folders and files that need their own entries are locked after their parent;
- a folder that holds a junction or link the installation did not make (only `app\current` is allowed) is REFUSED: a junction in a
  folder made before the install could point at `C:\Windows`, and nothing is followed;
- the virtual accounts are given by their SIDs, computed from the service names (as `sc.exe showsid` does), so the folders can be
  locked before the services exist.

Locking `app` resets everything below it, `node_modules` included: on a server with several releases it can take a few minutes.

| Folder | Service accounts | Nobody else |
|---|---|---|
| `InstallRoot`, `services`, `scripts` | none | no user may write |
| `bin` | all four read and run | |
| `app` (releases, `current`) | web, worker, gateway read and run | |
| go2rtc's folder | go2rtc read and run | |
| `config` | none on the folder; each env file read by its own service only; `drishti.config.psd1` administrators only | |
| `data` | the web app may read the free space of its disk only (`(RA,S)` on the folder itself, nothing inside; review M-4) | |
| `logs` | each service modify on its own log folder only | |
| `BackupDir` | the web app: the free space of its disk only, as for `data` (backups are made as an administrator or SYSTEM) | |
| `KeyBackupDir` | none | |

Check them at any time, from an elevated PowerShell: `drishti-services.ps1 -Action Audit` lists every owner other than SYSTEM, the
Administrators or TrustedInstaller; every folder or file where anybody but that folder's own service account may write; and on the
secret paths (the configuration folder and file, every env file, `go2rtc.yaml`, `data`, `BackupDir`, `KeyBackupDir`) every entry that
lets anybody else even READ, so `Users:(R)` on `web.env` fails it. It never trusts the person running it. A path whose rules it
cannot read (not elevated) is reported as such. It ends with exit code 1 when there is a problem. `-Action Status` says
`access rules: ok` or how many problems. Put them right with `-Action RepairAcl` (elevated): it applies the same plan again and
removes foreign entries, so a repair really repairs. update.ps1, restore.ps1 and backup.ps1 refuse to run (`Run drishti-services.ps1 -Action RepairAcl`) while the configuration
file or the scripts folder may be written by others.

Named accounts instead (only if a policy requires it, for example a domain where the database is on another server and logs in with
Windows authentication): create a group Managed Service Account in the domain (`New-ADServiceAccount drishti-web -DNSHostName …`,
`Install-ADServiceAccount drishti-web`) or a local account without interactive logon (`New-LocalUser drishti-web -NoPassword`, then deny
"Log on locally" in the local security policy), and name it in the configuration: `Accounts = @{ DrishtiWeb = 'CITYKART\drishti-web$' }`.
**Do not create accounts on a development computer.**

## 4. Install (once per server, elevated PowerShell)

**Before you start: scripts from a zip, and where to build.** A release unpacked from a downloaded zip carries the "came from the
internet" mark, and PowerShell's execution policy (RemoteSigned on servers) then refuses its scripts. Check the zip's SHA-256 against the
one the owner published, then `Get-ChildItem <folder> -Recurse | Unblock-File`; run the scripts with
`powershell -ExecutionPolicy Bypass -File ...` only for that session, never by changing the machine policy. `update.ps1` runs `npm ci`,
which runs the install scripts of every dependency, here as an Administrator: use a checkout of a tag the owner approved, with its
`package-lock.json` unchanged. Better, when there is one: build on a separate build computer and copy the finished release folder.

0. Before anything: `C:\Drishti`, `D:\DrishtiBackups` and `E:\DrishtiKeys` should not exist yet. If one does and you did not make it,
   look at what is in it before going on (the install takes it over, locks it and warns about it).
1. Node.js 20 or later (the version the release is built with) at `C:\Program Files\nodejs`; Git (to stamp the build id); Docker
   Desktop for a self-hosted Supabase here. `DockerExe` and `GitExe` in the configuration give their full paths (the scripts never
   take a program from PATH). go2rtc for Windows amd64, the pinned 1.9.9: download it into YOUR OWN folder (Downloads), with the
   owner's approval, check its SHA-256 against the release page and `Unblock-File` it. It is copied to `C:\Drishti\go2rtc\go2rtc.exe`
   only after step 4 has made and locked that folder. Caddy as in runbook-tls.md.
2. The env files, first, because they create `C:\Drishti\config` locked:
   `node scripts\gen-secrets.mjs --production --out-dir C:\Drishti\config --jwt-secret-env DRISHTI_JWT_SECRET` (set
   `$env:DRISHTI_JWT_SECRET` in this session to the project's JWT secret first, then remove it). It creates the folder locked (SYSTEM
   and Administrators only) and each file locked before writing a secret into it, so they are never readable by other users, not even
   for a moment. It writes `web.env`, `worker.env`, `gateway.env`, `go2rtc.env` with only each service's lines, generated secrets (43
   characters, one per purpose, shared ones equal) and the four database keys; it refuses a folder inside the repository and never
   overwrites a file. Fill the addresses (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL`, `NEXT_PUBLIC_APP_URL`, `GATEWAY_ALLOWED_ORIGINS`),
   the project's anon and service keys and `DRISHTI_BACKUP_DIR` (the `BackupDir` of step 3) in `web.env`. `DRISHTI_ENV=production` is
   in each file: every process then refuses to start with one plain log line when a key or secret is missing, shorter than 32
   characters, weak (a repeated pattern or part, a placeholder) or used for two purposes, or when the full service key is in the
   worker's or the gateway's file (`lib/startup-checks.ts`).
3. The configuration: copy `deploy\windows\drishti.config.example.psd1` into that locked folder as
   `C:\Drishti\config\drishti.config.psd1` (a file copied into it takes the folder's lock) and adjust the folders, the database (review
   M-13; the install and the update refuse a pair that does not fit): `Container` + `MigrationMode = 'DbUrl'` for a self-hosted
   Supabase in Docker on this server, `Direct` + `'DbUrl'` for PostgreSQL elsewhere. `Container` + `'Local'` is the Supabase CLI's own
   stack, which is seeded for tests: only on a test server, with `TestServer = $true`. Then the Vault key location (`KeyBackupDir`, not inside `BackupDir`: backup.ps1 refuses that). For `DbUrl` the database
   password is never written in the file or on a command line: set `$env:DRISHTI_DB_PASSWORD` (the name in `PasswordEnv`) in the
   elevated session before an update and remove it after; the scripts hand it to `pg_dump`, `pg_restore`, `psql` and the Supabase CLI
   as `PGPASSWORD` of that child process only.
4. The services: `.\deploy\windows\drishti-services.ps1 -Action Install -WhatIf` (read the plan), then without `-WhatIf`. In this
   order it creates and locks every folder (section 3), copies `deploy\windows` to `C:\Drishti\scripts`, compiles the host, writes the
   `.conf` files, creates the four services (stopped; delayed automatic start, own account, restart on failure) and gives each service
   read access to its own env file only. They point at `C:\Drishti\app\current`, which step 8 creates. From here on, run the scripts
   from `C:\Drishti\scripts`. Now copy `go2rtc.exe` from your Downloads into the locked `C:\Drishti\go2rtc`.
5. `C:\Drishti\scripts\drishti-services.ps1 -Action Audit` (elevated): it must say `access rules: ok`.
6. Production checklist before the first start: the service key locked out of NVR logins (runbook `secret-rotation.md` section 5),
   multi-factor (runbook-tls.md section 5), go2rtc's login (section 4 of the rotation runbook), Caddy and the certificate.
7. `drishti-services.ps1 -Action Start -Service DrishtiGo2rtc` (go2rtc first: the gateway checks its login at start).
8. The first release: `C:\Drishti\scripts\update.ps1 -SourcePath <checkout> -DryRun` (read the plan), then without `-DryRun`. It first
   refuses a database whose test fixture switch is on: such a database was seeded for tests (`supabase/seed.sql` must never be applied
   to a production database). After the migrations it marks the database as a production one, so the switch can never be turned on
   there (the seed fails). It builds
   into `app\releases\<id>`, backs up the database, applies the migrations, points `app\current` at the release, starts the worker, the
   gateway and the web app, and waits until `/api/version` shows the new build and `/api/health` says `ok`. Then `-Action Status` and the
   Health page (super administrators, `/admin/health`): every check "OK".
9. The nightly backup as a scheduled task running `C:\Drishti\scripts\backup.ps1` (runbook `backup-restore.md` section 4).
10. Rehearse a restore into a disposable database (runbook `backup-restore.md` section 5), then the first-run checks of section 7.

## 5. Every day

- `drishti-services.ps1 -Action Status`: each service's state, its log file, the public health (`ok` / `degraded`) and whether the
  folder locks still hold (`access rules: ok`; otherwise `-Action Audit` lists them and `-Action RepairAcl` puts them right).
- Health page (`/admin/health`, super administrators): database, Vault, gateway, worker (lease, last sign of life, clock), database
  version against the release, free disk space (the data disk and the backup disk), the clean-up of unused video sessions. `/api/health/detail` gives the same as JSON to a
  signed-in super administrator; the public `/api/health` says only `ok` or `degraded` (for a load balancer or a monitor).
- Logs: `C:\Drishti\logs\<service>\<service>.log` (one JSON line per event; never a secret). The host's own lines are `"event":"service_host"`.

## 6. Uninstall

`drishti-services.ps1 -Action Uninstall` stops and deletes the four services; releases, configuration, logs and backups stay. The virtual
accounts disappear with their services.

## 7. First real installation (to do and record)

On a test server (never the development computer): steps 1-10, then:

1. Stop each service from `services.msc` and check its log ends with the program's clean stop (`worker_stopped`, `gateway_stopped`).
   **The real worker under the host (review M-5):** the worker and the gateway run under `tsx`, which is two processes; on Windows tsx
   passes Ctrl+C on to its child and ends it outright when the child answers late. The host test used a stand-in program, so this is
   the first proof that the real worker hands its lease back: after the stop, the Health page shows the lease "not held" at once (not
   after it runs out, 20 s later).
2. Kill `node.exe` of the worker in Task Manager and check the host starts it again within 5 s.
3. **A user signs out (review M-5):** sign in over VNC as a normal user and as an administrator, sign out, and check the four services
   are still running and their logs show no stop (Windows sends a sign-out notice to programs that have a console, and the programs
   run on the host's private console; how they react to it is not tested yet).
4. **Reboot:** the four start by themselves; the worker's lease is either handed back before the shutdown (`worker_stopped` in the log)
   or runs out within 20 s, and the new worker takes it (the host cannot ask Windows for more shutdown time).
5. Fill a log past 10 MB (or set `LogMaxBytes` low) and check it rolls; open the log in a viewer that holds it, and check the service
   keeps running and the host's line "the log could not be rolled" appears, then the roll happens once the viewer is closed.
6. `-Action Audit` after all of this: `access rules: ok`.

Record the result (date, Windows version, Node.js and go2rtc versions) in the tracker (LG-37, SO-12). If step 1 shows the lease
running out instead of being handed back, the fallback is to run the compiled worker without tsx (a later package).
