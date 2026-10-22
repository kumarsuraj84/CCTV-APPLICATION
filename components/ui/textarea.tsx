import * as React from "react"

import { cn } from "@/lib/utils"
import { fieldClasses } from "@/components/ui/input"

/** A multi-line field in the same skin as Input (P3-0). Give it a visible <Label htmlFor>. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClasses, "min-h-20 py-2 placeholder:text-field-placeholder read-only:bg-field-readonly", className)}
      {...props}
    />
  )
}

export { Textarea }
