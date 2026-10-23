# Runbook: backup, restore and the Vault root key (P5.4)

Applies to: the production database of CityKart Drishti (Supabase / PostgreSQL 17) and its Vault. Scripts: `deploy/windows/backup.ps1`,
`deploy/windows/restore.ps1` (both with `-DryRun` / `-WhatIf`). Written 2026-10-23 with P5.4.

**Verification status (honest).** Proven on the development computer, in a disposable database: `tests/integration/backup-restore.test.ts`
dumps the local database (read only) and restores it into a NEW database `drishti_restore_test` on the same server, then compares the
row counts of 18 key tables (all equal), the migration level (equal to the backup and to this checkout's highest migration), decrypts
every Vault secret (224 of 224) and the canary secret, and compares the SHA-256 of the server's Vault root key with the one in the
backup; the copy is dropped afterwards. Evidence: `docs/drishti/evidence/p5/backup-restore.md` and `backup-restore-proof.json`.
**Fix round 1 (review I-1).** The live restore no longer runs `pg_restore --clean` on the live database (that fails on a Supabase
database anyway: realtime's partitioned tables). It restores into a new database, proves it, and swaps the two by renaming (section
5b). That path is tested end to end on a disposable "live" database `drishti_restore_live` of the local server: swapped, counts back,
the database it replaced kept with a row written after the backup, a `before-restore` backup made first; and a forged manifest refused
with the live database unchanged and no copy left.
**Not exercised:** that path against the real live database (it would replace the owner's data), a restore onto another server with a
restored key file, and the Direct (non-Docker) mode of the scripts. Rehearse them on a copy of the server before relying on them
(section 6).

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
  password): `backup.ps1 -IncludeVaultKey` copies it to `VaultKey.KeyBackupDir` (in production a different disk or an encrypted
  removable medium kept by the owner, plus a sealed paper copy of the 64 characters in the safe). backup.ps1 refuses a `KeyBackupDir`
  that is `BackupDir` or inside it (or the other way round), and locks the folder (SYSTEM and Administrators only) BEFORE it copies the
  key or the configuration into it. Every manifest records the key's SHA-256 even without a copy, and `restore.ps1` compares it with
  the server it restores on.
- **Copies off the server must be encrypted** (review M-8): the key file, the configuration copies AND the dumps. A dump holds the
  sign-in system's two-step secrets and refresh tokens, not only the NVR ciphertext. Use an encrypted medium or an encrypted archive
  whose password the owner keeps apart.
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

`backup.ps1 -ApplyRetention` (or `-RetentionOnly`, without a new backup) removes only folders it made itself that are older than
`Retention.Days` AND not among the newest `Retention.KeepAtLeast`; other folders are never touched. "Made itself" means all of: a name
`<yyyyMMdd-HHmmss>-<tag>`, a `manifest.json` whose `kind` is `drishti-backup`, not a junction or link, and nothing inside that is a
junction or link (such a folder is kept and named in the output; the walk never follows a link). Retention runs as SYSTEM, so it
refuses to run at all while `BackupDir` may be written by anyone but SYSTEM and the Administrators (review I-6). Tested with a real
junction planted in a backup folder, pointing at a folder that must survive (`tests/unit/windows-scripts.test.ts`).
A backup that has not been restored once is not a backup: rehearse a restore every month (section 6) and record it.

## 4. The nightly backup (scheduled task, on the production server only)

```powershell
# C:\Drishti\scripts is the administrators-only copy the install and every update keep current (never a folder users can write to:
# the task runs as SYSTEM).
# Windows PowerShell by its full path (re-review M-new-6: never a powershell.exe found on PATH).
$a = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\Drishti\scripts\backup.ps1 -ConfigPath C:\Drishti\config\drishti.config.psd1 -Tag nightly -ApplyRetention'
$t = New-ScheduledTaskTrigger -Daily -At 02:00
Register-ScheduledTask -TaskName 'Drishti nightly backup' -Action $a -Trigger $t -User 'SYSTEM' -RunLevel Highest
```

(Direct mode: the task needs the database password in its environment; use a dedicated backup account with the variable set for that
account, never in the task's arguments.) Check the next morning: a new folder, `manifest.json` with the expected counts, and the task's
last result 0.

Fix round 2 (re-review M-new-8): a backup also refuses a `BackupDir` that anybody but SYSTEM, the Administrators and the web app's
free-space entry may write or read, and it refuses a dated backup folder that exists already (the names are predictable: one that is
there was not made by this run). Both say `Run drishti-services.ps1 -Action RepairAcl` or what to look at.

## 5. Restore

### 5a. Rehearsal into a new database (safe at any time)

```powershell
.\restore.ps1 -BackupPath D:\DrishtiBackups\20261023-020000-nightly -TargetDatabase drishti_restore_test -CreateDatabase -DropAfterVerify -SourcePath C:\Drishti\app\current -ResultPath C:\Drishti\data\restore-proof.json
```

It refuses the live database, an existing database, a name that is not plain (`a-z`, `0-9`, `_`), and a dump whose SHA-256 differs
from its manifest. Every line of its output says what was checked; exit code 0 only when all passed.

### 5b. The real restore (the live database)

1. Announce downtime. `drishti-services.ps1 -Action Stop` (all four; restore.ps1 refuses while any Drishti service runs).
2. Check the server's Vault root key is the backup's: `restore.ps1` compares the SHA-256; on a new server put the saved key file in
   place (`/etc/postgresql-custom/pgsodium_root.key` in the container, or the mounted host folder) and restart the database before
   restoring.
3. `C:\Drishti\scripts\restore.ps1 -BackupPath <folder> -TargetDatabase postgres -AllowLiveDatabase -PreRestoreBackup -SourcePath C:\Drishti\app\current`.
   It holds the update lock, and then:
   - `-PreRestoreBackup`: a backup of the current state first (`before-restore`), even if it is damaged;
   - restores into a new database `postgres_restored_<time>` (from `template0`, connected through `template1`), stopping at the first
     `pg_restore` error;
   - proves the copy: the dump's SHA-256, row counts equal to the manifest, the migration level, every Vault secret and the canary, the
     root key hash;
   - only when every check passed: gives the copy the live database's owner, rights and settings, closes the connections and renames
     `postgres` to `postgres_before_restore_<time>` and the copy to `postgres`. The replaced database is kept (drop it yourself once the
     restored one is known good); its connections are allowed again so you can read from it.
   - when anything fails before the swap: "the live database postgres was NOT changed", the unused copy is dropped, exit code 1.
   - the swap itself is four steps (close the live database to new connections, end its sessions and wait for them, rename it, rename
     the copy), each recorded (re-review M-new-3). A failure part way never says "NOT changed"; it says STOPPED and exactly where:
     closed but not renamed: it is opened again ("open again; its data was not changed"), or, if that fails, "still REFUSES
     CONNECTIONS" with the statement to run; renamed but the copy not yet in its place: the old one is put back under its name ("put
     back … accepts connections again"), or, if that fails, "THERE IS NO DATABASE NAMED postgres NOW" with both names and the
     statements. Once the live database has been renamed, the restored copy is never dropped. The result file says `swapState`
     (`not started`, `reopened`, `closed`, `put back`, `no live database`, `swapped`). Tested by making the swap fail on purpose after
     each of the first two steps on the disposable "live" database (`-SimulateSwapFailure`, refused for any other database).
4. If the migration level is below the release's ("migrations of this release are not applied yet"): `npx supabase migration up`
   (runbook `update-rollback.md`).
5. Start the services, open the Health page: every check "OK", especially "Vault" and "Database version".

The swap needs room for a second copy of the database on the database's disk (about 3 times the dump size). The swap ends every
connection to the live database, including those of the Supabase services (PostgREST, GoTrue, Realtime, the database's own background
jobs). Whether each reconnects by itself is **not tested**: after step 3, restart the Supabase stack's containers other than the
database (`docker restart` of each, or `docker compose restart`) before step 5.

## 6. Monthly rehearsal (record it)

Restore the newest nightly backup into a new database (5a) and keep the result file; once a quarter, on a spare server, a full restore
including the key file (5b on that server). Record date, backup, counts and verdicts in the tracker (SO-13).
