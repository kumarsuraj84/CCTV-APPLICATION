import { logger } from './logger'

// The one place that turns a raw database, auth or thrown error into a short message that is safe to show.
// The real error is logged first, so nothing is lost for debugging.

export interface PgErrorLike {
  code?: string
  message?: string
}

const PG_CODE_MESSAGES: Record<string, string> = {
  '23505': 'That already exists. Please check for a duplicate and try again.',
  '23503': 'This action refers to something that no longer exists. Please refresh and try again.',
  '23502': 'A required field is missing. Please fill in all required fields and try again.',
  '23514': 'One of the values provided is not valid for this field.',
  '22P02': 'One of the values provided is not in the expected format.',
  '42501': 'You do not have permission to perform this action.',
  '40001': 'This record was changed by someone else at the same time. Please refresh and try again.',
  '55P03': 'This record is being updated elsewhere. Please try again in a moment.',
}

// Messages written for end users by the sign-in service itself.
const SAFE_AUTH_MESSAGES = new Set([
  'Invalid login credentials',
  'Email not confirmed',
  'User already registered',
  'New password should be different from the old password.',
])

const DEFAULT_MESSAGE = 'Something went wrong. Please try again, and contact support if the problem continues.'

export interface SanitizeErrorOptions {
  fallback?: string
  route?: string
  context?: Record<string, unknown>
}

const isPgErrorLike = (err: unknown): err is PgErrorLike => typeof err === 'object' && err !== null && ('code' in err || 'message' in err)

export function sanitizeError(err: unknown, opts: SanitizeErrorOptions = {}): string {
  logger.error({
    event: 'error_sanitized',
    route: opts.route,
    errorCode: isPgErrorLike(err) && typeof err.code === 'string' ? err.code : undefined,
    context: opts.context,
    error: err,
  })
  if (isPgErrorLike(err)) {
    if (err.code && PG_CODE_MESSAGES[err.code]) return PG_CODE_MESSAGES[err.code]
    if (err.message && SAFE_AUTH_MESSAGES.has(err.message)) return err.message
  }
  return opts.fallback ?? DEFAULT_MESSAGE
}
