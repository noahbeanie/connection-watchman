import { useEffect, useRef, useState, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { Area, AreaChart, CartesianGrid, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { LAT_BAD, fmtTime, latGradientStops, latencyColor, latencyFence } from "@/lib/format"
import type { RangeData } from "@/lib/types"

const config = { avg: { label: "Latency", color: "var(--lat-line)" } } satisfies ChartConfig

// Time spans (seconds) of connectivity outages, to shade red on the latency chart. A bucket
// is an outage when some or all of its checks were down (up < total); fully-up buckets (even
// very slow ones) and no-data gaps (total 0) are not outages. Adjacent outage buckets merge.
function outageSpans(buckets: RangeData["buckets"], bucket: number): { x1: number; x2: number }[] {
  const spans: { x1: number; x2: number }[] = []
  let start: number | null = null
  let end = 0
  for (const b of buckets) {
    if (b.total > 0 && b.up < b.total) {
      if (start == null) start = b.t
      end = b.t + bucket
    } else if (start != null) {
      spans.push({ x1: start, x2: end })
      start = null
    }
  }
  if (start != null) spans.push({ x1: start, x2: end })
  return spans
}

// Monotone cubic path through the points (Fritsch-Carlson tangents, the same family
// recharts' "monotone" uses): corners are rounded but the curve passes through every
// data value with NO overshoot, so a latency spike's height is never exaggerated or
// shaved by the smoothing.
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 3) {
    return pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
  }
  const n = pts.length
  const dx: number[] = [], d: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x)
    d.push((pts[i + 1].y - pts[i].y) / (dx[i] || 1e-6))
  }
  const m: number[] = [d[0]]
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2)
  m.push(d[n - 2])
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i] }
  }
  let path = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3
    path += ` C${(pts[i].x + h).toFixed(1)},${(pts[i].y + m[i] * h).toFixed(1)}`
      + ` ${(pts[i + 1].x - h).toFixed(1)},${(pts[i + 1].y - m[i + 1] * h).toFixed(1)}`
      + ` ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`
  }
  return path
}

// Conveyor-belt live chart. The window is fetched one second behind the clock (see
// windowFor), so the newest bucket is always committed before it scrolls into view; the
// plot is rendered one tick WIDER than the viewport and slides left via a GPU-composited
// CSS transform over each 1 s data tick - continuous 60 fps motion with one render per
// second. Recharts can't do this without its y-axis riding the belt, so the live view
// uses this purpose-built SVG (same visual language) and a static y gutter.
export function LiveTicker({ data }: { data: RangeData }) {
  const [slid, setSlid] = useState(false)
  const T = Math.max(2, data.end - data.start)
  useEffect(() => {
    // New window: snap the belt to 0 without transition, then (two frames later, so the
    // snap has painted) start the 1 s linear slide toward the next tick.
    setSlid(false)
    let r2 = 0
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setSlid(true)) })
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2) }
  }, [data.end])

  const W = 1000, H = 100, PAD = 6
  const vals = data.buckets
    .filter((b) => b.avg != null)
    .map((b) => ({ t: b.t + data.bucket / 2, v: b.avg as number }))
  if (!vals.length) {
    return (
      <div className="flex grow min-h-[150px] items-center justify-center text-sm text-muted-foreground">
        Waiting for live samples…
      </div>
    )
  }
  const fence = latencyFence(vals.map((p) => p.v))
  const realMax = Math.max(...vals.map((p) => p.v))
  let maxL = fence === Infinity
    ? Math.max(20, Math.ceil(realMax / 10) * 10)
    : Math.max(80, Math.ceil(fence / 10) * 10)
  // Spikes peg at the ceiling rather than stretching the axis; when they do, the ceiling
  // rises just enough to reach the red zone (never past LAT_BAD), so an off-scale spike
  // always LOOKS red while a 5000 ms monster still can't blow out the scale. The exact
  // number lives in the tooltip.
  if (realMax > maxL && maxL < LAT_BAD) maxL = Math.min(LAT_BAD, Math.ceil(realMax / 10) * 10)
  const x = (t: number) => ((t - data.start) / T) * W
  const y = (v: number) => PAD + (1 - Math.max(0, Math.min(v, maxL)) / maxL) * (H - PAD)

  // Rolling least-squares trend over the window, drawn neutral and dashed like the big
  // chart's. Over two minutes it mostly hugs the average; its value is the moment it
  // starts tilting during a degradation.
  let trend: { x0: number; y0: number; x1: number; y1: number } | null = null
  if (vals.length >= 2) {
    const n = vals.length
    const cv = vals.map((p) => ({ t: p.t, v: Math.min(p.v, maxL) }))
    const mx = cv.reduce((a, p) => a + p.t, 0) / n
    const my = cv.reduce((a, p) => a + p.v, 0) / n
    let num = 0, den = 0
    for (const p of cv) { num += (p.t - mx) * (p.v - my); den += (p.t - mx) ** 2 }
    const slope = den ? num / den : 0
    const b0 = my - slope * mx
    const t0 = cv[0].t, t1 = cv[cv.length - 1].t
    trend = { x0: x(t0), y0: y(slope * t0 + b0), x1: x(t1), y1: y(slope * t1 + b0) }
  }

  // Bands: outage buckets red, recorded gaps grey, paused blue - same language as the
  // main chart, clipped to the window.
  const bands = outageSpans(data.buckets, data.bucket)
    .map((b) => ({ x1: b.x1, x2: b.x2, c: "var(--down)", o: 0.3 }))
    .concat(data.gaps.map((g) => ({
      x1: g.start, x2: g.end,
      c: g.kind === "paused" ? "var(--paused)" : "var(--gap-band)",
      o: g.kind === "paused" ? 0.22 : 0.6,
    })))
    .map((b) => ({ ...b, x1: Math.max(b.x1, data.start), x2: Math.min(b.x2, data.end) }))
    .filter((b) => b.x2 > b.x1)

  // Line runs: bridge micro-holes (a 1 s cadence legitimately skips the odd second;
  // dashed flicker on a moving belt would read as packet loss), split on real holes.
  const runs: { t: number; v: number }[][] = []
  {
    let run: { t: number; v: number }[] = []
    for (const p of vals) {
      if (run.length && p.t - run[run.length - 1].t > data.bucket * 2.5) { runs.push(run); run = [] }
      run.push(p)
    }
    if (run.length) runs.push(run)
  }
  const segs: string[] = []
  const areas: string[] = []
  const dots: { cx: number; cy: number }[] = []
  for (const r of runs) {
    if (r.length >= 2) {
      const d = smoothPath(r.map((p) => ({ x: x(p.t), y: y(p.v) })))
      segs.push(d)
      areas.push(`${d} L${x(r[r.length - 1].t).toFixed(1)},${H} L${x(r[0].t).toFixed(1)},${H} Z`)
    } else {
      dots.push({ cx: x(r[0].t), cy: y(r[0].v) }) // a lone sample between holes still gets a mark
    }
  }
  // Dashed connectors across holes that are bracketed by passing checks and covered by
  // no band: the line was up the whole time (the checks on both sides prove it), the
  // monitor just spent those seconds waiting out a slow probe cycle. Faint and dashed
  // so sampled line and bridged hole stay distinct; outages/gaps stay true breaks.
  const connectors: { x1: number; y1: number; x2: number; y2: number }[] = []
  for (let i = 0; i + 1 < runs.length; i++) {
    const a = runs[i][runs[i].length - 1]
    const b = runs[i + 1][0]
    if (!bands.some((bd) => bd.x1 < b.t && bd.x2 > a.t)) {
      connectors.push({ x1: x(a.t), y1: y(a.v), x2: x(b.t), y2: y(b.v) })
    }
  }

  const ticks: number[] = []
  for (let t = Math.ceil(data.start / 30) * 30; t < data.end; t += 30) ticks.push(t)

  return (
    <div className="flex grow min-h-[150px]">
      {/* static y gutter (34px, matching the big chart's axis width so the strip above stays aligned) */}
      <div className="relative w-[34px] shrink-0 font-mono text-[11px] text-muted-foreground">
        <span className="absolute right-1.5 top-0">{maxL}</span>
        <span className="absolute bottom-[14px] right-1.5">0</span>
      </div>
      <div className="relative grow overflow-hidden">
        {/* fixed LIVE marker: chart chrome, so it does NOT ride the belt */}
        <div className="pointer-events-none absolute right-2 top-1 z-10 flex items-center gap-1.5 rounded-full bg-background/60 px-2 py-0.5 font-mono text-[11px] font-semibold tracking-widest text-muted-foreground ring-1 ring-border/60 backdrop-blur-sm">
          <span
            className="led-pulse size-1.5 rounded-full"
            style={{ background: "var(--primary)", "--led-c": "var(--primary)" } as CSSProperties}
          />
          LIVE
        </div>
        <div
          className="absolute inset-y-0 left-0 flex flex-col"
          style={{
            width: `${((T / (T - 1)) * 100).toFixed(4)}%`,
            transform: slid ? `translateX(-${(100 / T).toFixed(4)}%)` : "translateX(0)",
            transition: slid ? "transform 1000ms linear" : "none",
          }}
        >
          <svg className="min-h-0 w-full grow" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            <defs>
              {/* Latency quality ramp in plot coordinates (y PAD..H = maxL..0), so the
                  green/amber/red thresholds sit at their true ms heights whatever the
                  ceiling is. userSpaceOnUse also keeps horizontal pieces (connectors,
                  dots) on the same ramp instead of degenerating their bboxes. */}
              <linearGradient id="liveLatGrad" gradientUnits="userSpaceOnUse" x1="0" y1={PAD} x2="0" y2={H}>
                {latGradientStops(maxL, 0).map((s, i) => (
                  <stop key={i} offset={s.offset} style={{ stopColor: s.color }} />
                ))}
              </linearGradient>
              <linearGradient id="liveTickFill" gradientUnits="userSpaceOnUse" x1="0" y1={PAD} x2="0" y2={H}>
                {latGradientStops(maxL, 0).map((s, i) => (
                  <stop key={i} offset={s.offset} style={{ stopColor: s.color }} stopOpacity={0.04 + (1 - s.offset) * 0.16} />
                ))}
              </linearGradient>
            </defs>
            {[0, 0.5, 1].map((f) => (
              <line key={f} x1={0} x2={W} y1={y(f * maxL)} y2={y(f * maxL)}
                stroke="var(--border)" strokeOpacity={0.5} vectorEffect="non-scaling-stroke" />
            ))}
            {bands.map((b, i) => (
              <rect key={i} x={x(b.x1)} width={x(b.x2) - x(b.x1)} y={0} height={H}
                fill={b.c} fillOpacity={b.o} />
            ))}
            {areas.map((d, i) => <path key={i} d={d} fill="url(#liveTickFill)" />)}
            {connectors.map((c, i) => (
              <line key={`br-${i}`} x1={c.x1} y1={c.y1} x2={c.x2} y2={c.y2}
                stroke="url(#liveLatGrad)" strokeOpacity={0.35} strokeWidth={1.5}
                strokeDasharray="4 5" vectorEffect="non-scaling-stroke" />
            ))}
            {/* soft halo under the line: a wide low-opacity stroke, NOT a blur filter -
                this SVG repaints every second, so it has to stay cheap */}
            {segs.map((d, i) => (
              <path key={`halo-${i}`} d={d} fill="none" stroke="url(#liveLatGrad)" strokeWidth={7}
                strokeOpacity={0.12} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            ))}
            {segs.map((d, i) => (
              <path key={i} d={d} fill="none" stroke="url(#liveLatGrad)" strokeWidth={2}
                strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            ))}
            {dots.map((d, i) => (
              <circle key={`dot-${i}`} cx={d.cx} cy={d.cy} r={2} fill="url(#liveLatGrad)" />
            ))}
            {trend && (
              <line x1={trend.x0} y1={trend.y0} x2={trend.x1} y2={trend.y1}
                stroke="var(--muted-foreground)" strokeWidth={1.5} strokeOpacity={0.7}
                strokeDasharray="8 6" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          {/* Time labels ride the belt (they ARE times, sliding is correct for them). A
              freshly minted label eases in over its first seconds of travel instead of
              popping into existence at the right edge. */}
          <div className="relative h-4 shrink-0 font-mono text-[11px] text-muted-foreground">
            {ticks.map((t) => (
              <span
                key={t} className="absolute -translate-x-1/2"
                style={{
                  left: `${((t - data.start) / T) * 100}%`,
                  opacity: Math.min(1, (data.end - t) / 8),
                  transition: "opacity 1000ms linear",
                }}
              >
                {fmtTime(t)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function LatencyChart({ data, hoverT, onHoverT }: {
  data: RangeData
  hoverT?: number | null
  onHoverT?: (t: number | null) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  // Dismiss the hover tooltip on scroll: touch has no mouseleave, so a fixed-position tip
  // would otherwise stick to the screen and drift as the page scrolls.
  useEffect(() => {
    const onScroll = () => onHoverT?.(null)
    window.addEventListener("scroll", onScroll, { passive: true, capture: true })
    return () => window.removeEventListener("scroll", onScroll, true)
  }, [onHoverT])
  const wd = data.end - data.start > 86400
  // Plot latency wherever a bucket had at least one successful check (b.avg != null). The line
  // gaps ONLY where there were zero successful checks, i.e. a full outage or a no-data span, and
  // every such gap is covered by a band below. So a gap on this chart always means "outage" or
  // "no data", never a hidden high reading. Outlier spikes are CLAMPED to a robust ceiling (so
  // one slow burst can't blow out the axis or vanish); the tooltip still shows the true number.
  const mid = (i: number) => data.buckets[i].t + data.bucket / 2
  // Times inside a recorded gap (paused or no-data). A boundary bucket can hold checks from just
  // before/after the span, so null the line there too: the line then gaps cleanly under the band
  // instead of poking a reading out past a pause.
  const inGap = (t: number) => data.gaps.some((g) => t >= g.start && t < g.end)
  const reals = data.buckets.map((b, i) => (b.avg != null && !inGap(mid(i)) ? b.avg : null))
  // A fully-up bucket with NO sample is a window whose outage was deleted (latency was cleared):
  // interpolate from the nearest real neighbors so the line fills in instead of gapping.
  const points = data.buckets.map((b, i) => {
    const t = mid(i)
    if (inGap(t)) return { t, avg: null as number | null, up: b.up, total: b.total, est: false }
    if (reals[i] != null) return { t, avg: reals[i] as number, up: b.up, total: b.total, est: false }
    if (b.total > 0 && b.up === b.total) {
      let lo = i - 1
      while (lo >= 0 && reals[lo] == null) lo--
      let hi = i + 1
      while (hi < reals.length && reals[hi] == null) hi++
      const loV = lo >= 0 ? reals[lo] : null
      const hiV = hi < reals.length ? reals[hi] : null
      let est: number | null = null
      if (loV != null && hiV != null) est = loV + (hiV - loV) * ((t - mid(lo)) / (mid(hi) - mid(lo)))
      else if (loV != null) est = loV
      else if (hiV != null) est = hiV
      return { t, avg: est != null ? Math.round(est * 10) / 10 : null, up: b.up, total: b.total, est: est != null }
    }
    return { t, avg: null as number | null, up: b.up, total: b.total, est: false }
  })
  const valued = points.filter((p): p is { t: number; avg: number; up: number; total: number; est: boolean } => p.avg != null)

  if (!valued.length) {
    return (
      <div className="flex grow min-h-[150px] items-center justify-center text-sm text-muted-foreground">
        No latency samples in this range.
      </div>
    )
  }
  // Display ceiling: cap the axis near the normal spread (a robust fence over healthy buckets) so
  // a spike pegs at the top instead of squashing the normal range. Sparse ranges (fence = Infinity)
  // just use the real max, so nothing is clamped there. Plotted values are clamped to maxL; the
  // tooltip reports the true latency.
  const fence = latencyFence(
    data.buckets.filter((b) => b.total > 0 && b.up === b.total && b.avg != null).map((b) => b.avg as number),
  )
  const realMax = Math.max(...valued.map((p) => p.avg))
  let maxL = fence === Infinity
    ? Math.max(20, Math.ceil(realMax / 10) * 10)
    : Math.max(80, Math.ceil(fence / 10) * 10)
  // Spikes peg at the ceiling rather than stretching the axis; when they do, the ceiling
  // rises just enough to reach the red zone (never past LAT_BAD), so an off-scale spike
  // always LOOKS red while a 5000 ms monster still can't blow out the scale. The exact
  // number lives in the tooltip.
  if (realMax > maxL && maxL < LAT_BAD) maxL = Math.min(LAT_BAD, Math.ceil(realMax / 10) * 10)
  // Clamp to the ceiling for plotting, and insert an explicit null break wherever buckets are
  // missing (the backend only emits buckets that had checks, so a no-data span is a time jump):
  // this makes the line genuinely gap there instead of bridging across it. The gap is covered by
  // a grey no-data band below.
  const series: { t: number; avg: number | null; plot: number | null; up: number; total: number; est: boolean }[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    series.push({ ...p, plot: p.avg == null ? null : Math.min(p.avg, maxL) })
    if (i + 1 < points.length && points[i + 1].t - p.t > data.bucket * 1.5) {
      series.push({ t: p.t + data.bucket, avg: null, plot: null, up: 0, total: 0, est: false })
    }
  }
  // Plotted extremes, for mapping the quality gradient's stops onto the line's bbox.
  const plotVals = series.map((p) => p.plot).filter((v): v is number => v != null)
  const minPlotted = Math.min(...plotVals)
  const maxPlotted = Math.max(...plotVals)
  // X domain. Live/tiny windows use the REQUESTED window, so every poll slides the plot
  // by exactly the elapsed second and motion is a uniform crawl - a data-driven domain
  // only moves when a new bucket lands (sometimes 0 per poll, sometimes 2), which reads
  // as stutter. Larger ranges keep the data-driven domain so sparse edges stay trimmed.
  const liveWin = data.end - data.start <= 900
  const domMin = liveWin ? data.start : points[0].t
  const domMax = liveWin ? data.end : points[points.length - 1].t
  // Bands so every line gap is explained: red = connectivity outage (up < total),
  // grey = no-data (reboot/stall), blue = paused. Clamped to the plotted time domain.
  const clampSpan = (x1: number, x2: number) => ({ x1: Math.max(x1, domMin), x2: Math.min(x2, domMax) })
  const bands = outageSpans(data.buckets, data.bucket).map((b) => clampSpan(b.x1, b.x2)).filter((b) => b.x2 > b.x1)
  // Paused spans get their own blue band (matching the tracker); genuine no-data gaps stay grey.
  const pausedBands = data.gaps.filter((g) => g.kind === "paused").map((g) => clampSpan(g.start, g.end)).filter((b) => b.x2 > b.x1)
  const nodataBands = data.gaps.filter((g) => g.kind !== "paused").map((g) => clampSpan(g.start, g.end)).filter((b) => b.x2 > b.x1)

  // Dashed connectors across sample holes that no band explains: the checks on both
  // sides passed (the line was up), the monitor just spent those seconds waiting out a
  // slow probe cycle, so no latency landed. Faint and dashed so sampled line and
  // bridged hole stay distinct; outage / no-data / paused holes stay true breaks.
  const allBands = [...bands, ...pausedBands, ...nodataBands]
  const bridges: { x0: number; y0: number; x1: number; y1: number }[] = []
  {
    let i = 0
    while (i < series.length) {
      if (series[i].plot == null) { i++; continue }
      let j = i + 1
      while (j < series.length && series[j].plot == null) j++
      if (j < series.length && j > i + 1
        && !allBands.some((b) => b.x1 < series[j].t && b.x2 > series[i].t)) {
        bridges.push({ x0: series[i].t, y0: series[i].plot as number, x1: series[j].t, y1: series[j].plot as number })
      }
      i = j
    }
  }

  // Least-squares trend over the visible (clamped) line. Drawn neutral: red/green already
  // mean down/up elsewhere on this chart, so a colored trend would collide with them.
  // Skipped on live/tiny windows, where a "trend" over seconds is jitter, not signal.
  let trend: { x0: number; y0: number; x1: number; y1: number } | null = null
  const tv = series.filter((p): p is typeof p & { plot: number } => p.plot != null)
  if (tv.length >= 2 && data.end - data.start > 600) {
    const n = tv.length
    const mx = tv.reduce((a, p) => a + p.t, 0) / n
    const my = tv.reduce((a, p) => a + p.plot, 0) / n
    let num = 0, den = 0
    for (const p of tv) { num += (p.t - mx) * (p.plot - my); den += (p.t - mx) ** 2 }
    const slope = den ? num / den : 0
    const intercept = my - slope * mx
    const x0 = tv[0].t, x1 = tv[tv.length - 1].t
    trend = { x0, y0: slope * x0 + intercept, x1, y1: slope * x1 + intercept }
  }

  // Tooltip driven by the shared hovered time, so it shows whether the latency or
  // the uptime chart is the one being hovered. Positioned from the chart geometry
  // (y-axis width 34, right margin 12) so it tracks the crosshair.
  const nearest = hoverT != null
    ? series.reduce((best, p) => (Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT) ? p : best), series[0])
    : null
  // When the hover is driven by the TRACKER (segment midpoints), the nearest data
  // point can sit far from the crosshair on coarse or sparse ranges; labeling the
  // crosshair with that faraway timestamp reads as a lie. Show the tooltip only when
  // the nearest point is actually at the hovered position.
  const nearestClose = nearest != null && hoverT != null && Math.abs(nearest.t - hoverT) <= data.bucket * 1.5
  let pos: { x: number; y: number } | null = null
  if (hoverT != null && wrapRef.current) {
    const rect = wrapRef.current.getBoundingClientRect()
    const plotL = rect.left + 34
    const plotR = rect.right - 12
    const frac = domMax > domMin ? (hoverT - domMin) / (domMax - domMin) : 0
    const cx = plotL + Math.max(0, Math.min(1, frac)) * (plotR - plotL)
    const half = 130
    pos = { x: Math.min(Math.max(cx, half), window.innerWidth - half), y: rect.top }
  }

  return (
    <div ref={wrapRef} className="relative flex grow flex-col min-h-[150px]">
      <ChartContainer config={config} className="min-h-0 w-full grow">
        <AreaChart
          data={series} margin={{ left: 0, right: 12, top: 10, bottom: 0 }}
          onMouseMove={(st: any) => {
            const p = st?.activePayload?.[0]?.payload
            const t = typeof p?.t === "number" ? p.t : typeof st?.activeLabel === "number" ? st.activeLabel : null
            onHoverT?.(t)
          }}
          onMouseLeave={() => onHoverT?.(null)}
        >
          <defs>
            {/* Quality ramp over the LINE's bbox: stop offsets are computed from the
                plotted extremes so the green/amber/red thresholds land at absolute ms
                heights. (A bbox gradient with fixed stops would be relative to each
                view's spread, which is what sank the early attempt at this.) */}
            <linearGradient id="latStroke" x1="0" y1="0" x2="0" y2="1">
              {latGradientStops(maxPlotted, minPlotted).map((s, i) => (
                <stop key={i} offset={s.offset} style={{ stopColor: s.color }} />
              ))}
            </linearGradient>
            {/* Same ramp for the area fill, whose bbox reaches the zero baseline. */}
            <linearGradient id="latFill" x1="0" y1="0" x2="0" y2="1">
              {latGradientStops(maxPlotted, 0).map((s, i) => (
                <stop key={i} offset={s.offset} style={{ stopColor: s.color }} stopOpacity={0.03 + (1 - s.offset) * 0.18} />
              ))}
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.5} />
          <XAxis
            dataKey="t" type="number" domain={[domMin, domMax]}
            tickLine={false} axisLine={false} minTickGap={56}
            tick={(props: any) => {
              const { x, y, payload, index, visibleTicksCount } = props
              const anchor = index === 0 ? "start" : index === visibleTicksCount - 1 ? "end" : "middle"
              return (
                <text
                  x={x} y={y} dy={12} textAnchor={anchor} fill="var(--muted-foreground)"
                  style={{ fontSize: 11, fontFamily: "var(--font-mono, monospace)" }}
                >
                  {fmtTime(payload.value, wd)}
                </text>
              )
            }}
          />
          {/* Conventional orientation: 0 at the bottom, spikes point up (slower = higher),
              like every other monitoring tool. Units live in the section header. */}
          <YAxis
            domain={[0, maxL]} width={34} tickLine={false} axisLine={false}
            tick={{ fontSize: 11, fontFamily: "var(--font-mono, monospace)" }}
            tickFormatter={(v) => `${v}`}
          />
          {/* Keep a tooltip so Recharts computes the active point for onMouseMove, but render nothing. */}
          <ChartTooltip cursor={false} content={() => null} />
          {/* Grey bands over genuine no-data spans (reboot / stall): a gap that is not an outage. */}
          {nodataBands.map((b, i) => (
            <ReferenceArea key={`gap-${i}`} x1={b.x1} x2={b.x2}
              fill="var(--gap-band)" fillOpacity={0.6} stroke="none" ifOverflow="visible" />
          ))}
          {/* Blue bands over paused spans, labelled, so a pause never reads as "no data" or an outage. */}
          {pausedBands.map((b, i) => (
            <ReferenceArea key={`paused-${i}`} x1={b.x1} x2={b.x2}
              fill="var(--paused)" fillOpacity={0.22} stroke="none" ifOverflow="visible"
              label={{ value: "Paused", position: "center", fill: "var(--paused)", fontSize: 11 }} />
          ))}
          {/* Half-transparent red bands over connectivity outages (where the latency line gaps). */}
          {bands.map((b, i) => (
            <ReferenceArea key={`outage-${i}`} x1={b.x1} x2={b.x2}
              fill="var(--down)" fillOpacity={0.3} stroke="none" ifOverflow="visible" />
          ))}
          {bridges.map((b, i) => (
            <ReferenceLine key={`br-${i}`}
              segment={[{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y1 }]}
              stroke={latencyColor(Math.max(b.y0, b.y1))} strokeWidth={1.5} strokeDasharray="4 5" strokeOpacity={0.35}
            />
          ))}
          {trend && (
            <ReferenceLine
              segment={[{ x: trend.x0, y: trend.y0 }, { x: trend.x1, y: trend.y1 }]}
              stroke="var(--muted-foreground)" strokeWidth={1.5} strokeDasharray="5 4" strokeOpacity={0.7}
            />
          )}
          {/* soft halo under the line: a wide low-opacity stroke (no SVG blur filters) */}
          <Area
            dataKey="plot" type="monotone" stroke="url(#latStroke)" strokeWidth={7}
            strokeOpacity={0.12} fill="none" connectNulls={false} isAnimationActive={false}
            activeDot={false} dot={false}
          />
          <Area
            dataKey="plot" type="monotone" stroke="url(#latStroke)" strokeWidth={2}
            fill="url(#latFill)" connectNulls={false} isAnimationActive={false}
          />
          {hoverT != null && (
            <ReferenceLine x={hoverT} stroke="var(--foreground)" strokeOpacity={0.55} strokeWidth={1} />
          )}
        </AreaChart>
      </ChartContainer>
      {nearest && nearestClose && pos &&
        createPortal(
          <div
            role="tooltip"
            className="tip-card pointer-events-none fixed z-50 -translate-x-1/2 px-3 py-2 text-xs leading-snug text-popover-foreground"
            style={{ left: pos.x, top: pos.y + 6 }}
          >
            {(() => {
              const noData = !nearest.total
              const status = noData ? "No data" : nearest.up === nearest.total ? "Online" : nearest.up === 0 ? "Offline" : "Partial outage"
              const sc = noData ? "var(--muted-foreground)" : nearest.up === nearest.total ? "var(--up)" : nearest.up === 0 ? "var(--down)" : "var(--amber)"
              return (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono font-semibold">{fmtTime(nearest.t, true)}</span>
                    <span className="font-semibold" style={{ color: sc }}>{status}</span>
                  </div>
                  {nearest.avg != null ? (
                    <div className="mt-0.5 font-mono text-foreground">
                      {nearest.est
                        ? `~${nearest.avg} ms (estimated)`
                        : `${nearest.avg} ms latency${nearest.avg > maxL ? " (above chart top)" : ""}`}
                    </div>
                  ) : nearest.up === 0 && nearest.total ? (
                    <div className="mt-0.5 font-mono text-foreground">No response</div>
                  ) : null}
                  {!noData && <div className="text-muted-foreground">{nearest.up}/{nearest.total} checks passed</div>}
                </>
              )
            })()}
          </div>,
          document.body,
        )}
    </div>
  )
}
