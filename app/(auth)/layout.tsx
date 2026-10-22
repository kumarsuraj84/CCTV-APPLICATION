import { BrandLogo } from '@/components/layout/BrandLogo'

// One layout for sign-in, forgot password, reset password and choose a password (P3-0): the full CityKart Drishti logo centred above
// the card, on the light page canvas. It has room at every width from 320 px phones to control-room screens without scrolling sideways.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-6 bg-muted px-4 py-8 sm:gap-7 sm:py-10">
      <BrandLogo priority className="w-[240px] sm:w-[300px] md:w-[340px]" sizes="(min-width: 768px) 340px, (min-width: 640px) 300px, 240px" />
      <div className="w-full max-w-[420px]">{children}</div>
    </main>
  )
}
