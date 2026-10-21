import { redirect } from 'next/navigation'

// The e-mailed link signs the person in through /auth/callback and sends them here; the password form is the same one.
export default function ResetPasswordPage() {
  redirect('/change-password')
}
