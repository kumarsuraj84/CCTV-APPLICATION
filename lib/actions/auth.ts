'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { getClientIp } from '@/lib/rate-limit'
import { refusalFor, sharedLimiter } from '@/lib/rate-limit-shared'
import { getCurrentProfile } from '@/lib/auth/profile'
import { safeNext } from '@/lib/auth/safe-next'
import { passwordSchema } from '@/lib/validation/password'
import { sanitizeError } from '@/lib/observability/sanitize-error'

export type FormState = { error?: string; message?: string }

const signInSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter your e-mail address.')),
  password: z.string().min(1, 'Enter your password.'),
})

/** The plain words for a sign-in that must wait (D-11: a rising delay, never a lockout). Not exported: a 'use server' file exports actions only. */
const signInWaitMessage =(sec: number) => `Too many wrong tries. Please wait ${sec} ${sec === 1 ? 'second' : 'seconds'} and try again.`

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signInSchema.safeParse({ email: formData.get('email'), password: formData.get('password') })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  const { email, password } = parsed.data

  // P2-6 (D-11): failures are counted for this e-mail address AND client IP in the shared limiter (every app instance); from the third,
  // the next try must wait 5 s, 10 s, 20 s ... at most 5 minutes; a successful sign-in clears them. No hard lockout: nobody can lock
  // somebody else out. The IP is known only behind TRUSTED_PROXY_HOPS trusted proxies (otherwise "noip": the delay is then per address).
  const ip = (await getClientIp()) ?? 'noip'
  const who = `${ip}|${email}`
  const limiter = sharedLimiter()
  const wait = await limiter.signInWait(who)
  if (wait > 0) return { error: signInWaitMessage(wait) }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    await limiter.signInFailed(who)
    return { error: 'Wrong e-mail or password.' }
  }
  await limiter.signInSucceeded(who)
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
  // P2-6 (D-11): three links per address and IP in 15 minutes, counted for every app instance (none is sent when the count cannot be read).
  const limited = (await refusalFor('forgot_password', `${ip}|${parsed.data}`)) !== null
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
  // Every action checks the caller first. A person who still has to choose a password has a profile; a deactivated person does not.
  if (!(await getCurrentProfile())) redirect('/login')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  // P2-6 (D-11): five changes per person in 15 minutes, for every app instance.
  const refused = await refusalFor('change_password', user.id)
  if (refused) return { error: refused }
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
