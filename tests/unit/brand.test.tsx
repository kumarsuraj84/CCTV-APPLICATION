import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// P3-0 (directive "Design reference and branding"; tracker BR-3, BR-4, BR-5): the full transparent logo on every authentication page
// and in the shell, the compact mark only where space is short, the product name "CityKart Drishti" everywhere, one light theme.

vi.mock('next/navigation', () => ({ usePathname: () => '/home', redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/actions/auth', () => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  forgotPassword: vi.fn(),
  changePassword: vi.fn(),
}))

const { BRAND, ROOT_METADATA } = await import('@/lib/brand')
const { BrandLogo, LOGO, MARK } = await import('@/components/layout/BrandLogo')
const { default: AuthLayout } = await import('@/app/(auth)/layout')
const { AppShell } = await import('@/components/layout/AppShell')

const ROOT = path.resolve(__dirname, '../..')
const FULL_LOGO_FILES = ['/brand/citykart-drishti-logo.png', '/brand/citykart-drishti-logo-925.png', '/brand/citykart-drishti-logo-462.png']
const MARK_FILES = ['/brand/citykart-drishti-mark-32.png', '/brand/citykart-drishti-mark-64.png']

type Img = { src: string; srcset: string; alt: string; width: string; height: string; className: string }
function images(html: string): Img[] {
  return [...html.matchAll(/<img\b[^>]*>/g)].map(([tag]) => {
    const attr = (name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? ''
    return { src: attr('src'), srcset: attr('srcSet') || attr('srcset'), alt: attr('alt'), width: attr('width'), height: attr('height'), className: attr('class') }
  })
}
const fullLogos = (html: string) => images(html).filter((i) => FULL_LOGO_FILES.includes(i.src))
const marks = (html: string) => images(html).filter((i) => MARK_FILES.includes(i.src))

// A class that would put a plate behind the transparent logo, crop it, recolour it, or force a size that breaks its 1851:849 ratio.
function assertUndistorted(img: Img) {
  const cls = img.className.split(/\s+/)
  expect(cls, img.className).toContain('object-contain')
  for (const c of cls) {
    expect(c, `background/plate class ${c}`).not.toMatch(/^(?:[a-z0-9-]+:)*(bg-|ring-|shadow|rounded|border|p-|px-|py-)/)
    expect(c, `filter class ${c}`).not.toMatch(/^(?:[a-z0-9-]+:)*(filter|grayscale|invert|sepia|brightness|contrast|saturate|hue-rotate|opacity-|mix-blend|object-cover|object-fill|aspect-)/)
  }
  // Only one dimension may be fixed: the other must follow the picture (h-auto or w-auto).
  const fixedW = cls.some((c) => /^(?:[a-z0-9-]+:)*(w-(?!auto|full)|size-)/.test(c))
  const fixedH = cls.some((c) => /^(?:[a-z0-9-]+:)*(h-(?!auto)|size-)/.test(c))
  expect(fixedW && fixedH, `fixed width and height together: ${img.className}`).toBe(false)
  expect(cls.includes('h-auto') || cls.includes('w-auto'), img.className).toBe(true)
}

describe('product name', () => {
  it('is CityKart Drishti, short CKDRISHTI, with a short plain tagline', () => {
    expect(BRAND.name).toBe('CityKart Drishti')
    expect(BRAND.short).toBe('CKDRISHTI')
    expect(BRAND.subtitle).toBe('Cameras, devices and Wi-Fi at a glance')
  })

  it('names the browser title after the product', () => {
    expect(ROOT_METADATA.title).toEqual({ template: '%s — CityKart Drishti', default: 'CityKart Drishti' })
    expect(ROOT_METADATA.description).toBe(BRAND.subtitle)
    expect(ROOT_METADATA.applicationName).toBe('CityKart Drishti')
  })

  it('the old name is gone from code-controlled branding', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(tsx?|css|mjs)$/.test(name)) files.push(full)
      }
    }
    for (const dir of ['app', 'components', 'lib']) walk(path.join(ROOT, dir))
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/Network (Monitoring )?Hub/)
    expect(readFileSync(path.join(ROOT, 'README.md'), 'utf8').split('\n')[0]).toBe('# CityKart Drishti (CKDRISHTI)')
  })
})

describe('BrandLogo', () => {
  it('the full logo keeps its 1851:849 picture, alt text and every size is the full logo', () => {
    const [img] = images(renderToStaticMarkup(<BrandLogo className="w-72" sizes="288px" />))
    expect(img.src).toBe('/brand/citykart-drishti-logo.png')
    expect(img.alt).toBe('CityKart Drishti')
    expect([img.width, img.height]).toEqual(['1851', '849'])
    expect(LOGO).toMatchObject({ width: 1851, height: 849 })
    for (const candidate of img.srcset.split(',').map((s) => s.trim().split(' ')[0])) expect(FULL_LOGO_FILES).toContain(candidate)
    assertUndistorted(img)
  })

  it('the mark is a square icon used at its own ratio', () => {
    const [img] = images(renderToStaticMarkup(<BrandLogo variant="mark" />))
    expect(MARK_FILES).toContain(img.src)
    expect(img.alt).toBe('CityKart Drishti')
    expect(img.width).toBe(img.height)
    expect(MARK).toMatchObject({ width: 64, height: 64 })
    assertUndistorted(img)
  })

  it('stays transparent on a tinted container: the logo itself never gets a plate', () => {
    const html = renderToStaticMarkup(
      <div className="bg-primary-soft p-4">
        <BrandLogo className="w-64" sizes="256px" />
      </div>,
    )
    const [img] = fullLogos(html)
    assertUndistorted(img)
    expect(html).not.toMatch(/<img[^>]*style=/)
  })

  it('refuses a caller class that would distort or put a plate behind the logo', () => {
    const [img] = images(renderToStaticMarkup(<BrandLogo className="h-20 w-72 bg-white rounded-xl" sizes="288px" />))
    assertUndistorted(img)
  })
})

describe('authentication pages show the full logo', () => {
  it('every authentication page sits in the (auth) layout, and that layout shows the full logo above the form', () => {
    for (const page of ['login', 'forgot-password', 'reset-password', 'change-password']) {
      expect(statSync(path.join(ROOT, 'app', '(auth)', page, 'page.tsx')).isFile(), page).toBe(true)
    }
    const html = renderToStaticMarkup(<AuthLayout><p id="form">form</p></AuthLayout>)
    const logos = fullLogos(html)
    expect(logos).toHaveLength(1)
    assertUndistorted(logos[0])
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('id="form"'))
    expect(marks(html)).toHaveLength(0)
  })
})

describe('page not found', () => {
  it('shows the full logo and a way back, outside the shell', async () => {
    const { default: NotFound } = await import('@/app/not-found')
    const html = renderToStaticMarkup(<NotFound />)
    expect(fullLogos(html)).toHaveLength(1)
    assertUndistorted(fullLogos(html)[0])
    expect(html).toContain('href="/home"')
    expect(html).toMatch(/<h1[^>]*>This page does not exist<\/h1>/)
  })
})

describe('shell branding', () => {
  const caps = { failed: false, grants: {} }
  const render = (role: 'user' | 'operator' | 'manager' | 'admin' | 'platform_owner') =>
    renderToStaticMarkup(<AppShell profile={{ full_name: 'Asha Rao', role, capabilities: caps }}>page</AppShell>)

  it('the sidebar has the full logo and the narrow top bar has only the mark', () => {
    const html = render('user')
    expect(fullLogos(html)).toHaveLength(1)
    assertUndistorted(fullLogos(html)[0])
    expect(marks(html)).toHaveLength(1)
    assertUndistorted(marks(html)[0])
    expect(html).toContain('href="/home"')
  })

  it('the top bar shows the name, the role label and Sign out, and no theme switch', () => {
    const labels = { user: 'Viewer', operator: 'Operator', manager: 'Manager', admin: 'Administrator', platform_owner: 'Super administrator' } as const
    for (const [role, label] of Object.entries(labels)) {
      const html = render(role as keyof typeof labels)
      expect(html).toContain('Asha Rao')
      expect(html, role).toContain(`>${label}<`)
      expect(html).toContain('Sign out')
      expect(html).not.toMatch(/theme/i)
    }
  })
})

describe('one light theme', () => {
  it('nothing can switch to the unreviewed dark or alternative colour themes', () => {
    const css = readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8')
    expect(css).not.toMatch(/^\.dark\s*\{/m)
    expect(css).not.toMatch(/\[data-theme=/)
    // `dark:` utilities stay tied to a class nobody sets (without this line Tailwind would follow the computer's dark setting).
    expect(css).toContain('@custom-variant dark (&:is(.dark *));')
    const layout = readFileSync(path.join(ROOT, 'app', 'layout.tsx'), 'utf8')
    expect(layout).not.toMatch(/cctvhub-theme|classList|dangerouslySetInnerHTML|data-theme/)
    expect(() => statSync(path.join(ROOT, 'components', 'layout', 'ThemeSwitcher.tsx'))).toThrow()
  })

  it('the browser icons are the compact mark, copied unchanged', () => {
    const same = (a: string, b: string) => expect(readFileSync(path.join(ROOT, a)).equals(readFileSync(path.join(ROOT, b))), a).toBe(true)
    same('app/icon.png', 'public/brand/citykart-drishti-mark-32.png')
    same('app/icon1.png', 'public/brand/citykart-drishti-mark-64.png')
    same('app/apple-icon.png', 'public/brand/citykart-drishti-mark-180.png')
  })
})
