import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// P3-0 (owner complaint: fields hard to see; design reference §6.4): one visible field skin on every control, labels above fields,
// a solid focus ring, and authentication forms with bound labels, autocomplete, inline errors that are announced.

vi.mock('next/navigation', () => ({ usePathname: () => '/login', redirect: vi.fn() }))
vi.mock('@/lib/actions/auth', () => ({ signIn: vi.fn(), signOut: vi.fn(), forgotPassword: vi.fn(), changePassword: vi.fn() }))

const { Input } = await import('@/components/ui/input')
const { Select } = await import('@/components/ui/select')
const { Textarea } = await import('@/components/ui/textarea')
const { Checkbox } = await import('@/components/ui/checkbox')
const { PasswordInput } = await import('@/components/ui/password-input')
const { Button } = await import('@/components/ui/button')
const { FormAlert } = await import('@/components/ui/form-alert')
const { LoginForm } = await import('@/app/(auth)/login/LoginForm')
const { ChangePasswordForm } = await import('@/app/(auth)/change-password/ChangePasswordForm')
const { ForgotPasswordForm } = await import('@/app/(auth)/forgot-password/ForgotPasswordForm')

const classOf = (html: string, tag: string) => html.match(new RegExp(`<${tag}\\b[^>]*class="([^"]*)"`))?.[1]?.split(/\s+/) ?? []

// The field contract (design reference §13 "Field class contract").
const FIELD = ['border', 'border-field-border', 'bg-field', 'hover:border-field-border-hover', 'focus-visible:border-ring', 'focus-visible:ring-2',
  'focus-visible:ring-ring', 'aria-invalid:border-destructive', 'disabled:bg-field-disabled', 'disabled:text-field-disabled-foreground', 'rounded-sm']
const NEVER = [/^border-transparent$/, /^bg-transparent$/, /^(?:[a-z-]+:)*opacity-/, /^dark:/, /^(?:[a-z-]+:)*ring-ring\/\d+$/, /^border-border$/, /^bg-muted/]

function expectFieldSkin(cls: string[], what: string) {
  for (const c of FIELD) expect(cls, `${what} needs ${c}`).toContain(c)
  for (const c of cls) for (const bad of NEVER) expect(c, `${what} must not use ${c}`).not.toMatch(bad)
}

describe('one visible field skin', () => {
  it('Input', () => {
    const cls = classOf(renderToStaticMarkup(<Input aria-label="Name" />), 'input')
    expectFieldSkin(cls, 'Input')
    expect(cls).toContain('placeholder:text-field-placeholder')
    expect(cls).toContain('read-only:bg-field-readonly')
  })

  it('Select (one dropdown look, same as Input)', () => {
    const html = renderToStaticMarkup(<Select aria-label="Role"><option>Viewer</option></Select>)
    expectFieldSkin(classOf(html, 'select'), 'Select')
    expect(classOf(html, 'select')).toContain('appearance-none')
    // The arrow is drawn by us (the native one is removed) and is decoration only.
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/)
  })

  it('Textarea', () => {
    const cls = classOf(renderToStaticMarkup(<Textarea aria-label="Notes" />), 'textarea')
    expectFieldSkin(cls, 'Textarea')
    expect(cls).toContain('placeholder:text-field-placeholder')
  })

  it('Checkbox has a visible box, the brand accent and a solid focus ring', () => {
    const html = renderToStaticMarkup(<Checkbox aria-label="Active" />)
    expect(html).toContain('type="checkbox"')
    const cls = classOf(html, 'input')
    for (const c of ['accent-primary', 'size-4', 'focus-visible:outline-2', 'focus-visible:outline-ring', 'disabled:cursor-not-allowed']) expect(cls).toContain(c)
  })

  it('PasswordInput has a show/hide button with a name and its own focus ring', () => {
    const html = renderToStaticMarkup(<PasswordInput id="pw" name="password" autoComplete="current-password" />)
    expect(html).toContain('type="password"')
    expect(html).toContain('aria-label="Show password"')
    expect(html).toContain('aria-controls="pw"')
    expect(html).toContain('aria-pressed="false"')
    expect(classOf(html, 'button')).toContain('focus-visible:ring-2')
    expectFieldSkin(classOf(html, 'input'), 'PasswordInput')
  })

  it('buttons have a solid focus ring, and the outline button has a visible edge', () => {
    const solid = classOf(renderToStaticMarkup(<Button>Save</Button>), 'button')
    expect(solid).toContain('focus-visible:ring-2')
    expect(solid).toContain('focus-visible:ring-ring')
    expect(solid.some((c) => /ring-ring\/\d+/.test(c))).toBe(false)
    expect(classOf(renderToStaticMarkup(<Button variant="outline">Cancel</Button>), 'button')).toContain('border-field-border')
  })

  it('a form error is words plus an icon, announced, never colour alone', () => {
    const html = renderToStaticMarkup(<FormAlert id="e">Wrong e-mail or password.</FormAlert>)
    expect(html).toContain('role="alert"')
    expect(html).toContain('id="e"')
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(html).toContain('Wrong e-mail or password.')
    expect(classOf(html, 'div')).toContain('border-destructive')
  })

  it('the global styles give native fields (in screens not yet moved to these components) the same visible edge', () => {
    const css = readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8')
    expect(css).toMatch(/select,\s*\n?\s*textarea\s*\{[^}]*border-color:\s*var\(--field-border\)/)
    expect(css).toMatch(/::placeholder\s*\{[^}]*color:\s*var\(--field-placeholder\);[^}]*opacity:\s*1/)
    expect(css).toMatch(/accent-color:\s*var\(--primary\)/)
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ring\)/)
    expect(css).not.toMatch(/opacity:\s*0\.6/)
  })
})

// Label `for` must point at an element id in the same markup.
function expectBoundLabels(html: string) {
  const labels = [...html.matchAll(/<label\b[^>]*for="([^"]+)"/g)].map((m) => m[1])
  expect(labels.length).toBeGreaterThan(0)
  for (const id of labels) expect(html, `label for ${id}`).toMatch(new RegExp(`<(input|select|textarea)\\b[^>]*id="${id}"`))
}

// Base UI's Input writes some attribute names as given (autoComplete, inputMode); HTML attribute names are case-insensitive, so the
// browser reads them the same. The checks below therefore ignore case.
describe('authentication forms', () => {
  it('sign-in: labelled e-mail and password with autocomplete, a large submit and an announced error area', () => {
    const html = renderToStaticMarkup(<LoginForm next="/home" />)
    expectBoundLabels(html)
    expect(html).toMatch(/<input[^>]*autocomplete="username"[^>]*type="email"|<input[^>]*type="email"[^>]*autocomplete="username"/i)
    expect(html).toMatch(/autocomplete="current-password"/i)
    expect(html).toContain('>E-mail<')
    expect(html).toContain('>Password<')
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>/)
    expect(html).toContain('Sign in')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('name="next"')
  })

  it('choose a password: two labelled new-password fields and the rule text tied to the first', () => {
    const html = renderToStaticMarkup(<ChangePasswordForm />)
    expectBoundLabels(html)
    expect(html.match(/autocomplete="new-password"/gi)).toHaveLength(2)
    expect(html).toMatch(/aria-describedby="[^"]*password-help/)
    expect(html).toContain('aria-live="polite"')
  })

  it('forgot password: labelled e-mail with autocomplete and an announced result area', () => {
    const html = renderToStaticMarkup(<ForgotPasswordForm />)
    expectBoundLabels(html)
    expect(html).toMatch(/autocomplete="email"/i)
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('href="/login"')
  })
})
