# CityKart Drishti — NETGEAR Wi-Fi AP capability research (documentation only)

Status: research input for decisions W-1…W-6 and requirement supplement §B/§C. Read date for every source below: **2026-10-22** (one research session). Nothing here is lab-validated. Every cell is documentation evidence only; per W-2/W-6 every operation remains `unverified` for CityKart's real devices until the first hardware pilot.

---

## 1. Scope and method

**Estate (as known):** ~10 NETGEAR APs at head office, 4–5 per store, several models (WAX615 mentioned), management addresses reachable over SD-WAN from HO. **Real models, firmware versions and management mode are NOT known** — nothing in this document assumes them.

**Questions answered per model group and management mode:** (1) inventory retrieval, (2) health/client metrics, (3) configuration read, (4) SSID/security, (5) MAC access lists, (6) radio settings, (7) backup/restore, (8) firmware upgrade, (9) reboot, (10) management interfaces, (11) management-mode change implications, (12) firmware versions where interface support changed.

**Method**
- Official NETGEAR sources only: netgear.com product/Insight pages, data sheets and user manuals on downloads.netgear.com, kb.netgear.com release notes and articles. Forum/third-party material is listed separately (§8) and not relied on.
- No login, no scan, no NETGEAR account, no firmware or MIB download, nothing installed. PDFs that the fetch tool cached automatically (under 10 MB) were converted to text locally for reading; nothing else was downloaded.
- A cell is **S** (Supported) only if an official source that was actually read states it for that model (or model family named in the source) and mode. **N** (Not supported) only if an official source states absence/removal. Everything else is **U** (Unverified). Features documented for one model are **not** carried over to another model, even within the same family; where a sibling source exists it is cited as "family reference" and the cell stays U.
- Sources only seen as search-engine excerpts (page fetch returned empty, or PDF over the 10 MB fetch limit) are tagged **[index-only]** and can only produce U ("lead").

**Legend used in the tables**

| Mark | Meaning |
|---|---|
| S | Supported — official source read, applies to this model/mode |
| N | Not supported — official source states it is absent/removed |
| U | Unverified — no official source read for this exact model/mode (may cite a lead) |
| SA | Standalone ("Web-browser" / local) mode, local web UI and on-box protocols |
| HY | Insight-managed device accessed through its own local web UI ("hybrid" / limited local UI) |
| IA | NETGEAR Insight mobile app |
| IC | Insight Cloud Portal (historically Insight Premium/Pro subscription; Insight 10.0 = single paid tier, see §4.4) |

Source IDs (S1…, I1…) are resolved in §9 with URL and read date.

### 1.1 What could not be accessed (be explicit)
- **WAX615 user manual** (current rev. 202-12568-10, Jan 2026), and the WAX620, WAX630, WAX618 and WBE750 manuals: each exceeds the 10 MB fetch limit. Downloading them would be a file download needing explicit owner permission, so only their search-index excerpts (table of contents / revision lines) were seen. **This is the single largest gap**: the WAX615 standalone (local UI) cells are therefore mostly U.
- **WAX610 manual**: the URL served the *first publication* (202-12098-01, July 2020, firmware 9.0.0.x screenshots). It was read in full but is old; later revisions may differ.
- **NETGEAR support/download pages** (support.netgear.com/support/product/…) are JavaScript-rendered and returned empty; MIB availability is known only from search excerpts.
- Several kb.netgear.com articles (000048439, 000060933, 000059566, 000060541) returned empty pages; only their search excerpts were seen.
- **Insight partner REST API documentation**: not found on any public NETGEAR page.
- MIB files themselves (OIDs, writable objects): not downloaded, not read.

---

## 2. Capability matrices

Each cell: mark — *how* (UI / protocol) — source. "Capability" notes in the first column are mode-independent hardware/feature statements (e.g. data sheet) that do not by themselves prove a mode-specific procedure.

### 2.1 Group A — WAX615 / WAX615PA (WiFi 6, AX3000, the model named by the owner)

Capability notes (mode not stated by source): 8 SSIDs, WPA/WPA2/WPA3 and WPA3-Enterprise, VLAN, MAC address filtering, adjustable transmit power, 5 GHz 160 MHz, "Insight or Standalone" remote management, 1-year Insight subscription included (S1 data sheet D-WAX615_30Jan23; S2 product page).

| # | Operation | SA (standalone local UI) | HY (Insight-managed, local UI) | IA (Insight app) | IC (Insight Cloud Portal) |
|---|---|---|---|---|---|
| 1 | Inventory retrieval (model, serial, MAC, firmware) | U — local Dashboard exists (S4 known issue mentions it) but fields not read for WAX615; S3 [index-only] | U | S — UI; app device page shows model, MAC, uptime, firmware (S1 screenshot) | S — UI device list/health (S21, S22); machine-readable export U |
| 2 | Health and client metrics | U (S3 not read) | U | S — UI; client name/MAC/IP/RSSI/channel/SSID, usage (S1 screenshots) | S — UI; device health, client tracking, usage history (S21) |
| 3 | Configuration read | U | U | U | S — UI only (S22); programmatic read U (partner API undocumented, S23) |
| 4 | SSID / security config | U (capability S1) | U | U | S — UI; SSID changes pushed on save; device groups apply SSID/VLAN (S22) |
| 5 | MAC access lists | U — MAC ACL exists (S4 known issue on RADIUS-based MAC ACL with MPSK/DVLAN; capability S1) but local procedure not read | U | U | U — Insight 7.6.2 added MAC/IP traffic filters in custom ACLs for "several WAX" models, list not given (S23); SSID MAC ACL KB lead I5 |
| 6 | Radio settings (band, channel, width, power, auto) | U (capability S1) | U | U | S — device groups include radio configuration (S22); Insight options for DTIM/beacon/broadcast rate limits and separate 802.11k/v toggles from FW 10.8.6.3 (S4) |
| 7 | Backup / restore | U (S3 not read) | U | U — lead I4 | U — leads conflict: device backup up to three copies, wireless/VLAN excluded (I4) vs. 2018 portal manual: restore not available for APs (I8) |
| 8 | Firmware upgrade | U (S3 not read) | U | U | S — immediate, scheduled, batch, device-group; choose latest or two previous versions (S22). Downgrade while in Insight mode supported from 11.8.0.9 (S6) |
| 9 | Reboot | U (S3 not read; reset-button restart ≥ 10 s = factory reset per S3 [index-only]) | U | U | S — single, multiple, scheduled (S22) |
| 10 | Management interfaces | see §3.1 | see §3.1 | — | see §4 |
| 11 | Mode change implications | U for WAX615 — S3 [index-only] says the Insight network password keeps replacing the admin password after switching back to Web-browser mode; S6 known issue: after switching standalone⇄Insight the configured channel may not take effect (restart AP). Family reference (WAX610 S9, WAC510 S19): Web→Insight **clears configuration** except IP, AP name, local password, and reboots. Treat as expected until lab-proven. | | | |
| 12 | Version changes | 10.8.12.7: SNMP model-ID fix (S5) · 11.8.0.9: firmware downgrade in Insight mode; mode-switch channel issue (S6) · 12.5.0.14 (21 Jan 2026): SNMPv3 added (S7) · 12.8.0.6 (23 Apr 2026): SNMPv2 backward compatibility (S8). Manual rev 202-12568-09 (Dec 2025) added SNMPv3 configuration (S3 [index-only]) | | | |

### 2.2 Group B — other Insight-managed WiFi 6/6E: WAX610 / WAX610Y, WAX620, WAX630

Only the WAX610 has a manual that was read (S9, July 2020, firmware 9.0.x). WAX620/WAX630 rows are release-note evidence only. Capability notes (S1 comparison table, mode not stated): WAX610/620/630/630E all list MAC filtering, VLAN, WPA3, "Insight App" centralized management.

**B1 — WAX610 (S9 manual; WAX610Y covered only by release notes S10–S12)**

| # | Operation | SA | HY | IA | IC |
|---|---|---|---|---|---|
| 1 | Inventory | S — UI: system name, LAN/radio MACs, serial, current and backup firmware, bootloader, uptime, power source, LLDP neighbour (S9 p.168–174) | U | U | U (Insight generic S21/S22 not model-specific) |
| 2 | Health/client metrics | S — UI: per-radio clients (max 200), client MAC/IP/host/OS, RSSI, Tx/Rx rate and bytes, channel utilisation, traffic/ARP stats, neighbour APs, alarms (S9 p.171–187) | U | U | U |
| 3 | Config read | S — UI only; no documented export other than encrypted backup (S9) | U | U | U |
| 4 | SSID/security | S — UI: 8 SSIDs; Open/Enhanced Open, WPA2/WPA3 Personal, WPA2 Enterprise; schedule; client isolation; VLAN per SSID; PMF; band steering (S9 p.49–76) | U — S9 p.9: Insight-manageable settings are masked in local UI | U | U |
| 5 | MAC ACL | S — UI: 8 local MAC ACLs × 256 MACs, allow/deny policy, import .txt/.cfg list, per-SSID selection, or RADIUS MAC ACL (not with WPA2-Enterprise) (S9 p.73, 111–118) | U | U | U |
| 6 | Radio | S — UI: radio on/off, WiFi mode, width (default dynamic), guard interval, output power 100/50/25/12.5/4 %, channel (default Auto); apply restarts radio(s) and clients may reconnect (S9 p.77–90, 193–206) | U | U | U |
| 7 | Backup/restore | S — UI: backup is password-protected binary .tar; restore reboots (~2 min) (S9 p.155–158) | U | U | U |
| 8 | Firmware upgrade | S — UI: online check, manual upload, SFTP pull; dual image with "revert to backup firmware"; **downgrade/revert to older firmware clears configuration** except IP, name, local password (S9 p.149–155) | U | U | U |
| 9 | Reboot | S — UI reboot and recurring scheduled reboot (S9 p.158–160) | U | U | U |
| 11 | Mode change | S — Web→Insight clears config except IP, AP name, local password; AP restarts with default SSID; Insight→Web keeps Insight network password as admin password; factory-reset button disabled until AP is removed from Insight location; in Insight mode only a basic, limited local UI (S9 p.14, 22, 141–142, 161) | | | |

**B2 — WAX610Y, WAX620, WAX630**: rows 1–9 are **U** for all modes (no manual read). Interface changes only, see §3.2 and §5.

### 2.3 Group C — WiFi 7: WBE750 / WBE758 (and WBE710 / WBE718)

No manual or data sheet read (WBE750 manual rev 202-12966-01, July 2026, has SNMP v1/v2c/v3 sections per I6 [index-only]).

| # | Operation | SA | HY | IA | IC |
|---|---|---|---|---|---|
| 1–4, 7, 9 | — | U | U | U | U (Insight generic S22) |
| 5 | MAC ACL | U | U | U | U — Insight 7.6.2 custom ACL MAC/IP filters for WBE700 series (S23; model list not given) |
| 6 | Radio | U | U | U | U — Insight 7.6.6 added channel support for WBE710/718/750/758 (S23); 12.5.0.22 fixed Insight↔AP channel mismatch after onboarding (S15) |
| 8 | Firmware | U | U | U | S — Insight generic (S22) |
| 12 | Versions | 12.5.0.22 (21 Jan 2026): SNMPv3 added (S15) · 12.8.0.7 (22 Apr 2026): SNMPv2 backward compatibility (S16) · WBE710/718 12.8.0.7 same (S17) | | | |

### 2.4 Group D — WAX214 / WAX218 (described by NETGEAR as standalone APs)

Source S18 (manual 202-12175-02, Jan 2022). The manual calls the WAX214 a standalone AP; the Insight app is used for discovery/registration only. A "Management Mode" section exists on the Advanced page but its contents were not described → Insight management **U**. Search excerpt (I7) indicates the WAX214 support page is marked end-of-life — unverified.

| # | Operation | SA | HY / IA / IC |
|---|---|---|---|
| 1 | Inventory | S — UI Device Status page (S18) | U |
| 2 | Health/client metrics | S — UI; default 64 clients/radio, client list and kick/block (S18) | U |
| 4 | SSID/security | S — UI (S18) | U |
| 5 | MAC ACL | S — UI per SSID; "Deny MAC in the List" / "Allow MAC in the List", default disabled (S18, MAC address filter section) | U |
| 6 | Radio | S — UI: channel(s), channel width (HT mode), transmit power with "Auto RF" default or fixed dBm, minimum bit rate, client limits (S18 p.63–70) | U |
| 7 | Backup/restore | S — UI export .tar.gz / restore (S18 p.93–94) | U |
| 8 | Firmware | S — UI local file upload only (S18 p.90) | U |
| 9 | Reboot | S — UI + Auto Reboot schedule (S18 p.91–92) | U |
| 10 | Interfaces | SNMP v1/v2c and v3 (see §3.3); remote syslog host (S18); NTP server setting (S18); email alerts via SMTP (S18) | U |

### 2.5 Group E — legacy WAC510 (WAC505, WAC104 not documented here)

WAC510 source S19 (manual 202-11840-10, Sept 2022; relevant sections read). **WAC505 and WAC104: all U** (no source read; I3 lead says Hybrid Management Mode applies to WAC505/WAC510/WAC540 from firmware 5.0.0.17).

| # | Operation | SA | HY | IA / IC |
|---|---|---|---|---|
| 5 | MAC ACL | S — 8 local ACLs, max 512 MACs each since rev -09 (June 2022) (S19 p.126–130) | U | U |
| 7 | Backup/restore | S — UI sections exist (S19 p.193–194) | U | U |
| 8 | Firmware | S — UI incl. revert to backup firmware (S19 p.187–190) | U | U |
| 11 | Mode change | S — identical statement to WAX610: Web→Insight clears config except IP, AP name, local password; Insight→Web keeps Insight password; in Insight mode only a basic/limited local UI (S19 p.177) | | |
| other rows | | U | U | U |

---

## 3. Documented on-device interfaces

### 3.1 WAX615
| Interface | Status | Source |
|---|---|---|
| Local web UI (HTTPS) | Exists (Dashboard referenced) — feature coverage U | S4, S3 [index-only] |
| SNMPv1/v2c | U for procedure; manual has "Enable SNMP… / SNMPv1/v2c settings" sections | S3 [index-only] |
| SNMPv3 | **S — added in firmware 12.5.0.14** (21 Jan 2026) | S7 |
| SNMPv2 after 12.8.0.6 | "backward compatibility for SNMPv2" added 12.8.0.6 | S8 |
| SNMP limitation | Known issue on 12.5.0.14 and 12.8.0.6: v2/v3 "supported only through the “snmpwalk” command"; workaround: copy correct MIB to /usr/share/snmp/mibs/ | S7, S8 |
| SNMP read-only vs read-write | U for WAX615 (family reference S9: RW community "private" exists by default) | — |
| SNMPv3 auth/priv algorithms | U | — |
| MIB | Per-model MIB download (e.g. "MIB Version 12.8.0.6") reported on support page — U | I7 [index-only] |
| SSH / CLI | U — no official CLI reference found | — |
| Telnet | U | — |
| Syslog | U standalone; Insight 7.6.2 severity setting for "WAX600 series" (WAX615 membership not stated) | S23 |
| NTP | U | — |
| On-device REST/HTTP API | U — none documented anywhere found | — |

### 3.2 WAX610 / WAX610Y / WAX620 / WAX630 (+ WAX605, WAX608Y, WAX610W per release notes)
| Interface | Status | Source |
|---|---|---|
| SNMP (WAX610 manual July 2020) | S — **SNMPv1/v2 only**; disabled by default; read-only community default `public`, **read-write community default `private`**, trap community `trap`, trap port 162 | S9 p.164–165, 235 |
| SNMP read community via Insight | S — WAX610/610Y firmware 9.1.0.16 extended read-community configuration to APs from Insight app and Cloud Portal | S10 |
| SNMPv3 | S — WAX610/610Y 12.5.0.15 (21 Jan 2026); WAX630 12.5.0.15 (search excerpt only) | S11 |
| SNMPv2 backward compatibility | S — WAX610/610Y, WAX608Y, WAX620 12.8.0.7 (8 Jul 2026); WAX630 12.8.0.7 (21 Apr 2026); WAX605 12.8.0.6 (8 Jul 2026) | S12, S13, S14, S25 |
| "snmpwalk only" known issue | S (present) on all of the above 12.x notes and WAX610W 12.1.1.5 | S11–S14, S25 |
| SSH | WAX610 (July 2020): SSH toggle, **enabled by default**; no CLI command reference documented | S9 p.163, 235 |
| Reverse SSH "Secure Diagnostic Mode" | WAX610 9.1.0.16: NETGEAR-support temporary access, revocable | S10 |
| Syslog | S — WAX610 UI: server IP, port 514 default, disabled by default | S9 p.148, 233 |
| NTP | S — WAX610 UI: custom NTP host/IP, NTP client enabled by default | S9 p.146 |
| LLDP / UPnP | S — enabled by default (WAX610) | S9 p.137–138, 233 |
| On-device REST API | U — none documented | — |

### 3.3 WAX214 / WAX218
| Interface | Status | Source |
|---|---|---|
| SNMPv1/v2c | S — disabled by default; RO community `public`, **RW community `private`**, trap port 162 | S18 p.98–100 |
| SNMPv3 | S — one user; auth MD5 or SHA (or None); privacy **DES only** (or None); keys 8–32 chars; engine ID | S18 p.100–102 |
| Remote syslog | S | S18 |
| NTP | S | S18 |
| Email alerts (SMTP) | S | S18 |
| SSH / Telnet / API | U | — |

### 3.4 WAC510
| Interface | Status | Source |
|---|---|---|
| SNMP | S — **SNMPv1/v2 only**, RO `public` / RW `private` / trap `trap` | S19 p.200–201 |
| Telnet | **N** — removed, "no longer supported" (manual rev 202-11840-06, Aug 2019) | S19 |
| SSH | U — the "Enable or disable Secure Shell" section was removed in rev 202-11840-08 (July 2021); removal from the manual is not a statement of non-support | S19 |
| Syslog | S — section exists | S19 p.186 |
| Login | HTTPS required for local login (rev -06) | S19 |

---

## 4. Documented cloud / controller interfaces (NETGEAR Insight)

### 4.1 Architecture facts (S20, Feb 2024)
- Devices initiate outbound HTTPS/TCP 443 to NETGEAR cloud (registration, devcom, api, presence, xbroker hosts, monitor, firmware S3 bucket). No inbound ports. User traffic does not traverse the cloud.
- If cloud connectivity is lost, devices keep working but firmware updates and settings cannot be pushed.
- Security model: after association with an Insight account, a device is "designed to reject all other attempts to communicate with it". **This conflicts with** the hybrid local UI (S9) and the Insight-configurable SNMP read community (S10); exactly which on-box interfaces answer in Insight mode is **U** and must be lab-tested.
- The Insight app exposes a subset of the portal's configuration.

### 4.2 Insight Cloud Portal operations (S22, FAQ updated 20 Apr 2026)
Reboot (single, bulk, scheduled); firmware upgrade (immediate, scheduled, batch, per device group; target = latest or two previous); SSID changes pushed on save; device groups share SSID/VLAN/radio config. The FAQ states device-level logs are not available in the portal (troubleshoot tab and diagnostic bundles instead). Backup/restore, API, SNMP, syslog and data export are **not covered** by the FAQ.

### 4.3 Insight API
- **Only official statement found:** Insight Cloud Portal & App 7.6.2 (21 Dec 2024) — "Support for Insight Cloud RESTful APIs for partners" (S23).
- **Not found:** public documentation, endpoint list, authentication model, who qualifies as "partner", licensing, **rate limits**, whether AP configuration (SSID/MAC ACL/radio) is writable through it. Current Insight product pages (S24) and the Insight 10.0 data sheet (S21) do not mention an API. → **Unverified in every respect beyond its existence for partners.** No endpoints may be designed or invented from this.

### 4.4 Licensing
- Feb 2024: two subscription plans, Premium and Pro (Pro adds organisations/multi-customer) (S20). Older manuals: Cloud Portal for Premium/Pro subscribers only (S9 p.23).
- 2026: Insight 10.0 "single-tier subscription"; per-device credits; monthly (US/Canada only), 1-year, 3-year prepaid, or partner licence; devices without credit become unmanaged after a 14/30-day grace (S21, S22, S24). SKUs still named "Insight Pro Cloud Management" (S21).
- WAX615 ships with a 1-year Insight subscription (S1, S2).

---

## 5. Firmware versions where interface support changed (as stated by sources)

| Model(s) | Version (date if stated) | Change | Source |
|---|---|---|---|
| WAX610 | 9.0.0.x (manual July 2020) | SNMPv1/v2 only; SSH enabled by default | S9 |
| WAX610 / WAX610Y | 9.1.0.16 | SNMP read community configurable from Insight app/portal for APs; reverse-SSH diagnostic mode; some features (802.11r, advanced mesh) Insight-mode only | S10 |
| WAX615 | 10.8.6.3 | Insight options for DTIM, beacon, broadcast/multicast rate limiting, ARP proxy; 802.11k/v independent toggles in Insight | S4 |
| WAX615 | 10.8.12.7 | Fix: AP model identified incorrectly by SNMP | S5 |
| WAX615 | 11.8.0.9 | Firmware downgrade allowed in Insight mode; known issue: channel may not apply after standalone⇄Insight switch | S6 |
| WAX615 | 12.5.0.14 (21 Jan 2026) | **SNMPv3 added**; v2/v3 only via snmpwalk (known issue) | S7 |
| WAX610 / WAX610Y | 12.5.0.15 (21 Jan 2026) | **SNMPv3 added**; snmpwalk-only known issue | S11 |
| WAX610W | 12.1.1.5 (21 Jan 2026) | snmpwalk-only known issue | S25 |
| WBE750 / WBE758 | 12.5.0.22 (21 Jan 2026) | **SNMPv3 added**; snmpwalk-only; Insight channel-mismatch fix | S15 |
| WAX615 | 12.8.0.6 (23 Apr 2026) | SNMPv2 backward compatibility; snmpwalk-only persists | S8 |
| WAX630 | 12.8.0.7 (21 Apr 2026) | SNMPv2 backward compatibility | S14 |
| WBE750/758, WBE710/718 | 12.8.0.7 (22 Apr 2026) | SNMPv2 backward compatibility | S16, S17 |
| WAX610/610Y, WAX608Y, WAX620 | 12.8.0.7 (8 Jul 2026) | SNMPv2 backward compatibility | S12, S13, S25 |
| WAX605 | 12.8.0.6 (8 Jul 2026) | SNMPv2 backward compatibility | S25 |
| WAC510 | manual rev -06 (Aug 2019) / -08 (Jul 2021) | Telnet removed; SSH section removed | S19 |
| WAC505/510/540 | 5.0.0.17 | Hybrid Management Mode default in Insight (lead only) | I3 [index-only] |
| Insight | 7.6.2 (21 Dec 2024) | Partner REST APIs; syslog severity for WAX600/WBE700; MAC/IP filters in custom ACLs | S23 |
| Insight | 10.0 (2026) | Single-tier subscription | S21, S24 |

Observation (not an inference about devices): the 12.8.x "SNMPv2 backward compatibility" item suggests SNMPv2 behaviour changed in the 12.5 train; a pilot must record which SNMP versions answer on the exact firmware found.

---

## 6. Gaps and risks

1. **No documented configuration API for standalone APs.** For every model read, configuration (SSID, passphrase, MAC ACL, radio) is documented only through the local web UI (and Insight UI). No on-device REST API and no CLI reference exist in the sources. → Any Drishti write adapter for standalone mode would be **web-UI automation = experimental adapter requiring lab validation**, pinned to exact model + firmware, never a fleet dependency (W-3: "No browser automation as a fleet dependency").
2. **SNMP is not a safe configuration channel.** Writable MIB objects are undocumented; read-write community `private` exists by default on WAX610, WAX214/218 and WAC510 when SNMP is enabled (S9, S18, S19). Drishti must not use SNMP SET and should require the RW community be changed/neutralised (whether it can be disabled is U).
3. **SNMP read path itself is fragile on current firmware**: the "only through snmpwalk" known issue (12.5.x–12.8.x) is not explained; it is unknown whether GET, GETNEXT and GETBULK from a non-net-snmp poller work. SNMPv3 algorithm support for WAX6xx/WBE is U; WAX214/218 offer DES only for privacy (weak).
4. **Insight mode may block local interfaces** (S20 statement vs. S9/S10). Whether SNMP/syslog/local UI answer while Insight-managed is U per model/firmware.
5. **Insight API is partner-only and undocumented publicly** (S23). Licensing, auth, rate limits and write scope are unknown. Screen-scraping the Insight portal is not acceptable.
6. **Destructive side-effects are documented**: switching Web→Insight clears configuration and reboots (S9, S19); firmware downgrade or reverting to backup firmware clears configuration (S9); radio/country changes restart radios or the AP (S9). Drishti must never change management mode automatically (supplement §B) and must flag downgrade/revert as configuration-destroying.
7. **Backups are opaque**: WAX610 backups are password-protected binary (S9); Drishti cannot diff them for drift detection. Insight device-level backup excludes wireless/VLAN settings per lead I4 and older portal manual says AP restore is unavailable (I8) — unresolved.
8. **Client MAC randomisation and MAC ACL scale**: limits differ by model (256/ACL WAX610; 512/ACL WAC510; WAX214 per-SSID list); RADIUS MAC ACL incompatible with WPA2-Enterprise (S9) and with MPSK/DVLAN on WAX615 (S4).
9. **Firmware stability**: 12.8.0.6 notes list multiple open known issues (S8); an unofficial forum report alleges ~72 h reboots on WAX615 12.8.0.6 (§8, not relied on). Pilot must capture uptime.
10. **Documentation age**: the only WAX6xx manual read is from 2020; WAX615-specific behaviour is largely undocumented in what was readable.

---

## 7. Recommendations

### 7.1 Drishti adapter order (aligns with W-2, W-3, W-6)
1. **`fake` adapter** (already decided) — orchestration tests only; never evidence of NETGEAR support.
2. **Manual / CSV inventory** — owner-supplied model, serial, MAC, firmware, management mode, management IP per location. No device access needed.
3. **`snmpv3-readonly` telemetry adapter (first real adapter)** — eligible only where firmware ≥ the SNMPv3 release for that model (WAX615 ≥ 12.5.0.14; WAX610/610Y ≥ 12.5.0.15; WBE750/758 ≥ 12.5.0.22) and only after lab validation. Start with standard MIB-II system/interfaces objects (uptime, ifTable counters); NETGEAR private MIB objects (clients, radios) only after the owner downloads the model-matched MIB and OIDs are verified on the pilot unit. authPriv only; v1/v2c disabled where possible; RW community changed; poller on HO collector over SD-WAN; test GET/GETNEXT/GETBULK because of the snmpwalk-only known issue. Below those versions: SNMPv1/v2c read-only is documented (WAX610 2020, WAC510, WAX214/218) but should be `experimental` (cleartext community).
4. **Passive syslog receiver** — documented for WAX610 standalone (S9), WAX214/218 (S18), WAC510 (S19); Insight-side severity setting for WAX600/WBE700 (S23). Read-only, no device writes.
5. **Insight partner API adapter** — only if the owner confirms partner status and obtains official documentation, licence terms and rate limits in writing; until then capability rows stay U and no endpoint is designed.
6. **Vendor configuration adapter (local web UI)** — `experimental`, per exact model+firmware, lab-validated, isolated, opt-in per device; Drishti shows all other config operations as "Unsupported: no documented NETGEAR interface for programmatic configuration in this mode". Prefer leaving configuration in Insight (UI) when the estate is Insight-managed, with Drishti doing inventory, telemetry, drift *observation* and change records only.

### 7.2 `device_capabilities` seeding guidance (W-2)
Seed rows from §2–§3 with `verification_state = documented` (S) or `unverified` (U), `doc_ref = Sx`, and **never** `lab_validated` until the pilot. Rollout planning must refuse every configuration operation for every NETGEAR model today (no row is lab-validated, and no non-UI configuration interface is documented).

---

## 8. Unofficial leads (not relied on)
- NETGEAR Community: WAX6xx line said to have no CLI; SNMPv3 recommended over v2 (user opinion).
- NETGEAR Community (Oct 2023, staff reply): "no REST API available for Insight" — predates S23.
- NETGEAR Community (2021): Insight SNMP v1/v2 settings moved to Location → Settings.
- NETGEAR Community (Sept 2026): WAX615 on 12.8.0.6 reboots roughly every ~72 h uptime.
- NETGEAR Community: M4300 switch REST API documentation available on request (switch, not AP).

## 9. Source list (all read or indexed on 2026-10-22)

| ID | Source | URL | Access |
|---|---|---|---|
| S1 | WAX615 data sheet (D-WAX615_30Jan23) | https://www.downloads.netgear.com/files/GDC/WAX615/WAX615_DS.pdf | read in full |
| S2 | WAX615 product page | https://www.netgear.com/business/wifi/access-points/wax615/ | read |
| S3 | WAX615 user manual (rev 202-12568-09 Dec 2025 / -10 Jan 2026) | https://www.downloads.netgear.com/files/GDC/WAX615/WAX615_UM_EN.pdf | **index-only** (>10 MB) |
| S4 | WAX615 FW 10.8.6.3 release notes | https://kb.netgear.com/000066111/WAX615-Firmware-Version-10-8-6-3 | read |
| S5 | WAX615 FW 10.8.12.7 | https://kb.netgear.com/000066569/WAX615-Firmware-version-10-8-12-7 | read |
| S6 | WAX615 FW 11.8.0.9 | https://kb.netgear.com/000068397/WAX615-Firmware-Version-11-8-0-9 | read |
| S7 | WAX615 FW 12.5.0.14 | https://kb.netgear.com/000070478 | read |
| S8 | WAX615 FW 12.8.0.6 | https://kb.netgear.com/000070675/WAX615-Firmware-Version-12-8-0-6 | read |
| S9 | WAX610 user manual 202-12098-01 (July 2020) | https://www.downloads.netgear.com/files/GDC/WAX610/WAX610_UM_EN.pdf | read in full |
| S10 | WAX610/610Y FW 9.1.0.16 | https://kb.netgear.com/000062512 | read |
| S11 | WAX610/610Y FW 12.5.0.15 | https://kb.netgear.com/000070473/WAX610-WAX610Y-Firmware-Version-12-5-0-15 | read |
| S12 | WAX610/610Y FW 12.8.0.7 | https://kb.netgear.com/000070668 | read |
| S13 | WAX620 FW 12.8.0.7 | https://kb.netgear.com/000070669 | read |
| S14 | WAX630 FW 12.8.0.7 | https://kb.netgear.com/000070665/WAX630-Firmware-Version-12-8-0-7 | read |
| S15 | WBE750/758 FW 12.5.0.22 | https://kb.netgear.com/000070484/WBE750-WBE758-Firmware-Version-12-5-0-22 | read |
| S16 | WBE750/758 FW 12.8.0.7 | https://kb.netgear.com/000070671/WBE750-WBE758-Firmware-Version-12-8-0-7 | read |
| S17 | WBE710/718 FW 12.8.0.7 | https://kb.netgear.com/000070670 | read |
| S18 | WAX214/WAX218 user manual 202-12175-02 (Jan 2022) | https://www.downloads.netgear.com/files/GDC/WAX214/WAX214_WAX218_UM_EN.pdf | read (relevant sections) |
| S19 | WAC510 user manual 202-11840-10 (Sept 2022) | https://www.downloads.netgear.com/files/GDC/WAC510/WAC510_UM_EN.pdf | read (relevant sections) |
| S20 | NETGEAR Insight Architecture (DS-InsightArchitecture-06Feb24) | https://www.downloads.netgear.com/files/netgear/documents/Insight_Architecture_PDF_06Feb24.pdf | read in full |
| S21 | Insight 10.0 data sheet (©2026) | https://www.downloads.netgear.com/files/business/Insight_DS.pdf | read in full |
| S22 | Insight Cloud Portal 10.0 FAQ (updated 20 Apr 2026) | https://kb.netgear.com/000070652/Insight-Cloud-Portal-Frequently-Asked-Questions | read |
| S23 | Insight Cloud Portal and App 7.6 release notes | https://kb.netgear.com/000066505/NETGEAR-Insight-Cloud-Portal-and-App-version-7-6 | read |
| S24 | Insight product pages | https://www.netgear.com/business/services/insight/ ; https://www.netgear.com/ae/business/services/insight/ | read |
| S25 | WAX605 12.8.0.6 / WAX608Y 12.8.0.7 / WAX610W 12.1.1.5 | https://kb.netgear.com/000070666 ; https://kb.netgear.com/000070667 ; https://kb.netgear.com/000070475 | read |
| I1 | KB: reset an Insight-managed device to defaults | https://kb.netgear.com/000048439/How-do-I-reset-an-Insight-Managed-Switch-or-Wireless-Access-Point-to-factory-default-settings-in-Insight | index-only (page empty) |
| I2 | KB: SNMP for Insight managed switches (excerpt: Insight read-only v1/v2, no v3 — switches) | https://kb.netgear.com/000060933/How-do-I-set-up-SNMP-for-my-Insight-managed-switches-using-the-Insight-Cloud-Portal | index-only |
| I3 | KB: Hybrid Management Mode (WAC505/510/540) | https://kb.netgear.com/000059566/What-is-Hybrid-Management-Mode-and-how-does-it-apply-to-my-WAC505-WAC510-or-WAC540-access-point | index-only |
| I4 | KB: Insight device / location backup & restore | https://kb.netgear.com/000060541/How-do-I-back-up-or-restore-my-device-settings-in-the-Insight-Cloud-Portal ; https://kb.netgear.com/000060540/How-do-I-back-up-my-location-settings-in-the-Insight-Cloud-Portal | index-only |
| I5 | KB: WiFi MAC ACL in Insight | https://kb.netgear.com/000053884/How-do-I-set-up-a-WiFi-MAC-access-control-list-ACL-in-Insight | index-only |
| I6 | WBE750 user manual (rev 202-12966-01, July 2026) | https://www.downloads.netgear.com/files/GDC/WBE750/WBE750_UM_EN.pdf | index-only |
| I7 | Support/download pages listing MIBs (e.g. WAX615, WAX610, WAX214) | https://support.netgear.com/support/product/wax615 | index-only (JS page) |
| I8 | Insight App & Cloud Portal User Manual (July 2018) | https://www.netgear.com/images/pdf/Insight-App-and-Cloud-Portal-UM.pdf | index-only |

---

## 10. Questions for the owner (first-hardware-pilot checklist inputs)

**Estate facts**
1. Exact model of every AP (label, incl. suffix: WAX615 vs WAX615PA, WAX610 vs 610Y, etc.), serial and Ethernet MAC, per location.
2. Exact running firmware **and backup firmware** version on each AP (Dashboard / Insight device page).
3. Management mode of each AP today: standalone (Web-browser), Insight-managed, or mixed? Power/Cloud LED blue = Insight-connected, green = standalone or not connected (S9).
4. Are any devices described as "routers" actually NETGEAR APs, or other NETGEAR devices (Orbi Pro, PR460X, BR500)? Record real role.

**Insight**
5. Is there an Insight account? Who owns it (email/org)? Which licence (legacy Premium/Pro, Insight 10.0 credits, partner licence)? Expiry dates and credit count vs. AP count.
6. Is CityKart (or its integrator) a NETGEAR partner with access to the "Insight Cloud RESTful APIs for partners"? If yes: provide the official API documentation, terms, auth model and rate limits.
7. Will APs stay Insight-managed? Drishti will never change management mode; any migration is a separate owner decision because Web→Insight clears configuration and reboots.

**SNMP / syslog / time**
8. Is SNMP enabled today on any AP? Which versions? Have default communities (`public`/`private`) been changed? Is the read-write community in use by anything?
9. Will the owner download the model- and firmware-matched NETGEAR MIB files for the pilot (Drishti did not download them)?
10. Is there a syslog collector and NTP source reachable from store management VLANs over SD-WAN? UDP 161/162/514 permitted HO⇄stores?
11. Firewall: do APs have outbound HTTPS 443 to NETGEAR cloud hosts (needed for Insight, S20)?

**Credentials and change policy**
12. Credential policy: who holds local admin passwords and the Insight network password per location; may Drishti store an SNMPv3 read-only user in Vault; is any write credential to be given to Drishti at all?
13. Is a firmware baseline per model desired (e.g. ≥ 12.5.x for SNMPv3) and who approves upgrades given the documented config-loss risk on downgrade?
14. Confirm that configuration changes stay manual (Insight UI or local UI) until a model-specific adapter is lab-validated.

**Pilot scope**
15. Name one lab/spare AP per model (ideally WAX615) that may be reset, mode-switched and re-flashed for validation, isolated from production SSIDs.
16. Low-impact pilot scenarios: (a) read inventory over SNMPv3 from HO; (b) poll uptime/interface counters; (c) receive syslog on reboot; (d) observe Insight-mode behaviour of SNMP/syslog/local UI; (e) record exact firmware and MIB used — before any write operation is considered.
