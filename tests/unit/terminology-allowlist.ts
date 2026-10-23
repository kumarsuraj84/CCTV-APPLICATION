// T-1 (ruling T-1, docs/drishti/DECISIONS.md): the only places where the word "store" may stay in a string of the application.
// Everything else the person can read says "location". Each entry is one string in one file, with the reason. A string must equal
// `text`, or only contain it when `partial` is set. Code identifiers, property names, imports and comments are not strings and are not
// scanned at all; this list is for strings only. An entry that matches nothing fails the guard (the list stays an honest record).
// Release 1 clean-ups (T-1 review L1): strings that are code — a field or column name, a PostgREST select list, a header value such as
// "no-store, private", a preset id such as "store-viewer" — are recognised by the guard itself (codeLike in terminology-guard.test.ts),
// so the broad `partial` entries for them are gone; the two `partial` entries left are narrow phrases.

export type Allowed = { file: string; text: string; partial?: true; reason: string }

const KIND = 'the kind of a location is "store" (a shop); one of store, head office, DC, warehouse, other'

export const ALLOWED: Allowed[] = [
  // --- not wording: technical values -------------------------------------------------------------------------------------------------
  { file: 'lib/streams/gateway.ts', text: 'Cache-Control: no-store', partial: true, reason: 'HTTP cache directive in a raw HTTP answer written by hand, not wording' },
  // P3-1: the old addresses of ruling T-1, now redirected by proxy.ts (they were in next.config.ts, which this guard does not scan).
  { file: 'lib/web/legacy-redirects.ts', text: '/stores', reason: 'the old address that redirects to /locations (ruling T-1)' },
  { file: 'lib/web/legacy-redirects.ts', text: '/admin/stores', reason: 'the old address that redirects to /admin/locations (ruling T-1)' },
  { file: 'lib/jobs/engine.ts', text: 'store', reason: 'option name of the job engine\'s persistence ("JobStore"), nothing to do with shops' },
  { file: 'lib/jobs/testing.ts', text: 'store', reason: 'option name of the job engine\'s persistence ("JobStore"), nothing to do with shops' },
  // --- values already saved in the database (history keeps them) ---------------------------------------------------------------------
  { file: 'lib/auth/access-audit.ts', text: 'store', reason: "audit entity_type 'store' of rows already written; P2-5a renames the schema" },
  // --- the kind of a location: "Store" stays one of the kinds (Store, Head office, DC, Warehouse, Office, Other) -------------------------
  { file: 'lib/inventory/forms.ts', text: 'Store', reason: KIND },
  { file: 'lib/inventory/forms.ts', text: 'store', reason: 'the stored value of the kind: ' + KIND },
  { file: 'components/admin/inventory/LocationForm.tsx', text: 'store', reason: 'default value of the kind: ' + KIND },
  { file: 'lib/import/locations-plan.ts', text: 'store', reason: 'default value of the kind: ' + KIND },
  { file: 'lib/import/locations-csv.ts', text: 'store', reason: 'spellings of the kind in a file ("store", "shop"): ' + KIND },
  { file: 'lib/import/locations-csv.ts', text: 'Not a kind of location: use store, head office, DC, warehouse or other.', reason: 'names the kinds: ' + KIND },
  { file: 'lib/queries/live.ts', text: 'store', reason: 'scope kind value ("store" | "group" | "camera"), code only; the description people read says "Location"' },
  // --- release 1 (T-1 review L1): the import help names the old column spelling that older files still use --------------------------
  { file: 'lib/import/help.ts', text: 'in older files, store_code', partial: true, reason: 'the import help names the older column name store_code, which files made before T-1 still carry and the reader accepts' },
  { file: 'lib/import/help.ts', text: 'the older name store_code', partial: true, reason: 'the device import help names the older column name store_code, which the reader still accepts' },
]
