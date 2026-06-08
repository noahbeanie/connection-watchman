import { useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import type { LucideIcon } from "lucide-react"
import { Card } from "@/components/ui/card"

// Compact single-row stat tile: icon, label, and value on one line. When a hint
// is given, the whole tile is the tooltip trigger (hover or keyboard focus
// anywhere on it), so there is no separate info icon.
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
    <Card
      className={`group relative flex flex-row items-center gap-3 overflow-hidden p-4 transition-colors duration-200 hover:bg-foreground/[0.03] hover:ring-foreground/20${hint ? " cursor-help" : ""}${className ? " " + className : ""}`}
      tabIndex={hint ? 0 : undefined}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setTip(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setTip(null)}
    >
      {/* soft accent glow, brightens on hover */}
      <div
        className="pointer-events-none absolute -right-8 -top-8 size-24 rounded-full opacity-50 blur-2xl transition-opacity duration-200 group-hover:opacity-90"
        style={{ background: `color-mix(in oklab, ${a} 22%, transparent)` }}
      />
      <span
        className="relative flex size-8 shrink-0 items-center justify-center rounded-lg"
        style={{ background: `color-mix(in oklab, ${a} 16%, transparent)`, color: a }}
      >
        <Icon className="size-4" />
      </span>
      <span className="relative text-sm font-medium text-muted-foreground">{label}</span>
      <span
        className="relative ml-auto font-mono text-2xl font-bold tabular-nums tracking-tight whitespace-nowrap"
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </span>
      {tip &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-50 w-60 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 -translate-y-full rounded-lg border bg-popover p-2.5 text-xs leading-snug text-popover-foreground shadow-xl"
            style={{ left: tip.x, top: tip.y - 8 }}
          >
            {hint}
          </div>,
          document.body,
        )}
    </Card>
  )
}
