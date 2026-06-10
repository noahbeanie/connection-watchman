import type { CSSProperties } from "react"
import { Badge } from "@/components/ui/badge"
import type { Live, Meta } from "@/lib/types"

// Quiet status chip: ambient chrome, not a call to action. The dot is a status LED
// that softly breathes while online (suppressed under prefers-reduced-motion).
export function StatusBadge({ live, meta }: { live: Live | null; meta: Meta | null }) {
  let state: string = live?.status ?? "nodata"
  let text = "…"
  if (meta?.paused) { state = "paused"; text = "Paused" }
  else if (state === "up") text = "Online"
  else if (state === "down") text = "Offline"
  else if (state === "unknown") text = "No signal"
  else text = "No data"
  const c = state === "up" ? "var(--up)" : state === "down" ? "var(--down)" : "var(--amber)"

  return (
    <Badge
      variant="outline"
      className="h-auto shrink-0 cursor-default gap-2 py-1 pl-2.5 pr-3 text-sm font-semibold sm:py-1.5 sm:pl-3 sm:pr-3.5"
      style={{
        background: `color-mix(in oklab, ${c} 10%, transparent)`,
        color: c,
        borderColor: `color-mix(in oklab, ${c} 30%, var(--border))`,
      }}
    >
      <span
        className={`relative inline-flex size-2 rounded-full${state === "up" ? " led-pulse" : ""}`}
        style={{ background: c, "--led-c": c } as CSSProperties}
      />
      {text}
    </Badge>
  )
}
