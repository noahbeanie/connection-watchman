import { useState } from "react"
import { createPortal } from "react-dom"

// Legend for the outage list: the connectivity (kind "net") causes plus DNS, which is shown here
// (clearly labeled, in its own colour) but kept out of the connectivity downtime math.
const CAUSES = [
  {
    key: "isp",
    label: "ISP / Internet",
    color: "var(--orange)",
    desc: "Your router answered, but the public internet did not. The problem sits upstream with your ISP or out on the wider network, so this reflects a real loss of service.",
  },
  {
    key: "local",
    label: "Your network",
    color: "var(--down)",
    desc: "The router or local network could not be reached at all. The cause is on your side of things: the router, Wi-Fi, cabling, or the monitor's own connection to it.",
  },
  {
    key: "unknown",
    label: "Unknown",
    color: "var(--muted-foreground)",
    desc: "The connection was down but the cause could not be pinned down, for example when the router's address was not known at the moment of the check.",
  },
  {
    key: "dns",
    label: "DNS",
    color: "var(--primary)",
    desc: "Name resolution failed: websites and apps won't load on any device even though the line is technically up. Counts as downtime, but shown as its own kind (DNS) so you can tell it apart from a connectivity outage.",
  },
]

// Cause key -> description, available for reuse elsewhere.
export const CAUSE_DESC: Record<string, string> = Object.fromEntries(CAUSES.map((c) => [c.key, c.desc]))

export function CauseLegend() {
  const [tip, setTip] = useState<{ x: number; y: number; desc: string } | null>(null)

  // Position a portal tooltip just above the hovered chip, clamped to the
  // viewport so it never gets clipped by the card it lives in.
  const show = (el: HTMLElement, desc: string) => {
    const r = el.getBoundingClientRect()
    const half = 140 // keep the 256px-wide tooltip clear of the screen edges
    const x = Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half)
    setTip({ x, y: r.top, desc })
  }

  return (
    <div className="mb-4 flex flex-wrap gap-x-4 gap-y-2">
      {CAUSES.map((c) => (
        <span
          key={c.key}
          tabIndex={0}
          onMouseEnter={(e) => show(e.currentTarget, c.desc)}
          onMouseLeave={() => setTip(null)}
          onFocus={(e) => show(e.currentTarget, c.desc)}
          onBlur={() => setTip(null)}
          className="inline-flex cursor-help items-center gap-1.5 rounded text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="size-2.5 rounded-sm" style={{ background: c.color }} />
          {c.label}
        </span>
      ))}
      {tip &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-50 w-64 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 -translate-y-full rounded-lg border bg-popover p-3 text-xs leading-snug text-popover-foreground shadow-xl"
            style={{ left: tip.x, top: tip.y - 8 }}
          >
            {tip.desc}
          </div>,
          document.body,
        )}
    </div>
  )
}
