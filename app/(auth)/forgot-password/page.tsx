import { AuthCard } from '../AuthCard'
import { ForgotPasswordForm } from './ForgotPasswordForm'

export const metadata = { title: 'Forgot your password' }

export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Forgot your password?" description="Enter your e-mail and we will send you a link to choose a new one.">
      <ForgotPasswordForm />
    </AuthCard>
  )
}
