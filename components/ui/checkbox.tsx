import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A native checkbox (P3-0): the browser's own box (its edge is well above 3:1 on white) in the brand colour when ticked, with a solid
 * focus ring. Always pair it with a visible label, for example <label className="flex items-center gap-2"><Checkbox /> Active</label>.
 */
function Checkbox({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        "size-4 shrink-0 cursor-pointer accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed",
        className
      )}
      {...props}
    />
  )
}

export { Checkbox }
