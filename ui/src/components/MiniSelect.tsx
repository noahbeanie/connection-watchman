import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronDown } from "lucide-react"

// A tiny custom dropdown (native <select> option colours can't be styled reliably across browsers).
// Options are white; the moused-over / selected one is black. Menu is portalled so the overflow-
// hidden card can't clip it; closes on outside-click / Escape / scroll.
export function MiniSelect({ value, options, onChange, className = "" }: {
  value: string
  options: { v: string; label: string }[]
  onChange: (v: string) => void
  className?: string
}) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ left: r.left, top: r.bottom + 4, width: r.width })
    setOpen(true)
  }
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    const onScroll = () => setOpen(false)
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    window.addEventListener("scroll", onScroll, true)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("scroll", onScroll, true)
    }
  }, [open])

  const cur = options.find((o) => o.v === value)
  return (
    <>
      <button
        ref={btnRef} type="button" aria-haspopup="listbox" aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={`inline-flex items-center justify-between gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs text-foreground outline-none transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring ${className}`}
      >
        {cur?.label ?? value}
        <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef} role="listbox"
          className="fixed z-50 overflow-hidden rounded-md border border-black/10 bg-white py-1 shadow-xl"
          style={{ left: pos.left, top: pos.top, minWidth: pos.width }}
        >
          {options.map((o) => (
            <button
              key={o.v} type="button" role="option" aria-selected={o.v === value}
              onClick={() => { onChange(o.v); setOpen(false) }}
              className="block w-full px-3 py-1.5 text-left font-mono text-xs text-black transition-colors hover:bg-black hover:text-white"
            >
              {o.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
