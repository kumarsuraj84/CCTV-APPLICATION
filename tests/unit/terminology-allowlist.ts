// T-1 (ruling T-1, docs/drishti/DECISIONS.md): the only places where the word "store" may stay in a string of the application.
// Everything else the person can read says "location". Each entry is one string in one file, with the reason. A string must equal
// `text`, or only contain it when `partial` is set. Code identifiers, property names, imports and comments are not strings and are not
// scanned at all; this list is for strings only. An entry that matches nothing fails the guard (the list stays an honest record).

export type Allowed = { file: string; text: string; partial?: true; reason: string }

const KIND = 'the kind of a location is "store" (a shop); one of store, head office, DC, warehouse, other'
const HTTP = 'HTTP cache directive "no-store", not wording'
const POSTGREST = 'PostgREST select alias or embed name; the database still has these names until P2-5a renames the schema'

export const ALLOWED: Allowed[] = [
  // --- not wording: technical values -------------------------------------------------------------------------------------------------
  { file: 'lib/streams/gateway.ts', text: 'no-store', partial: true, reason: HTTP },
  { file: 'lib/streams/gateway-health.ts', text: 'no-store', partial: true, reason: HTTP },
  { file: 'lib/streams/go2rtc.ts', text: 'no-store', partial: true, reason: HTTP },
  { file: 'lib/streams/speed.ts', text: 'no-store', partial: true, reason: HTTP },
  { file: 'lib/streams/vod.ts', text: 'no-store', partial: true, reason: HTTP },
  { file: 'app/api/health/route.ts', text: 'no-store', partial: true, reason: HTTP },
  { file: 'app/api/vod/route.ts', text: 'no-store', partial: true, reason: HTTP },
  { file: 'components/layout/NewVersionBanner.tsx', text: 'no-store', partial: true, reason: HTTP },
  { file: 'lib/jobs/engine.ts', text: 'store', reason: 'option name of the job engine\'s persistence ("JobStore"), nothing to do with shops' },
  { file: 'lib/jobs/testing.ts', text: 'store', partial: true, reason: 'option name and test ids of the job engine\'s persistence ("JobStore"), nothing to do with shops' },
  // --- values already saved in the database (history keeps them) ---------------------------------------------------------------------
  { file: 'lib/auth/access-audit.ts', text: 'store', reason: "audit entity_type 'store' of rows already written; P2-5a renames the schema" },
  { file: 'components/admin/access-labels.ts', text: 'migrated:store', reason: 'reason code saved on grants moved over from the old location grants; the label next to it says what it means' },
  { file: 'lib/admin/access-rules.ts', text: 'store-viewer', reason: 'preset id kept in saved grants; the visible label says "Location CCTV viewer"' },
  { file: 'lib/admin/access-rules.ts', text: 'store-it-viewer', reason: 'preset id kept in saved grants; the visible label says "Location IT viewer"' },
  { file: 'components/admin/AccessBuilder.tsx', text: 'store-viewer', reason: 'preset id (see lib/admin/access-rules.ts)' },
  { file: 'components/admin/AccessBuilder.tsx', text: 'store-it-viewer', reason: 'preset id (see lib/admin/access-rules.ts)' },
  // --- the kind of a location: "Store" stays one of the kinds (Store, Head office, DC, Warehouse, Office, Other) -------------------------
  { file: 'lib/inventory/forms.ts', text: 'Store', reason: KIND },
  { file: 'lib/inventory/forms.ts', text: 'store', reason: 'the stored value of the kind: ' + KIND },
  { file: 'components/admin/inventory/LocationForm.tsx', text: 'store', reason: 'default value of the kind: ' + KIND },
  { file: 'lib/import/locations-plan.ts', text: 'store', reason: 'default value of the kind: ' + KIND },
  { file: 'lib/import/locations-csv.ts', text: 'store', reason: 'spellings of the kind in a file ("store", "shop"): ' + KIND },
  { file: 'lib/import/locations-csv.ts', text: 'Not a kind of location: use store, head office, DC, warehouse or other.', reason: 'names the kinds: ' + KIND },
  { file: 'lib/queries/live.ts', text: 'store', reason: 'scope kind value ("store" | "group" | "camera"), code only; the description people read says "Location"' },
  // --- the database still uses these names until P2-5a --------------------------------------------------------------------------------
  { file: 'lib/admin/access.ts', text: 'stores:', partial: true, reason: POSTGREST },
  { file: 'lib/queries/groups.ts', text: 'stores', partial: true, reason: POSTGREST },
  { file: 'lib/queries/inventory.ts', text: 'stores', partial: true, reason: POSTGREST },
  { file: 'lib/queries/live.ts', text: 'stores', partial: true, reason: POSTGREST },
]
