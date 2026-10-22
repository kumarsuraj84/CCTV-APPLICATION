"use client"

import * as React from "react"
import { Eye, EyeOff, Lock } from "lucide-react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

/**
 * A password field with a lock icon and a show/hide button (P3-0; design reference §5.1). The button has its own name, state and
 * focus ring; it never submits the form. The field keeps every prop it is given (name, autoComplete, aria-*).
 */
function PasswordInput({ className, id, ...props }: Omit<React.ComponentProps<"input">, "type"> & { id: string }) {
  const [shown, setShown] = React.useState(false)
  return (
    <div className="relative">
      <Lock aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input id={id} type={shown ? "text" : "password"} className={cn("pr-11 pl-9", className)} {...props} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        aria-controls={id}
        className="absolute top-1/2 right-1 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {shown ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
      </button>
    </div>
  )
}

export { PasswordInput }
