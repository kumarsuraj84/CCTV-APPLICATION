import type { Metadata } from 'next'
import { JetBrains_Mono, Manrope } from 'next/font/google'
import { Toaster } from 'sonner'
import { ROOT_METADATA } from '@/lib/brand'
import './globals.css'

const manrope = Manrope({ variable: '--font-manrope', subsets: ['latin'], display: 'swap' })
const jetbrainsMono = JetBrains_Mono({ variable: '--font-jetbrains', subsets: ['latin'], display: 'swap' })

// Title, description and app name come from lib/brand.ts; the browser icons are app/icon.png, app/icon1.png and app/apple-icon.png
// (the compact CityKart Drishti mark, copied unchanged from public/brand/).
export const metadata: Metadata = ROOT_METADATA

// One light theme only (P3-0): no theme switch and no saved theme.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${jetbrainsMono.variable} h-full antialiased`}>
      <body className="h-full">
        {children}
        <Toaster richColors position="bottom-right" />
      </body>
    </html>
  )
}
