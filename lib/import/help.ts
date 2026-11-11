// The column help on the Import page (T-1, ruling T-1): the visible words say "location code"; the older names (store_code) are still
// read and are documented here so that nobody has to guess. Kept in one place so a test can pin the words.

export const LOCATION_COLUMNS_HELP =
  'Up to 5 MB. Columns: the location code (code, also written location_code or, in older files, store_code) or name, and for each NVR: ip, user, password '
  + '(optional: display_name, kind, city, zone, state, address, region, cluster, port, http_port, channels, nvr_name, monitoring). '
  + 'Several NVRs of one location: one row each, with the same location code.'

export const DEVICES_IMPORT_HELP =
  'Columns: name, type (nvr, server, attendance, footfall, other), location_code (optional; the older name store_code also works), ip, port (optional), notes (optional). '
  + 'A device is found again by its address and port. An empty location or notes cell keeps what is saved; write (clear) to empty it. '
  + 'Check the file first; Import saves every row, or nothing if a row has a problem.'
