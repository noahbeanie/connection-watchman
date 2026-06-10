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
  paused?: boolean
  noData: boolean    // dominated by RECORDED no-data (gap events / pre-history), not mere check absence
  downFrac: number   // fraction of the slice's MONITORED time inside an outage (0..1)
}

type Span = { start: number; end: number }

const mergeSpans = (spans: Span[]): Span[] => {
  const iv = [...spans].sort((x, y) => x.start - y.start)
  const out: Span[] = []
  for (const sp of iv) {
    const last = out[out.length - 1]
    if (last && sp.start <= last.end) last.end = Math.max(last.end, sp.end)
    else out.push({ ...sp })
  }
  return out
}

const subtractSpans = (base: Span[], cuts: Span[]): Span[] => {
  let segs = base
  for (const c of cuts) {
    const nxt: Span[] = []
    for (const sp of segs) {
      if (c.end <= sp.start || c.start >= sp.end) { nxt.push(sp); continue }
      if (sp.start < c.start) nxt.push({ start: sp.start, end: c.start })
      if (c.end < sp.end) nxt.push({ start: c.end, end: sp.end })
    }
    segs = nxt
  }
  return segs
}

const overlapSec = (s: number, e: number, spans: { start: number; end: number }[]) =>
  spans.reduce((a, g) => a + Math.max(0, Math.min(e, g.end) - Math.max(s, g.start)), 0)

// Exact downtime spans (connectivity + DNS outages, no-data spans cut out), clipped to the
// range. During a real outage failing checks are MUCH sparser than healthy ones (each takes
// the full retry burst), so colouring by check counts alone understates downtime - these
// intervals are the truth the strip shades by. Check counts stay in as a floor because the
// outage list is capped at 200 server-side for very long ranges.
function downSpansOf(d: Pick<RangeData, "outages" | "gaps" | "start" | "end" | "now">): Span[] {
  const clip = (s: number, e: number): Span | null => {
    const a = Math.max(s, d.start), b = Math.min(e, d.end)
    return b > a ? { start: a, end: b } : null
  }
  const down = d.outages
    .filter((o) => o.kind === "net" || o.kind === "dns")
    .map((o) => clip(o.start, o.end ?? d.now))
    .filter((x): x is Span => x != null)
  const cuts = mergeSpans(d.gaps.map((g) => ({ start: g.start, end: g.end })))
  return subtractSpans(mergeSpans(down), cuts)
}

// Slice the range into fixed-width TIME segments (a classic status-page strip), then derive each
// slice's state from the checks in it AND the paused / no-data spans. Going by time (not by bucket
// index) means a paused or no-data stretch shows as itself, instead of letting an adjacent bucket's
// colour smear across the whole gap. Fewer segments on phones so bars stay tappable.
//
// Each segment is an integer number of WHOLE buckets wide and its edges are snapped to the bucket
// grid (server bucket keys are multiples of d.bucket), so every bucket belongs to exactly ONE
// segment. If slices were offset from the grid, a bucket straddling a slice edge would be counted in
// BOTH neighbours - painting a slice "partial" from a failure that actually sits in the adjacent
// minute, while the hover drill-down (which re-queries the exact slice window) shows all-green.
// Grid alignment keeps the strip and the drill-down breakdown consistent.
function toSegments(d: RangeData, target: number): Seg[] {
  const span = Math.max(1, d.end - d.start)
  const per = Math.max(1, Math.ceil(Math.round(span / d.bucket) / target)) // whole buckets per segment
  const slice = per * d.bucket
  // Anchor the grid to ABSOLUTE time (multiples of the slice width), not to the window
  // start: on the sliding LIVE view a start-anchored grid re-phases every second, which
  // shuffles checks between slices and makes empty slots appear to travel and blink.
  const gridStart = Math.floor(d.start / slice) * slice
  const n = Math.max(1, Math.ceil((d.end - gridStart) / slice))
  const pausedSpans = d.gaps.filter((g) => g.kind === "paused")
  const downSpans = downSpansOf(d)
  // Time after the newest recorded bucket isn't a gap, it just hasn't happened/landed
  // yet (the live edge runs a second or two behind): trim it instead of painting grey.
  const lastKnown = d.buckets.length ? d.buckets[d.buckets.length - 1].t + d.bucket : d.start
  const out: Seg[] = []
  for (let i = 0; i < n; i++) {
    const s = gridStart + i * slice
    if (s >= lastKnown) break
    const wEnd = s + slice                      // grid-aligned window used to assign buckets
    const e = i === n - 1 ? d.end : wEnd         // clamp only the shown end of the last segment to the range
    const bs = d.buckets.filter((b) => b.t >= s && b.t < wEnd)
    const up = bs.reduce((a, b) => a + b.up, 0)
    const total = bs.reduce((a, b) => a + b.total, 0)
    const avgs = bs.map((b) => b.avg).filter((x): x is number => x != null)
    const mins = bs.map((b) => b.min).filter((x): x is number => x != null)
    const maxs = bs.map((b) => b.max).filter((x): x is number => x != null)
    // Down fraction from the EXACT outage intervals over the slice's monitored time,
    // with the check counts as a floor (capped outage list on very long ranges).
    const gapOv = overlapSec(s, e, d.gaps)
    const preHist = d.first_ts != null ? Math.max(0, Math.min(e, d.first_ts) - s) : 0
    const unknown = gapOv + preHist
    const downOv = overlapSec(s, e, downSpans)
    const effective = Math.max(0, e - s - unknown)
    const intervalFrac = effective > 0 ? Math.min(1, downOv / effective) : 0
    const checkFrac = total > 0 ? (total - up) / total : 0
    out.push({
      t: s, end: e, up, total,
      pct: total ? (up / total) * 100 : null,
      avg: avgs.length ? Math.round((avgs.reduce((a, c) => a + c, 0) / avgs.length) * 10) / 10 : null,
      min: mins.length ? Math.min(...mins) : null,
      max: maxs.length ? Math.max(...maxs) : null,
      downFrac: Math.max(intervalFrac, checkFrac),
      // Grey/blue mean RECORDED absence (gap events, pauses, before monitoring began),
      // mirroring the availability math, where un-gapped time counts as monitored even
      // if no check landed in this exact slot (1 s cadence legitimately skips seconds).
      paused: downOv <= 0 && overlapSec(s, e, pausedSpans) >= (e - s) * 0.5,
      noData: downOv <= 0 && unknown >= (e - s) * 0.5,
    })
  }
  return out
}

function segColor(s: Seg): string {
  if (s.paused) return "var(--paused)" // monitoring was paused: not an outage
  if (s.noData) return "var(--gap-band)" // recorded gap / pre-history: genuinely unknown
  if (s.downFrac <= 0) return "var(--up)" // monitored and online (even between sparse checks)
  if (s.downFrac >= 0.999) return "var(--down)" // down the whole (monitored) slice
  // Partially down: the larger the down share of the slice, the redder (amber -> red).
  return `color-mix(in oklab, var(--down) ${Math.round(s.downFrac * 100)}%, var(--amber))`
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
  const partial = !!activeSeg && activeSeg.downFrac > 0 && activeSeg.downFrac < 0.999

  // Fetch a finer breakdown for a partial active segment (cached per segment). Bars are
  // judged by the SAME rule as the strip (failed checks OR exact outage overlap), so the
  // drill-down can never contradict the colour that invited the hover.
  useEffect(() => {
    if (!activeSeg || !partial || !fetchRange) { setMini(null); return }
    const key = activeSeg.t
    const cached = miniCache.current.get(key)
    if (cached) { setMini({ key, bars: cached }); return }
    setMini(null)
    let alive = true
    fetchRange(activeSeg.t, activeSeg.end)
      .then((rd) => {
        const downs = downSpansOf(rd)
        const bars = rd.buckets.map((b) => ({
          t: b.t + rd.bucket / 2,
          ok: !(b.total > 0 && b.up < b.total) && overlapSec(b.t, b.t + rd.bucket, downs) <= 0,
        }))
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
    const paused = !!sg.paused
    const noData = !paused && sg.noData
    const down = !paused && !noData && sg.downFrac > 0
    // DNS outages count as downtime, so they belong in the cause line too (labeled "DNS").
    const causes = down
      ? [...new Set(
          data.outages
            .filter((o) => (o.kind === "net" || o.kind === "dns")
              && o.start < sg.end && (o.end == null || o.end >= sg.t))
            .map((o) => o.cause),
        )]
      : []
    return {
      when: sg.end - sg.t > 60 ? `${fmtPt(sg.t)} - ${fmtPt(sg.end)}` : fmtPt(sg.t),
      noData, down, paused,
      status: paused ? "Paused" : noData ? "No data" : down ? (partial ? "Partial outage" : "Offline") : "Online",
      statusColor: paused ? "var(--paused)" : noData ? "var(--muted-foreground)" : down ? (partial ? "var(--amber)" : "var(--down)") : "var(--up)",
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
              className={`relative h-full min-w-[2px] flex-1 rounded-[3px] outline-none transition focus-visible:ring-2 focus-visible:ring-ring ${hot ? "z-10 brightness-125 ring-2 ring-inset ring-white/70" : "opacity-90 hover:opacity-100 hover:brightness-110"}`}
              style={{ background: c }}
            />
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
                {mini && mini.key === activeSeg.t && mini.bars.length === 0 ? (
                  <div className="flex h-7 items-center text-xs text-muted-foreground">
                    No checks landed in this slice; shaded from the exact outage record.
                  </div>
                ) : mini && mini.key === activeSeg.t ? (
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
                    <div className="mt-1 h-4 text-xs">
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
                  <div className="flex h-7 items-center text-xs text-muted-foreground">Loading breakdown</div>
                )}
              </div>
            ) : info.paused ? (
              <div className="mt-1 text-muted-foreground">Monitoring was paused for this window. Paused time is never counted as downtime.</div>
            ) : info.down ? (
              <div className="mt-1 text-muted-foreground">{info.explain || "The connection was down for this window."}</div>
            ) : info.noData ? (
              <div className="mt-1 text-muted-foreground">The monitor wasn't running for this window.</div>
            ) : (
              <div className="mt-1 text-muted-foreground">
                {info.total > 0
                  ? `All ${info.total} checks passed${info.avg != null ? ` · ${info.avg} ms` : ""}`
                  : "Monitored and online; the surrounding checks bracket this slice."}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
