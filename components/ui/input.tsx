import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

/**
 * The one field skin (P3-0; design reference §6.4 and §13 "Field class contract"): a white fill and a solid edge of at least 3:1 on
 * every surface, a darker edge on hover, a solid 2 px focus ring, a red edge for errors (the message beside it carries words and an
 * icon), a tinted read-only fill with the edge kept, and a disabled look that does not fade the whole control away.
 * Input, Select, Textarea and PasswordInput all use it, so every field in the app looks the same.
 */
export const fieldClasses =
  "w-full min-w-0 rounded-sm border border-field-border bg-field px-3 text-base text-foreground shadow-none transition-colors outline-none " +
  "hover:border-field-border-hover " +
  "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring " +
  "aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive " +
  "disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-field-border disabled:bg-field-disabled disabled:text-field-disabled-foreground " +
  "md:text-sm"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        fieldClasses,
        "h-9 py-1 placeholder:text-field-placeholder read-only:bg-field-readonly file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Input }
