import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, X } from "lucide-react"
import { TargetSettings } from "@/components/TargetSettings"
import type { Target } from "@/lib/types"

// A compact "Custom DNS" link that opens the reachability-targets editor in a small anchored
// popover, so the editor stays out of the way until you want it (instead of a tall always-on
// panel). Flips above the trigger when there isn't room below; closes on outside-click / Escape.
export function TargetsPopover({ targets, custom, onSaved }: {
  targets: Target[]; custom: boolean; onSaved: () => void
}) {
  const wrapRef = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)

  const openPop = () => {
    const r = wrapRef.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.max(12, Math.min(r.left, window.innerWidth - 312))
    const spaceBelow = window.innerHeight - r.bottom
    setPos(spaceBelow >= 300 ? { left, top: r.bottom + 8 } : { left, bottom: window.innerHeight - r.top + 8 })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || wrapRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <span ref={wrapRef} className="inline-flex">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPop())}
        className="inline-flex items-center gap-1 rounded text-xs font-medium text-primary outline-none transition hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        Custom DNS
        <ChevronDown className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          className="tip-card fixed z-50 w-[19rem] max-w-[calc(100vw-1.5rem)] overflow-y-auto p-3 text-popover-foreground"
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: "min(70vh, 420px)" }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">Custom targets</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close"
              className="rounded p-0.5 text-muted-foreground transition hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>
          <TargetSettings targets={targets} custom={custom} onSaved={onSaved} />
        </div>,
        document.body,
      )}
    </span>
  )
}
