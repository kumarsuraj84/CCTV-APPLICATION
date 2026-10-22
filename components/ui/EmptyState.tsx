import type { LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
}

// P3-1: on the design tokens (app/globals.css) instead of fixed colours, so it reads like the rest of the light theme.
export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-4 py-8 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent">
        <Icon aria-hidden="true" className="h-5 w-5 text-primary" />
      </div>
      <div className="space-y-1">
        <p className="text-[13px] font-semibold text-foreground">{title}</p>
        {description && <p className="text-[12px] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
