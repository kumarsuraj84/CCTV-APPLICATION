// Visible form controls for the administration screens built in P2-3, following docs/design/ASSET-MANAGEMENT-DESIGN-REFERENCE.md §6.4
// before the global re-skin (P3) lands: a white field with a 1 px border of at least 3:1 against the field and its surface
// (#7C8795 = 3.64:1 on white; #8A96A6 on the dark card), a darker border on hover, and on focus the ring colour as border AND a
// solid 2 px ring (never the faint glow alone). Placeholders use full-strength muted text (no opacity). Labels are always visible.
export const FIELD =
  'h-10 w-full min-w-0 rounded-lg border border-[#7C8795] bg-white px-3 text-base text-[#071727] placeholder:text-[#576574] ' +
  'hover:border-[#5A6A80] focus-visible:border-[var(--ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ' +
  'disabled:cursor-not-allowed disabled:bg-[#EAF1F8] disabled:text-[#5B646F] md:text-sm ' +
  'dark:border-[#8A96A6] dark:bg-[#0B1220] dark:text-[#E6EAF0] dark:placeholder:text-[#A9B4C2]'

export const TEXTAREA = FIELD.replace('h-10', 'min-h-[72px] py-2')

/** Native checkboxes and radios: their own border is ≥ 3:1; the focus ring is solid. */
export const CHECK = 'h-4 w-4 shrink-0 accent-[var(--ring)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]'

/** Added to buttons and links on these screens: a solid, visible focus ring. */
export const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]'

export const LABEL = 'block text-sm font-medium text-foreground'
export const HELP = 'text-xs text-muted-foreground'

/**
 * Responsive tables: a normal table from 768 px, and below that every row becomes a stacked card (cells one under the other with a
 * small label), so nothing hides behind a sideways scroll on a 375 px phone.
 */
export const RT = {
  table: 'block w-full text-sm md:table md:min-w-[640px]',
  caption: 'block px-3 pt-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground md:table-caption',
  thead: 'hidden text-left text-xs text-muted-foreground md:table-header-group',
  tbody: 'block md:table-row-group',
  tr: 'block border-t py-1 align-top md:table-row md:py-0',
  td: 'block px-3 py-1 md:table-cell md:py-2',
  tdAction: 'block px-3 py-2 md:table-cell md:text-right',
  label: 'mr-1 text-xs font-medium text-muted-foreground md:hidden',
} as const

/** A block notice (warning tone) and a neutral status band (reference §4 "Inline status band"). */
export const NOTE = 'rounded-lg border border-amber-700/40 bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100'
export const STATUS = 'rounded-lg border bg-muted/40 px-3 py-2 text-sm'

/** A small text badge (always words, never colour alone). */
export const BADGE = {
  warn: 'inline-flex items-center rounded-full border border-amber-700/40 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100',
  info: 'inline-flex items-center rounded-full border border-sky-700/40 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-950 dark:text-sky-100',
  neutral: 'inline-flex items-center rounded-full border border-slate-500/40 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-800 dark:bg-slate-900 dark:text-slate-100',
  danger: 'inline-flex items-center rounded-full border border-red-700/40 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-900 dark:bg-red-950 dark:text-red-100',
  ok: 'inline-flex items-center rounded-full border border-emerald-700/40 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
} as const
