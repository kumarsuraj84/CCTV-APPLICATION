import type { Metadata } from 'next'

// The product name shown in the app (directive "Design reference and branding"; P3-0). Plan 4 may move this into an admin settings screen.
export const BRAND = {
  name: 'CityKart Drishti',
  short: 'CKDRISHTI',
  subtitle: 'Cameras, devices and Wi-Fi at a glance',
} as const

// Browser title and description for every page (app/layout.tsx). A page title reads "Sign in — CityKart Drishti".
export const ROOT_METADATA = {
  title: { template: `%s — ${BRAND.name}`, default: BRAND.name },
  description: BRAND.subtitle,
  applicationName: BRAND.name,
} satisfies Metadata
