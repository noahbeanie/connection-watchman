import { useCallback, useEffect, useRef, useState } from "react"
import { CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"
import { Gauge, Info } from "lucide-react"
import { toast } from "sonner"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { InfoTip } from "@/components/InfoTip"
import type { SpeedData } from "@/lib/types"
import { PRESETS, fmtBps, fmtStreak, fmtTime, humanBytes, nowSec } from "@/lib/format"

const api = async (p: string) => (await fetch(p, { cache: "no-store" })).json()
const post = (p: string, body: unknown) =>
  fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

// Values must match the backend whitelist in dashboard.py CFG_OPTIONS.
const PERIOD_OPTS = [
  { v: 0, label: "Off" }, { v: 4, label: "Every 4h" }, { v: 6, label: "Every 6h" },
  { v: 8, label: "Every 8h" }, { v: 12, label: "Every 12h" }, { v: 24, label: "Daily" },
]
const CAP_OPTS = [25, 50, 100, 250, 500].map((v) => ({ v, label: `${v} MB` }))

const DOWN_COLOR = "var(--primary)"
const UP_COLOR = "var(--orange)"
const config = {
  down: { label: "Download", color: DOWN_COLOR },
  up: { label: "Upload", color: UP_COLOR },
} satisfies ChartConfig

// Same styled dropdown as the Data & tools selects (App.ConfigSelect), duplicated here
// because importing it from App would make App and this panel import each other.
function CfgSelect({ value, options, onChange }: {
  value: number; options: { v: number; label: string }[]; onChange: (v: number) => void
}) {
  return (
    <Select
      items={options.map((o) => ({ value: o.v, label: o.label }))}
      value={value}
      onValueChange={(v) => { if (v != null && Number(v) !== value) onChange(Number(v)) }}
    >
      <SelectTrigger size="sm" className="gap-1 px-2 font-mono text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.v} value={o.v} className="font-mono text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// Compact axis label from bits/s: 500M, 1.5G.
const axBps = (v: number) =>
  v >= 1e9 ? `${+(v / 1e9).toFixed(1)}G` : v >= 1e6 ? `${Math.round(v / 1e6)}M` : `${Math.round(v / 1e3)}K`

// Worst-case data use per month, for the footer estimate: tests/day x both directions
// x the cap. Real use is lower on slower lines (tests are time-bounded too).
const monthlyGB = (periodH: number, capMb: number) =>
  (30 * (24 / periodH) * 2 * capMb) / 1000

export function SpeedPanel({ preset, customRange, periodLabel }: {
  preset: string
  customRange: { start: number; end: number } | null
  periodLabel: string
}) {
  const [data, setData] = useState<SpeedData | null>(null)
  // Run-now completion watch: newest row ts at click time + when the click happened,
  // so the finished test can be toasted and a dead monitor detected (nothing new
  // after the pending flag went stale).
  const awaiting = useRef<{ base: number; since: number } | null>(null)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const s = ++seq.current
    const { start, end } = preset === "custom" && customRange
      ? customRange
      : (() => {
          const e = nowSec()
          const span = PRESETS.find((p) => p.id === preset)?.span
          return { start: span ? e - span : 0, end: e }
        })()
    try {
      const d = await api(`/api/speedtests?start=${start}&end=${end}`)
      if (s === seq.current) setData(d)
    } catch { /* keep last */ }
  }, [preset, customRange])

  useEffect(() => { load() }, [load])
  // Slow poll normally (tests land a few times a day); fast poll while a run-now
  // request is in flight so the result appears within seconds of finishing.
  useEffect(() => {
    const id = setInterval(load, data?.pending ? 3000 : 30000)
    return () => clearInterval(id)
  }, [load, data?.pending])

  useEffect(() => {
    if (!awaiting.current || !data) return
    const newest = Math.max(data.latest?.ts ?? 0, data.last_error?.ts ?? 0)
    if (newest > awaiting.current.base) {
      awaiting.current = null
      if (data.last_error && data.last_error.ts === newest) {
        toast.error("Speed test failed: " + (data.last_error.error ?? "unknown error"))
      } else if (data.latest) {
        toast.success(`Speed test done: ${fmtBps(data.latest.down_bps)} down / ${fmtBps(data.latest.up_bps)} up`)
      }
    } else if (!data.pending && nowSec() - awaiting.current.since > 180) {
      // The request went stale without a result: the monitor never picked it up.
      awaiting.current = null
      toast.error("The speed test never ran. Is the monitor service running?")
    }
  }, [data])

  const setCfg = async (key: string, v: number) => {
    const res = await post("/api/config", { [key]: v })
    if (res.ok) { toast.success("Setting updated"); load() }
    else toast.error("Update failed: " + (await res.text()))
  }
  const runNow = async () => {
    const res = await post("/api/speedtest/run", {})
    if (res.ok) {
      awaiting.current = {
        base: Math.max(data?.latest?.ts ?? 0, data?.last_error?.ts ?? 0),
        since: nowSec(),
      }
      setData((d) => (d ? { ...d, pending: true } : d))
      toast.success("Speed test queued; it runs within one check cycle")
    } else {
      toast.error("Could not queue the test: " + (await res.text()))
    }
  }

  const latest = data?.latest ?? null
  // ONE chart-level series holding successes and failures: a failed test carries
  // `fail: 0` (a red dot pinned to the baseline) and null speeds. A separate Scatter
  // with its own data prop is exactly what recharts computes the down-axis domain
  // from in a ComposedChart, which collapsed the axis to [0, 0] - hence this shape.
  const series = data
    ? data.tests.map((t) => ({
        t: t.ts, down: t.down_bps, up: t.up_bps, ping: t.ping_ms,
        jitter: t.jitter_ms ?? null, loss: t.loss_pct ?? null,
        used: (t.bytes_down || 0) + (t.bytes_up || 0),
        fail: t.down_bps == null ? 0 : null,
        error: t.error,
      }))
    : []
  const failCount = series.filter((p) => p.down == null).length
  const wd = data ? data.end - data.start > 86400 : false
  const off = (data?.period_h ?? 0) === 0

  return (
    <Card className="fade-up mb-4 p-4 sm:p-5" style={{ animationDelay: "150ms" }}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold tracking-tight">
          Speed <span className="font-normal text-muted-foreground">({periodLabel})</span>
        </h2>
        {latest && (
          <InfoTip label="The most recent speed test result (regardless of the selected range) and how long ago it ran." className="cursor-help">
            <span className="font-mono text-xs text-muted-foreground">
              <span style={{ color: DOWN_COLOR }}>&darr; {fmtBps(latest.down_bps)}</span>
              <span className="mx-1.5">&middot;</span>
              <span style={{ color: UP_COLOR }}>&uarr; {fmtBps(latest.up_bps)}</span>
              {latest.ping_ms != null && <><span className="mx-1.5">&middot;</span>{latest.ping_ms} ms ping</>}
              <span className="mx-1.5">&middot;</span>{fmtStreak(Math.max(0, nowSec() - latest.ts))} ago
            </span>
          </InfoTip>
        )}
      </div>
      {data?.last_error && (
        <p className="mb-2 text-xs" style={{ color: "var(--down)" }}>
          Last attempt failed {fmtStreak(Math.max(0, nowSec() - data.last_error.ts))} ago: {data.last_error.error}
        </p>
      )}

      {!data ? (
        <div className="h-[180px] w-full animate-pulse rounded-md bg-muted/40" />
      ) : series.length ? (
        <>
          {/* Legend: dashed upload + distinct colors, so the two lines never rely on
              color alone. Ping stays in the tooltip - two axes is already plenty. */}
          <div className="mb-1 flex items-center justify-end gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={DOWN_COLOR} strokeWidth="2" /></svg>
              Download
            </span>
            <span className="flex items-center gap-1.5">
              <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={UP_COLOR} strokeWidth="2" strokeDasharray="4 3" /></svg>
              Upload
            </span>
            {failCount > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2 rounded-full" style={{ background: "var(--down)" }} />
                Failed
              </span>
            )}
          </div>
          <div className="h-[180px]">
            <ChartContainer config={config} className="aspect-auto h-full w-full">
              <ComposedChart data={series} margin={{ left: 0, right: 0, top: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.5} />
                <XAxis
                  dataKey="t" type="number" domain={[data.start, data.end]}
                  tickLine={false} axisLine={false} minTickGap={56}
                  tick={{ fontSize: 11, fontFamily: "var(--font-mono, monospace)" }}
                  tickFormatter={(v: number) => fmtTime(v, wd)}
                />
                {/* Down and up on separate axes: a typical line's upload is 10-50x below
                    its download, and one shared axis would flatten the upload line into
                    a floor-hugging noodle. Ticks are tinted to match their line. */}
                <YAxis
                  yAxisId="down" domain={[0, (max: number) => max * 1.15]} width={44}
                  tickLine={false} axisLine={false} tickFormatter={axBps}
                  tick={{ fontSize: 11, fontFamily: "var(--font-mono, monospace)", fill: DOWN_COLOR }}
                />
                <YAxis
                  yAxisId="up" orientation="right" domain={[0, (max: number) => max * 1.15]} width={44}
                  tickLine={false} axisLine={false} tickFormatter={axBps}
                  tick={{ fontSize: 11, fontFamily: "var(--font-mono, monospace)", fill: UP_COLOR }}
                />
                <ChartTooltip
                  cursor={{ stroke: "var(--foreground)", strokeOpacity: 0.4 }}
                  content={({ active, payload }) => {
                    const p = active && payload?.length ? (payload[0].payload as typeof series[number]) : null
                    if (!p) return null
                    return (
                      <div className="tip-card px-3 py-2 text-xs leading-snug text-popover-foreground">
                        <div className="font-mono font-semibold">{fmtTime(p.t, true)}</div>
                        {p.down == null ? (
                          <div className="mt-0.5" style={{ color: "var(--down)" }}>Test failed: {p.error ?? "unknown error"}</div>
                        ) : (
                          <>
                            <div className="mt-0.5 font-mono">
                              <span style={{ color: DOWN_COLOR }}>&darr; {fmtBps(p.down)}</span>
                              <span className="mx-1.5">&middot;</span>
                              <span style={{ color: UP_COLOR }}>&uarr; {fmtBps(p.up)}</span>
                            </div>
                            <div className="text-muted-foreground">
                              {p.ping != null ? `${p.ping} ms ping · ` : ""}
                              {p.jitter != null ? `${p.jitter} ms jitter · ` : ""}
                              {p.loss != null ? `${p.loss}% loss · ` : ""}
                              {humanBytes(p.used)} transferred
                            </div>
                          </>
                        )}
                      </div>
                    )
                  }}
                />
                <Line
                  yAxisId="down" dataKey="down" type="monotone" stroke={DOWN_COLOR} strokeWidth={2}
                  dot={{ r: 3, fill: DOWN_COLOR, strokeWidth: 0 }} activeDot={{ r: 4 }}
                  isAnimationActive={false} connectNulls
                />
                <Line
                  yAxisId="up" dataKey="up" type="monotone" stroke={UP_COLOR} strokeWidth={2}
                  strokeDasharray="5 4" dot={{ r: 3, fill: UP_COLOR, strokeWidth: 0 }} activeDot={{ r: 4 }}
                  isAnimationActive={false} connectNulls
                />
                {/* Failed attempts sit on the baseline as red dots, so a hole in the
                    line is always explainable from the chart itself. A dot-only Line
                    over the shared series, NOT a Scatter with its own data (see the
                    series construction note above). */}
                {failCount > 0 && (
                  <Line
                    yAxisId="down" dataKey="fail" stroke="none"
                    dot={{ r: 3, fill: "var(--down)", strokeWidth: 0 }} activeDot={{ r: 4 }}
                    isAnimationActive={false}
                  />
                )}
              </ComposedChart>
            </ChartContainer>
          </div>
        </>
      ) : (
        <div className="flex h-[120px] flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
          {off && !latest ? (
            <>
              <Gauge className="mb-1 size-5 opacity-60" />
              <p className="max-w-md">
                Measure your line&apos;s real download and upload speed a few times a day and
                track it here over time, alongside your uptime.
              </p>
              <p className="max-w-md text-xs">
                Pick a schedule below to turn it on, or hit Test now for a one-off reading.
              </p>
            </>
          ) : (
            <p>No speed tests in this range.{off ? " Scheduled tests are off." : ""}</p>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-border/40 pt-3 text-xs">
        <InfoTip label="How often an automatic speed test runs. Each one saturates the connection for ~20 seconds; it runs between connectivity checks, so it can never be logged as an outage or a latency spike." className="cursor-help">
          <span className="mr-1 flex items-center gap-1 text-muted-foreground">
            Test every
            <Info className="size-3 text-muted-foreground/60" />
          </span>
        </InfoTip>
        <CfgSelect value={data?.period_h ?? 0} options={PERIOD_OPTS} onChange={(v) => setCfg("speedtest_period_h", v)} />
        <InfoTip label={data?.engine === "ookla"
          ? "Only used by the built-in fallback engine. Tests currently run through the Ookla Speedtest CLI, which adapts its own transfer size to the line (roughly 1-2 GB per direction on fast links)."
          : "Most data a test may move in each direction. Bigger caps read fast lines more accurately (more of the test runs at full speed); smaller caps suit capped or metered plans."} className="cursor-help">
          <span className="ml-3 mr-1 flex items-center gap-1 text-muted-foreground">
            Data cap
            <Info className="size-3 text-muted-foreground/60" />
          </span>
        </InfoTip>
        <CfgSelect value={data?.cap_mb ?? 100} options={CAP_OPTS} onChange={(v) => setCfg("speedtest_cap_mb", v)} />
        {data?.engine === "ookla" ? (
          <InfoTip label="The official Ookla Speedtest CLI is installed, so tests use speedtest.net's own servers and engine (with jitter and packet loss). Uninstall it and the monitor falls back to the built-in zero-dependency engine." className="cursor-help">
            <span className="ml-1 flex items-center gap-1 text-muted-foreground">
              Engine: Ookla
              <Info className="size-3 text-muted-foreground/60" />
            </span>
          </InfoTip>
        ) : !off && data ? (
          <span className="ml-1 text-muted-foreground">
            &le; ~{monthlyGB(data.period_h, data.cap_mb).toFixed(monthlyGB(data.period_h, data.cap_mb) >= 10 ? 0 : 1)} GB/mo
          </span>
        ) : null}
        <Button size="sm" variant="secondary" className="ml-auto" disabled={!data || data.pending} onClick={runNow}>
          <Gauge className="size-3.5" />{data?.pending ? "Running…" : "Test now"}
        </Button>
      </div>
    </Card>
  )
}
