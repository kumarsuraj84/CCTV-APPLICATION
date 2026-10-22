'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { FileCheck2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FormAlert } from '@/components/ui/form-alert'
import { applyLocationImportAction, checkLocationImportAction, type ImportApplyState, type ImportCheckState } from '@/lib/actions/admin/import-locations'
import { LOCATION_COLUMNS_HELP } from '@/lib/import/help'
import type { ImportOutcome } from '@/lib/import/locations-import'
import type { ImportPreview, PlanLocationView, PlanRecorderView } from '@/lib/import/locations-plan'
import { CheckField } from '../inventory/fields'

// The validated location import (P2-5c-2 brief item 1): choose the file → "Check the file" (validate + preview; nothing is written) →
// read the preview (problems by line and column, what happens to each location and NVR, what is not in the file) → "Import" (the same
// plan, bound to this preview, saved in one go). Passwords are never shown: only "set" or "unchanged".

const STATUS: Record<PlanLocationView['status'], string> = { create: 'New', update: 'Changes', unchanged: 'No change', skipped: 'Skipped (has a problem)' }
const NVR_ACTION: Record<PlanRecorderView['action'], string> = { create: 'new NVR', update: 'changes', unchanged: 'no change' }
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function LocationImport() {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [skip, setSkip] = useState(false)
  const [keepNames, setKeepNames] = useState(false)
  const [archive, setArchive] = useState(false)
  const [showUnchanged, setShowUnchanged] = useState(false)
  const [check, setCheck] = useState<ImportCheckState | null>(null)
  const [applied, setApplied] = useState<ImportApplyState | null>(null)
  const [pending, start] = useTransition()
  const form = (extra: Record<string, string> = {}) => {
    const f = new FormData()
    if (file) f.set('file', file)
    if (skip) f.set('skip_bad_rows', 'on')
    if (keepNames) f.set('keep_names', 'on')
    for (const [k, v] of Object.entries(extra)) f.set(k, v)
    return f
  }
  // A new file or a new choice makes the preview stale: it must be checked again before importing.
  const reset = () => {
    setCheck(null)
    setArchive(false)
  }
  const onCheck = () => start(async () => {
    setApplied(null)
    setCheck(await checkLocationImportAction(form()))
  })
  const onApply = () => start(async () => {
    if (!check?.ok) return
    const res = await applyLocationImportAction(form({ fingerprint: check.preview.fingerprint, ...(archive ? { archive: 'on' } : {}) }))
    setApplied(res)
    if (res.ok) {
      setCheck(null)
      setArchive(false)
      router.refresh()
    }
  })
  return (
    <div className="space-y-4">
      <form
        className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault()
          onCheck()
        }}
      >
        <div className="space-y-1.5">
          <label htmlFor="import-file" className="block text-sm font-medium">CSV file</label>
          <input
            id="import-file" name="file" type="file" accept=".csv,text/csv" required aria-describedby="import-file-help"
            className="block w-full rounded-sm border border-field-border bg-field px-3 py-2 text-base file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1 md:text-sm"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              reset()
              setApplied(null)
            }}
          />
          <p id="import-file-help" className="text-xs text-muted-foreground">
            {LOCATION_COLUMNS_HELP}
          </p>
        </div>
        <Button type="submit" disabled={pending || !file}>
          <FileCheck2 aria-hidden="true" />
          {pending && !check ? 'Checking…' : 'Check the file'}
        </Button>
        <div className="space-y-3 sm:col-span-2">
          <CheckField
            id="import-skip" label="Skip the rows with problems"
            help="Without this, nothing is imported while the file has a problem. With it, a location with a problem in any of its rows is left out whole and the others are imported — but a refusal by the database still stops the whole file (nothing is saved), and a file that cannot be read as a whole is never imported."
            checked={skip}
            onChange={(e) => {
              setSkip(e.currentTarget.checked)
              reset()
            }}
          />
          <CheckField
            id="import-keep-names" label="Keep the current display names"
            help="Without this, a location whose display name is still its starting value (its code) gets “CODE - City”. A display_name column is always used."
            checked={keepNames}
            onChange={(e) => {
              setKeepNames(e.currentTarget.checked)
              reset()
            }}
          />
        </div>
      </form>
      <div aria-live="polite" className="space-y-4 empty:hidden">
        {check && !check.ok && <FormAlert tone="error">{check.error}</FormAlert>}
        {applied && !applied.ok && <FormAlert tone="error">{applied.error}</FormAlert>}
        {applied?.ok && <ImportResultPanel result={applied.result} />}
        {check?.ok && (
          <PreviewPanel
            preview={check.preview} archive={archive} onArchive={setArchive} showUnchanged={showUnchanged} onShowUnchanged={setShowUnchanged}
            onApply={onApply} pending={pending} skipping={skip}
          />
        )}
      </div>
    </div>
  )
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border bg-card px-3 py-2 shadow-sm">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function IssueTable({ caption, issues, tone }: { caption: string; issues: ImportPreview['errors']; tone: 'error' | 'warning' }) {
  return (
    <div className="overflow-x-auto rounded-md border bg-card">
      <table className="w-full text-sm">
        <caption className={`px-3 pt-2 text-left text-sm font-medium ${tone === 'error' ? 'text-destructive-strong' : 'text-warning-strong'}`}>{caption}</caption>
        <thead className="text-left text-xs text-muted-foreground">
          <tr><th scope="col" className="px-3 py-2 font-medium">Line</th><th scope="col" className="px-3 py-2 font-medium">Column</th><th scope="col" className="px-3 py-2 font-medium">Reason</th></tr>
        </thead>
        <tbody>
          {issues.map((e, i) => (
            <tr key={i} className="border-t">
              <td className="px-3 py-1.5 tabular-nums">{e.line}</td>
              <td className="px-3 py-1.5 font-mono">{e.column ?? '—'}</td>
              <td className="px-3 py-1.5">{e.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RecorderLine({ r }: { r: PlanRecorderView }) {
  const what = r.action === 'update' ? `changes: ${r.changes.join(', ')}` : NVR_ACTION[r.action]
  return (
    <li>
      <span className="font-medium">{r.name}</span> <span className="text-muted-foreground">({r.host}, web port {r.http_port})</span> — {what}
      {r.matchedBy === 'primary' && ' (the location’s main NVR: its address changes)'}.
      {/* Review B-I3: never compared with the saved one — "will be set" means: written if it differs. */}
      {r.password === 'set' ? ' Password: will be set.' : ' Password: kept.'}
      {r.monitoring === 'off' && ' Monitoring: switched off.'}
      {/* Review B-M5: a new NVR says that it will be checked once the monitoring service runs. */}
      {r.monitoring === 'on' && (r.action === 'create' ? ' Monitoring: switched on (it is checked once the monitoring service runs).' : ' Monitoring: switched on.')}
      {r.camerasToAdd > 0 && r.action === 'create' && ` ${plural(r.camerasToAdd, 'camera', 'cameras')} to add.`}
    </li>
  )
}

/** The preview: counts, problems, what happens to each location, what is not in the file, and the Import button when it can apply. */
export function PreviewPanel({ preview, archive, onArchive, showUnchanged, onShowUnchanged, onApply, pending = false, skipping = false }: {
  preview: ImportPreview; archive: boolean; onArchive: (v: boolean) => void; showUnchanged: boolean; onShowUnchanged: (v: boolean) => void
  onApply?: () => void; pending?: boolean; skipping?: boolean
}) {
  const c = preview.counts
  const shown = preview.locations.filter((l) => showUnchanged || l.status !== 'unchanged')
  const unchanged = preview.locations.length - preview.locations.filter((l) => l.status !== 'unchanged').length
  // Review B-M1: "old → new" when the display name changes.
  const nameOf = (l: PlanLocationView) => (l.previousName ? `${l.previousName} → ${l.name}` : l.name)
  return (
    <section aria-labelledby="import-preview" className="space-y-3 rounded-md border bg-card p-4 shadow-sm">
      <h3 id="import-preview" className="text-base font-semibold">What the import would do</h3>
      <p className="text-sm text-muted-foreground">Nothing has been saved yet. Rows read: {preview.rows}.</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <Tile label="New locations" value={c.locationsNew} />
        <Tile label="Locations that change" value={c.locationsChanged} />
        <Tile label="Locations with no change" value={c.locationsUnchanged} />
        <Tile label="New NVRs" value={c.recordersNew} />
        <Tile label="NVRs that change" value={c.recordersChanged} />
        <Tile label="Passwords given" value={c.passwordsSet} />
        <Tile label="New cameras" value={c.camerasNew} />
        {c.camerasRelinked > 0 && <Tile label="Cameras linked again" value={c.camerasRelinked} />}
        <Tile label="New regions / clusters" value={`${c.regionsNew} / ${c.clustersNew}`} />
        {c.locationsSkipped > 0 && <Tile label="Skipped locations" value={c.locationsSkipped} />}
      </div>
      {preview.errors.length > 0 && (
        <>
          <IssueTable caption={`Problems (${preview.errors.length})`} issues={preview.errors} tone="error" />
          {!skipping && (
            <p className="text-sm">
              Nothing is imported while the file has problems. Fix them and check the file again, or choose “Skip the rows with problems” above: a
              location with a problem is then left out whole.
            </p>
          )}
        </>
      )}
      {preview.warnings.length > 0 && <IssueTable caption={`Worth a look (${preview.warnings.length}); they do not stop the import`} issues={preview.warnings} tone="warning" />}
      <div className="space-y-2">
        <CheckField id="import-show-unchanged" label={`Show the ${plural(unchanged, 'location', 'locations')} with no change too`} checked={showUnchanged} onChange={(e) => onShowUnchanged(e.currentTarget.checked)} />
        {/* Phones: one card per location; wider screens: the table. */}
        <ul className="space-y-2 sm:hidden">
          {shown.map((l) => (
            <li key={`${l.line}-${l.code}`} className="space-y-1 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span><span className="font-mono">{l.code}</span> · {nameOf(l)}</span>
                <span className="text-xs text-muted-foreground">Line {l.line}</span>
              </div>
              <p>{STATUS[l.status]}{l.changes.length > 0 && `: ${l.changes.join(', ')}`}{l.cluster ? ` · Cluster ${l.cluster}` : ''}</p>
              {l.recorders.length > 0 && <ul className="space-y-1 pl-3">{l.recorders.map((r) => <RecorderLine key={r.line} r={r} />)}</ul>}
            </li>
          ))}
          {shown.length === 0 && <li className="rounded-md border p-3 text-sm text-muted-foreground">Every location of the file is already as the file says.</li>}
        </ul>
        <div className="hidden overflow-x-auto rounded-md border sm:block">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">Locations of the file and what happens to each</caption>
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Line</th><th scope="col" className="px-3 py-2 font-medium">Code</th>
                <th scope="col" className="px-3 py-2 font-medium">Display name</th><th scope="col" className="px-3 py-2 font-medium">What happens</th>
                <th scope="col" className="px-3 py-2 font-medium">NVRs</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => (
                <tr key={`${l.line}-${l.code}`} className="border-t align-top">
                  <td className="px-3 py-2 tabular-nums">{l.line}</td>
                  <td className="px-3 py-2 font-mono">{l.code}</td>
                  <td className="px-3 py-2">{nameOf(l)}{l.cluster ? <span className="block text-xs text-muted-foreground">Cluster {l.cluster}</span> : null}</td>
                  <td className="px-3 py-2">{STATUS[l.status]}{l.changes.length > 0 && <span className="block text-xs text-muted-foreground">{l.changes.join(', ')}</span>}</td>
                  <td className="px-3 py-2">
                    {l.recorders.length === 0 ? <span className="text-muted-foreground">{l.status === 'skipped' ? '—' : 'None in the file'}</span> : (
                      <ul className="space-y-1">{l.recorders.map((r) => <RecorderLine key={r.line} r={r} />)}</ul>
                    )}
                  </td>
                </tr>
              ))}
              {shown.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">Every location of the file is already as the file says.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          onApply?.()
        }}
      >
        {preview.archive.length > 0 && (
          <div className="space-y-2 rounded-md border border-warning-strong/40 bg-warning-soft/40 p-3">
            <h4 className="text-sm font-semibold">Not in the file ({preview.archive.length})</h4>
            <p className="text-sm">These are kept as they are unless you tick the box. Archived means switched off and hidden, not deleted: history, access and passwords are kept, and they can be restored.</p>
            {/* Review B-M6: every item the tick box would archive is listed (folded away when the list is long). */}
            <details open={preview.archive.length <= 20}>
              <summary className="cursor-pointer text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                {`Show all ${plural(preview.archive.length, 'item', 'items')}`}
              </summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                {preview.archive.map((a) => <li key={`${a.kind}-${a.id}`}>{a.kind === 'location' ? 'Location' : a.kind === 'recorder' ? 'NVR' : 'Camera'} {a.label}{a.kind !== 'camera' && a.cameras > 0 ? ` (${plural(a.cameras, 'camera', 'cameras')})` : ''}</li>)}
              </ul>
            </details>
            <CheckField id="import-archive" label={`Also archive these ${plural(preview.archive.length, 'item', 'items')}`} checked={archive} onChange={(e) => onArchive(e.currentTarget.checked)} />
          </div>
        )}
        {!preview.archiveAllowed && <p className="text-sm text-muted-foreground">What is not in the file is only listed for a file without problems.</p>}
        {preview.canApply ? (
          <Button type="submit" disabled={pending}>
            <Upload aria-hidden="true" />
            {pending ? 'Importing…' : `Import${archive ? ' and archive' : ''}`}
          </Button>
        ) : (
          <p className="text-sm font-medium">{preview.errors.length > 0 ? 'Fix the problems first (or skip those rows).' : 'There is nothing in this file to import.'}</p>
        )}
      </form>
    </section>
  )
}

export function ImportResultPanel({ result }: { result: ImportOutcome }) {
  const r = result
  const lines = [
    `${plural(r.locationsCreated, 'location', 'locations')} added and ${r.locationsUpdated} changed.`,
    `${plural(r.recordersCreated, 'NVR', 'NVRs')} added and ${r.recordersUpdated} changed; ${plural(r.passwordsGiven, 'password', 'passwords')} given (write-only; one equal to the saved password is not written again).`,
    `${plural(r.camerasCreated, 'camera', 'cameras')} added${r.camerasRelinked > 0 ? `, ${r.camerasRelinked} linked again to their channel` : ''}. Their real names come from “Find cameras”.`,
    ...(r.regionsCreated + r.clustersCreated > 0 ? [`${plural(r.regionsCreated, 'region', 'regions')} and ${plural(r.clustersCreated, 'cluster', 'clusters')} made (named by their code; rename them on Regions and clusters).`] : []),
    ...(r.archived.locations + r.archived.recorders + r.archived.cameras > 0 ? [`Archived: ${plural(r.archived.locations, 'location', 'locations')}, ${plural(r.archived.recorders, 'NVR', 'NVRs')}, ${plural(r.archived.cameras, 'camera', 'cameras')}.`] : []),
  ]
  return (
    <div className="space-y-2">
      <FormAlert tone="success">Imported. Everything in the file was saved in one go.</FormAlert>
      <ul className="list-disc space-y-0.5 pl-5 text-sm">{lines.map((l) => <li key={l}>{l}</li>)}</ul>
    </div>
  )
}
