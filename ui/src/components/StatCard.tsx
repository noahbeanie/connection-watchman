import { useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import type { LucideIcon } from "lucide-react"

// Compact stat row: icon chip, label, and value on one line. Rows stack inside one
// shared panel (hairline-divided) instead of each carrying its own card chrome, so
// the gauge stays the visual anchor of the column. When a hint is given, the whole
// row is the tooltip trigger (hover or keyboard focus), no separate info icon.
export function StatCard({ icon: Icon, label, value, valueColor, accent, hint, className }: {
  icon: LucideIcon
  label: string
  value: ReactNode
  valueColor?: string
  accent?: string
  hint?: string
  className?: string
}) {
  const a = accent ?? "var(--muted-foreground)"
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)

  const show = (el: HTMLElement) => {
    if (!hint) return
    const r = el.getBoundingClientRect()
    const half = 130
    const x = Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half)
    setTip({ x, y: r.top })
  }

  return (
    <div
      className={`group relative flex flex-row items-center gap-3 px-4 py-3 outline-none transition-colors duration-200 hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03]${hint ? " cursor-help" : ""}${className ? " " + className : ""}`}
      tabIndex={hint ? 0 : undefined}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setTip(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setTip(null)}
    >
      {/* The icon chip carries the category colour; the value stays foreground so colour
          remains information (state) rather than upholstery. */}
      <span
        className="relative flex size-8 shrink-0 items-center justify-center rounded-lg"
        style={{ background: `color-mix(in oklab, ${a} 14%, transparent)`, color: a }}
      >
        <Icon className="size-4" />
      </span>
      <span className="relative text-sm font-medium text-muted-foreground">{label}</span>
      <span
        className="relative ml-auto whitespace-nowrap font-mono text-lg font-semibold tabular-nums tracking-tight"
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </span>
      {tip &&
        createPortal(
          <div
            role="tooltip"
            className="tip-card pointer-events-none fixed z-50 w-60 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 -translate-y-full p-2.5 text-xs leading-snug text-popover-foreground"
            style={{ left: tip.x, top: tip.y - 8 }}
          >
            {hint}
          </div>,
          document.body,
        )}
    </div>
  )
}
