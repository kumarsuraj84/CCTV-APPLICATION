# Drishti endpoint telemetry (read-only collector, WP-6.2a)

The collector is `agent/windows/collector/Collect-DrishtiInventory.ps1`. It describes one Windows PC as one JSON document. The document is described by `docs/drishti/agent-telemetry-schema.json` (JSON Schema draft-07, schema version `1.0`). This package is collection only: it makes no network call, takes no command, and has no enrolment. Transport, enrolment and signed commands belong to WP-6.1 and phase 7 (decision D-9: PowerShell 5.1 agent, asymmetric command signing later).

## What the collector guarantees

- **Read only.** It never changes the machine. The static scan in `tests/unit/agent-collect.test.ts` allows only an allow-list of read commands, rejects every `Set-`, `New-`, `Remove-`, `Start-`, `Stop-`, `Restart-`, `Register-`, `Install-`, `Enable-`, `Disable-`, `Add-`, `Out-`, `Invoke-` command, and checks that the only file write is the caller's `-OutFile`.
- **No network.** No web, DNS, ping, mail or remote-management call. Windows Update data is read from the local Windows Update Agent with `Online = false`, which never contacts a server.
- **Honest gaps.** A value that cannot be read is `unavailable` (or `null` for plain text) and the reason is listed in `collection.items`. Nothing is guessed or filled with a healthy-looking default.
- **One section failing never stops the rest.** Each section runs in its own guard; a failed section is `null` with an `error` entry.
- **Bounded output.** Text is at most 256 characters, control characters are replaced by spaces, the software list holds at most 2,000 entries, hotfixes at most 200. The text is pure ASCII (non-ASCII characters are written as `\uXXXX`), so any console encoding is safe.
- **Culture independent.** Numbers and dates are formatted with the invariant culture. Times are UTC ISO 8601 (`2026-10-22T04:28:45Z`); install dates of applications and hotfixes are plain days (`2026-10-21`).

## Running it

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File Collect-DrishtiInventory.ps1 [options]
```

| Option | Meaning |
|---|---|
| `-Sections host,os,...` | Only these sections (`host os hardware network software services security updates metrics`). Others are absent from the document and from `collection.items`. Unknown name: exit 2. |
| `-OutFile path.json` | Write the document there instead of the console. The name must end in `.json` and the folder must already exist (the collector never creates folders). Checked before collecting; refused with exit 2. |
| `-Quiet` | Print nothing on success. |
| `-SelfTest` | Collect, check the document against the built-in rules, print one line (`SELFTEST: PASS (n checks)` or the names of failed checks). Never prints machine data. Exit 0 pass, 1 fail. |
| `-Redact` | Replace computer name, domain or workgroup name, serial numbers, UUID, MAC addresses and user names with salted hashes (`host-3f2a...`, `sn-...`, `mac-...`, `uuid-...`, `dom-...`, `user-...`). The same machine gives the same hashes on every run, so two files can be compared. `redacted` is `true`. Names and serials that turn up inside other text (for example a software name) are replaced too. |
| `-RedactSalt` | Salt for `-Redact`. The default is public, so use a private salt when a guessable name must not be reproducible. |
| `-RequiredServices a,b` | Replace the default service list. |
| `-SimulateFailure section` | Test hook: make that section fail. |
| `-Pretty` | Indent the JSON. |

Exit codes: 0 ok, 1 self test failed, 2 bad argument or `-OutFile` refused, 3 unexpected failure.

## Fields

`collection.items` has one line for each requested section (`status` is `ok`, `unavailable` or `error`) and extra lines named `section.part` for a single datum that could not be read (for example `security.bitlocker`) or that carries a caveat. Every line that is not `ok` has a reason.

| Section | Fields and source |
|---|---|
| `host` | `computer_name`, `domain_or_workgroup`, `join_type` (`domain`, `workgroup`, `azure_ad`, `unknown`), `azure_ad_joined`, `form_factor` (`desktop`, `laptop`, `server`, `unknown`, from chassis type and server role), `manufacturer`, `model`, `serial_number`, `bios_serial`, `bios_version`, `uuid`. Sources: Win32_ComputerSystem, Win32_BIOS, Win32_ComputerSystemProduct, Win32_SystemEnclosure, the CloudDomainJoin registry key. Placeholder serials ("To be filled by O.E.M.", repeated characters, all-zero UUID) are `null` with an `unavailable` note `host.serial_number`. |
| `os` | `caption`, `version`, `build` (`BuildNumber.UBR`, for example `26200.9711`), `display_version` (24H2/25H2), `edition`, `architecture`, `install_date`, `activation_state` (`licensed`, `unlicensed`, `grace_oob`, `grace_oot`, `grace_non_genuine`, `notification`, `grace_extended`, `unavailable`), `last_boot_utc`, `uptime_s`. With Fast Startup the boot time is that of the last kernel start, not the last power-on. |
| `hardware` | `cpu_name`, `cpu_cores`, `cpu_logical` (all sockets), `ram_total_mb`, `disks` (fixed local drives: `drive`, `label`, `fs`, `size_gb`, `free_gb`, `smart_status`), `gpu` (`name`, `driver_version`, `adapter_ram_mb`; the 32-bit WMI field caps at 4 GB), `macs` (physical adapters). `smart_status` is Windows' storage health summary (`healthy`, `warning`, `unhealthy`) from the storage subsystem, not raw SMART attributes; it is `unavailable` where the drive is not exposed. |
| `network` | Per connection (up to 32): `adapter` (the name shown in Network Connections), `status` (`connected`, `media_disconnected`, `disconnected`, ...), `link_speed_mbps`, `dhcp`, `ipv4`, `gateway`, `dns`. IPv4 only. |
| `software` | `name`, `version`, `publisher`, `install_date`, `scope` (`machine` or `user`). From the Uninstall registry keys: 64-bit and WOW6432Node views of HKLM, and the loaded per-user hives. Updates and hotfixes (`ParentKeyName`, `ReleaseType`, "Update for ... (KBnnn)") and entries marked `SystemComponent=1` are left out. Duplicates (same name and version) are merged. `Win32_Product` is never used (it can trigger MSI repairs). |
| `services` | `required`: for each requested service `name`, `display_name`, `status` (`running`, `stopped`, ..., `not_installed`), `start_type` (`automatic`, `automatic_delayed`, `manual`, `disabled`, `unavailable`). Default list: `wuauserv` (Windows Update), `WinDefend`, `mpssvc` (Windows Firewall), `W32Time`, `Spooler`, `RpcSs`, `Dhcp`, `Dnscache`, plus `DrishtiAgent` or `CityKartAgent` only when installed. `WinDefend` normally shows `stopped` and `manual` when another antivirus is active; that is a fact, not a fault. |
| `security.antivirus` | List of `{name, state, signature_last_updated_utc}`. First choice Windows Security Center (`root/SecurityCenter2`, client Windows only), else Defender through `Get-MpComputerStatus` (state `on_up_to_date`, `on_out_of_date` = signatures older than 7 days, `off`), else the literal `unavailable`. States from Security Center: `on_up_to_date`, `on_out_of_date`, `off`, `snoozed`, `expired`, `unknown`. |
| `security.firewall_profiles` | `domain`, `private`, `public` with `enabled` (effective policy, `ActiveStore`), or `unavailable`. |
| `security.bitlocker` | `system_drive`: `protected`, `off`, `unavailable`. See the elevation table: only an elevated or SYSTEM run can report `off`. |
| `security.tpm` | `{present, version}` or `unavailable`. |
| `security.secure_boot` | `on`, `off` (read from the SecureBoot registry state), `unsupported` (the PC started in legacy BIOS mode), `unavailable` (UEFI but the state is not readable). |
| `updates` | `pending_reboot` (true if any source is set) with `pending_reboot_sources` (`component_servicing`, `windows_update`, `file_rename` = PendingFileRenameOperations, `update_exe`), `last_install_utc` (newest successful install in the Windows Update history; falls back to the newest hotfix day), `last_scan_utc` (last successful Windows Update search), `pending_count` (integer, or `unavailable`), `hotfixes` (`id`, `installed_on`, newest first, at most 200). `file_rename` is set by many installers and is the noisiest indicator. `pending_count` comes from the local update cache (offline); it is only reported when a successful scan is on record, and reflects that scan, not the live Microsoft catalogue. |
| `metrics` | `cpu_pct` (mean of three one-second samples from the raw processor counters, language independent), `cpu_samples`, `ram_used_pct`, `ram_used_mb`, `disks` (`drive`, `free_pct`). |
| `collection` | `duration_ms`, `privilege` (`standard`, `elevated`, `system`), `powershell_version`, `items`. |

## What needs elevation or SYSTEM

| Datum | Standard user | Elevated administrator or SYSTEM |
|---|---|---|
| host, os, hardware, network, services, software (machine), firewall, antivirus, secure boot, pending reboot, hotfixes, update history, metrics | read | read |
| BitLocker `system_drive` | `protected` only when the Explorer shell property reports it; anything else is `unavailable` with the property code in the reason (the code for "off" is not yet verified on a lab machine) | read from the volume encryption provider: `protected` or `off` |
| TPM | read from the device list: `present` and `version`; "ready/enabled" is not read; a TPM disabled in firmware is not listed | read from `Win32_Tpm` |
| Per-user software of users who are not signed in | not included | not included either (see below) |

Asking the elevated-only providers as a standard user costs about five seconds per refusal, so the collector skips them when it knows it is not elevated.

## Running as SYSTEM: per-user settings

The agent will run as SYSTEM. Two consequences are built into the collector:

1. **`HKCU` is SYSTEM's own hive, not the signed-in user's.** The collector therefore never uses `HKCU`. For per-user software it reads, read-only, the hives that are already loaded under `HKEY_USERS` (one `S-1-5-21-...` hive per signed-in user; as SYSTEM that is every signed-in user, as a standard user it is only the caller). It never loads a hive from disk (`reg load` writes to the registry), so applications installed only for a user who is not signed in are not listed. `software.per_user` states how many hives were read.
2. **Per-user desktop settings (wallpaper, screensaver, shell) are out of scope for collection** and are handled by phase 7 (RM-11), which must act in the user's session or in a loaded hive.

## Domain versus workgroup

- **Domain-joined:** `join_type` is `domain` and `domain_or_workgroup` is the DNS domain. Group policy can change firewall, update and BitLocker behaviour; the values reported are the effective ones. A hybrid Entra (Azure AD) join that is also domain-joined is reported as `domain` with `azure_ad_joined: true`.
- **Workgroup:** `join_type` is `workgroup` and `domain_or_workgroup` is the workgroup name. There is no central policy; local settings are reported as they are.
- **Entra-only:** `join_type` is `azure_ad` (CloudDomainJoin information present, not domain joined).
- `unknown` means the computer system record could not be read.

Domain-joined behaviour has not been run yet (the development PC is a workgroup machine). See the tracker rows.

## `unavailable`, `unsupported`, `error`

- **`unavailable`**: the datum exists in principle, but this run could not read it (access denied, provider missing on this edition, no scan on record, timeout). The reason says what would change it (for example "needs an elevation or a SYSTEM token").
- **`unsupported`**: the machine cannot have the feature. Only used for `secure_boot` on legacy BIOS. It is a real answer, not a gap.
- **`error`** (section status only): the section's code raised an unexpected exception; the section value is `null`. This is a collector defect or an unusual machine and should be reported.
- `null` in a text field means "not reported by the machine"; it never means healthy.
- A downstream health display must treat `unavailable` and `null` as "unknown", never as passing (directive: unsupported checks never show fabricated healthy values).

## Size and time budget

Measured on the development PC (Windows 11 Pro 25H2, standard user, 68 listed applications, one network connection):

| | Result |
|---|---|
| Duration, all sections | about 9 s (`collection.duration_ms` 9,000); slowest parts are the three processor samples (3 s), the Windows licensing query, Windows Update history and cache search |
| JSON size, all sections, compact | about 14 KB; software about 9.7 KB (about 140 bytes per application) |
| Health subset (`network`, `services`, `security`, `updates` without hotfixes, `metrics`, `collection`) | about 2.5 KB |

Targets: typical under 5 s on a normal office PC, worst case under 20 s. The worst case is bounded: the Windows Update history read is cut off after 5 s and the cache search after 6 s; every other source is a local query. The target of under 5 s typical is **not** met on the development PC (9 s) and is not yet measured on office hardware: the processor sampling alone takes 3 s by definition. Treat 10 s as the planning figure until the lab run. A document with the maximum 2,000 applications is about 290 KB.

## Planned check-in cadence and payload estimates (1,000 endpoints, planning only)

Nothing below is built; the transport is WP-6.1 and the hub tables are P2/P6 work. The figures use the measured sizes above.

| Message | Cadence | Content | Size | Load for 1,000 PCs |
|---|---|---|---|---|
| Health check-in | every 5 minutes with up to 60 s of jitter | `metrics`, `services`, `security`, `updates` (no hotfix list), `network` summary | about 2.5 KB (about 0.8 KB gzipped) | 12 per hour per PC, 12,000 per hour, about 3.3 requests per second, about 30 MB per hour, about 700 MB per day raw (about 200 MB gzipped) |
| Full inventory | once a day (jittered) and after boot or on request | all sections | 15 to 30 KB typical, 290 KB worst (about 3 to 6 KB gzipped typical) | about 25 MB per day |
| Software list | only when its hash changed | `software` | about 10 to 25 KB | small after the first day |

Collection itself costs about 10 s of CPU-light work per run (CIM queries and a 3 s sampling wait), so the health check-in should use a lighter section set than the daily inventory (no software, no hotfix list, no WU search): `-Sections` supports this. Storage: if a health row is about 200 bytes after normalisation, 1,000 PCs at 5-minute cadence is about 288,000 rows a day and about 8.6 million rows in 30 days, so raw rows should be rolled up to hourly aggregates after a few days (the Plan 6 retention of 30 days raw and 400 days hourly stands). The hub must accept a single missed check-in without alarm and mark an endpoint stale after a configured number of missed intervals; the threshold is a decision for WP-6.1 and the monitoring work (the 20-minute "Not checked lately" ruling for cameras is not automatically the endpoint rule).

## Validation status

Run locally on one workgroup PC as a standard user (see the tracker rows EA-2 and MC-11 and the evidence log). Awaiting lab validation: domain-joined machines, elevated and SYSTEM runs (BitLocker, TPM, per-user hives of all signed-in users), a server SKU (no Security Center), Windows 10, a laptop, a machine with BitLocker on, and the timing on office hardware.
