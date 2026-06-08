import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { Area, AreaChart, CartesianGrid, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { fmtTime, latencyFence } from "@/lib/format"
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

export function LatencyChart({ data, hoverT, onHoverT, degradedMs = 0 }: {
  data: RangeData
  hoverT?: number | null
  onHoverT?: (t: number | null) => void
  degradedMs?: number
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
  const reals = data.buckets.map((b) => (b.avg != null ? b.avg : null))
  // A fully-up bucket with NO sample is a window whose outage was deleted (latency was cleared):
  // interpolate from the nearest real neighbors so the line fills in instead of gapping.
  const points = data.buckets.map((b, i) => {
    const t = mid(i)
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
  const maxL = fence === Infinity
    ? Math.max(20, Math.ceil(realMax / 10) * 10)
    : Math.max(80, Math.ceil(fence / 10) * 10)
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
  // "Slow" zone shading + threshold line at the degraded threshold; drawn only when in view.
  const showSlow = degradedMs > 0 && degradedMs < maxL

  // Bands so every line gap is explained: red = connectivity outage (up < total), amber =
  // brownout (kind 'slow'), grey = no-data (reboot/pause). Clamped to the plotted time domain.
  const tMin = points[0].t
  const tMax = points[points.length - 1].t
  const clampSpan = (x1: number, x2: number) => ({ x1: Math.max(x1, tMin), x2: Math.min(x2, tMax) })
  const bands = outageSpans(data.buckets, data.bucket).map((b) => clampSpan(b.x1, b.x2)).filter((b) => b.x2 > b.x1)
  const brownBands = data.outages.filter((o) => o.kind === "slow").map((o) => clampSpan(o.start, o.end ?? data.now)).filter((b) => b.x2 > b.x1)
  const gapBands = data.gaps.map((g) => clampSpan(g.start, g.end)).filter((b) => b.x2 > b.x1)

  // Least-squares trend over the visible (clamped) line, colored by direction: rising latency
  // (worse) is red, falling (better) is green, roughly flat is neutral amber.
  let trend: { x0: number; y0: number; x1: number; y1: number } | null = null
  let trendColor = "var(--amber)"
  const tv = series.filter((p): p is typeof p & { plot: number } => p.plot != null)
  if (tv.length >= 2) {
    const n = tv.length
    const mx = tv.reduce((a, p) => a + p.t, 0) / n
    const my = tv.reduce((a, p) => a + p.plot, 0) / n
    let num = 0, den = 0
    for (const p of tv) { num += (p.t - mx) * (p.plot - my); den += (p.t - mx) ** 2 }
    const slope = den ? num / den : 0
    const intercept = my - slope * mx
    const x0 = tv[0].t, x1 = tv[tv.length - 1].t
    trend = { x0, y0: slope * x0 + intercept, x1, y1: slope * x1 + intercept }
    const delta = trend.y1 - trend.y0
    const thresh = Math.max(8, my * 0.08)
    trendColor = delta > thresh ? "var(--down)" : delta < -thresh ? "var(--up)" : "var(--amber)"
  }

  // Tooltip driven by the shared hovered time, so it shows whether the latency or
  // the uptime chart is the one being hovered. Positioned from the chart geometry
  // (y-axis width 34, right margin 12) so it tracks the crosshair.
  const nearest = hoverT != null
    ? series.reduce((best, p) => (Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT) ? p : best), series[0])
    : null
  let pos: { x: number; y: number } | null = null
  if (hoverT != null && wrapRef.current) {
    const rect = wrapRef.current.getBoundingClientRect()
    const plotL = rect.left + 34
    const plotR = rect.right - 12
    const tMin = points[0].t
    const tMax = points[points.length - 1].t
    const frac = tMax > tMin ? (hoverT - tMin) / (tMax - tMin) : 0
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
            {/* Y axis is reversed (fast on top): green at the top (fast), red at the bottom (slow). */}
            <linearGradient id="latStroke" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--up)" />
              <stop offset="50%" stopColor="var(--amber)" />
              <stop offset="100%" stopColor="var(--down)" />
            </linearGradient>
            <linearGradient id="latFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--lat-line)" stopOpacity={0.20} />
              <stop offset="100%" stopColor="var(--lat-line)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.5} />
          <XAxis
            dataKey="t" type="number" domain={["dataMin", "dataMax"]}
            tickLine={false} axisLine={false} minTickGap={56}
            tick={(props: any) => {
              const { x, y, payload, index, visibleTicksCount } = props
              const anchor = index === 0 ? "start" : index === visibleTicksCount - 1 ? "end" : "middle"
              return (
                <text
                  x={x} y={y} dy={12} textAnchor={anchor} fill="var(--muted-foreground)"
                  style={{ fontSize: 10, fontFamily: "var(--font-mono, monospace)" }}
                >
                  {fmtTime(payload.value, wd)}
                </text>
              )
            }}
          />
          <YAxis
            reversed domain={[0, maxL]} width={34} tickLine={false} axisLine={false}
            tick={{ fontSize: 10, fontFamily: "var(--font-mono, monospace)" }}
            tickFormatter={(v) => `${v}`}
          />
          {/* Keep a tooltip so Recharts computes the active point for onMouseMove, but render nothing. */}
          <ChartTooltip cursor={false} content={() => null} />
          {/* Faint "slow" zone: latency worse than the degraded threshold (the lower band). */}
          {showSlow && (
            <ReferenceArea y1={degradedMs} y2={maxL} fill="var(--down)" fillOpacity={0.06}
              stroke="none" ifOverflow="visible" />
          )}
          {/* Grey bands over no-data spans (reboot / pause): explains a gap that is not an outage. */}
          {gapBands.map((b, i) => (
            <ReferenceArea key={`gap-${i}`} x1={b.x1} x2={b.x2}
              fill="var(--gap-band)" fillOpacity={0.6} stroke="none" ifOverflow="visible" />
          ))}
          {/* Amber bands over brownout (sustained slow-but-up) events. */}
          {brownBands.map((b, i) => (
            <ReferenceArea key={`brown-${i}`} x1={b.x1} x2={b.x2}
              fill="var(--amber)" fillOpacity={0.14} stroke="none" ifOverflow="visible" />
          ))}
          {/* Half-transparent red bands over connectivity outages (where the latency line gaps). */}
          {bands.map((b, i) => (
            <ReferenceArea key={`outage-${i}`} x1={b.x1} x2={b.x2}
              fill="var(--down)" fillOpacity={0.3} stroke="none" ifOverflow="visible" />
          ))}
          {trend && (
            <ReferenceLine
              segment={[{ x: trend.x0, y: trend.y0 }, { x: trend.x1, y: trend.y1 }]}
              stroke={trendColor} strokeWidth={1.5} strokeDasharray="5 4" strokeOpacity={0.9}
            />
          )}
          <Area
            dataKey="plot" type="monotone" stroke="url(#latStroke)" strokeWidth={2.5}
            fill="url(#latFill)" baseValue={maxL} connectNulls={false} isAnimationActive={false}
          />
          {showSlow && (
            <ReferenceLine y={degradedMs} stroke="var(--amber)" strokeDasharray="4 4" strokeOpacity={0.6}
              label={{ value: `slow > ${degradedMs} ms`, position: "insideRight", fill: "var(--amber)", fontSize: 9 }} />
          )}
          {hoverT != null && (
            <ReferenceLine x={hoverT} stroke="var(--foreground)" strokeOpacity={0.55} strokeWidth={1} />
          )}
        </AreaChart>
      </ChartContainer>
      {nearest && pos &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-50 -translate-x-1/2 rounded-lg border bg-popover px-3 py-2 text-xs leading-snug text-popover-foreground shadow-xl"
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
