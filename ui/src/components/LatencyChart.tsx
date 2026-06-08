import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { Area, AreaChart, CartesianGrid, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { fmtTime, latencyFence } from "@/lib/format"
import type { RangeData } from "@/lib/types"

const config = { avg: { label: "Latency", color: "var(--lat-line)" } } satisfies ChartConfig

// Time spans (seconds) of connectivity outages, to shade red on the latency chart. A bucket
// is an outage when some or all of its checks were down (up < total); no-data gaps (total 0)
// and fence-hidden latency spikes (fully up) are not outages. Adjacent outage buckets merge.
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
  // Latency only means something when the connection was fully up. During a partial outage the
  // few surviving connects crawl near the timeout, which would spike the line; null those (and
  // fully-down buckets). We also drop fully-up-but-outlier buckets past a robust fence (a
  // degraded-but-connected stretch near the timeout) so it can't blow out the reversed Y axis.
  const fence = latencyFence(
    data.buckets.filter((b) => b.total > 0 && b.up === b.total && b.avg != null).map((b) => b.avg as number),
  )
  const points = data.buckets.map((b) => ({
    t: b.t + data.bucket / 2,
    avg: b.up === b.total && b.avg != null && b.avg <= fence ? b.avg : null,
    up: b.up,
    total: b.total,
  }))
  const valued = points.filter((p): p is { t: number; avg: number; up: number; total: number } => p.avg != null)
  const lats = valued.map((p) => p.avg)

  if (!lats.length) {
    return (
      <div className="flex grow min-h-[150px] items-center justify-center text-sm text-muted-foreground">
        No latency samples in this range.
      </div>
    )
  }
  const maxL = Math.max(20, Math.ceil(Math.max(...lats) / 10) * 10)

  // Red outage bands, clamped to the plotted time domain (mid-bucket points) so they never
  // fall outside the axis and get dropped.
  const tMin = points[0].t
  const tMax = points[points.length - 1].t
  const bands = outageSpans(data.buckets, data.bucket)
    .map((b) => ({ x1: Math.max(b.x1, tMin), x2: Math.min(b.x2, tMax) }))
    .filter((b) => b.x2 > b.x1)

  // Least-squares trend line, colored by direction: rising latency (worse) is
  // red, falling (better) is green, roughly flat is neutral amber.
  let trend: { x0: number; y0: number; x1: number; y1: number } | null = null
  let trendColor = "var(--amber)"
  if (valued.length >= 2) {
    const n = valued.length
    const mx = valued.reduce((a, p) => a + p.t, 0) / n
    const my = valued.reduce((a, p) => a + p.avg, 0) / n
    let num = 0, den = 0
    for (const p of valued) { num += (p.t - mx) * (p.avg - my); den += (p.t - mx) ** 2 }
    const slope = den ? num / den : 0
    const intercept = my - slope * mx
    const x0 = valued[0].t, x1 = valued[valued.length - 1].t
    trend = { x0, y0: slope * x0 + intercept, x1, y1: slope * x1 + intercept }
    const delta = trend.y1 - trend.y0
    const thresh = Math.max(8, my * 0.08)
    trendColor = delta > thresh ? "var(--down)" : delta < -thresh ? "var(--up)" : "var(--amber)"
  }

  // Tooltip driven by the shared hovered time, so it shows whether the latency or
  // the uptime chart is the one being hovered. Positioned from the chart geometry
  // (y-axis width 34, right margin 12) so it tracks the crosshair.
  const nearest = hoverT != null
    ? points.reduce((best, p) => (Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT) ? p : best), points[0])
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
          data={points} margin={{ left: 0, right: 12, top: 10, bottom: 0 }}
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
            dataKey="avg" type="monotone" stroke="url(#latStroke)" strokeWidth={2.5}
            fill="url(#latFill)" baseValue={maxL} connectNulls={false} isAnimationActive={false}
          />
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
                    <div className="mt-0.5 font-mono text-foreground">{nearest.avg} ms latency</div>
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
