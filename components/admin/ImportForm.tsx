'use client'

import { useActionState } from 'react'
import type { ImportState } from '@/lib/actions/admin/inventory'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function ImportForm({ title, help, sampleHref, action }: {
  title: string
  help: string
  sampleHref: string
  action: (prev: ImportState, formData: FormData) => Promise<ImportState>
}) {
  const [state, formAction, pending] = useActionState<ImportState, FormData>(action, {})
  const errors = [...(state.parseErrors ?? []), ...(state.result?.errors ?? [])].sort((a, b) => a.line - b.line)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{help}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <form action={formAction} className="flex flex-wrap items-center gap-3">
          <input type="file" name="file" accept=".csv,text/csv" required className="text-sm" />
          <Button type="submit" disabled={pending}>{pending ? 'Importing…' : 'Import'}</Button>
          <a href={sampleHref} download className="text-sm underline">Download a sample file</a>
        </form>
        {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
        {state.result && (
          <p className="text-sm">
            Added {state.result.created}, updated {state.result.updated}, skipped {errors.length}.
          </p>
        )}
        {(state.result?.warnings?.length ?? 0) > 0 && (
          <ul role="status" className="space-y-1 text-sm text-amber-700">
            {state.result!.warnings!.map((w, i) => <li key={i}>Line {w.line}: {w.message}</li>)}
          </ul>
        )}
        {errors.length > 0 && (
          <div className="max-h-60 overflow-y-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr><th className="px-3 py-1.5">Line</th><th className="px-3 py-1.5">Problem</th></tr>
              </thead>
              <tbody>
                {errors.map((e, i) => (
                  <tr key={i} className="border-t"><td className="px-3 py-1.5">{e.line}</td><td className="px-3 py-1.5">{e.message}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
