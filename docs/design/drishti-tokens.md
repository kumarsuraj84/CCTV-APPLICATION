# CityKart Drishti — design tokens and measured contrast (P3-0)

Written 2026-10-22 by work package P3-0 (brand quick pass). The tokens live in `app/globals.css` (`:root`, one light theme). They are the
CityKart Asset Management (CKAM) values from `docs/design/ASSET-MANAGEMENT-DESIGN-REFERENCE.md` §13 plus the Drishti field-visibility and
readable-status tokens. **No visual parity with Asset Management is claimed**: the reference was inspected from its code, tokens and
stored screenshots only (reference doc §1.3–1.4).

How the numbers were produced: `lib/design/contrast.ts` converts each OKLCH token to sRGB the way browsers do (OKLab → linear sRGB,
per-channel gamut clamp) and computes the WCAG 2.x contrast ratio. `tests/unit/field-contrast.test.ts` runs the same computation on the
real `app/globals.css` and fails if any field-edge, focus, placeholder or text pair drops below its threshold, so this table cannot
silently go stale. The browser check agrees: the computed field border on the live sign-in page is `lab(55.86 -1.79 -9.05)` = `#7C8795`
(`docs/drishti/evidence/p3-0/capture-report.json`).

## 1. Contrast of the final token pairs

| Pair | Foreground | On | Ratio | Needed |
|---|---|---|---|---|
| Field edge at rest | `--field-border` #7C8795 | `--field` #FFFFFF | **3.64:1** | 3:1 |
| Field edge at rest | `--field-border` #7C8795 | `--card` #FFFFFF | **3.64:1** | 3:1 |
| Field edge at rest | `--field-border` #7C8795 | `--background` #F7FBFE | **3.49:1** | 3:1 |
| Field edge at rest | `--field-border` #7C8795 | `--muted` #EAF1F8 (page canvas) | **3.19:1** | 3:1 |
| Field edge at rest | `--field-border` #7C8795 | `--popover` #FBFEFF | **3.58:1** | 3:1 |
| Field edge at rest | `--field-border` #7C8795 | `--sidebar` #FFFFFF | **3.64:1** | 3:1 |
| Field edge at rest | `--field-border` #7C8795 | `--field-readonly` #F3F7FC | **3.39:1** | 3:1 |
| Field edge at rest | `--field-border` #7C8795 | `--field-disabled` #EAF1F8 | **3.19:1** | 3:1 |
| `border-input` (= field edge) | `--input` #7C8795 | `--field` #FFFFFF | **3.64:1** | 3:1 |
| `border-input` (= field edge) | `--input` #7C8795 | `--muted` #EAF1F8 | **3.19:1** | 3:1 |
| Field edge on hover | `--field-border-hover` #5A6A80 | `--field` #FFFFFF | **5.50:1** | 3:1 |
| Field edge on hover | `--field-border-hover` #5A6A80 | `--muted` #EAF1F8 | **4.83:1** | 3:1 |
| Focus ring (2 px solid) | `--ring` #33588F | `--field` #FFFFFF | **7.17:1** | 3:1 |
| Focus ring (2 px solid) | `--ring` #33588F | `--card` #FFFFFF | **7.17:1** | 3:1 |
| Focus ring (2 px solid) | `--ring` #33588F | `--background` #F7FBFE | **6.87:1** | 3:1 |
| Focus ring (2 px solid) | `--ring` #33588F | `--muted` #EAF1F8 | **6.29:1** | 3:1 |
| Error edge | `--destructive` #DF202E | `--field` #FFFFFF | **4.79:1** | 3:1 |
| Error edge | `--destructive` #DF202E | `--muted` #EAF1F8 | **4.21:1** | 3:1 |
| Checkbox / radio accent | `--primary` #14325D | `--field` #FFFFFF | **12.77:1** | 3:1 |
| Checkbox / radio accent | `--primary` #14325D | `--muted` #EAF1F8 | **11.21:1** | 3:1 |
| Placeholder | `--field-placeholder` #576574 | `--field` #FFFFFF | **5.98:1** | 4.5:1 |
| Placeholder | `--field-placeholder` #576574 | `--field-readonly` #F3F7FC | **5.57:1** | 4.5:1 |
| Placeholder (muted text) | `--muted-foreground` #425468 | `--field` #FFFFFF | **7.74:1** | 4.5:1 |
| Typed text | `--foreground` #071727 | `--field` #FFFFFF | **18.09:1** | 4.5:1 |
| Typed text | `--foreground` #071727 | `--muted` #EAF1F8 | **15.88:1** | 4.5:1 |
| Labels / secondary text | `--muted-foreground` #425468 | `--card` #FFFFFF | **7.74:1** | 4.5:1 |
| Labels / secondary text | `--muted-foreground` #425468 | `--background` #F7FBFE | **7.42:1** | 4.5:1 |
| Labels / secondary text | `--muted-foreground` #425468 | `--muted` #EAF1F8 | **6.80:1** | 4.5:1 |
| Disabled field text | `--field-disabled-foreground` #5B646F | `--field-disabled` #EAF1F8 | **5.26:1** | 4.5:1 |
| Error text | `--destructive` #DF202E | `--card` #FFFFFF | **4.79:1** | 4.5:1 |
| Error text (form alert) | `--destructive-strong` #B71824 | `--card` #FFFFFF | **6.63:1** | 4.5:1 |
| Error text (form alert) | `--destructive-strong` #B71824 | `--destructive-soft` #FFDAD6 | **5.15:1** | 4.5:1 |
| Primary button text | `--primary-foreground` #FCFCFC | `--primary` #14325D | **12.40:1** | 4.5:1 |
| Active navigation text | `--sidebar-accent-foreground` #14325D | `--sidebar-accent` #DEE9F9 | **10.40:1** | 4.5:1 |

Before P3-0 (reference doc §6.3): field edge `#E3E9F0` was **1.22:1** on white and **1.12:1** on the page; the `input-field` placeholder
was **2.28:1**; the dark theme's fields were **1.38 / 1.08:1**. Those are gone.

Known weak pairs that are *not* used for text or field edges (kept from CKAM, documented so nobody uses them that way): `--success`
#00A263 with white text 3.31:1 (large/bold only), `--warning` #EFA831 and `--info` #32A5D4 as dots or text on white (2.04 / 2.81:1) —
use `--*-strong` for text and `--dot-*` for dots instead. `--border` #D7DFE8 (1.35:1) is for card edges and dividers only.

## 2. Field rules applied (globally)

- Components: `components/ui/input.tsx` exports `fieldClasses`, used by `Input`, `Select` (native, our arrow), `Textarea` and
  `PasswordInput`: white fill, 1 px `--field-border`, `--field-border-hover` on hover, focus = `--ring` border + 2 px solid `--ring` ring,
  `aria-invalid` = red border + 1 px red ring (the message beside it has words and an icon: `components/ui/form-alert.tsx`), read-only
  `--field-readonly` with the edge kept, disabled `--field-disabled` + `--field-disabled-foreground` (no whole-control fade).
  `Checkbox` is a native box with `accent-color: --primary` and a solid focus outline.
- Global base layer (`app/globals.css`): every native text input, `<select>` and `<textarea>` — including screens that still use a bare
  native control with their own classes — gets the visible edge, white fill, hover and disabled looks; `::placeholder` uses
  `--field-placeholder` at full opacity; checkboxes/radios get the brand accent; anything focused with the keyboard gets a 2 px solid
  `--ring` outline unless its component draws its own ring.
- Buttons: 2 px solid ring with a 2 px gap; the outline button's edge is `--field-border` (visible), heights line up with fields (h-9).
- One light theme: the alternative colour themes and the `.dark` set were deleted, the theme switch and the saved-theme script were
  removed. `@custom-variant dark (&:is(.dark *))` is kept so leftover `dark:` utilities stay inert (without it Tailwind would follow the
  computer's dark setting). A reviewed dark set can come back by redefining the same variables under `.dark`.

## 3. Final token table (`app/globals.css :root`)

| Token | Value | sRGB |
|---|---|---|
| `--background` | `oklch(0.985 0.006 240)` | `#F7FBFE` |
| `--foreground` | `oklch(0.20 0.04 250)` | `#071727` |
| `--card` | `oklch(1 0 0)` | `#FFFFFF` |
| `--card-foreground` | `oklch(0.20 0.04 250)` | `#071727` |
| `--popover` | `oklch(0.995 0.004 240)` | `#FBFEFF` |
| `--popover-foreground` | `oklch(0.20 0.04 250)` | `#071727` |
| `--muted` (page canvas) | `oklch(0.955 0.012 250)` | `#EAF1F8` |
| `--muted-foreground` | `oklch(0.44 0.04 250)` | `#425468` |
| `--primary` | `oklch(0.32 0.085 258)` | `#14325D` |
| `--primary-foreground` | `oklch(0.99 0 0)` | `#FCFCFC` |
| `--primary-soft` | `oklch(0.93 0.025 258)` | `#DEE9F9` |
| `--primary-glow` | `oklch(0.46 0.10 258)` | `#33588F` |
| `--secondary` | `oklch(0.94 0.02 250)` | `#E2EDF8` |
| `--secondary-foreground` | `oklch(0.25 0.06 250)` | `#06233D` |
| `--accent` | `oklch(0.92 0.04 250)` | `#D1E7FF` |
| `--accent-foreground` | `oklch(0.25 0.08 250)` | `#002246` |
| `--teal` | `oklch(0.465 0.083 218)` | `#026478` |
| `--border` | `oklch(0.90 0.015 250)` | `#D7DFE8` |
| `--input` | `oklch(0.62 0.025 255)` | `#7C8795` |
| `--ring` | `oklch(0.46 0.10 258)` | `#33588F` |
| `--field` | `oklch(1 0 0)` | `#FFFFFF` |
| `--field-border` | `oklch(0.62 0.025 255)` | `#7C8795` |
| `--field-border-hover` | `oklch(0.52 0.04 255)` | `#5A6A80` |
| `--field-placeholder` | `oklch(0.50 0.03 250)` | `#576574` |
| `--field-readonly` | `oklch(0.975 0.008 250)` | `#F3F7FC` |
| `--field-disabled` | `oklch(0.955 0.012 250)` | `#EAF1F8` |
| `--field-disabled-foreground` | `oklch(0.50 0.02 250)` | `#5B646F` |
| `--destructive` | `oklch(0.58 0.22 25)` | `#DF202E` |
| `--destructive-foreground` | `oklch(0.99 0 0)` | `#FCFCFC` |
| `--destructive-soft` | `oklch(0.93 0.055 25)` | `#FFDAD6` |
| `--on-destructive-soft` | `oklch(0.50 0.18 25)` | `#B32228` |
| `--success` | `oklch(0.62 0.16 160)` | `#00A263` |
| `--success-foreground` | `oklch(0.99 0 0)` | `#FCFCFC` |
| `--success-soft` | `oklch(0.94 0.045 160)` | `#D2F5E1` |
| `--on-success-soft` | `oklch(0.45 0.12 160)` | `#00683D` |
| `--warning` | `oklch(0.78 0.15 75)` | `#EFA831` |
| `--warning-foreground` | `oklch(0.22 0.06 60)` | `#2E1200` |
| `--warning-soft` | `oklch(0.95 0.060 85)` | `#FFECC1` |
| `--on-warning-soft` | `oklch(0.47 0.10 75)` | `#7B5100` |
| `--info` | `oklch(0.68 0.12 230)` | `#32A5D4` |
| `--info-foreground` | `oklch(0.15 0.04 240)` | `#000D1A` |
| `--info-soft` | `oklch(0.93 0.045 230)` | `#CAEEFF` |
| `--on-info-soft` | `oklch(0.45 0.11 230)` | `#005F86` |
| `--destructive-strong` | `oklch(0.50 0.19 25)` | `#B71824` |
| `--success-strong` | `oklch(0.48 0.12 160)` | `#007145` |
| `--warning-strong` | `oklch(0.50 0.11 70)` | `#8A5600` |
| `--info-strong` | `oklch(0.48 0.11 235)` | `#006692` |
| `--neutral-strong` | `oklch(0.55 0.02 250)` | `#69737D` |
| `--dot-success` | `oklch(0.58 0.14 160)` | `#00935D` |
| `--dot-warning` | `oklch(0.62 0.13 70)` | `#B77610` |
| `--dot-info` | `oklch(0.56 0.12 235)` | `#007EB0` |
| `--dot-destructive` | `oklch(0.58 0.22 25)` | `#DF202E` |
| `--row-exception-bg` | `oklch(0.975 0.03 25)` | `#FFF0ED` |
| `--row-selected-bg` | `oklch(0.955 0.03 218)` | `#DBF6FE` |
| `--sidebar` | `oklch(1 0 0)` | `#FFFFFF` |
| `--sidebar-foreground` | `oklch(0.20 0.04 250)` | `#071727` |
| `--sidebar-primary` | `var(--primary)` | `#14325D` |
| `--sidebar-primary-foreground` | `var(--primary-foreground)` | `#FCFCFC` |
| `--sidebar-accent` | `var(--primary-soft)` | `#DEE9F9` |
| `--sidebar-accent-foreground` | `var(--primary)` | `#14325D` |
| `--sidebar-border` | `oklch(0.90 0.015 250)` | `#D7DFE8` |
| `--sidebar-ring` | `var(--ring)` | `#33588F` |
| `--sidebar-active` | `var(--primary-soft)` | `#DEE9F9` |
| `--sidebar-muted` | `var(--muted-foreground)` | `#425468` |
| Older names `--surface`, `--surface-raised`, `--ink`, `--ink-soft`, `--peach`, `--mint`, `--sky`, `--chart-1..5` | aliases of the tokens above | — |

Radius `--radius: 0.75rem` (sm 8 px fields, md 10 px buttons/cards, lg 12 px dialogs, xl 16 px auth card); shadows `--shadow-sm/md/lg` and
motion `--dur-fast 140ms`, `--dur-base 220ms` as CKAM. Fonts are unchanged in P3-0 (Manrope / JetBrains Mono via `next/font`); the CKAM
Inter / IBM Plex Mono switch is left to WP-3.1 so this pass does not change text metrics across every screen at once.

## 4. Logo usage

- Full logo `public/brand/citykart-drishti-logo.png` (1851×849, RGBA, transparent corners — decoded in `tests/unit/brand-assets.test.ts`)
  with the `-925` / `-462` web copies in `srcset`, through `components/layout/BrandLogo.tsx`: sign-in, forgot password, reset password
  (redirects into those pages), choose a password, page not found (240–340 px wide), and the desktop sidebar header (184 px). Only the
  width is set; the height follows (measured ratio 2.179 in every browser capture). The component drops caller classes that would add
  a plate, crop, filter or a second fixed dimension.
- Compact mark `citykart-drishti-mark-64/32.png` only in the phone top bar (32 px, below the `md` breakpoint where the sidebar is hidden)
  and as the browser icons (`app/icon.png` = mark-32, `app/icon1.png` = mark-64, `app/apple-icon.png` = mark-180, byte-identical copies).
- `proxy.ts` lets image files directly inside `/brand/` load before sign-in (the logo was otherwise redirected to `/login`).
