'use client'

import { useActionState, useId } from 'react'
import type { ImportState } from '@/lib/actions/admin/inventory'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'

// The device CSV import. Final fix Y (final review C I-8, M-18): the file input has a label; "Check the file" shows what would be
// added and changed and saves nothing; "Import" saves every row in one go, or nothing when any row has a problem. No message repeats a
// cell value.
export function ImportForm({ title, help, sampleHref, action }: {
  title: string
  help: string
  sampleHref: string
  action: (prev: ImportState, formData: FormData) => Promise<ImportState>
}) {
  const [state, formAction, pending] = useActionState<ImportState, FormData>(action, {})
  const fileId = useId()
  const errors = [...(state.parseErrors ?? []), ...(state.result?.errors ?? [])].sort((a, b) => a.line - b.line)
  const r = state.result
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{help}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <form action={formAction} className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={fileId}>CSV file (up to 5 MB)</Label>
            <input id={fileId} type="file" name="file" accept=".csv,text/csv" required className="block text-sm" />
          </div>
          <Button type="submit" name="intent" value="check" variant="outline" disabled={pending}>Check the file</Button>
          <Button type="submit" name="intent" value="import" disabled={pending}>{pending ? 'Working…' : 'Import'}</Button>
          <a href={sampleHref} download className="text-sm underline">Download a sample file</a>
        </form>
        {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
        {r && (
          <p role="status" className="text-sm">
            {errors.length > 0
              ? `Nothing was saved: ${errors.length} ${errors.length === 1 ? 'problem' : 'problems'} to fix first (listed below).`
              : r.applied
                ? `Imported: ${r.created} added, ${r.updated} changed.`
                : `Checked: ${r.created} would be added and ${r.updated} changed. Nothing is saved until you press Import.`}
          </p>
        )}
        {(state.warnings?.length ?? 0) > 0 && (
          <ul role="status" className="space-y-1 text-sm text-amber-700">
            {state.warnings!.map((w, i) => <li key={i}>Line {w.line}{w.column ? ` (${w.column})` : ''}: {w.message}</li>)}
          </ul>
        )}
        {errors.length > 0 && (
          <div className="max-h-60 overflow-y-auto rounded-lg border">
            <table className="w-full text-sm">
              <caption className="sr-only">Problems in the file</caption>
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr><th scope="col" className="px-3 py-1.5">Line</th><th scope="col" className="px-3 py-1.5">Column</th><th scope="col" className="px-3 py-1.5">Problem</th></tr>
              </thead>
              <tbody>
                {errors.map((e, i) => (
                  <tr key={i} className="border-t"><td className="px-3 py-1.5">{e.line}</td><td className="px-3 py-1.5">{e.column ?? ''}</td><td className="px-3 py-1.5">{e.message}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
