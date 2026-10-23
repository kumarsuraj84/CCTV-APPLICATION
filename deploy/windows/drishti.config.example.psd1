# CityKart Drishti: configuration of the Windows deployment scripts (P5.4). Copy to C:\Drishti\config\drishti.config.psd1 and adjust.
# A PowerShell data file: values only, no code. It holds NO secret: the database password is read from the environment variable named
# in Database.PasswordEnv (Direct mode) and each service's secrets are in its own env file under ConfigDir (made by
# `node scripts/gen-secrets.mjs --production --out-dir C:\Drishti\config`). Runbook: docs/drishti/runbooks/windows-services.md.
@{
  # Where releases, the service host and the per-service host files live (app\releases\<build>, app\current, bin, services).
  InstallRoot = 'C:\Drishti'
  # web.env, worker.env, gateway.env, go2rtc.env, go2rtc.yaml: each readable by its own service account and the Administrators only.
  ConfigDir   = 'C:\Drishti\config'
  DataDir     = 'C:\Drishti\data'
  # One folder per service (DrishtiWeb, DrishtiWorker, DrishtiGateway, DrishtiGo2rtc); each log rolls at LogMaxBytes, LogKeep kept.
  LogDir      = 'C:\Drishti\logs'
  LogMaxBytes = 10485760
  LogKeep     = 10
  BackupDir   = 'D:\DrishtiBackups'

  # Node.js 20 or later (the same major version the release was built with).
  NodeExe     = 'C:\Program Files\nodejs\node.exe'
  # go2rtc for Windows (amd64), the pinned version (1.9.9), downloaded with the owner's approval; its hash checked.
  Go2rtcExe   = 'C:\Drishti\go2rtc\go2rtc.exe'

  # Which services this computer runs (all four on a single server).
  Services    = @('DrishtiGo2rtc', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiWeb')
  # Optional: a named account per service instead of the default virtual account "NT SERVICE\<name>" (for example a gMSA in the domain:
  # 'CITYKART\svc-drishti-web$'). Leave out to use the virtual accounts (recommended: nothing to create, no password).
  # Accounts  = @{ DrishtiWeb = 'CITYKART\svc-drishti-web$' }

  HealthUrl        = 'http://127.0.0.1:3212/api/health'
  VersionUrl       = 'http://127.0.0.1:3212/api/version'
  GatewayHealthUrl = 'http://127.0.0.1:3412/g/health'
  HealthTimeoutSec = 180
  # Releases kept under app\releases after a good update (the current one and the ones before it, for a quick roll back).
  KeepReleases     = 3

  # The database server.
  #   Container: a Supabase stack in Docker on this computer (the local stack, or self-hosted Supabase): client tools run inside the
  #              database container as a superuser (supabase_admin), and the Vault root key is read from the container.
  #   Direct:    a PostgreSQL server reached over the network with the client tools of PgBin; the password comes from the environment
  #              variable named in PasswordEnv (set it in the session that runs the script; never write it here).
  Database = @{
    Mode      = 'Container'
    # Container mode: the database container and the superuser its client tools run as (no password: docker exec inside the container).
    Container = 'supabase_db_drishti'
    User      = 'supabase_admin'
    Name      = 'postgres'
    # Direct mode (all client tools) AND MigrationMode 'DbUrl' (in either mode): where the server listens and which account applies the
    # migrations. The password is NEVER here: it is read from the environment variable named in PasswordEnv and handed to each client
    # program as PGPASSWORD in its own environment only (never on a command line, review I-2).
    PgBin       = 'C:\Program Files\PostgreSQL\17\bin'
    Host        = '127.0.0.1'
    Port        = 5432
    MigrateUser = 'postgres'
    PasswordEnv = 'DRISHTI_DB_PASSWORD'
  }
  # Migrations (review M-13):
  #   'DbUrl' (self-hosted Supabase in Docker, or Direct mode): npx supabase migration up --db-url postgresql://<MigrateUser>@<Host>:<Port>/<Name>
  #           with the password from PasswordEnv as PGPASSWORD of that one program. Set $env:DRISHTI_DB_PASSWORD in the session first.
  #   'Local' (only the Supabase CLI's own local stack, a test server): npx supabase migration up --local; no password needed.
  MigrationMode = 'DbUrl'

  # The Vault root key (supabase_vault: every NVR password is encrypted with keys derived from it; a dump holds the ciphertext only).
  #   ContainerFile: copy it from the database container (Path inside the container).
  #   File:          copy it from this computer (self-hosted Postgres with the key file on disk).
  #   None:          not reachable from here (a hosted project: the platform keeps it; restore only into the same project).
  VaultKey = @{
    Mode = 'ContainerFile'
    Path = '/etc/postgresql-custom/pgsodium_root.key'
    # Where the copy goes: NOT the backup folder of the dumps, nor inside it (refused; review M-8); created Administrators-only before
    # anything is copied. A second disk of the server is a first step only: the off-server copy must be ENCRYPTED (the key and the
    # dumps both: the dumps hold the GoTrue two-step secrets and refresh tokens too) and kept apart from the dumps.
    KeyBackupDir = 'E:\DrishtiKeys'
  }

  # Backups: every night (scheduled task, runbook backup-restore.md) and before every update. Kept RetentionDays, never fewer than
  # KeepAtLeast (the newest ones), whatever their age.
  Retention = @{ Days = 30; KeepAtLeast = 7 }
}
