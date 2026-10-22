import * as React from "react"
import { CircleAlert, CircleCheck } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * An inline message on a form (P3-0): words plus an icon, never colour alone. An error is announced straight away (role="alert");
 * a result such as "we have sent a link" is announced politely (role="status"). Put it inside an aria-live region that is always
 * present so the announcement is not missed.
 */
function FormAlert({ tone = "error", className, children, ...props }: React.ComponentProps<"div"> & { tone?: "error" | "success" }) {
  const Icon = tone === "error" ? CircleAlert : CircleCheck
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm",
        tone === "error" ? "border-destructive bg-destructive-soft/40 text-destructive-strong" : "border-success-strong/40 bg-success-soft/50 text-success-strong",
        className
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </div>
  )
}

export { FormAlert }
