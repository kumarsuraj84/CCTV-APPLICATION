import { z } from 'zod'

export const PASSWORD_HELP = 'Use at least 10 characters, with at least one letter and one number.'

export const passwordSchema = z
  .string()
  .min(10, PASSWORD_HELP)
  .max(72, 'Use 72 characters or fewer.')
  .regex(/[A-Za-z]/, PASSWORD_HELP)
  .regex(/[0-9]/, PASSWORD_HELP)
