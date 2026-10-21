'use client'

import { useActionState } from 'react'
import { createUserAction, type CreateUserState } from '@/lib/actions/admin/users'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const ROLE_LABELS: Record<string, string> = {
  user: 'Viewer (sees only what is granted)',
  agent: 'Operator (viewer who can also start checks)',
  manager: 'Manager (sees everything, read-only)',
  admin: 'Administrator',
  platform_owner: 'Platform owner',
}

export function CreateUserForm({ allowedRoles, stores }: { allowedRoles: string[]; stores: { id: string; code: string; name: string }[] }) {
  const [state, action, pending] = useActionState<CreateUserState, FormData>(createUserAction, {})
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a person</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form action={action} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="full_name">Name</Label>
            <Input id="full_name" name="full_name" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">E-mail</Label>
            <Input id="email" name="email" type="email" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role">Role</Label>
            <select id="role" name="role" defaultValue="user" className="h-8 w-full rounded-lg border bg-background px-2 text-sm">
              {allowedRoles.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="store_id">Store login (optional)</Label>
            <select id="store_id" name="store_id" defaultValue="" className="h-8 w-full rounded-lg border bg-background px-2 text-sm">
              <option value="">Not a store login</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>{pending ? 'Adding…' : 'Add person'}</Button>
          </div>
        </form>
        {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
        {state.created && (
          <div className="rounded-lg border bg-muted p-3 text-sm">
            <p className="font-medium">{state.created.email} was added.</p>
            <p>One-time password: <code className="font-mono">{state.created.oneTimePassword}</code></p>
            <p className="text-muted-foreground">This is shown only once. Give it to the person. They must choose their own password the first time they sign in.</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
