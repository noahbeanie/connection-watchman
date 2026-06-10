import { Badge } from "@/components/ui/badge"
import type { Live, Meta } from "@/lib/types"

// Quiet status chip: ambient chrome, not a call to action - sized like a label, no
// hover glow, with a gentle pulse on the dot (suppressed under prefers-reduced-motion).
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
      className="h-auto shrink-0 cursor-default gap-1.5 py-1 pl-2.5 pr-3 text-sm font-semibold sm:gap-2 sm:py-1.5 sm:pl-3 sm:pr-3.5 sm:text-base"
      style={{
        background: `color-mix(in oklab, ${c} 12%, var(--card))`,
        color: c,
        borderColor: `color-mix(in oklab, ${c} 32%, var(--border))`,
      }}
    >
      <span className="relative flex size-2.5">
        {state === "up" && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: c }} />
        )}
        <span className="relative inline-flex size-2.5 rounded-full" style={{ background: c }} />
      </span>
      {text}
    </Badge>
  )
}
