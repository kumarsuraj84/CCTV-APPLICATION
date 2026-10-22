'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { resetPasswordAction, setActiveAction } from '@/lib/actions/admin/users'
import { Button } from '@/components/ui/button'

export type UserRowData = {
  id: string
  email: string
  full_name: string
  role: string
  is_active: boolean
  must_reset_password: boolean
  manageable: boolean
  is_self: boolean
}

const ROLE_NAMES: Record<string, string> = { user: 'Viewer', operator: 'Operator', manager: 'Manager', admin: 'Administrator', platform_owner: 'Platform owner' }

export function UserRow({ u }: { u: UserRowData }) {
  const [pending, start] = useTransition()
  const [otp, setOtp] = useState<string | null>(null)

  const toggle = () =>
    start(async () => {
      const res = await setActiveAction(u.id, !u.is_active)
      if (res.error) toast.error(res.error)
      else toast.success(u.is_active ? 'Deactivated.' : 'Activated.')
    })

  const reset = () =>
    start(async () => {
      const res = await resetPasswordAction(u.id)
      if (res.error) toast.error(res.error)
      else setOtp(res.oneTimePassword ?? null)
    })

  return (
    <>
      <tr className="border-t">
        <td className="px-3 py-2">
          <div className="font-medium">{u.full_name || '—'}</div>
          <div className="text-xs text-muted-foreground">{u.email}</div>
        </td>
        <td className="px-3 py-2">{ROLE_NAMES[u.role] ?? u.role}</td>
        <td className="px-3 py-2">{!u.is_active ? 'Deactivated' : u.must_reset_password ? 'Waiting for first sign-in' : 'Active'}</td>
        <td className="space-x-2 px-3 py-2 text-right">
          {/* Every role gets its access from grants now, managers too (AC-8). */}
          {u.manageable && (
            <Link href={`/admin/users/${u.id}/access`} className="text-sm underline">Access</Link>
          )}
          {u.manageable && !u.is_self && (
            <>
              <Button size="sm" variant="outline" disabled={pending} onClick={reset}>Reset password</Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={toggle}>{u.is_active ? 'Deactivate' : 'Activate'}</Button>
            </>
          )}
        </td>
      </tr>
      {otp && (
        <tr className="bg-muted">
          <td colSpan={4} className="px-3 py-2 text-sm">
            New one-time password for {u.email}: <code className="font-mono">{otp}</code>. Shown only once.
          </td>
        </tr>
      )}
    </>
  )
}
