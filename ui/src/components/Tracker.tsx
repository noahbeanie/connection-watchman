import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { CAUSE_EXPLAIN, CAUSE_LABEL, fmtDate, fmtTime, pctText } from "@/lib/format"
import type { RangeData } from "@/lib/types"

const causeColor: Record<string, string> = {
  isp: "var(--orange)", local: "var(--down)", dns: "var(--primary)", unknown: "var(--muted-foreground)",
}

interface Seg {
  t: number; end: number; up: number; total: number
  pct: number | null; avg: number | null; min: number | null; max: number | null
}

// Aggregate the adaptive buckets down to ~target fixed segments so the bar reads as a
// classic status-page tracker, regardless of how many buckets the range made. Fewer
// segments on phones so the bars stay wide enough to tap.
function toSegments(d: RangeData, target: number): Seg[] {
  const b = d.buckets
  let out: Seg[]
  if (b.length <= target) {
    out = b.map((x) => ({ t: x.t, end: 0, up: x.up, total: x.total, pct: x.pct, avg: x.avg, min: x.min, max: x.max }))
  } else {
    const group = Math.ceil(b.length / target)
    out = []
    for (let i = 0; i < b.length; i += group) {
      const g = b.slice(i, i + group)
      const up = g.reduce((s, x) => s + x.up, 0)
      const total = g.reduce((s, x) => s + x.total, 0)
      const avgs = g.map((x) => x.avg).filter((x): x is number => x != null)
      const mins = g.map((x) => x.min).filter((x): x is number => x != null)
      const maxs = g.map((x) => x.max).filter((x): x is number => x != null)
      out.push({
        t: g[0].t, end: 0, up, total,
        pct: total ? (up / total) * 100 : null,
        avg: avgs.length ? Math.round((avgs.reduce((a, c) => a + c, 0) / avgs.length) * 10) / 10 : null,
        min: mins.length ? Math.min(...mins) : null,
        max: maxs.length ? Math.max(...maxs) : null,
      })
    }
  }
  // Each segment spans from its start to the next segment's start (range end for the last).
  for (let i = 0; i < out.length; i++) out[i].end = i + 1 < out.length ? out[i + 1].t : d.end
  return out
}

function segColor(s: Seg): string {
  if (s.total === 0 || s.pct == null) return "var(--gap-band)"
  if (s.up === s.total) return "var(--up)" // every check passed
  if (s.up === 0) return "var(--down)" // every check failed
  // Partially down: the more checks failed, the redder (amber -> red by down fraction).
  const downFrac = (s.total - s.up) / s.total
  return `color-mix(in oklab, var(--down) ${Math.round(downFrac * 100)}%, var(--amber))`
}

export function Tracker({ data, hoverT, onHoverT, fetchRange }: {
  data: RangeData
  hoverT?: number | null
  onHoverT?: (t: number | null) => void
  fetchRange?: (start: number, end: number) => Promise<RangeData>
}) {
  const [hovSeg, setHovSeg] = useState<{ seg: Seg; idx: number } | null>(null)
  const [mini, setMini] = useState<{ key: number; bars: { t: number; ok: boolean }[] } | null>(null)
  const [miniHover, setMiniHover] = useState<number | null>(null)
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches)
  const miniCache = useRef(new Map<number, { t: number; ok: boolean }[]>())
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const wd = data.end - data.start > 86400
  // Fewer, wider segments on phones so each slot is tappable; desktop keeps the dense look.
  const target = narrow ? 24 : 60

  const segs = data.buckets.length ? toSegments(data, target) : []
  // Active segment: the one being hovered (interactive), else the one the shared
  // hovered time falls in (driven by the latency chart).
  const extIdx = !hovSeg && hoverT != null ? segs.findIndex((s) => hoverT >= s.t && hoverT < s.end) : -1
  const activeIdx = hovSeg ? hovSeg.idx : extIdx
  const activeSeg = hovSeg ? hovSeg.seg : extIdx >= 0 ? segs[extIdx] : null
  const interactive = !!hovSeg
  const partial = !!activeSeg && activeSeg.total > 0 && activeSeg.up > 0 && activeSeg.up < activeSeg.total

  // Fetch a finer breakdown for a partial active segment (cached per segment).
  useEffect(() => {
    if (!activeSeg || !partial || !fetchRange) { setMini(null); return }
    const key = activeSeg.t
    const cached = miniCache.current.get(key)
    if (cached) { setMini({ key, bars: cached }); return }
    setMini(null)
    let alive = true
    fetchRange(activeSeg.t, activeSeg.end)
      .then((rd) => {
        const bars = rd.buckets.map((b) => ({ t: b.t + rd.bucket / 2, ok: b.total > 0 && b.up === b.total }))
        miniCache.current.set(key, bars)
        if (alive) setMini({ key, bars })
      })
      .catch(() => {})
    return () => { alive = false }
  }, [activeSeg?.t, activeSeg?.end, partial, fetchRange])

  // Adapt the segment count to viewport width (recomputed on breakpoint change).
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)")
    const on = () => setNarrow(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])

  // Dismiss the tooltip on scroll: on touch there is no mouseleave, so a fixed-position
  // tip would otherwise hang on screen and drift as the page scrolls.
  useEffect(() => {
    const onScroll = () => {
      if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
      setHovSeg(null); setMiniHover(null); onHoverT?.(null)
    }
    window.addEventListener("scroll", onScroll, { passive: true, capture: true })
    return () => window.removeEventListener("scroll", onScroll, true)
  }, [onHoverT])

  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null } }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => { setHovSeg(null); setMiniHover(null); onHoverT?.(null) }, 220)
  }
  const openSeg = (seg: Seg, idx: number) => { cancelClose(); setHovSeg({ seg, idx }); setMiniHover(null); onHoverT?.((seg.t + seg.end) / 2) }

  if (!data.buckets.length) {
    return (
      <div className="flex h-10 items-center justify-center rounded-md bg-muted/30 text-xs text-muted-foreground">
        No data in this range yet.
      </div>
    )
  }

  // Position the tooltip above the active segment using the bar's geometry.
  let pos: { x: number; y: number } | null = null
  if (activeSeg && barRef.current && segs.length) {
    const rect = barRef.current.getBoundingClientRect()
    const half = 130
    const cx = rect.left + ((activeIdx + 0.5) / segs.length) * rect.width
    pos = { x: Math.min(Math.max(cx, half), window.innerWidth - half), y: rect.top }
  }

  const fmtPt = (t: number) => (data.bucket >= 86400 ? fmtDate(t) : fmtTime(t, wd))
  const info = activeSeg ? (() => {
    const sg = activeSeg
    const noData = sg.total === 0 || sg.pct == null
    const down = !noData && sg.up < sg.total
    const causes = down
      ? [...new Set(
          data.outages
            .filter((o) => o.kind !== "dns" && o.start < sg.end && (o.end == null || o.end >= sg.t))
            .map((o) => o.cause),
        )]
      : []
    return {
      when: sg.end - sg.t > 60 ? `${fmtPt(sg.t)} - ${fmtPt(sg.end)}` : fmtPt(sg.t),
      noData, down,
      status: noData ? "No data" : down ? (partial ? "Partial outage" : "Offline") : "Online",
      statusColor: noData ? "var(--muted-foreground)" : down ? (partial ? "var(--amber)" : "var(--down)") : "var(--up)",
      total: sg.total, avg: sg.avg,
      cause: causes[0] ?? "unknown",
      causeLabel: causes.length ? causes.map((c) => CAUSE_LABEL[c] ?? CAUSE_LABEL.unknown).join(", ") : CAUSE_LABEL.unknown,
      explain: causes.map((c) => CAUSE_EXPLAIN[c] ?? CAUSE_EXPLAIN.unknown).join(" "),
    }
  })() : null

  return (
    <div className="relative flex grow flex-col">
      <div ref={barRef} className="flex grow items-stretch gap-[2px] min-h-[64px] sm:min-h-[96px]" role="img" aria-label="Uptime timeline">
        {segs.map((s, i) => {
          const c = segColor(s)
          const hot = i === activeIdx
          return (
            <button
              key={i} type="button"
              onMouseEnter={() => openSeg(s, i)} onMouseLeave={scheduleClose}
              onFocus={() => openSeg(s, i)} onBlur={scheduleClose}
              aria-label={`${fmtTime(s.t, wd)}: ${pctText(s.pct)} uptime`}
              className={`group relative h-full min-w-[2px] flex-1 overflow-hidden rounded-[3px] outline-none transition hover:opacity-100 hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring ${hot ? "z-10 opacity-100 brightness-125 ring-2 ring-inset ring-white/70" : "opacity-90"}`}
              style={{
                background: `linear-gradient(to bottom, color-mix(in oklab, ${c} 70%, white) 0%, ${c} 46%, color-mix(in oklab, ${c} 82%, black) 100%)`,
                boxShadow: "inset 0 1px 0 0 rgba(255,255,255,0.25), inset 0 -1px 2px 0 rgba(0,0,0,0.30)",
              }}
            >
              {/* glossy top sheen */}
              <span className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/30 via-white/5 to-transparent" />
              {/* bottom inner shadow for depth */}
              <span className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/25 to-transparent" />
            </button>
          )
        })}
      </div>
      {activeSeg && pos && info &&
        createPortal(
          <div
            role="tooltip"
            className={`fixed z-50 w-60 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 -translate-y-full rounded-lg border bg-popover px-3 py-2 text-xs leading-snug text-popover-foreground shadow-xl ${interactive ? "" : "pointer-events-none"}`}
            style={{ left: pos.x, top: pos.y + 4 }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono font-semibold">{info.when}</span>
              <span className="font-semibold" style={{ color: info.statusColor }}>{info.status}</span>
            </div>
            {info.down && (
              <div className="mt-1 text-xs">
                <span className="text-muted-foreground">Cause: </span>
                <span className="font-medium" style={{ color: causeColor[info.cause] ?? causeColor.unknown }}>{info.causeLabel}</span>
              </div>
            )}
            {partial ? (
              <div className="mt-1.5">
                {mini && mini.key === activeSeg.t ? (
                  <>
                    <div className="flex h-7 items-stretch gap-[2px]">
                      {mini.bars.map((bar, j) => (
                        <button
                          key={j} type="button"
                          onMouseEnter={() => { setMiniHover(j); onHoverT?.(bar.t) }}
                          onMouseLeave={() => { setMiniHover(null); onHoverT?.((activeSeg.t + activeSeg.end) / 2) }}
                          aria-label={`${fmtTime(bar.t, wd)}: ${bar.ok ? "online" : "offline"}`}
                          className={`flex-1 rounded-[2px] outline-none transition ${miniHover === j ? "z-10 ring-2 ring-inset ring-white/80 brightness-125" : "opacity-90 hover:opacity-100"}`}
                          style={{ background: bar.ok ? "var(--up)" : "var(--down)" }}
                        />
                      ))}
                    </div>
                    {/* per-bar time/status on hover; height reserved so the bars don't shift */}
                    <div className="mt-1 h-4 text-[0.7rem]">
                      {miniHover != null && (
                        <>
                          <span className="font-mono text-muted-foreground">{fmtTime(mini.bars[miniHover].t, wd)}</span>{" "}
                          <span style={{ color: mini.bars[miniHover].ok ? "var(--up)" : "var(--down)" }}>
                            {mini.bars[miniHover].ok ? "Online" : "Offline"}
                          </span>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex h-7 items-center text-[0.7rem] text-muted-foreground/60">Loading breakdown</div>
                )}
              </div>
            ) : info.down ? (
              <div className="mt-1 text-muted-foreground">{info.explain || "The connection was down for this window."}</div>
            ) : info.noData ? (
              <div className="mt-1 text-muted-foreground">No checks were recorded in this window.</div>
            ) : (
              <div className="mt-1 text-muted-foreground">All {info.total} checks passed{info.avg != null ? ` · ${info.avg} ms` : ""}</div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
