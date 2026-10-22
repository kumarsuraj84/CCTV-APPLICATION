import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { fieldClasses } from "@/components/ui/input"

/**
 * The one dropdown (P3-0): a native <select> (keyboard, screen readers and phones handle it well) in the same field skin as Input,
 * with our own arrow. Use it instead of a bare <select> with its own classes. Give it a visible <Label htmlFor>.
 */
function Select({ className, wrapperClassName, children, ...props }: React.ComponentProps<"select"> & { wrapperClassName?: string }) {
  return (
    <div data-slot="select-wrapper" className={cn("relative w-full", wrapperClassName)}>
      <select data-slot="select" className={cn(fieldClasses, "h-9 cursor-pointer appearance-none py-1 pr-9", className)} {...props}>
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
}

export { Select }
