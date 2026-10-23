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
C:\Drishti\services\<name>.conf      what the host runs (no secret: it names the env file)
C:\Drishti\config\*.env              one env file per service; go2rtc.yaml; drishti.config.psd1
C:\Drishti\logs\<name>\<name>.log    each service's output, rolled at 10 MB, 10 files kept
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
password and nothing to create or rotate. Each account may read the host (`bin`), the releases (`app`, not go2rtc) and its own env file,
and write its own log folder; nothing else (the install sets the ACLs with `icacls`, inheritance removed on the env files and log folders).
Network access from a virtual account uses the computer's account: enough for the database on this server and for the NVRs (RTSP/HTTP
over the VPN).

Named accounts instead (only if a policy requires it, for example a domain where the database is on another server and logs in with
Windows authentication): create a group Managed Service Account in the domain (`New-ADServiceAccount drishti-web -DNSHostName …`,
`Install-ADServiceAccount drishti-web`) or a local account without interactive logon (`New-LocalUser drishti-web -NoPassword`, then deny
"Log on locally" in the local security policy), and name it in the configuration: `Accounts = @{ DrishtiWeb = 'CITYKART\drishti-web$' }`.
**Do not create accounts on a development computer.**

## 4. Install (once per server, elevated PowerShell)

1. Node.js 20 or later (the version the release is built with) at `C:\Program Files\nodejs`; Git (to stamp the build id). go2rtc for
   Windows amd64, the pinned 1.9.9, at `C:\Drishti\go2rtc\go2rtc.exe` (download with the owner's approval, check its SHA-256 against the
   release page). Caddy as in runbook-tls.md.
2. The configuration: copy `deploy\windows\drishti.config.example.psd1` to `C:\Drishti\config\drishti.config.psd1`, adjust the folders,
   the database (`Container` for a Supabase stack in Docker on this server, `Direct` otherwise) and the Vault key location.
3. The env files: `node scripts\gen-secrets.mjs --production --out-dir C:\Drishti\config --jwt-secret-env DRISHTI_JWT_SECRET` (set
   `$env:DRISHTI_JWT_SECRET` in this session to the project's JWT secret first, then remove it). It writes `web.env`, `worker.env`,
   `gateway.env`, `go2rtc.env` with only each service's lines, generated secrets (43 characters, one per purpose, shared ones equal) and
   the four database keys; it refuses a folder inside the repository and never overwrites a file. Fill the addresses
   (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL`, `NEXT_PUBLIC_APP_URL`, `GATEWAY_ALLOWED_ORIGINS`) and the project's anon and service
   keys in `web.env`. `DRISHTI_ENV=production` is in each file: every process then refuses to start with one plain log line when a key
   or secret is missing, shorter than 32 characters, weak (a repeated pattern, a placeholder) or used for two purposes, or when the full
   service key is in the worker's or the gateway's file (`lib/startup-checks.ts`).
4. The services: `.\deploy\windows\drishti-services.ps1 -Action Install -WhatIf` (read the plan), then without `-WhatIf`. It compiles
   the host, writes the `.conf` files, creates the four services (stopped; delayed automatic start, own account, restart on failure)
   and sets the ACLs. They point at `C:\Drishti\app\current`, which the next step creates.
5. Production checklist before the first start: the service key locked out of NVR logins (runbook `secret-rotation.md` section 5),
   multi-factor (runbook-tls.md section 5), go2rtc's login (section 4 of the rotation runbook), Caddy and the certificate.
6. `.\deploy\windows\drishti-services.ps1 -Action Start -Service DrishtiGo2rtc` (go2rtc first: the gateway checks its login at start).
7. The first release: `.\deploy\windows\update.ps1 -SourcePath <checkout> -DryRun` (read the plan), then without `-DryRun`. It builds
   into `app\releases\<id>`, backs up the database, applies the migrations, points `app\current` at the release, starts the worker, the
   gateway and the web app, and waits until `/api/version` shows the new build and `/api/health` says `ok`. Then `-Action Status` and the
   Health page (super administrators, `/admin/health`): every check "OK".
8. The nightly backup as a scheduled task (runbook `backup-restore.md` section 4).

## 5. Every day

- `drishti-services.ps1 -Action Status`: each service's state, its log file and the public health (`ok` / `degraded`).
- Health page (`/admin/health`, super administrators): database, Vault, gateway, worker (lease, last sign of life, clock), database
  version against the release, free disk space, the clean-up of unused video sessions. `/api/health/detail` gives the same as JSON to a
  signed-in super administrator; the public `/api/health` says only `ok` or `degraded` (for a load balancer or a monitor).
- Logs: `C:\Drishti\logs\<service>\<service>.log` (one JSON line per event; never a secret). The host's own lines are `"event":"service_host"`.

## 6. Uninstall

`drishti-services.ps1 -Action Uninstall` stops and deletes the four services; releases, configuration, logs and backups stay. The virtual
accounts disappear with their services.

## 7. First real installation (to do and record)

On a test server (never the development computer): steps 1-8, then: stop each service from `services.msc` and check its log ends with
the program's clean stop (`worker_stopped`, `gateway_stopped`); kill `node.exe` of the worker in Task Manager and check the host starts it
again within 5 s; reboot and check the four start by themselves; fill a log past 10 MB (or set `LogMaxBytes` low) and check it rolls.
Record the result (date, Windows version, Node.js and go2rtc versions) in the tracker (LG-37, SO-12).
