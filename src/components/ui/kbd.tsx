import * as React from "react"

import { cn } from "@/lib/utils"

function KbdGroup({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-4 w-fit min-w-4 items-center justify-center gap-1 rounded-sm bg-current/15 px-1 font-sans text-[0.65rem] font-medium tracking-tight",
        "pointer-events-none select-none",
        className,
      )}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
