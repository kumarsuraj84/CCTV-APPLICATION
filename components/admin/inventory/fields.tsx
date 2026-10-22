'use client'

import * as React from 'react'
import { FormAlert } from '@/components/ui/form-alert'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

// The field pieces of the P2-5c-1 administration forms: the label ALWAYS above the field (design reference §6.4), an optional help
// line below it (tied with aria-describedby), the one field skin (components/ui/input), and plain messages with words and an icon.

type Common = { id: string; label: string; help?: string; required?: boolean; className?: string }

function Shell({ id, label, help, required, className, children }: Common & { children: React.ReactNode }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
        {required && <span aria-hidden="true" className="text-destructive"> *</span>}
      </label>
      {children}
      {help && <p id={`${id}-help`} className="text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}

export function TextField({ id, label, help, required, className, ...props }: Common & Omit<React.ComponentProps<typeof Input>, 'id'>) {
  return (
    <Shell id={id} label={label} help={help} required={required} className={className}>
      <Input id={id} name={props.name ?? id} required={required} aria-describedby={help ? `${id}-help` : undefined} className="h-10" {...props} />
    </Shell>
  )
}

export function SelectField({ id, label, help, required, className, children, ...props }: Common & Omit<React.ComponentProps<'select'>, 'id'>) {
  return (
    <Shell id={id} label={label} help={help} required={required} className={className}>
      <Select id={id} name={props.name ?? id} required={required} aria-describedby={help ? `${id}-help` : undefined} className="h-10" {...props}>{children}</Select>
    </Shell>
  )
}

export function AreaField({ id, label, help, required, className, ...props }: Common & Omit<React.ComponentProps<'textarea'>, 'id'>) {
  return (
    <Shell id={id} label={label} help={help} required={required} className={className}>
      <Textarea id={id} name={props.name ?? id} required={required} aria-describedby={help ? `${id}-help` : undefined} {...props} />
    </Shell>
  )
}

export function CheckField({ id, label, help, ...props }: { id: string; label: string; help?: string } & Omit<React.ComponentProps<'input'>, 'id' | 'type'>) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium">
        <input id={id} name={props.name ?? id} type="checkbox" className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" {...props} />
        {label}
      </label>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}

/** The outcome of an action: an error (announced at once), a result and an optional warning (announced politely), and details. */
export function Outcome({ state }: { state: { ok?: boolean; error?: string; message?: string; warning?: string; details?: string[] } | null | undefined }) {
  return (
    <div aria-live="polite" className="space-y-2 empty:hidden">
      {state?.error && <FormAlert tone="error">{state.error}</FormAlert>}
      {state?.ok && state.message && <FormAlert tone="success">{state.message}</FormAlert>}
      {state?.ok && state.warning && <p role="status" className="rounded-md border border-warning-strong/40 bg-warning-soft/60 px-3 py-2 text-sm text-warning-strong">{state.warning}</p>}
      {state?.ok && state.details && state.details.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm">{state.details.map((d, i) => <li key={i}>{d}</li>)}</ul>
      )}
    </div>
  )
}

/** A section card of a detail page (reference §4 "Section"). */
export function Section({ id, title, description, children, actions }: { id: string; title: string; description?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3 rounded-md border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}
