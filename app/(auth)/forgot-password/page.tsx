'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { forgotPassword, type FormState } from '@/lib/actions/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function ForgotPasswordPage() {
  const [state, action, pending] = useActionState<FormState, FormData>(forgotPassword, {})
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Choose a new password</CardTitle>
          <p className="text-sm text-muted-foreground">Enter your e-mail and we will send you a link.</p>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">E-mail</Label>
              <Input id="email" name="email" type="email" required />
            </div>
            {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
            {state.message && <p className="text-sm">{state.message}</p>}
            <Button type="submit" className="w-full" disabled={pending}>Send the link</Button>
            <Link href="/login" className="block text-center text-sm text-muted-foreground underline">Back to sign in</Link>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
