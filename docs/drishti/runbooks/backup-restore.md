# Runbook: backup, restore and the Vault root key (P5.4)

Applies to: the production database of CityKart Drishti (Supabase / PostgreSQL 17) and its Vault. Scripts: `deploy/windows/backup.ps1`,
`deploy/windows/restore.ps1` (both with `-DryRun` / `-WhatIf`). Written 2026-10-23 with P5.4.

**Verification status (honest).** Proven on the development computer, in a disposable database: `tests/integration/backup-restore.test.ts`
dumps the local database (read only) and restores it into a NEW database `drishti_restore_test` on the same server, then compares the
row counts of 18 key tables (all equal), the migration level (equal to the backup and to this checkout's highest migration), decrypts
every Vault secret (224 of 224) and the canary secret, and compares the SHA-256 of the server's Vault root key with the one in the
backup; the copy is dropped afterwards. Evidence: `docs/drishti/evidence/p5/backup-restore.md` and `backup-restore-proof.json`.
**Not exercised:** a restore INTO the live database (it would replace the owner's data; the script's live path, `--clean --if-exists`,
is unvalidated), a restore onto another server with a restored key file, and the Direct (non-Docker) mode of the scripts. Rehearse
both on a copy of the server before relying on them (section 6).

## 1. What a backup is

`backup.ps1` makes one folder per backup under `BackupDir`, `<yyyyMMdd-HHmmss>-<tag>\`:

| File | What |
|---|---|
| `db.dump` | `pg_dump -Fc` of the whole database (schemas public, auth, vault, storage, supabase_migrations …), as a superuser |
| `manifest.json` | time, tag, database, server version, migration level, row counts of 18 key tables, the dump's size and SHA-256, the SHA-256 of the Vault root key it needs. No secret, no row value |

The row counts are taken **in the dump's own snapshot** (one `REPEATABLE READ` transaction exports a snapshot with
`pg_export_snapshot()`; `pg_dump --snapshot` and the counts both read it), so a restore must reproduce them exactly, even while the
services keep running. Measured on the development database: about 8 MB compressed, 1–2 s to dump, 3–5 s to restore.

## 2. The Vault root key: what must be backed up separately, and why

The NVR passwords are stored with **Supabase Vault** (`supabase_vault` 0.3.1 on the pinned image `supabase/postgres:17.11.0.004`):
`vault.secrets` holds only ciphertext; each secret is encrypted with a key derived from **one server-wide root key** that is **not in the
database**. PostgreSQL loads it at start through the setting `pgsodium.getkey_script` = `/usr/lib/postgresql/bin/pgsodium_getkey.sh`,
which prints the file **`/etc/postgresql-custom/pgsodium_root.key`** (64 hex characters = 32 bytes; the script creates a random one if
the file is missing).

So:
- `pg_dump` copies the ciphertext but never the key. A dump restored on a server with **another** root key restores every row, but every
  NVR password (and the canary) fails to decrypt: monitoring and video stop for every NVR until each password is typed again.
- **Back up the key file separately**, once and after every key change, NOT next to the dumps (whoever has both has every NVR
  password): `backup.ps1 -IncludeVaultKey` copies it to `VaultKey.KeyBackupDir` (Administrators only; in production a different disk or
  an encrypted removable medium kept by the owner, plus a sealed paper copy of the 64 characters in the safe). Every manifest records
  the key's SHA-256 even without a copy, and `restore.ps1` compares it with the server it restores on.
- Self-hosted Supabase in Docker: the key file lives in the database container's file system at `/etc/postgresql-custom/`. On the
  local development stack the Supabase CLI writes the same development key into every new container (the 224 secrets still decrypt
  after the container was recreated on 2026-10-23), which is **not** the case for a self-hosted production stack: mount
  `/etc/postgresql-custom` from a host folder (so the key survives a container rebuild) and back that file up.
- Hosted Supabase project: the platform keeps the root key; there is no file. A dump restores with working secrets into the **same**
  project only. For another project, export the NVR passwords before (an administrator types them again from the NVR records) — plan it.
- A wrong key is visible at once: the Health page's "Vault (saved NVR logins)" check fails ("the check value does not decrypt"), and
  `restore.ps1` says `canary NOT ok`.
- Changing the root key is a migration of every secret (decrypt with the old, re-encrypt with the new); never replace the file on a
  running server with data in it.

## 3. Retention policy

| What | Kept | Where |
|---|---|---|
| Nightly backup (`-Tag nightly`, 02:00 IST) | 30 days, and never fewer than the newest 7 whatever their age | `BackupDir` on a second disk of the server |
| Before every update (`pre-update-<build>`, made by `update.ps1`) | same rule (they are ordinary backups) | same |
| Monthly copy (the first nightly backup of the month) | 12 months | copied off the server by the operator (NAS / company backup), not by the script |
| Vault root key copy | as long as any backup made with it exists (normally: for ever; the key changes only by a planned migration) | `KeyBackupDir` + the safe; never with the dumps |
| Configuration copy (`-IncludeConfig`: the env files with the services' secrets, `go2rtc.yaml`, `drishti.config.psd1`) | the last 3 copies; after every secret rotation | `KeyBackupDir\config-<time>`, Administrators only; never with the dumps |
| Credential-read log `vault_reads` | 180 days (the worker prunes it) | in the database |
| Audit (`admin_audit_log`, `auth_events`) | not pruned: append-only, kept in every backup | in the database |

`backup.ps1 -ApplyRetention` removes only folders it made itself (`<yyyyMMdd-HHmmss>-<tag>` with a `manifest.json`) that are older than
`Retention.Days` AND not among the newest `Retention.KeepAtLeast`; other folders are never touched (`tests/unit/windows-scripts.test.ts`).
A backup that has not been restored once is not a backup: rehearse a restore every month (section 6) and record it.

## 4. The nightly backup (scheduled task, on the production server only)

```powershell
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\Drishti\app\current\deploy\windows\backup.ps1 -ConfigPath C:\Drishti\config\drishti.config.psd1 -Tag nightly -ApplyRetention'
$t = New-ScheduledTaskTrigger -Daily -At 02:00
Register-ScheduledTask -TaskName 'Drishti nightly backup' -Action $a -Trigger $t -User 'SYSTEM' -RunLevel Highest
```

(Direct mode: the task needs the database password in its environment; use a dedicated backup account with the variable set for that
account, never in the task's arguments.) Check the next morning: a new folder, `manifest.json` with the expected counts, and the task's
last result 0.

## 5. Restore

### 5a. Rehearsal into a new database (safe at any time)

```powershell
.\restore.ps1 -BackupPath D:\DrishtiBackups\20261023-020000-nightly -TargetDatabase drishti_restore_test -CreateDatabase -DropAfterVerify -SourcePath C:\Drishti\app\current -ResultPath C:\Drishti\data\restore-proof.json
```

It refuses the live database, an existing database, a name that is not plain (`a-z`, `0-9`, `_`), and a dump whose SHA-256 differs
from its manifest. Every line of its output says what was checked; exit code 0 only when all passed.

### 5b. The real restore (the live database)

1. Announce downtime. `drishti-services.ps1 -Action Stop` (all four).
2. Make a backup of the current state first (`backup.ps1 -Tag before-restore`), even if it is damaged.
3. Check the server's Vault root key is the backup's: `restore.ps1` compares the SHA-256; on a new server put the saved key file in
   place (`/etc/postgresql-custom/pgsodium_root.key` in the container, or the mounted host folder) and restart the database before
   restoring.
4. `.\restore.ps1 -BackupPath <folder> -TargetDatabase postgres -AllowLiveDatabase -SourcePath C:\Drishti\app\current`. It runs
   `pg_restore --clean --if-exists` and then the same checks. **Unvalidated path** (section intro): if it reports problems, restore
   into a new database instead (5a without `-DropAfterVerify`) and point the stack at it, or rebuild the server and restore there.
5. If the migration level is below the release's ("migrations of this release are not applied yet"): `npx supabase migration up`
   (runbook `update-rollback.md`).
6. Start the services, open the Health page: every check "OK", especially "Vault" and "Database version".

## 6. Monthly rehearsal (record it)

Restore the newest nightly backup into a new database (5a) and keep the result file; once a quarter, on a spare server, a full restore
including the key file (5b on that server). Record date, backup, counts and verdicts in the tracker (SO-13).
