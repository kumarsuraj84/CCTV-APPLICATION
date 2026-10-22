# Importing locations and NVRs from a CSV file (administrator guide)

Screen: **Admin → Import → Locations and NVRs** (`/admin/import`). Who: an administrator (or super administrator) holding
`admin.inventory` for the whole organisation. Built in P2-5c-2 (`lib/import/locations-csv.ts`, `locations-plan.ts`, `locations-import.ts`,
migrations `20261021000028` and, for review round 1, `20261021000031`). The examples below use made-up data only (TEST-NET addresses,
invented passwords).

## 1. How it works: check, then import

1. **Choose the file** (CSV, up to 5 MB, up to 5,000 rows).
2. **Check the file.** Nothing is saved. The screen shows:
   - counts: new / changing / unchanged locations and NVRs, passwords given, new cameras (and cameras linked back to their channel),
     new regions and clusters;
   - **Problems**, one line each with the **line number**, the **column** and a plain **reason** (for example: line 7, column `ip`,
     "Not a valid IP address."). A message never repeats what is in a cell (review B-I2: whatever lands in a column, a password is
     never echoed);
   - **Worth a look**: things that are saved but may be a mistake (the same NVR address at two locations, an unknown column, a
     location already in another cluster);
   - what happens to each location and each of its NVRs ("New", "Changes: address, web port", "No change"); a display name that
     changes shows **old → new**. Passwords are never shown and never compared with the saved one: **"Password: will be set"** when the
     row gives one (it is written only if it differs from the saved one, so importing the same file again writes nothing) and
     **"Password: kept"** when the cell is empty (review B-I3: the preview cannot be used to guess a saved password);
   - a new NVR says **"Monitoring: switched on"** (it is checked once the monitoring service runs) unless the file says `no`;
   - **Not in the file**: locations of the organisation that the file does not list, NVRs of listed locations that the file does not
     list, cameras on channels above the number of cameras the file gives. They are only listed.
3. **Import.** The same plan is worked out again and must be exactly the one you checked (otherwise: "Something changed since you
   checked the file… Check the file again"). Then **everything is saved in one go, or nothing** (one database transaction): when the
   database refuses one location, nothing of the file is saved and the message names the line.

### All or nothing, or "Skip the rows with problems"

- By default a file with any problem is **not imported at all**. Fix the rows and check again.
- With **"Skip the rows with problems"** ticked, a location with a problem in **any** of its rows is left out **whole** (never half of
  its NVRs); the other locations are imported (still in one transaction).
- "Skip" covers problems found while checking. **A refusal by the database** while saving (for example a code taken in the meantime)
  still stops the whole file: nothing is saved and the line is named.
- **A file that cannot be read as a whole** is never imported, whatever is ticked: a quote (`"`) that is never closed (nothing after it
  can be read), or a file that is not UTF-8 text (save it as "CSV UTF-8"; otherwise a password with a character such as `é` or `£`
  would be saved wrong).

### Keep the current display names

Tick **"Keep the current display names"** to keep every existing location's display name as it is. Without it, a location whose
display name is still its starting value (its code, as the old import left it) gets **"CODE - City"** (owner ruling). A `display_name`
column is always used.

### How a row is read (review B-I1)

A row is read **whole or not at all**:
- it must have exactly as many cells as the first line ("This row has 18 cells; the first line has 17…"): a comma inside a value that
  is not in quotes would otherwise shift every column after it;
- a value with a comma goes in quotes (`"Shop 1, Station Rd"`), and a quote inside a quoted value is written twice (`""`); a quote in
  the middle of an unquoted value is a problem of that row;
- a value may not contain a line break. A quote that is opened on one line and closed on a later one holds the lines in between: the check names the
  first line ("a line break inside the value") **and every line it swallowed** ("Line 3 is part of a value that was opened on line 2 and closed on
  line 4"), so "Skip the rows with problems" never drops a location without saying so;
- a text value (display name, city, zone, state, address, NVR name) may not start with `=`, `+`, `-` or `@` (a spreadsheet would read
  it as a formula). Passwords and user names may.
Such a row is never merged with the next one and never partly imported.

### Archive, never delete — and only when you confirm

Nothing that is missing from the file is changed unless you tick **"Also archive these N items"** under "Not in the file". Archived
means switched off and hidden, **not deleted**: monitoring history, access grants, groups and the NVR passwords in the vault are kept,
and the item can be restored (Locations and NVRs → the item → Restore). Archiving is offered only for a file **without problems** (a bad
row could hide a location that *is* in the file). An archived NVR's cameras are archived with it; an archived location takes its NVRs
and cameras with it. Their live video streams are closed.

## 2. Columns

The first line names the columns (any order, any case; spaces and dashes count as underscores). Unknown columns are reported as
"not used". A cell left **empty keeps what is saved** (to clear a value, edit the location on its page).

| Column | Needed | Meaning |
|---|---|---|
| `code` | `code` or `name` | The location code (letters, numbers, dashes, up to 50, e.g. `JCL`). The column may also be called `location_code`, or `store_code` as in older files. Stable: the identity of the location. The code of an **archived** location is refused: restore that location first (no second location with the same code). |
| `name` | (legacy) | The older file's name column. Used as the code (upper case) when there is no `code` column. |
| `display_name` | no | The name people see. A new location without one gets **"CODE - City"** (owner ruling). An existing location keeps a name a person edited; one still at its starting value ("CODE" or "CODE - City") follows the ruling. |
| `kind` | no | `store`, `head office` / `head_office`, `DC` / `distribution centre`, `warehouse`, `other`. New locations default to store. |
| `city`, `zone`, `state`, `address` | no | Plain attributes. Zone and state are tidied (e.g. `jh` → `Jharkhand`). |
| `cluster` | no | Cluster code. A **new** location is put in it. An existing location **without** a cluster joins it (a move: the access of people with grants on that cluster or its region changes at once; audited). An existing location in **another** cluster is **not moved** (warning): move it on its page, which shows the effect on access first. A missing cluster is created with its code as its name. |
| `region` | no, and only with `cluster` | Region code of the cluster (a location joins a region through its cluster). A missing region is created. An existing cluster in another region is not moved (warning). One cluster may not have two regions in one file. |
| `ip` | for an NVR | The NVR's IP address. A row **without** `ip` (and without the other NVR columns) is a location **without an NVR** (a head office). |
| `port` | no | The NVR's video (RTSP) port. Empty: an existing NVR keeps its saved port; a new one gets 554. |
| `http_port` | no | The NVR's web (HTTP) port. Empty: an existing NVR keeps its saved port and is found by its address alone (when two NVRs of the location share the address, give the port); a new one gets 80. |
| `user` | with `ip` | The NVR user name. |
| `password` | for a new NVR | Written to the vault only (write-only). Empty keeps the saved one — **except** when the row changes the NVR's address or web port: then the password must be given again (review I-4: a saved password is only used for the address it was saved for). |
| `channels` | no | The number of cameras of the NVR (0–999). Cameras are made for channels 1..N that never had a camera on this NVR ("Camera N"; real names come from "Find cameras"). Empty keeps the saved number. |
| `nvr_name` | no | The NVR's name (e.g. "Ground floor"). New NVRs default to "NVR" (or "NVR 2", "NVR 3" when a location has several). |
| `monitoring` | no | `yes` / `no`. New NVRs are switched on unless `no`. `no` switches an NVR off (the reason saved is "Switched off by the CSV import."): nothing contacts it. Empty leaves an existing NVR as it is. |

**Several NVRs at one location:** one row per NVR, with the same `code`. The location columns may be repeated or left empty on the later
rows, but may not contradict the first row (that is a problem on the later row). The same NVR (address + web port) twice at one location
is a problem.

### The older one-row-per-location file keeps working

`name, city, zone, ip, port, http_port, user, password, channels` is read as "location + its main NVR + channels": the location by its
code (the name column), its NVR by address and web port — and when the address changed, the location's main NVR is updated (one row
per location), never a second NVR made. That last rule is for a location with **exactly one NVR**. A location with two or more NVRs and one
row whose address is none of them is **refused**: the message names the addresses and web ports of its NVRs (never a password) so you can
choose; to add another NVR give a row for each NVR, or add it on the location's page.

## 3. Identity rules (why importing the same file again changes nothing)

- A **location** is matched by its **code** within the organisation (another organisation's locations are never seen or touched).
- An **NVR** is matched by **location + address + web port** (an empty web port cell: by the address alone); for a location with one
  row, by the legacy rule above.
- A **camera** is matched by **NVR + channel**. A channel that ever had a camera on that NVR (archived or moved since) gets no new one;
  an unlinked camera that belongs on a channel is linked back to it ("cameras linked again").
- A password given in the file is written only when it differs from the saved one (compared inside the database during the import,
  never in the preview). Unchanged NVRs are not saved again (no audit noise).

So the second import of the same file shows every location "No change" and saves nothing.

## 4. Examples (made-up data)

Two stores, one with two NVRs, and a head office:

```
code,display_name,kind,city,zone,state,region,cluster,ip,port,http_port,user,password,channels,nvr_name,monitoring
SMP1,,store,Patna,BR,Bihar,EAST,EAST-1,192.0.2.10,554,80,viewer,change-me-1,16,Ground floor,yes
SMP1,,,,,,,,192.0.2.11,554,80,viewer,change-me-2,8,First floor,yes
SMP2,,store,Ranchi,JH,Jharkhand,EAST,EAST-1,192.0.2.12,554,80,viewer,change-me-3,12,,yes
HO1,Head office Kolkata,head_office,Kolkata,WB,West Bengal,,,,,,,,,,
```

Result: SMP1 "SMP1 - Patna" with two NVRs (24 cameras), SMP2 "SMP2 - Ranchi" (12 cameras), HO1 without an NVR; region EAST and cluster
EAST-1 created. The sample file `public/samples/locations-sample.csv` ("Download a sample file") is this example.

The legacy form:

```
name,city,zone,ip,port,http_port,user,password,channels
SMP3,Gaya,BR,192.0.2.20,554,80,viewer,change-me-4,8
```

## 5. From the command line (local stack only)

`npx tsx scripts/import-estate-local.ts "<path to the CSV>"` prints what the import would do — **counts only**, never a cell value
(problems as counts per column). Add `--apply` to save it (the same single transaction as the screen; `--skip-bad-rows` as the tick
box, `--keep-names` as "Keep the current display names"). It refuses to run against anything but the local stack on port 55321, and
it never contacts an NVR.

## 6. After an import

- Run **Find cameras for all locations** (`/admin/locations/discover`) to replace the "Camera N" placeholders with the NVRs' own
  channel names; anything it cannot place goes to the reconciliation list (`/admin/reconciliation`). One search runs at a time per
  organisation; **Stop the search** asks no further NVR (the ones being asked finish; the rest are listed as skipped).
- Planner statistics are refreshed automatically after a bulk import.
- Rename the created regions and clusters (they carry their code as their name) on **Regions and clusters**.
