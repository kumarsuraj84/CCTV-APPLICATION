import { BRAND } from '@/lib/brand'
import { cn } from '@/lib/utils'

// The supplied transparent CityKart Drishti logo (directive "Design reference and branding"; P3-0). The FULL logo is used wherever
// there is room (sign-in and the other authentication pages, the expanded sidebar); the compact MARK only where space is short (the
// phone top bar) and for the browser icons. The files are shown exactly as supplied: never cropped, recoloured, stretched, put on a
// plate or redrawn. Only the width is set; the height follows the picture (or the reverse for the mark).

export const LOGO = {
  src: '/brand/citykart-drishti-logo.png',
  width: 1851,
  height: 849,
  // Smaller copies of the same full logo, so a 320 px logo does not download the 1 MB original.
  srcSet: '/brand/citykart-drishti-logo-462.png 462w, /brand/citykart-drishti-logo-925.png 925w, /brand/citykart-drishti-logo.png 1851w',
} as const

export const MARK = {
  src: '/brand/citykart-drishti-mark-64.png',
  width: 64,
  height: 64,
  srcSet: '/brand/citykart-drishti-mark-32.png 1x, /brand/citykart-drishti-mark-64.png 2x',
} as const

// Classes a caller may not put on the logo: a plate, frame, crop, filter or a second fixed dimension would break the rules above.
const FORBIDDEN = /^(?:[a-z0-9-]+:)*(?:bg-|ring|shadow|rounded|border|p-|px-|py-|pt-|pb-|pl-|pr-|filter|grayscale|invert|sepia|brightness|contrast|saturate|hue-rotate|opacity-|mix-blend|object-|aspect-|size-)/

function safeClasses(className: string | undefined, keep: 'width' | 'height'): string {
  const drop = keep === 'width' ? /^(?:[a-z0-9-]+:)*(?:h-|min-h-|max-h-)/ : /^(?:[a-z0-9-]+:)*(?:w-|min-w-|max-w-)/
  return (className ?? '')
    .split(/\s+/)
    .filter((c) => c && !FORBIDDEN.test(c) && !drop.test(c))
    .join(' ')
}

type Props = {
  /** "full" (default) wherever there is room; "mark" only where space is short. */
  variant?: 'full' | 'mark'
  /** Width classes for the full logo (for example `w-72`), height classes for the mark (for example `h-8`). */
  className?: string
  /** The width the full logo is shown at, so the browser picks the right file (for example `(min-width: 640px) 320px, 260px`). */
  sizes?: string
  /** Load straight away (the sign-in page). */
  priority?: boolean
}

export function BrandLogo({ variant = 'full', className, sizes, priority = false }: Props) {
  const file = variant === 'mark' ? MARK : LOGO
  return (
    // A plain <img> on purpose: the files are already made in web sizes, and the transparent PNG is served untouched (no re-encoding).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={file.src}
      srcSet={file.srcSet}
      sizes={variant === 'full' ? (sizes ?? '320px') : undefined}
      width={file.width}
      height={file.height}
      alt={BRAND.name}
      decoding="async"
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : undefined}
      draggable={false}
      className={cn(
        'block max-w-full select-none object-contain',
        variant === 'mark' ? 'h-8 w-auto' : 'h-auto',
        safeClasses(className, variant === 'mark' ? 'height' : 'width'),
      )}
    />
  )
}
