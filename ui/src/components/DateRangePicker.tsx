import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { fmtRangeShort } from "@/lib/format"

// A shadcn-styled date-range picker built on a portal popover (so it floats above the
// overflow-hidden card and clamps to the viewport, matching the app's other tooltips).
// Days with no recorded data (before the first check) and future days are disabled.
const WD = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1)
const sameDay = (a: Date, b: Date) => a.getTime() === b.getTime()
const daySec = (d: Date) => Math.floor(startOfDay(d).getTime() / 1000)

export function DateRangePicker({ firstTs, now, value, active, onApply }: {
  firstTs: number | null
  now: number
  value: { start: number; end: number } | null
  active: boolean
  onApply: (start: number, end: number) => void
}) {
  const wrapRef = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  const minDate = firstTs ? startOfDay(new Date(firstTs * 1000)) : null
  const maxDate = startOfDay(new Date(now * 1000))
  const noData = !minDate

  const [month, setMonth] = useState(() => monthStart(maxDate))
  const [from, setFrom] = useState<Date | null>(null)
  const [to, setTo] = useState<Date | null>(null)
  const [hov, setHov] = useState<Date | null>(null)

  const openPop = () => {
    const r = wrapRef.current?.getBoundingClientRect()
    if (r) setPos({ x: r.left, y: r.bottom + 8 })
    if (value) {
      const f = startOfDay(new Date(value.start * 1000))
      const t = startOfDay(new Date(value.end * 1000))
      setFrom(f); setTo(t); setMonth(monthStart(t))
    } else {
      setFrom(null); setTo(null); setMonth(monthStart(maxDate))
    }
    setHov(null); setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || wrapRef.current?.contains(t)) return
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

  const dayDisabled = (d: Date) =>
    !!((minDate && d.getTime() < minDate.getTime()) || d.getTime() > maxDate.getTime())

  // The range's end is the END OF THE DAY, even for today: the server clamps each
  // fetch to "now", so a range that includes today keeps rolling forward instead of
  // freezing at the moment it was picked and silently missing the rest of the day.
  const applyDay = (d: Date) => onApply(daySec(d), daySec(d) + 86399)

  const pick = (d: Date) => {
    if (dayDisabled(d)) return
    // Fresh start (no start yet, a finished range, or a click before the current start): select
    // just this one day and apply it right away, so picking a single day (e.g. "today") takes a
    // single click. The popover stays open so a later second click can extend it to a range.
    if (!from || to || d.getTime() < from.getTime()) {
      setFrom(d); setTo(null)
      applyDay(d)
      return
    }
    // Second click on / after the start: complete a multi-day range and close.
    setTo(d)
    onApply(daySec(from), daySec(d) + 86399)
    setOpen(false)
  }

  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const lead = first.getDay()
  const dim = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells: (Date | null)[] = []
  for (let i = 0; i < lead; i++) cells.push(null)
  for (let d = 1; d <= dim; d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d))

  const inRange = (d: Date) => {
    const end = to ?? hov
    if (!from || !end) return false
    const lo = Math.min(from.getTime(), end.getTime())
    const hi = Math.max(from.getTime(), end.getTime())
    return d.getTime() >= lo && d.getTime() <= hi
  }
  const isEnd = (d: Date) => (!!from && sameDay(d, from)) || (!!to && sameDay(d, to))
  const prevDisabled = minDate ? monthStart(month).getTime() <= monthStart(minDate).getTime() : true
  const nextDisabled = monthStart(month).getTime() >= monthStart(maxDate).getTime()

  return (
    <span ref={wrapRef} className="inline-flex">
      <Button
        type="button" size="sm" disabled={noData}
        variant={active ? "default" : "ghost"}
        className="h-8 gap-1.5 px-2 text-xs font-semibold sm:px-3"
        onClick={() => (open ? setOpen(false) : openPop())}
      >
        <CalendarIcon className="size-3.5" />
        {active && value ? fmtRangeShort(value.start, value.end) : "Custom"}
      </Button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          className="tip-card fixed z-50 w-[18rem] p-3 text-popover-foreground"
          style={{ left: Math.max(12, Math.min(pos.x, window.innerWidth - 288 - 12)), top: pos.y }}
        >
          <div className="mb-2 flex items-center justify-between">
            <button type="button" disabled={prevDisabled} aria-label="Previous month"
              onClick={() => setMonth(addMonths(month, -1))}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted disabled:pointer-events-none disabled:opacity-30">
              <ChevronLeft className="size-4" />
            </button>
            <span className="text-sm font-semibold">
              {month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
            </span>
            <button type="button" disabled={nextDisabled} aria-label="Next month"
              onClick={() => setMonth(addMonths(month, 1))}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted disabled:pointer-events-none disabled:opacity-30">
              <ChevronRight className="size-4" />
            </button>
          </div>
          <div className="mb-1 grid grid-cols-7 text-center text-xs font-medium text-muted-foreground">
            {WD.map((w) => <span key={w} className="flex h-6 items-center justify-center">{w}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5" onMouseLeave={() => setHov(null)}>
            {cells.map((d, i) => {
              if (!d) return <span key={i} />
              const dis = dayDisabled(d)
              const end = isEnd(d)
              const rng = !end && inRange(d)
              return (
                <button
                  key={i} type="button" disabled={dis}
                  onMouseEnter={() => from && !to && setHov(d)}
                  onClick={() => pick(d)}
                  className={`flex h-9 w-full items-center justify-center rounded-md text-sm tabular-nums outline-none transition focus-visible:ring-2 focus-visible:ring-ring ${
                    dis ? "cursor-not-allowed text-muted-foreground/25"
                      : end ? "bg-primary font-semibold text-primary-foreground"
                        : rng ? "bg-primary/20 text-foreground"
                          : "text-foreground hover:bg-muted"
                  }`}
                >
                  {d.getDate()}
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {!from ? "Pick a day" : !to ? "Click another day for a range" : fmtRangeShort(daySec(from), daySec(to))}
          </p>
        </div>,
        document.body,
      )}
    </span>
  )
}
