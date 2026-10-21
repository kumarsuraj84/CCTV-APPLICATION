import type { Role } from '@/lib/nav'

// Pure, so services that run without Next.js can use it too.
export const isAdminRole = (role: Role) => role === 'admin' || role === 'platform_owner'
