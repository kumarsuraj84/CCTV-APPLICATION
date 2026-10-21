import type { Metadata } from 'next'
import { JetBrains_Mono, Manrope } from 'next/font/google'
import { Toaster } from 'sonner'
import { BRAND } from '@/lib/brand'
import './globals.css'

const manrope = Manrope({ variable: '--font-manrope', subsets: ['latin'], display: 'swap' })
const jetbrainsMono = JetBrains_Mono({ variable: '--font-jetbrains', subsets: ['latin'], display: 'swap' })

export const metadata: Metadata = {
  title: { template: `%s — ${BRAND.short}`, default: BRAND.name },
  description: BRAND.subtitle,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning className={`${manrope.variable} ${jetbrainsMono.variable} h-full antialiased`}>
      <head>
        {/* Apply the saved theme before the first paint so the page does not flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var v=localStorage.getItem('cctvhub-theme')||'light';var r=document.documentElement;r.setAttribute('data-theme',v);r.classList.toggle('dark',v==='dark');}catch(e){}})()`,
          }}
        />
      </head>
      <body className="h-full">
        {children}
        <Toaster richColors position="bottom-right" />
      </body>
    </html>
  )
}
