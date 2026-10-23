# P5.4 evidence: backup and restore in a disposable database

Run: 2026-10-23 05:37 IST on the development computer (Windows 11 Pro, PowerShell 5.1, local Supabase stack, PostgreSQL 17.11,
`supabase_vault` 0.3.1), by `tests/integration/backup-restore.test.ts` with `DRISHTI_EVIDENCE_DIR` set. Raw proof (counts and verdicts
only, no secret): [`backup-restore-proof.json`](backup-restore-proof.json).

What ran:

1. `deploy/windows/backup.ps1 -Tag restore-test` (Container mode, the local database container): one `REPEATABLE READ` transaction
   exported its snapshot; the row counts of 18 tables and `pg_dump -Fc --snapshot=<it>` both read that snapshot; the dump (8 MB) was
   copied out to a temporary folder with its manifest. The Vault root key never left the container (only its SHA-256 was recorded).
2. `deploy/windows/restore.ps1 -TargetDatabase drishti_restore_test -CreateDatabase -DropAfterVerify -SourcePath <checkout>`: dump
   SHA-256 checked, new database created, `pg_restore --exit-on-error` (no error), the checks below, the database dropped. 4.1 s.
3. Refusals (same test): the live database without `-AllowLiveDatabase`, a name that is not plain, a database that exists already
   (`template1`), a damaged dump (one byte changed: "SHA-256 differs"); nothing created, the live data unchanged.

| Table (in the dump's snapshot) | Backup | Restored | Equal |
|---|---|---|---|
| `public.organizations` | 122 | 122 | yes |
| `public.profiles` | 37 | 37 | yes |
| `public.regions` | 2 | 2 | yes |
| `public.clusters` | 3 | 3 | yes |
| `public.locations` | 240 | 240 | yes |
| `public.assets` | 240 | 240 | yes |
| `public.recorders` | 235 | 235 | yes |
| `public.cameras` | 4656 | 4656 | yes |
| `public.camera_channel_mappings` | 4656 | 4656 | yes |
| `public.access_grants` | 5707 | 5707 | yes |
| `public.camera_groups` | 2 | 2 | yes |
| `public.camera_group_items` | 33 | 33 | yes |
| `public.admin_audit_log` | 3127 | 3127 | yes |
| `public.auth_events` | 347 | 347 | yes |
| `public.vault_reads` | 1151 | 1151 | yes |
| `auth.users` | 37 | 37 | yes |
| `vault.secrets` | 224 | 224 | yes |
| `supabase_migrations.schema_migrations` | 43 | 43 | yes |

(The organisations and locations include test organisations of other builders' integration runs that were in the database at that
moment; the counts are of the snapshot, whatever it holds.)

| Check | Result |
|---|---|
| Migration level | restored `20261021000043` = backup `20261021000043` = the checkout's highest migration; nothing pending |
| Vault secrets | 224 of 224 decrypt in the restored database |
| Vault canary (`drishti_vault_canary`, migration 0041) | decrypts to its known text |
| Server's Vault root key | SHA-256 equal to the one recorded in the backup |
| Disposable database | dropped afterwards (`pg_database` has no `drishti_restore_test`) |

Why the Vault part matters: the dump holds only ciphertext; the root key (`/etc/postgresql-custom/pgsodium_root.key`, loaded through
`pgsodium.getkey_script`) is not in it. Here the restore ran on the same server, so the key was the same; on another server the key file
must be restored first (runbook `docs/drishti/runbooks/backup-restore.md` section 2).

Not proven here: a restore into the live database (`-AllowLiveDatabase`, `pg_restore --clean --if-exists`), a restore on another server
with the saved key file, the Direct (non-Docker) mode. See the runbook's section 6 for the rehearsal to do on a spare server.

Other P5.4 evidence in this folder: [`dry-runs.txt`](dry-runs.txt) (install `-WhatIf`, update `-DryRun`, the two roll-back plans).
