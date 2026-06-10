import { useEffect, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

// Small portal tooltip, Base UI friendly (no Radix). Mirrors the pattern in
// CauseLegend so the tip floats above any overflow-hidden card and stays clear
// of the screen edges. Wrap any trigger (a label, an icon, or a button).
// focusable=false omits the wrapper tab stop (use when wrapping a button, whose
// own focus still bubbles up to show the tip).
export function InfoTip({
  label, children, focusable = true, className = "",
}: {
  label: ReactNode
  children: ReactNode
  focusable?: boolean
  className?: string
}) {
  const [tip, setTip] = useState<{ x: number; y: number; below: boolean } | null>(null)

  // Dismiss on scroll so the fixed-position tip doesn't stick to the screen on touch.
  useEffect(() => {
    if (!tip) return
    const onScroll = () => setTip(null)
    window.addEventListener("scroll", onScroll, { passive: true, capture: true })
    return () => window.removeEventListener("scroll", onScroll, true)
  }, [tip])

  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const half = 130 // keep the 240px-wide tooltip clear of the viewport edges
    const x = Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half)
    // Flip below the trigger when there isn't room above it (e.g. the header status
    // badge), otherwise the tip bleeds off the top of the page.
    const below = r.top < 150
    setTip({ x, y: below ? r.bottom : r.top, below })
  }

  return (
    <span
      {...(focusable ? { tabIndex: 0 } : {})}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setTip(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setTip(null)}
      className={`inline-flex items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      {children}
      {tip &&
        createPortal(
          <div
            role="tooltip"
            className={`tip-card pointer-events-none fixed z-50 w-60 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 ${tip.below ? "" : "-translate-y-full"} p-2.5 text-xs leading-snug text-popover-foreground`}
            style={{ left: tip.x, top: tip.below ? tip.y + 8 : tip.y - 8 }}
          >
            {label}
          </div>,
          document.body,
        )}
    </span>
  )
}
