import Link from 'next/link'
import { BrandLogo } from '@/components/layout/BrandLogo'
import { buttonVariants } from '@/components/ui/button'

export const metadata = { title: 'Page not found' }

// A wrong or old address (P3-0): the full logo, plain words and a way back. A page someone may not open says the same thing elsewhere,
// so this never tells anyone whether something exists.
export default function NotFound() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-6 bg-muted px-4 py-10 text-center">
      <BrandLogo className="w-[220px] sm:w-[280px]" sizes="(min-width: 640px) 280px, 220px" />
      <div className="w-full max-w-[420px] space-y-2 rounded-xl border bg-card px-6 py-7 shadow-[var(--shadow-md)]">
        <h1 className="text-xl font-semibold tracking-tight">This page does not exist</h1>
        <p className="text-sm text-muted-foreground">The address may be old or mistyped.</p>
        <div className="pt-3">
          <Link href="/home" className={buttonVariants()}>Go to the home page</Link>
        </div>
      </div>
    </main>
  )
}
