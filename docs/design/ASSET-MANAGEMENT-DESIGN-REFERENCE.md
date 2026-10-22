# CityKart Asset Management — design reference for CityKart Drishti

Written 2026-10-22 for the owner's directive in `docs/drishti/REQUIREMENTS-DIRECTIVE.md` ("Design reference and branding"). It records what the CityKart Asset Management application (CKAM) actually does in its code, where each finding came from, the cause of the "fields hard or impossible to see" complaint, and what Drishti must change to match the reference without repeating that defect.

Path shorthand used below:

- **AM** = `D:\ANKUR AI PROJECTS\Asset Management\.claude\worktrees\ckam-build\` (the newest CKAM code, branch `worktree-ckam-build`, head `94e345a8b`, 2026-10-17)
- **AMF** = `AM\frontend\src\`
- **DESK** = `D:\ANKUR AI PROJECTS\CitykartDesk-ZOHO Alternate\`
- **DR** = `D:\ANKUR AI PROJECTS\CCTV MONITORING TOOL\` (Drishti)

---

## 1. Sources inspected, and what was NOT inspected

### 1.1 Where the reference code actually is

`D:\ANKUR AI PROJECTS\Asset Management` itself (branch `main`, commit `7ee9523`) holds **only** two planning documents (`docs/specs/2026-09-23-ckam-design.md`, `docs/superpowers/plans/2026-09-23-ckam-implementation.md`) plus release zips. The application source lives in two git worktrees under `.claude\worktrees\`:

| Worktree | Branch | Last change | Used here |
|---|---|---|---|
| `ckam-build` | `worktree-ckam-build` @ `94e345a8b` | 2026-10-16/17 (release 0b8c525 deployed 2026-10-17) | **Yes — the reference for this document** |
| `brave-euler-07879a` | `claude/brave-euler-07879a` (the repo's default branch, per `AM\CLAUDE.md`) | 2026-09-23 | No (older) |

The stack is **React 19 + Vite + TanStack Router/Query + Tailwind v4 + shadcn/ui (`new-york` style, Radix primitives)**, light theme only (`AM\frontend\components.json`, `AMF\styles.css`). Drishti is Next.js 16 + shadcn `base-nova` (Base UI primitives), so components must be **re-implemented to the same visual contract**, not copied.

### 1.2 Inspected (read in full or in the relevant part)

| Area | Files |
|---|---|
| Project instructions | `AM\CLAUDE.md`, `AM\frontend\components.json`, `AM\frontend\package.json` |
| Design documentation | `AM\docs\ai\DESIGN_SYSTEM.md` (the app's own design system), `AM\docs\ai\DECISIONS.md` (AM-14, AM-15, AM-16 entries), grep of `AM-14_COMPLETE_VISUAL_REDESIGN_REPORT.md`, `AM-15_FULL_VISUAL_ACCEPTANCE_REPORT.md`, `AM-15_VISUAL_ACCEPTANCE_MATRIX.md`, `UAT_MATRIX.md`, `CURRENT_STAGE.md` for contrast/visibility findings |
| Tokens | `AMF\styles.css` (authoritative), `AMF\design-tokens\tokens.css`, `AMF\fonts.css` |
| UI primitives | `AMF\components\ui\` input, textarea, select, label, button, badge, card, table, checkbox, radio-group, switch, tabs, tooltip, alert, skeleton, sonner, dialog, alert-dialog, sheet, pagination, sidebar (widths, menu button, group label) |
| Shared components | `AMF\components\shared\` FormField, PageHeader, StatusBadge, EmptyState, ErrorState, ErrorMessage, SectionHeading, AsyncButton, DataTable |
| Shell / navigation | `AMF\router.tsx` (LoginPage, ChangePasswordPage, AppShell), `AMF\components\app-shell\AppNav.tsx`, `AMF\hooks\use-mobile.tsx` |
| Auth pages | `AMF\routes\login.tsx`, `AMF\routes\change-password.tsx` (the reference has **no** forgot-password or reset-password page — passwords are issued by an administrator and a forced change follows the first sign-in) |
| Operational pages | `AMF\features\dashboard\Dashboard.tsx` (home), `AMF\features\assets\AssetRegister.tsx` (list + filters + table), `AMF\features\assets\AssetDetail.tsx` (Asset 360 detail), `AMF\features\purchase-orders\PurchaseOrderDetail.tsx` (KPI tiles), `AMF\features\system\AuditTab.tsx` / `ErrorsTab.tsx` / `RecordHistory.tsx` (investigation drawers) |
| Stored screenshots (images in the reference repo, viewed) | `AM\docs\security\evidence\closure\infra\raw\fonts\after\00-login.png`, `AM\docs\ai\s7-screens\vis_home@1366.png`, `vis_modal_add_employee@390.png`, `AM\docs\ai\demo-screens\51_assets_more_filters.png`, `52_asset_360_summary.png` |
| Desk (differences only) | `DESK\app\globals.css`, `DESK\components\ui\input.tsx`, `DESK\app\(auth)\login\page.tsx` |
| Drishti current UI | `DR\app\globals.css`, `DR\app\layout.tsx`, `DR\app\(app)\layout.tsx`, `DR\components\layout\*`, `DR\app\(auth)\**`, `DR\components\ui\` input, label, button, badge, card, PageHeader, EmptyState, `DR\components\monitor\StatusBadge.tsx`, `MonitoringBanner.tsx`, `DR\app\(app)\error.tsx`, `DR\lib\brand.ts`, `DR\lib\nav.ts`, class usage on `DR\app\(app)\home\page.tsx` |

### 1.3 Rendered pages

- **Asset Management was NOT running** on this machine (2026-10-22: no listening port or process whose command line points at the Asset Management folder; its dev port 3211 was not listening). It was **not started**, per instruction. **No reference page was rendered live.** All reference visual findings come from the code above plus the screenshots already stored in its repository (listed in 1.2). Those stored screenshots are copied, unchanged, into `docs/design/reference-screenshots/am-repo-*.png` (they show demo data only).
- **Drishti's own dev server (http://localhost:3212) was rendered** in the built-in browser, public pages only, no sign-in, nothing typed or submitted:
  - `reference-screenshots/drishti-login-light-pane-710.png` — `/login`, light, pane width 710 px
  - `reference-screenshots/drishti-login-light-1366-scaled.png` — `/login`, light, 1366×768 emulation (scaled down to fit the pane)
  - `reference-screenshots/drishti-login-dark-1366-scaled.png` — `/login` with the `dark` class set in the page through the inspector (the state a user gets after choosing dark with the theme switcher; nothing was saved)
  - `reference-screenshots/drishti-forgot-password-light-pane-729.png` — `/forgot-password`, light
- Computed styles were read from the live Drishti page (input background `rgba(0,0,0,0)`, border `rgb(227,233,240)`, input height 32 px, card radius 16 px, font Manrope, page `rgb(243,245,248)`; in dark: input border `white / 0.12`, input background `white / 0.036`).

### 1.4 Not inspected

- No reference page was rendered (see above); hover, focus and animation behaviour of the reference is taken from its class strings, not observed.
- `AM\docs\ai\*` was searched, not read end to end (only DESIGN_SYSTEM.md and the relevant DECISIONS entries were read fully).
- The older `brave-euler-07879a` worktree, the release zips, the backend, any `.env*` file, the database and the `.git` internals were not opened.
- Reference feature screens beyond those listed (Receive, Move, PO list, Import, Reports, People, Settings sub-screens) were not read; their patterns are inferred from the shared components they use.

---

## 2. Tokens

All values from `AMF\styles.css :root` unless marked `tokens.css` (values `styles.css` does not override). Hex is the sRGB conversion computed for this document (clamped). The reference is **light theme only** ("All colors are OKLCH, light theme only", `AM\docs\ai\DESIGN_SYSTEM.md`); it has a `@custom-variant dark` line but **no dark token set**.

### 2.1 Colour — surfaces and brand

| Token | OKLCH | Hex | Use |
|---|---|---|---|
| `--background` | `oklch(0.985 0.006 240)` | `#F7FBFE` | Header bar, Sheet, outline-button fill |
| `--foreground` | `oklch(0.20 0.04 250)` | `#071727` | Body text |
| `--card` / `--surface` | `oklch(1 0 0)` | `#FFFFFF` | Cards, dialogs (AM-15), table wrapper |
| `--popover` | `oklch(0.995 0.004 240)` | — | Menus, select lists |
| `--muted` | `oklch(0.955 0.012 250)` | `#EAF1F8` | **Page canvas (`body`)**, input fill base |
| `--muted-foreground` | `oklch(0.44 0.04 250)` (tokens.css says 0.48; styles.css wins) | `#425468` | Secondary text, labels of read-only values, placeholders |
| `--primary` | `oklch(0.32 0.085 258)` | `#14325D` | Deep navy: primary buttons, active nav text, links, tooltips |
| `--primary-foreground` | `oklch(0.99 0 0)` | `#FCFCFC` | Text on primary |
| `--primary-soft` | `oklch(0.93 0.025 258)` (= `--sidebar-accent`) | `#DEE9F9` | Active/hover nav tint |
| `--header` | `oklch(0.24 0.08 258)` | — | Defined, not used by the current light header |
| `--secondary` | `oklch(0.94 0.02 250)` | `#E2EDF8` | Secondary button, neutral chip |
| `--secondary-foreground` | `oklch(0.25 0.06 250)` | `#06233D` | |
| `--accent` / `--accent-foreground` | `oklch(0.92 0.04 250)` / `oklch(0.25 0.08 250)` | | Ghost/outline hover, select item focus |
| `--teal` | `oklch(0.465 0.083 218)` | `#026478` | Brand accent, "never the dominant colour" |
| `--border` | `oklch(0.90 0.015 250)` | `#D7DFE8` | All borders (`* { border-color }`) |
| `--input` | `oklch(0.92 0.012 250)` | `#DFE5EC` | Outline-button border, switch off-state |
| `--ring` | `oklch(0.46 0.10 258)` | `#33588F` | Focus border and focus glow |
| `--sidebar` | `oklch(1 0 0)` | `#FFFFFF` | Sidebar background |
| `--sidebar-border` | `oklch(0.90 0.015 250)` | | |

### 2.2 Colour — semantic

| Tone | Solid (`--x`) | Text on solid | Soft fill (`--x-soft`, tokens.css) | Text on soft (`--on-x-soft`, tokens.css) |
|---|---|---|---|---|
| success | `oklch(0.62 0.16 160)` `#00A263` | `oklch(0.99 0 0)` | `oklch(0.94 0.045 160)` `#D2F5E1` | `oklch(0.45 0.12 160)` `#00683D` |
| warning | `oklch(0.78 0.15 75)` `#EFA831` | `oklch(0.22 0.06 60)` `#2E1200` | `oklch(0.95 0.060 85)` `#FFECC1` | `oklch(0.47 0.10 75)` `#7B5100` |
| destructive (danger) | `oklch(0.58 0.22 25)` `#DF202E` | `oklch(0.99 0 0)` | `oklch(0.93 0.055 25)` `#FFDAD6` | `oklch(0.50 0.18 25)` `#B32228` |
| info | `oklch(0.68 0.12 230)` `#32A5D4` | `oklch(0.15 0.04 240)` `#000D1A` | `oklch(0.93 0.045 230)` `#CAEEFF` | `oklch(0.45 0.11 230)` `#005F86` |
| neutral | — (uses `--secondary` / `--secondary-foreground`) | | `#E2EDF8` | `#06233D` |

Row tints (tokens.css): `--row-exception-bg oklch(0.975 0.03 25)`, `--row-selected-bg oklch(0.955 0.03 218)`; exception left accent `--row-exception oklch(0.58 0.22 25)`. A large unused starter-kit surface also exists (chart, trust, section, avatar, cta, ai palettes) — the reference itself says not to treat it as required.

### 2.3 Typography

| Item | Value | Source |
|---|---|---|
| Sans | `"Inter", system-ui, sans-serif` — self-hosted variable Inter (`@fontsource-variable/inter`), no Google calls (CSP `'self'`) | `AMF\styles.css @theme`, `AMF\fonts.css` |
| Numeric / code | `"IBM Plex Mono", ui-monospace, monospace` 400/500/600 | same |
| Body | 14 px, line-height 1.5, letter-spacing −0.005em, antialiased | `styles.css @layer base` |
| Inputs | `text-base` (16 px) on mobile, `md:text-sm` (14 px) from 768 px | `input.tsx` |
| Page title (h1 in PageHeader) | `text-lg` 18 px `font-semibold` | `PageHeader.tsx` |
| Nested page title (h2) | `text-base` 16 px semibold | `PageHeader.tsx` |
| Detail-page identity title | `font-mono text-xl font-semibold` (asset code) | `AssetDetail.tsx:607` |
| Auth title | `text-2xl sm:text-3xl font-semibold tracking-tight` | `router.tsx:132` |
| Card title | `text-base font-semibold leading-none tracking-tight` | `card.tsx` |
| Dialog title | `text-lg font-semibold leading-none` | `dialog.tsx` |
| Section heading | `text-xs font-semibold uppercase tracking-wide text-muted-foreground` + hairline rule | `SectionHeading.tsx` |
| Sidebar group label | `text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/60` | `sidebar.tsx:443` |
| Label | `text-sm font-medium leading-none` | `label.tsx` |
| Helper / error text | `text-xs text-muted-foreground` / `text-xs text-destructive` (auth pages: `text-sm text-destructive`) | `FormField.tsx`, `login.tsx` |
| Raw headings fallback | h1 24 px, h2 20 px, h3 18 px, weight 650, −0.02em | `styles.css` |
| Numbers | `tabular-nums`, right-aligned in tables; `.num` utility uses Plex Mono 600 | `DESIGN_SYSTEM.md` AM-16, `styles.css` |

### 2.4 Spacing, radius, border, shadow, motion

| Item | Value | Source |
|---|---|---|
| Page gutter | `p-4 md:p-6` (16/24 px), main area **uncapped width** | `router.tsx:243` |
| Section gap | `gap-4` (16 px) page sections; `gap-5` long forms | `DESIGN_SYSTEM.md` AM-13 |
| Card padding | `p-4` header/content/footer (content `pt-0`) | `card.tsx` |
| Label→control gap | `gap-1.5` (6 px) | `FormField.tsx` |
| Form grid | `grid gap-4 sm:grid-cols-2` (`lg:grid-cols-2` on detail edit) | `DESIGN_SYSTEM.md` AM-04 |
| `--radius` | `0.75rem` (12 px) → `radius-sm` 8 px, `radius-md` 10 px, `radius-lg` 12 px, `radius-xl` 16 px | `styles.css @theme` |
| Radius use | inputs/select/textarea `rounded-sm` 8 px · buttons `rounded-md` 10 px · cards `rounded-md` 10 px · dialogs `sm:rounded-lg` 12 px · auth card `rounded-xl` 16 px · badges `rounded-full` | component files |
| Border | 1 px `--border` everywhere | `styles.css` |
| Shadows | `--shadow-sm 0 2px 6px oklch(0.30 0.08 250 / .08), 0 1px 2px … / .05` on cards; `shadow-md` auth card and select lists; `shadow-lg` dialogs/menus/toasts | `styles.css`, components |
| Rule | "Surfaces are structure via border, not elevation via shadow" | `DESIGN_SYSTEM.md` AM-14 |
| Motion | `--dur-fast 140ms`, `--dur-base 220ms`, ease-out `cubic-bezier(0.22,1,0.36,1)`; controls use `transition-colors` | `styles.css` |
| Breakpoints | Tailwind defaults; mobile < 768 px (`MOBILE_BREAKPOINT = 768`) | `use-mobile.tsx` |

### 2.5 Focus ring

| Control | Focus style |
|---|---|
| Input / Select / Textarea | `focus-visible:border-ring` + `ring-[3px] ring-ring/25` + background firms up to `bg-background` |
| Button | `ring-[3px] ring-ring/30`, **no border change** (outline button keeps its `--input` border) |
| Checkbox / Radio | `ring-[3px] ring-ring/25` (box border is `border-primary`, always visible) |
| Tabs, Switch, Badge, dialog close | `ring-2 ring-ring ring-offset-2` (solid) |

The 25 %/30 % glow alone is 1.48:1 against white (see §6.3); on inputs the solid `--ring` border (7.17:1) carries the indication, on buttons nothing solid does.

---

## 3. Layout and shell (`AMF\router.tsx` `AppShell`, `AMF\components\ui\sidebar.tsx`, `AppNav.tsx`)

- **Top bar**: full width, `h-14` (56 px), `border-b bg-background px-3`, light (kept light because the logo is a transparent PNG with dark navy/red lettering — `DESIGN_SYSTEM.md` "App shell"). Left: sidebar collapse trigger, logo `h-8 w-auto` + product name `text-sm font-semibold` (hidden below `sm`). Right: role name `text-xs text-muted-foreground` (md+), "Report a problem" ghost `sm` button with LifeBuoy icon (label lg+), "Change password" text link (sm+), **Log out** `outline sm` button with icon.
- **Sidebar**: shadcn `Sidebar` with `collapsible="icon"`, below the top bar (`top-14 h-[calc(100svh-3.5rem)]`). Width **16rem (256 px)**, icon rail **3rem (48 px)**, mobile **18rem (288 px)** slide-in Sheet below 768 px; Ctrl/Cmd+B toggles. White background, right border.
- **Nav grouping** (role-aware; hiding a link is UX, server enforces): ungrouped "Home" → group "Work" (Assets, Purchase Orders, Receive, Move) → group "People & Places" → ungrouped "Reports" → a collapsible "Settings" with sub-groups. Items: `h-8 text-sm`, lucide icon `h-4 w-4`, active = `bg-sidebar-accent` (primary-soft) + `text-sidebar-accent-foreground` (navy), rounded-md. Active is computed with explicit prefixes so a detail page keeps its parent lit.
- **Main**: `SidebarInset` with `min-w-0` (prevents the 768 px overflow bug), `main` `flex-1 p-4 md:p-6`, canvas `--muted`.
- **Page header** (`PageHeader.tsx`): title + one-line description left, actions right (`flex flex-wrap gap-2`), optional filter area below (`gap-4`).
- **Mobile**: no bottom tab bar; navigation is the slide-in Sheet. Dialogs become full-width, footers stack (`flex-col-reverse`).

---

## 4. Components catalogue and usage rules

| Component | Reference contract (file) | Usage rule |
|---|---|---|
| **Button** (`ui\button.tsx`) | `rounded-md text-sm font-medium gap-2`; sizes default `h-10 px-4`, `sm h-9 px-3 text-xs`, `lg h-11 px-8`, `icon h-10 w-10`; variants: default (navy solid + `shadow`), destructive (red solid), outline (`border-input bg-background shadow-sm`, hover accent), secondary, ghost, link; disabled `opacity-50` | One solid primary per context; secondary = outline; low-emphasis = ghost; never two solids side by side (`DESIGN_SYSTEM.md` AM-14). Mutations use `AsyncButton` (spinner + optional pending label, `aria-busy`) |
| **Input / Textarea / SelectTrigger** (`ui\input.tsx`, `textarea.tsx`, `select.tsx`) | `h-10` (textarea `min-h-[80px]`), `rounded-sm px-3`, **`border-transparent bg-muted/50`** at rest, `hover:bg-muted`, focus `bg-background border-ring ring-[3px] ring-ring/25`, placeholder `text-muted-foreground`, disabled `opacity-50` | This at-rest skin is the visibility defect — see §6. Copy the size, radius and focus; **do not copy the fill/transparent border** |
| **Label / FormField** (`ui\label.tsx`, `shared\FormField.tsx`) | Label above control, `gap-1.5`; required `*` in `text-destructive` (aria-hidden); one line below: error (`text-xs text-destructive`) **replaces** helper (`text-xs text-muted-foreground`) | Every field has a visible label; placeholder is an example, never the label. Select trigger gets an `aria-label` equal to the visible label |
| **Checkbox / Radio** | `h-5 w-5`, `border-primary`, checked `bg-primary` | Always paired with a `<label>` |
| **Switch** | `h-5 w-9`, on `bg-primary`, off `bg-input` | — |
| **Card** (`ui\card.tsx`) | `rounded-md border bg-card shadow-sm`, `p-4` sections, title `text-base font-semibold` | Never add a bigger shadow to an ordinary card |
| **Section** (detail) | `rounded-md border p-3`, `h2 text-sm font-semibold` (`AssetDetail.tsx:224`) | Lighter than a Card for blocks inside a detail page |
| **SectionHeading** | uppercase muted xs label + `h-px bg-border` rule | Separates sections of a long form; never a card per section |
| **Badge** (`ui\badge.tsx`) | `rounded-full border px-2.5 py-0.5 text-xs font-semibold` | Pill for one-record identity/status |
| **StatusBadge** (`shared\StatusBadge.tsx`) | tone map → soft fill + on-soft text (pill) or `compact` = 6 px solid dot + `text-xs text-foreground` label | Always text, never colour alone; tables use `compact` |
| **Tabs** | list `h-9 rounded-lg bg-muted p-1`, active trigger `bg-background shadow` | Detail-page secondary content |
| **Tooltip** | navy `bg-primary text-primary-foreground text-xs rounded-md px-3 py-1.5` | Collapsed-rail labels, icon buttons |
| **Alert** | `rounded-lg border px-4 py-3 text-sm`, destructive = `border-destructive/50 text-destructive`, icon left | Auth errors and notices |
| **Inline status band** | `rounded-md border bg-muted/40 px-3 py-2 text-sm role="status"` | Results/notices on operational pages (e.g. `AssetMovement.tsx:932`, `ErrorsTab.tsx:148`) |
| **Toast** | `ui\sonner.tsx` exists (`bg-background border shadow-lg`) but **no `<Toaster>` is mounted** anywhere in `AMF` | The reference reports outcomes inline (status bands, alerts), not with toasts |
| **Dialog / AlertDialog** | centred, `max-w-lg`, `max-h-[85vh] overflow-y-auto`, **`bg-card`**, `p-5`, `sm:rounded-lg`, `shadow-lg`, overlay `bg-black/80`; footer sticky at bottom, buttons right (stacked on mobile) | Destructive confirm = AlertDialog naming the record, plain-language effect, outline Cancel + red action |
| **Sheet (drawer)** | right side, `w-full sm:max-w-xl` or `sm:max-w-2xl`, `p-4 overflow-y-auto`, title `text-base`, `bg-background` | Investigation of one log/audit/error/history record |
| **DataTable** | see §8 | — |
| **EmptyState** | centred, `py-10`, optional 32 px muted icon, `text-sm font-medium` title, muted description, optional action | Short, no illustration |
| **ErrorState** | `role="alert" rounded-md border border-destructive/30 bg-destructive-soft/50 px-4 py-8`, red message, request-reference line with Copy, outline `sm` "Try again" | Never a raw exception string |
| **Skeleton** | `animate-pulse rounded-md bg-primary/10` | Loading rows/blocks |

---

## 5. Authentication pages

### 5.1 Reference

**Sign-in** (`AMF\router.tsx:124-141`, `AMF\routes\login.tsx`; stored screenshot `am-repo-login-1366.png`):

- `main` full height, centred column, `gap-7`, `bg-muted` canvas, `p-4`.
- **Full logo** `/logo.png`, `w-64 sm:w-72 md:w-80`, `h-auto` (aspect ratio kept, transparent PNG, no plate), alt text = product name.
- Title `h1` "Sign in to Citykart Asset Management" `text-2xl sm:text-3xl font-semibold tracking-tight`, subtitle `text-sm sm:text-base text-muted-foreground`.
- Card `max-w-[420px] rounded-xl border shadow-md`, content `px-8 py-8`, form `flex-col gap-5`, `noValidate` (validation is the app's own, shown inline).
- Fields: Label above ("User ID", "Password"); inputs `h-11` with a leading muted icon (`UserRound`, `Lock`) at `left-3.5` and `pl-10`; password has a show/hide eye button (`aria-label` "Show password"/"Hide password", own focus ring). Placeholder "Employee Code or Email" clarifies, the label stays the accessible name.
- Field errors `role="alert" text-sm text-destructive` under the field; server refusal in a destructive `Alert` with icon at the top of the form; the "session ended" notice in a neutral `Alert` with an Info icon.
- Submit: full-width `h-11 text-base` primary button "Sign in" + trailing arrow; disabled while submitting.
- Messages: one sentence per refusal (401 same words for unknown user or wrong password; 423 locked; 429 too many attempts).

**Change password / forced first change** (`router.tsx:144-177`, `routes\change-password.tsx`): same layout (logo, card `max-w-[420px] rounded-xl`), heading inside the card `text-xl font-semibold`, three password fields with the same icon/eye pattern, primary submit, and an outline "Log out" button under the card. Shown outside the app shell; nothing else reachable until done.

**Forgot / reset password**: **not present in the reference.** Drishti has them (Supabase e-mail link). Build them on the same template as sign-in.

### 5.2 Desk (difference only)

`DESK\app\(auth)\login\page.tsx`: same structure (logo 110 px high, `h1 text-2xl` "Sign in to Citykart Desk", `rounded-lg border bg-card shadow-sm` card, `p-6`, leading icons `pl-9`) but the Desk `Input` is the transparent 32 px shadcn field with a `#E3E9F0` border (same as current Drishti).

---

## 6. Form-field visibility rules

### 6.1 Cause of the owner's complaint (found in the code and the reference's own records)

1. **AM-14 changed every field to a "quiet filled" skin**: `border-transparent bg-muted/50` at rest, firming up only on focus (`AMF\components\ui\input.tsx`, `select.tsx`, `textarea.tsx`; decision `AM\docs\ai\DECISIONS.md` "2026-09-28 — AM-14"). The idea was borrowed from Desk's request form. At rest the **only** thing separating a field from its surface is a 2-3 % lightness difference: **1.07:1** on a white card (sign-in, change-password, cards), **1.04:1** on `bg-background`, **1.00:1 (identical colour)** when placed straight on the `--muted` page canvas. WCAG 1.4.11 needs **3:1** for the boundary of a control.
2. **AM-15 found the symptom but fixed only dialogs**: "Reference No/Remarks nearly invisible" in Send for Repair (`AM-15_VISUAL_ACCEPTANCE_MATRIX.md`); the fix moved Dialog/AlertDialog to `bg-card` (`DECISIONS.md` "AM-15"), improving 1.04:1 to 1.07:1 — still invisible by any contrast standard. The **sign-in and change-password fields kept the same 1.07:1 skin** (visible in `am-repo-login-1366.png`: two faint grey strips, no outline).
3. **Tinted containers make it worse**: filter bands are `bg-muted/40` (`AssetRegister.tsx:435`); screens patch it per field with `className="bg-background"` but the border stays transparent (≈ **1.01:1**). Read-only inputs are given `bg-muted/40` (`PoDraftCard.tsx:758-771`), making read-only and editable fields look the same.
4. **The investigation drawer (`sheet.tsx`) is still `bg-background`**, the surface AM-15 called "nearly invisible" for these fields.
5. **Focus glow is weak**: `ring-ring/25` is 1.48:1 by itself; buttons rely on it alone (no border change).
6. **Disabled = `opacity-50`** on the already faint field: a disabled field and an empty field are hard to tell apart (see "Choose the company first" in `am-repo-dialog-add-employee-390.png`).
7. Placeholder text itself is fine (`#425468` on the fill = 7.26:1) and labels are always visible above fields — the problem is the field **boundary**, not the text.

### 6.2 Drishti today has the opposite skin with the same outcome

`DR\components\ui\input.tsx` (identical to `DESK\components\ui\input.tsx`): `h-8`, `border-input` = `#E3E9F0`, `bg-transparent`. Border vs white card **1.22:1**, vs page `#F3F5F8` **1.12:1**. Dark theme: border `white/12` over the dark card **1.38:1**, fill `white/3.6 %` **1.08:1** (screenshot `drishti-login-dark-1366-scaled.png`: the two fields are barely distinguishable from the card). The `input-field` utility in `DR\app\globals.css` sets placeholder `opacity: 0.6` → **2.28:1** (fails 4.5:1). Native `<select>`s in `DR\components\admin\*.tsx`, `GroupEditor.tsx`, `PlaybackView.tsx` use `border` (`--border`) and `bg-background` (grey) — a third, different field look.

### 6.3 Computed contrast (WCAG 2.x relative luminance; alpha composited in sRGB as browsers do)

| Pair | Colours | Ratio | Needed |
|---|---|---|---|
| AM input fill (muted/50) vs white card | `#F5F8FC` / `#FFFFFF` | **1.07:1** | 3:1 |
| AM input fill vs `--background` | `#F0F6FB` / `#F7FBFE` | **1.04:1** | 3:1 |
| AM input fill vs page canvas `--muted` | `#EAF1F8` / `#EAF1F8` | **1.00:1** | 3:1 |
| AM filter-band input (`bg-background`) vs band | `#F7FBFE` / `#F7F9FC` | **1.01:1** | 3:1 |
| AM `--border` vs white | `#D7DFE8` / `#FFFFFF` | 1.35:1 | 3:1 if it is the only field boundary |
| AM `--input` (outline button border) vs white | `#DFE5EC` / `#FFFFFF` | 1.27:1 | 3:1 |
| AM focus border `--ring` vs white | `#33588F` / `#FFFFFF` | 7.17:1 | 3:1 ✔ |
| AM focus glow `ring/25` vs white | `#CCD5E3` / `#FFFFFF` | 1.48:1 | 3:1 ✘ alone |
| AM `--foreground` on white | `#071727` | 18.09:1 | 4.5:1 ✔ |
| AM placeholder `--muted-foreground` on fill | `#425468` / `#F5F8FC` | 7.26:1 | 4.5:1 ✔ |
| AM `--muted-foreground` on white / on canvas | `#425468` | 7.74 / 6.80:1 | 4.5:1 ✔ |
| AM sidebar group label (foreground/60) on white | `#6A747E` | 4.77:1 | 4.5:1 ✔ |
| AM disabled text (opacity .5) on white | `#838B93` | 3.46:1 | exempt, but weak |
| AM primary button text | `#FCFCFC` / `#14325D` | 12.40:1 | ✔ |
| AM `--destructive` error text on white | `#DF202E` | 4.79:1 | ✔ (barely) |
| AM badges on-soft/soft: success, warning, danger, info, neutral | | 5.84 / 5.97 / 5.12 / 5.80 / 13.43:1 | ✔ |
| AM status dots on white: success, warning, info, danger | `#00A263` `#EFA831` `#32A5D4` `#DF202E` | 3.31 / **2.04** / **2.81** / 4.79:1 | 3:1 (warning, info fail) |
| AM white text on `--success` | | 3.31:1 | 4.5:1 ✘ (don't use for text) |
| Drishti input border vs white card / vs page | `#E3E9F0` | **1.22 / 1.12:1** | 3:1 |
| Drishti `input-field` placeholder (opacity .6) | `#9DA5B0` / `#F3F5F8` | **2.28:1** | 4.5:1 |
| Drishti focus ring `ring/50` vs white | `#8CA6C7` | 2.50:1 | 3:1 (plus border change ✔) |
| Drishti `--warning #B07B18` as text on white | | **3.69:1** | 4.5:1 |
| Drishti dark: input border / input fill vs card | | **1.38 / 1.08:1** | 3:1 |
| **Recommended** `--field-border oklch(0.62 0.025 255)` vs white / canvas / read-only fill | `#7C8795` | **3.64 / 3.19 / 3.39:1** | 3:1 ✔ |
| Recommended `--field-border-hover oklch(0.52 0.04 255)` vs white | `#5A6A80` | 5.50:1 | ✔ |
| Recommended `--field-placeholder oklch(0.50 0.03 250)` on white | `#576574` | 5.98:1 | ✔ |
| Recommended disabled text `oklch(0.50 0.02 250)` on disabled fill `--muted` | `#5B646F` / `#EAF1F8` | 5.26:1 | ✔ |
| Recommended status text tokens on white: success / warning / danger / info | `#007145` `#8A5600` `#B71824` `#006692` | 6.07 / 6.15 / 6.63 / 6.35:1 | ✔ |
| Recommended status dots on white: success / warning / info / neutral | `#00935D` `#B77610` `#007EB0` `#69737D` | 3.96 / 3.74 / 4.55 / 4.84:1 | 3:1 ✔ |

### 6.4 Rules for Drishti

**Do**

1. Give every text input, select, textarea, date/time input, combobox and search box a **white fill (`--field`) and a 1 px solid `--field-border`** (≥ 3:1 against both the field and whatever it sits on) at rest. Hover: `--field-border-hover`. Focus: border `--ring` **and** a 2 px solid outline/ring in `--ring` (or the 3 px `ring/40` glow *plus* the border change) — never the glow alone.
2. Keep the reference geometry: `h-10` (40 px) desktop, `h-11` (44 px) on auth pages, `rounded-sm` (8 px), `px-3`, `text-base md:text-sm`.
3. Keep the label **above** the field (`text-sm font-medium text-foreground`, `gap-1.5`), required marker `*` in `--destructive`, one helper/error line below (`text-xs`). Placeholder only as an example.
4. Errors: border `--destructive` + `aria-invalid` + message with an icon or the word, `role="alert"` on submit-time errors; a form-level destructive `Alert` for server refusals.
5. Read-only: fill `--field-readonly`, border kept, text `--foreground`, `readOnly` + `aria-readonly`. Disabled: fill `--field-disabled`, text `--field-disabled-foreground`, `cursor-not-allowed`, **no global opacity**.
6. Use the same field skin on every surface (page canvas, card, dialog, sheet, filter band, dark tile). The visibility must not depend on the parent's colour.
7. Use one `Select` component for every dropdown, styled like `Input` (no bare native `<select>` with its own classes).
8. Put a leading icon and show/hide eye on auth fields exactly as the reference does; the eye button has a visible focus ring.
9. Check fields at 1366×768, 1920×1080 and the control-room size (§11) in a real browser before claiming visual acceptance.

**Do not**

1. Do not use `border-transparent` on a field at rest, or a fill-only field (`bg-muted/50`, `bg-input/30`, `bg-transparent` with a pale border).
2. Do not put fields on `bg-muted/40`-type tinted bands and then patch individual fields; style the field so it is visible everywhere.
3. Do not use `--border`/`--input` (≈ 1.2–1.35:1) as the only field outline. They are for decorative card borders and dividers.
4. Do not lower placeholder opacity (`opacity: 0.6`) or use `muted-foreground/60` for text that must be read.
5. Do not make disabled = `opacity-50` of an already faint control.
6. Do not ship a dark theme whose fields are white-at-12 % borders; no dark/alternative colour themes until a reviewed token set passes §6.3 (the reference has no dark theme).
7. Do not use colour alone for status or validation.
8. Do not use the solid `--warning` (`#EFA831`) or `--info` (`#32A5D4`) as text or as a small dot on white; use the `-strong` tokens below.

---

## 7. Status and severity visual language

Reference (`AMF\components\shared\StatusBadge.tsx`): five tones — **info** (available/idle), **success** (in productive use), **warning** (needs attention, not final), **destructive** (needs attention, unresolved), **neutral** (terminal, no action). Pill = soft fill + on-soft text, `font-medium`; compact (tables) = 6 px solid dot + `text-xs text-foreground` label. Always words, never colour alone; labels come from one label module so raw codes never appear.

Drishti must distinguish more states (directive: confirmed failure, unreachable from head office, unknown because a parent is unreachable, stale, maintenance, healthy, unsupported). Extension of the reference tones — **icon + word always**, dot/pill colour from the tokens in §13:

| Drishti state | Tone | Icon (lucide) | Example wording |
|---|---|---|---|
| Healthy (observed) | success | `CircleCheck` | "Online" / "Recording" |
| Confirmed device/service failure | destructive | `CircleX` | "Down" / "Not recording" |
| Unreachable from head office | warning | `WifiOff` | "Not reachable" |
| Unknown — parent (WAN/NVR) unreachable | neutral, **dashed** outline pill | `CircleHelp` | "Unknown — store link down" |
| Stale monitoring | warning soft | `Clock` | "Not checked lately" (already in `DR\components\monitor\StatusBadge.tsx`) |
| Maintenance | info | `Wrench` | "Maintenance" |
| Unsupported / not available | neutral | `Minus` | "Not supported" |

Severity for incidents/alerts: critical = destructive solid pill, major = destructive soft, minor = warning soft, info = info soft; acknowledged adds a neutral "Acknowledged" chip, never removes the severity.

---

## 8. Tables, filters, pagination, KPI patterns

**Table** (`AMF\components\ui\table.tsx`, `shared\DataTable.tsx`, screenshot `am-repo-asset-register-filters-1366.png`):

- Wrapper `overflow-hidden rounded-md border` (white on the canvas); the `Table` itself scrolls horizontally (`overflow-auto`) — never a second scroll container.
- Header: `h-10 px-2 text-left font-medium text-muted-foreground`, white background, bottom border. **No sticky header, no zebra striping.**
- Rows: `border-b`, `hover:bg-muted/50`, selected `bg-muted`, cell `p-2` (≈ 37-40 px rows), clickable rows `cursor-pointer` (interactive cells stop propagation).
- Sort: opt-in per column; header becomes a button with `ArrowUp`/`ArrowDown`, unsorted `ChevronsUpDown` at 40 % opacity.
- Selection: first column `w-10` checkbox, select-all in header, row checkbox `aria-label` names the row.
- Codes (asset code, serial) in mono; numbers `text-right tabular-nums` (header and cell); empty values `—`.
- Row actions: ghost `icon` buttons (`Pencil`, `Trash2`…) each with `aria-label` naming the row, in a `flex justify-end gap-1` cell; unauthorised actions omitted, not disabled.
- Loading: 5 skeleton rows (`h-4` bars); empty: required `EmptyState`; error: `ErrorState` with retry, inside the table frame.
- Pagination footer under the table: left `text-sm text-muted-foreground` "Showing 1–2 of 2 assets" (`aria-live="polite"`), right outline `sm` "Previous" · "Page 1 of 1" · outline `sm` "Next".

**Filters** (`AssetRegister.tsx:435-600`): one band `rounded-md border bg-muted/40 p-3` under the page header. Row 1: full-width search with a leading search icon + "More filters (n)" toggle (outline → secondary when open, `aria-expanded`) + "Mine" toggle (`aria-pressed`) + "Columns" dropdown of checkboxes. Expanded: `grid gap-3 sm:grid-cols-2 lg:grid-cols-4`, each filter a labelled field. Active filters as removable chips + "Clear all". **Filters live in the URL** (survive back/refresh — matches Drishti's "preserve filters on return"). In Drishti, keep the band but follow §6 for the fields inside it.

**KPI / summary**:

- Compact tile (`PurchaseOrderDetail.tsx:49-55`): `rounded-md border bg-card px-4 py-3 shadow-sm`, label `text-xs font-medium text-muted-foreground`, value `text-xl font-semibold tabular-nums`; row `grid grid-cols-2 gap-3 sm:grid-cols-5|6`.
- Home (`Dashboard.tsx:413-579`, `vis_home@1366.png`): no big KPI grid — PageHeader + filter select in the actions slot, a row of quick-action buttons (`sm`, solid + one outline), a **"Needs attention" card** whose rows are "sentence … action link →" (`divide-y`, `py-2 text-sm`, link `font-medium text-primary`), an inline "Assets: In Stock **284** …" line of links to filtered lists, then two-column cards with small tables and a collapsible "Watch list" `<details>`.
- For Drishti's control centre: use the compact tile for the KPI strip (each tile is a link to the filtered investigation), and the "Needs attention" sentence-plus-action list for incidents awaiting action. Do not invent bigger hero numbers.

---

## 9. Investigation (detail and drawer) patterns

- **Detail page** (`AssetDetail.tsx`, `am-repo-asset-360-detail-1366.png`): "← Assets" back link (returns to the list with its filters); summary block `rounded-md border bg-muted/30 p-3` with identity (QR, mono title `text-xl`, status pill + work-area outline chip), actions right (one solid primary "Move…", outline secondaries, `…` overflow menu); key facts as `<dl>` grid `sm:grid-cols-3` (label `text-xs font-medium text-muted-foreground`, value `text-sm`, `—` when empty); then `Section` blocks in `lg:grid-cols-2`; timeline rows with icon, sentence, status chip, timestamp; secondary content in Tabs.
- **Edit** swaps the read view for one un-tabbed edit panel with Save (`AsyncButton`) / Cancel; corrections are a separate action with an immutable-identity block, an "old → new" impact summary and a mandatory reason (`DESIGN_SYSTEM.md` AM-07).
- **Drawer** (`AuditTab.tsx:124`, `ErrorsTab.tsx:41`, `RecordHistory.tsx:64`): right `Sheet`, `w-full sm:max-w-xl` (2xl for wide content), `p-4 overflow-y-auto`, header `pr-6 text-left`, title `text-base`. Used for one log/audit/history record opened from a table row, so the list stays in place.
- **Drishti**: open an incident/asset investigation in the drawer from the overview (keeps filters), with a "Open full page" link to the detail route for deep work. Give the drawer `bg-card` (not `bg-background`).

---

## 10. States

| State | Reference pattern |
|---|---|
| Loading | Skeleton bars (`bg-primary/10 animate-pulse`), table skeleton rows; buttons show `Loader2` spinner + optional pending label and are disabled |
| Empty | `EmptyState` (icon optional, one line + optional action); in-card "Nothing needs your attention right now." in muted text |
| Error (section) | `ErrorState` red-tinted box with message, request reference + Copy, "Try again" |
| Error (route) | `defaultErrorComponent` → `ErrorFallback` with retry (`router.tsx:962`) |
| Error (form) | field: red text under the field; server: destructive `Alert` at form top |
| Notice / result | inline `role="status"` band `rounded-md border bg-muted/40 px-3 py-2 text-sm` |
| Disabled | `opacity-50 cursor-not-allowed` (replace for fields — §6.4) |
| Not allowed | action omitted entirely; no-access route shows a page (`demo-screens/15_sunita_no_access_settings.png`) |
| Session ended | sign-in page shows "Your session has ended. Please sign in again." notice |

---

## 11. Responsive rules, including large control-room displays

Reference: mobile < 768 px → sidebar becomes a Sheet, filter grid collapses to one column, dialog footer stacks, inputs use 16 px text (no iOS zoom), header hides product name/secondary links. Desktop target 1366×768 (stored screenshots at 1366 and 390). **The reference has no rules for very large displays** (no `2xl:` usage in `AMF\features`, main content uncapped).

Drishti additions (not from the reference; required by the directive):

- Operational pages: keep the uncapped main width for tables and video walls; cap reading-width content (forms, settings) at `max-w-3xl`/`max-w-5xl` inside the page, not the whole shell.
- 1920×1080 and 2560×1440 control-room screens: live grid columns from `grid-cols-[repeat(auto-fill,minmax(360px,1fr))]`; KPI strip up to 8 tiles in one row; status words stay visible on tiles (no colour-only).
- Wall/kiosk mode (later): a `data-density="wall"` root attribute that raises base text to 16 px, tile labels to 14 px and status dots to 10 px; check at 3 m viewing distance. Fields keep the §6 skin at every size.
- Keep the reference sidebar collapse (icon rail) for wall screens to give video the width.

---

## 12. Gap analysis — current Drishti vs the reference (file level)

| # | Drishti file | Current | Reference / required | Severity |
|---|---|---|---|---|
| 1 | `app/globals.css` | Byte-identical copy of `DESK\app\globals.css` (header comment "Citykart Desk"); hex tokens `#F3F5F8` / `#1A4D8F` / `#E3E9F0`; five alternative colour themes + `.dark` "Synthwave"; Desk utilities (`btn-glossy`, `input-field` with placeholder opacity .6, `nav-active` gradient) | CKAM OKLCH token set, light only, field tokens (§13); drop alternative themes and dark until reviewed; remove `input-field` opacity | High |
| 2 | `app/layout.tsx` | Fonts Manrope + JetBrains Mono (`next/font/google`); `data-theme` / theme script; `Toaster richColors bottom-right` | Inter + IBM Plex Mono (`next/font/google` self-hosts at build, so no runtime Google calls); light only; inline status feedback first, toast only for background events | Medium |
| 3 | `components/ui/input.tsx` | `h-8`, `rounded-lg` (12 px), `bg-transparent`, border `#E3E9F0` (1.22:1), dark fill 1.08:1 | `h-10`, `rounded-sm` (8 px), white fill, `--field-border` (≥ 3:1), focus border + solid ring (§6.4) | **Critical** (owner complaint) |
| 4 | `components/admin/CreateUserForm.tsx`, `DeviceForm.tsx`, `AccessEditor.tsx`, `components/groups/GroupEditor.tsx`, `components/live/PlaybackView.tsx` | Native `<select>` with ad-hoc `h-8 rounded-lg border bg-background` (grey fill, `--border`) | One shared `Select` matching `Input`; textarea component missing (add `ui/textarea.tsx`) | High |
| 5 | `components/ui/label.tsx` | `text-sm font-medium` (ok) | Same; add a shared `FormField` (label + required `*` + helper/error) — none exists | Medium |
| 6 | `components/ui/button.tsx` | `h-8`, `rounded-lg`, `sm h-7`, destructive = red text on 10 % red | `h-10` / `sm h-9` / `lg h-11` / `icon h-10`, `rounded-md`; destructive solid red; outline border must be visible (use `--field-border` or ≥ 3:1) | High |
| 7 | `components/ui/card.tsx` | `rounded-xl` (16 px), `ring-1 ring-foreground/10`, no shadow, `py-4` gap layout | `rounded-md` (10 px), `border bg-card shadow-sm`, `p-4` sections | Medium |
| 8 | `components/ui/badge.tsx` | `rounded-4xl h-5 font-medium`, destructive 10 % tint | `rounded-full px-2.5 py-0.5 text-xs font-semibold`; tone classes from soft/on-soft tokens | Low |
| 9 | `components/monitor/StatusBadge.tsx`, `MonitoringBanner.tsx`, `app/(app)/home/page.tsx` | Raw Tailwind palette (`emerald-100/800`, `red-100`, `amber-300/50/900`) with `dark:` variants | Token-based tones (§7, §13) incl. `compact` dot variant for tables; banners as reference status band / `Alert` | Medium |
| 10 | `components/ui/EmptyState.tsx` | Hard-coded hex `#EEF2FF`, `#4F46E5` (indigo), `#0F0F1A`, `#6B6B88` | Tokens only; reference EmptyState (§4) | Medium |
| 11 | `components/ui/PageHeader.tsx` | `text-xl font-bold` h1; breadcrumbs `text-[11px] text-muted-foreground/60` (≈ 2.5:1 — too faint) | h1 `text-lg font-semibold`, description muted; breadcrumbs ≥ 4.5:1 or a "← Back to …" link like the reference | Medium |
| 12 | `components/layout/AppShell.tsx` | No top bar logo; header `py-2` with name, theme switcher, "Sign out"; main capped `max-w-[100rem]` | `h-14` light top bar with **logo `h-8` + product name**, role, change password, outline "Log out"; main uncapped (§11) | High |
| 13 | `components/layout/Sidebar.tsx` | Fixed `w-60` (240 px), text brand block, groups "Monitoring/Admin" `text-xs font-medium`, active `bg-sidebar-accent font-medium`, not collapsible | 256 px, collapsible icon rail (48 px) with tooltips, group labels `text-[11px] font-semibold uppercase tracking-wide /60`, active primary-soft + navy text, compact mark only in the rail | High |
| 14 | `components/layout/MobileNav.tsx` | Bottom tab bar (`md:hidden`) | Reference uses a slide-in Sheet sidebar (18 rem). Bottom bar is a Drishti divergence — keep only if the owner wants it for phone CCTV viewing | Low (decision) |
| 15 | `components/layout/ThemeSwitcher.tsx` | Light/dark toggle in the header | Reference is light only; remove or hide until a dark set passes §6.3 | High (causes invisible fields) |
| 16 | `app/(auth)/login/page.tsx`, `LoginForm.tsx` | No logo; card title "CityKart Network Hub"; `max-w-sm`; fields `h-8` without icons/eye; label "E-mail"; page bg grey | Reference template (§5): full logo `public/brand/citykart-drishti-logo.png` (w-64/72/80, `h-auto`), h1 "Sign in to CityKart Drishti", subtitle, card `max-w-[420px] rounded-xl border shadow-md px-8 py-8`, `h-11` fields with icons, eye toggle, destructive `Alert`, `h-11` full-width submit | **Critical** |
| 17 | `app/(auth)/forgot-password/page.tsx`, `change-password/page.tsx` + `ChangePasswordForm.tsx` | Same plain card, no logo, `h-8` fields | Same template as sign-in; change-password with "Log out" outline button under the card (reference) | High |
| 18 | `lib/brand.ts` | `name: 'CityKart Network Hub'`, `short: 'Network Hub'` (page title "Sign in — Network Hub") | "CityKart Drishti" / "CKDRISHTI" (directive) | High |
| 19 | `components/ui/sheet.tsx`, (no dialog component) | Base UI sheet; no `dialog.tsx`/`alert-dialog.tsx`/`table.tsx`/`select.tsx`/`textarea.tsx`/`skeleton.tsx`/`alert.tsx` in `components/ui` | Add those primitives to the reference contracts (dialogs and drawers `bg-card`, `max-h-[85vh]`) and a shared `DataTable` (§8) | High |
| 20 | `app/(app)/error.tsx` | `rounded-xl border bg-card p-6`, muted icon | Reference `ErrorState` (red-tinted, reference id, retry) | Low |
| 21 | `components.json` | `style: base-nova`, `baseColor: neutral` | Keep Base UI (stack decision) but restyle to the contracts above; set `baseColor: slate` to match the reference family | Low |

---

## 13. Recommended Drishti token set (paste into `app/globals.css`)

Light theme only — **the reference has no dark theme**, so none is proposed. Replace the `:root` block, delete the `[data-theme=…]` and `.dark` blocks (and the theme switcher), and add the `@theme inline` mappings below to the existing `@theme inline` block. Values are the CKAM tokens except the lines marked `/* Drishti */`, which add the field-visibility and readable-status tokens computed in §6.3.

```css
@theme inline {
  --radius-sm: calc(var(--radius) - 4px);   /* 8px  — inputs, select, textarea */
  --radius-md: calc(var(--radius) - 2px);   /* 10px — buttons, cards */
  --radius-lg: var(--radius);               /* 12px — dialogs, drawers */
  --radius-xl: calc(var(--radius) + 4px);   /* 16px — auth card */

  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary-soft: var(--primary-soft);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-teal: var(--teal);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);

  --color-field: var(--field);
  --color-field-border: var(--field-border);
  --color-field-border-hover: var(--field-border-hover);
  --color-field-placeholder: var(--field-placeholder);
  --color-field-readonly: var(--field-readonly);
  --color-field-disabled: var(--field-disabled);
  --color-field-disabled-foreground: var(--field-disabled-foreground);

  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-destructive-soft: var(--destructive-soft);
  --color-on-destructive-soft: var(--on-destructive-soft);
  --color-destructive-strong: var(--destructive-strong);
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-success-soft: var(--success-soft);
  --color-on-success-soft: var(--on-success-soft);
  --color-success-strong: var(--success-strong);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-warning-soft: var(--warning-soft);
  --color-on-warning-soft: var(--on-warning-soft);
  --color-warning-strong: var(--warning-strong);
  --color-info: var(--info);
  --color-info-foreground: var(--info-foreground);
  --color-info-soft: var(--info-soft);
  --color-on-info-soft: var(--on-info-soft);
  --color-info-strong: var(--info-strong);
  --color-neutral-strong: var(--neutral-strong);
  --color-row-exception-bg: var(--row-exception-bg);
  --color-row-selected-bg: var(--row-selected-bg);

  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);

  --font-sans: var(--font-inter), "Inter", system-ui, sans-serif;            /* next/font Inter */
  --font-mono: var(--font-plex-mono), "IBM Plex Mono", ui-monospace, monospace; /* next/font IBM_Plex_Mono */
}

:root {
  --radius: 0.75rem;

  /* Surfaces (CKAM) */
  --background: oklch(0.985 0.006 240);        /* #F7FBFE top bar, sheet fallback */
  --foreground: oklch(0.20 0.04 250);          /* #071727 */
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.20 0.04 250);
  --popover: oklch(0.995 0.004 240);
  --popover-foreground: oklch(0.20 0.04 250);
  --muted: oklch(0.955 0.012 250);             /* #EAF1F8 page canvas */
  --muted-foreground: oklch(0.44 0.04 250);    /* #425468 7.74:1 on white */

  /* Brand (CKAM) */
  --primary: oklch(0.32 0.085 258);            /* #14325D deep navy */
  --primary-foreground: oklch(0.99 0 0);
  --primary-soft: oklch(0.93 0.025 258);       /* #DEE9F9 active nav */
  --secondary: oklch(0.94 0.02 250);
  --secondary-foreground: oklch(0.25 0.06 250);
  --accent: oklch(0.92 0.04 250);
  --accent-foreground: oklch(0.25 0.08 250);
  --teal: oklch(0.465 0.083 218);              /* #026478 accent, sparingly */

  /* Lines and focus */
  --border: oklch(0.90 0.015 250);             /* #D7DFE8 cards/dividers only */
  --input: oklch(0.62 0.025 255);              /* Drishti: = field border so shadcn `border-input` is visible */
  --ring: oklch(0.46 0.10 258);                /* #33588F 7.17:1 */

  /* Form fields — Drishti visibility tokens */
  --field: oklch(1 0 0);                        /* white fill on every surface */
  --field-border: oklch(0.62 0.025 255);        /* #7C8795 3.64:1 white, 3.19:1 canvas */
  --field-border-hover: oklch(0.52 0.04 255);   /* #5A6A80 5.50:1 */
  --field-placeholder: oklch(0.50 0.03 250);    /* #576574 5.98:1 */
  --field-readonly: oklch(0.975 0.008 250);     /* #F3F7FC, border kept */
  --field-disabled: oklch(0.955 0.012 250);     /* #EAF1F8 */
  --field-disabled-foreground: oklch(0.50 0.02 250); /* #5B646F 5.26:1 on disabled fill */

  /* Status (CKAM solids, soft fills and on-soft text) */
  --destructive: oklch(0.58 0.22 25);
  --destructive-foreground: oklch(0.99 0 0);
  --destructive-soft: oklch(0.93 0.055 25);
  --on-destructive-soft: oklch(0.50 0.18 25);
  --success: oklch(0.62 0.16 160);
  --success-foreground: oklch(0.99 0 0);       /* 3.31:1 — large/bold text only */
  --success-soft: oklch(0.94 0.045 160);
  --on-success-soft: oklch(0.45 0.12 160);
  --warning: oklch(0.78 0.15 75);
  --warning-foreground: oklch(0.22 0.06 60);
  --warning-soft: oklch(0.95 0.060 85);
  --on-warning-soft: oklch(0.47 0.10 75);
  --info: oklch(0.68 0.12 230);
  --info-foreground: oklch(0.15 0.04 240);
  --info-soft: oklch(0.93 0.045 230);
  --on-info-soft: oklch(0.45 0.11 230);

  /* Drishti: readable status text on white and >=3:1 status dots */
  --destructive-strong: oklch(0.50 0.19 25);   /* #B71824 6.63:1 */
  --success-strong: oklch(0.48 0.12 160);      /* #007145 6.07:1 */
  --warning-strong: oklch(0.50 0.11 70);       /* #8A5600 6.15:1 */
  --info-strong: oklch(0.48 0.11 235);         /* #006692 6.35:1 */
  --neutral-strong: oklch(0.55 0.02 250);      /* #69737D 4.84:1 (unknown/unsupported dot) */
  --dot-success: oklch(0.58 0.14 160);         /* #00935D 3.96:1 */
  --dot-warning: oklch(0.62 0.13 70);          /* #B77610 3.74:1 */
  --dot-info: oklch(0.56 0.12 235);            /* #007EB0 4.55:1 */
  --dot-destructive: oklch(0.58 0.22 25);      /* #DF202E 4.79:1 */

  --row-exception-bg: oklch(0.975 0.03 25);
  --row-selected-bg: oklch(0.955 0.03 218);

  /* Sidebar (CKAM) */
  --sidebar: oklch(1 0 0);
  --sidebar-foreground: oklch(0.20 0.04 250);
  --sidebar-accent: var(--primary-soft);
  --sidebar-accent-foreground: var(--primary);
  --sidebar-border: oklch(0.90 0.015 250);
  --sidebar-ring: var(--ring);

  /* Elevation and motion (CKAM) */
  --shadow-sm: 0 2px 6px oklch(0.30 0.08 250 / 0.08), 0 1px 2px oklch(0.30 0.08 250 / 0.05);
  --shadow-md: 0 8px 20px -6px oklch(0.30 0.08 250 / 0.14), 0 2px 6px oklch(0.30 0.08 250 / 0.06);
  --shadow-lg: 0 18px 40px -12px oklch(0.30 0.10 250 / 0.22), 0 4px 12px oklch(0.30 0.10 250 / 0.08);
  --dur-fast: 140ms;
  --dur-base: 220ms;
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
}

@layer base {
  * { @apply border-border outline-ring/50; }
  html { @apply font-sans; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  body { background: var(--color-muted); color: var(--color-foreground); font-size: 14px; line-height: 1.5; letter-spacing: -0.005em; }
  h1, h2, h3, h4 { letter-spacing: -0.02em; font-weight: 650; }
  h1 { font-size: 1.5rem; line-height: 1.25; }
  h2 { font-size: 1.25rem; line-height: 1.3; }
  h3 { font-size: 1.125rem; line-height: 1.35; }
}
```

Field class contract to use in `components/ui/input.tsx` (and the same for `select` trigger and `textarea`):

```
h-10 w-full rounded-sm border border-field-border bg-field px-3 text-base text-foreground md:text-sm
placeholder:text-field-placeholder
hover:border-field-border-hover
focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card
aria-invalid:border-destructive aria-invalid:ring-destructive/30
read-only:bg-field-readonly
disabled:cursor-not-allowed disabled:bg-field-disabled disabled:text-field-disabled-foreground
```

---

## 14. Missing reference

**One thing is still needed for final visual alignment: a live rendered session of the Asset Management application** (the `ckam-build` code at or after `0b8c525`, or the production URL the owner uses), opened by the owner in the built-in browser and already signed in, so that the shell, a list page with filters, a detail page, a dialog and the sign-in page can be compared side by side with Drishti at 1366×768 and 1920×1080. Everything above is from the reference's code and its stored screenshots; hover/focus/animation and real-data density have not been observed live. Until then Drishti should use the token set in §13 as the provisional light theme, and should not claim visual parity.
