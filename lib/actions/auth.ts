'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { getClientIp, isOverLimit, rateLimit, recordEvent } from '@/lib/rate-limit'
import { safeNext } from '@/lib/auth/safe-next'
import { passwordSchema } from '@/lib/validation/password'
import { sanitizeError } from '@/lib/observability/sanitize-error'

export type FormState = { error?: string; message?: string }

const FAIL_WINDOW_MS = 15 * 60_000

const signInSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter your e-mail address.')),
  password: z.string().min(1, 'Enter your password.'),
})

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signInSchema.safeParse({ email: formData.get('email'), password: formData.get('password') })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  const { email, password } = parsed.data

  const ip = (await getClientIp()) ?? 'noip'
  const key = `signin:${ip}:${email}`
  if (isOverLimit(key, 5)) return { error: 'Too many tries. Please wait 15 minutes and try again.' }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    recordEvent(key, FAIL_WINDOW_MS)
    return { error: 'Wrong e-mail or password.' }
  }
  redirect(safeNext(String(formData.get('next') ?? '')))
}

export async function signOut(): Promise<void> {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}

export async function forgotPassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = z.string().trim().toLowerCase().pipe(z.email()).safeParse(formData.get('email'))
  if (!parsed.success) return { error: 'Enter your e-mail address.' }
  const ip = (await getClientIp()) ?? 'noip'
  const { limited } = await rateLimit(`forgot:${ip}:${parsed.data}`, 3, 15 * 60_000)
  if (!limited) {
    const supabase = await createClient()
    const base = process.env.NEXT_PUBLIC_APP_URL ?? ''
    await supabase.auth.resetPasswordForEmail(parsed.data, { redirectTo: `${base}/auth/callback?next=/reset-password` })
  }
  // The same answer whether or not the address exists, so nobody can find out who has an account.
  return { message: 'If that e-mail has an account, we have sent a link to choose a new password.' }
}

// Used by the forced change after first sign-in and by the reset link.
export async function changePassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const parsed = passwordSchema.safeParse(formData.get('password'))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message }
  if (formData.get('password') !== formData.get('confirm')) return { error: 'The two passwords are not the same.' }

  const { error } = await supabase.auth.updateUser({ password: parsed.data })
  if (error) return { error: sanitizeError(error, { route: 'changePassword', fallback: 'Could not change the password. Please try again.' }) }

  // Only the server may clear the flag; it does so after the change succeeded.
  const admin = createAdminClient()
  const { error: flagError } = await admin.from('profiles').update({ must_reset_password: false }).eq('id', user.id)
  if (flagError) return { error: sanitizeError(flagError, { route: 'changePassword.flag' }) }
  redirect('/home')
}
