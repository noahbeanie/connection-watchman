import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import type { Live, Meta } from "@/lib/types"

export function StatusBadge({ live, meta }: { live: Live | null; meta: Meta | null }) {
  const [hov, setHov] = useState(false)
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
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      className="h-auto cursor-default gap-3 py-3 pl-5 pr-7 text-2xl font-semibold sm:text-3xl"
      style={{
        background: `color-mix(in oklab, ${c} ${hov ? 20 : 13}%, var(--card))`,
        color: c,
        borderColor: `color-mix(in oklab, ${c} ${hov ? 60 : 32}%, var(--border))`,
        // soft glow in the status color on hover (animated by the Badge's transition-all)
        boxShadow: hov ? `0 0 22px 2px color-mix(in oklab, ${c} 45%, transparent)` : "0 0 0 0 transparent",
      }}
    >
      <span className="relative flex size-4">
        {state === "up" && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: c }} />
        )}
        <span className="relative inline-flex size-4 rounded-full" style={{ background: c }} />
      </span>
      {text}
    </Badge>
  )
}
