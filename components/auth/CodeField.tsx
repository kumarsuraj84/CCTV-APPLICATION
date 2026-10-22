import { KeyRound } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * The 6-digit code of an authenticator app (P3-1): numeric keyboard on phones, filled in by the phone's one-time-code suggestion where
 * it offers one, never translated, large and spaced for reading.
 */
export function CodeField({ id = 'code', describedBy, autoFocus = true }: { id?: string; describedBy?: string; autoFocus?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>6-digit code</Label>
      <div className="relative">
        <KeyRound aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={id}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          required
          autoFocus={autoFocus}
          translate="no"
          placeholder="123 456"
          className="h-11 pl-9 font-mono text-lg tracking-[0.3em]"
          aria-describedby={describedBy}
        />
      </div>
    </div>
  )
}
