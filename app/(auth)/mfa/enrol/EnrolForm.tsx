'use client'

import { Loader2 } from 'lucide-react'
import { useState, useTransition } from 'react'
import { confirmEnrolmentAction, startEnrolmentAction } from '@/lib/actions/mfa'
import { CodeField } from '@/components/auth/CodeField'
import { Button } from '@/components/ui/button'
import { FormAlert } from '@/components/ui/form-alert'

type Pending = { factorId: string; qrCode: string; secret: string }

/** The key in groups of four, for typing it by hand into an app. */
const grouped = (s: string) => s.replace(/(.{4})/g, '$1 ').trim()

// Setting up an authenticator app (P3-1): one button makes a new key; the QR code and the same key in letters are shown once; the first
// code from the app finishes the set-up. The key is only in this page's memory: it is not sent anywhere else and never stored by the app.
export function EnrolForm({ next }: { next: string }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, start] = useTransition()

  const begin = () =>
    start(async () => {
      setError(null)
      const r = await startEnrolmentAction()
      if (r.ok) setPending({ factorId: r.factorId, qrCode: r.qrCode, secret: r.secret })
      else setError(r.error)
    })

  const finish = (form: FormData) =>
    start(async () => {
      if (!pending) return
      setError(null)
      const r = await confirmEnrolmentAction(pending.factorId, String(form.get('code') ?? ''))
      if (r.ok) window.location.assign(next)
      else setError(r.error)
    })

  if (!pending) {
    return (
      <div className="flex flex-col gap-5">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm">
          <li>Install an authenticator app on your phone (for example Microsoft Authenticator or Google Authenticator).</li>
          <li>Choose “Set up” below and scan the code it shows with the app.</li>
          <li>Type the 6-digit code the app then shows.</li>
        </ol>
        <div aria-live="polite" className="empty:sr-only">{error && <FormAlert>{error}</FormAlert>}</div>
        <Button type="button" size="lg" className="w-full" onClick={begin} disabled={busy}>
          {busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          {busy ? 'Preparing…' : 'Set up'}
        </Button>
      </div>
    )
  }

  return (
    <form action={finish} className="flex flex-col gap-5" aria-busy={busy}>
      <div className="flex flex-col items-center gap-3">
        {/* The auth server's QR code (an SVG data address: no request leaves the page). */}
        {/* eslint-disable-next-line @next/next/no-img-element -- a data: SVG from the auth server, not an optimisable image */}
        <img src={pending.qrCode} alt="QR code to scan with your authenticator app" width={200} height={200} className="size-[200px] rounded-md border bg-white p-2" />
        <div className="w-full text-center">
          <p className="text-sm text-muted-foreground">Cannot scan it? Type this key into the app instead:</p>
          <p translate="no" className="mt-1 select-all rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all" aria-label="Key for the authenticator app">
            {grouped(pending.secret)}
          </p>
        </div>
      </div>
      <CodeField describedBy={error ? 'enrol-error' : undefined} />
      <div aria-live="polite" className="empty:sr-only">{error && <FormAlert id="enrol-error">{error}</FormAlert>}</div>
      <Button type="submit" size="lg" className="w-full" disabled={busy}>
        {busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
        {busy ? 'Checking…' : 'Finish set-up'}
      </Button>
    </form>
  )
}
