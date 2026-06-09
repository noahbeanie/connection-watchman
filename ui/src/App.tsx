import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  ChevronLeft, ChevronRight, Download, FileText, Pause, Play, Siren, Trash2, TrendingDown, TrendingUp,
} from "lucide-react"
import { toast } from "sonner"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Toaster } from "@/components/ui/sonner"
import { AvailabilityGauge } from "@/components/AvailabilityGauge"
import { LatencyChart } from "@/components/LatencyChart"
import { Tracker } from "@/components/Tracker"
import { StatCard } from "@/components/StatCard"
import { StatusBadge } from "@/components/StatusBadge"
import { OutagesEmpty } from "@/components/OutagesEmpty"
import { OutagesTimeline } from "@/components/OutagesTimeline"
import { CauseLegend } from "@/components/CauseLegend"
import { DateRangePicker } from "@/components/DateRangePicker"
import { AlertSettings } from "@/components/AlertSettings"
import { TargetsPopover } from "@/components/TargetsPopover"
import { ReportView } from "@/components/ReportView"
import { InfoTip } from "@/components/InfoTip"
import type { Live, Meta, RangeData } from "@/lib/types"
import {
  PRESETS, defaultPreset, fmtDate, fmtDur, fmtRangeShort, fmtSince, fmtStreak, fmtTime, humanBytes, latencyFence, nowSec, pctText, resolverName,
} from "@/lib/format"
import watchmanLogo from "@/assets/watchman.png"

const api = async (p: string) => (await fetch(p, { cache: "no-store" })).json()
const post = (p: string, body: unknown) =>
  fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

// Editable settings (values must match the backend whitelist in dashboard.py CFG_OPTIONS).
const INTERVAL_OPTS = [5, 10, 15, 30, 60].map((v) => ({ v, label: `Every ${v}s` }))
const RETENTION_OPTS = [
  { v: 30, label: "30 days" }, { v: 90, label: "90 days" }, { v: 180, label: "180 days" },
  { v: 365, label: "365 days" }, { v: 0, label: "Forever" },
]
const OUTAGE_OPTS = [
  { v: 0, label: "Forever" }, { v: 365, label: "1 year" }, { v: 180, label: "6 months" }, { v: 90, label: "90 days" },
]
const TIMEOUT_OPTS = [
  { v: 1000, label: "1.0 s (strict)" }, { v: 1500, label: "1.5 s" },
  { v: 2000, label: "2.0 s" }, { v: 3000, label: "3.0 s (lenient)" },
]

function ConfigSelect({ value, options, onChange }: {
  value: number; options: { v: number; label: string }[]; onChange: (v: number) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ colorScheme: "dark" }}
      className="cursor-pointer rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs text-foreground outline-none transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {options.map((o) => (
        <option key={o.v} value={o.v} style={{ backgroundColor: "var(--popover)", color: "var(--popover-foreground)" }}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function download(url: string) {
  const a = document.createElement("a"); a.href = url; a.download = ""
  document.body.appendChild(a); a.click(); a.remove()
}
function windowFor(presetId: string) {
  const end = nowSec()
  const span = PRESETS.find((p) => p.id === presetId)?.span
  return { start: span ? end - span : 0, end }
}

const Skeleton = ({ h }: { h: number }) => (
  <div className="w-full animate-pulse rounded-md bg-muted/40" style={{ height: h }} />
)

export default function App() {
  const [preset, setPreset] = useState("24h")
  const [customRange, setCustomRange] = useState<{ start: number; end: number } | null>(null)
  const [data, setData] = useState<RangeData | null>(null)
  const [allOutages, setAllOutages] = useState<RangeData | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [token, setToken] = useState("")
  const [resetOpen, setResetOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [outPage, setOutPage] = useState(0)
  const [nowTs, setNowTs] = useState(() => new Date())
  const [hoverT, setHoverT] = useState<number | null>(null)
  const booted = useRef(false)

  const loadRange = useCallback(async () => {
    const { start, end } = preset === "custom" && customRange ? customRange : windowFor(preset)
    try { setData(await api(`/api/range?start=${start}&end=${end}`)) } catch { /* keep last */ }
  }, [preset, customRange])

  useEffect(() => {
    loadRange()
    const span = PRESETS.find((p) => p.id === preset)?.span ?? Infinity
    const ms = span <= 86400 ? 10000 : span <= 2592000 ? 30000 : 60000
    const id = setInterval(loadRange, ms)
    return () => clearInterval(id)
  }, [preset, loadRange])

  // Jump back to the first page of outages whenever the selected range changes.
  useEffect(() => { setOutPage(0) }, [preset, customRange])

  // All-time fetch powers the lifetime stats in Data & tools (MTTR / MTBF / last outage).
  const loadOutages = useCallback(async () => {
    const start = meta?.first_ts ?? 0
    try { setAllOutages(await api(`/api/range?start=${start}&end=${nowSec()}`)) } catch { /* keep last */ }
  }, [meta?.first_ts])

  // Fine-grained range fetch for the tracker's partial-segment breakdown popover.
  const fetchRange = useCallback((start: number, end: number): Promise<RangeData> => api(`/api/range?start=${start}&end=${end}`), [])
  useEffect(() => {
    loadOutages()
    const id = setInterval(loadOutages, 30000)
    return () => clearInterval(id)
  }, [loadOutages])

  const refetchLive = useCallback(async () => { try { setLive(await api("/api/live")) } catch { /**/ } }, [])
  const refetchMeta = useCallback(async () => { try { setMeta(await api("/api/meta")) } catch { /**/ } }, [])

  useEffect(() => { refetchLive(); const id = setInterval(refetchLive, 5000); return () => clearInterval(id) }, [refetchLive])
  useEffect(() => { const id = setInterval(() => setNowTs(new Date()), 1000); return () => clearInterval(id) }, [])
  useEffect(() => {
    const load = async () => {
      try {
        const m: Meta = await api("/api/meta"); setMeta(m)
        if (!booted.current) { booted.current = true; setPreset(defaultPreset(m.first_ts)) }
      } catch { /**/ }
    }
    load(); const id = setInterval(load, 30000); return () => clearInterval(id)
  }, [])

  const setPause = async (want: boolean, minutes?: number) => {
    await post("/api/pause", { paused: want, minutes })
    await Promise.allSettled([refetchMeta(), refetchLive()])
    toast.success(
      want
        ? minutes ? `Paused for ${minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`}` : "Monitoring paused"
        : "Monitoring resumed",
    )
  }
  const doReset = async () => {
    const res = await post("/api/reset", { confirm: "RESET" })
    if (res.ok) { setResetOpen(false); setToken(""); await Promise.allSettled([refetchMeta(), loadRange(), loadOutages()]); toast.success("All data cleared") }
    else toast.error("Reset failed: " + (await res.text()))
  }
  const updateConfig = async (key: string, value: number) => {
    const res = await post("/api/config", { [key]: value })
    if (res.ok) { await Promise.allSettled([refetchMeta(), loadRange(), loadOutages()]); toast.success("Setting updated") }
    else toast.error("Update failed: " + (await res.text()))
  }
  const saveOutageNote = async (id: number, note: string) => {
    const res = await post("/api/outage/note", { id, note })
    if (res.ok) { await Promise.allSettled([loadRange(), loadOutages()]); toast.success(note ? "Note saved" : "Note cleared") }
    else toast.error("Could not save note: " + (await res.text()))
  }
  const deleteOutage = async (id: number) => {
    const res = await post("/api/outage/delete", { id })
    if (res.ok) { await Promise.allSettled([refetchMeta(), loadRange(), loadOutages()]); toast.success("Outage removed; that time is now marked online") }
    else toast.error("Could not delete outage: " + (await res.text()))
  }
  const exportUrl = (kind: string) => { const { start, end } = windowFor(preset); return `/api/export/${kind}.csv?start=${start}&end=${end}` }
  const exportData = () => { download(exportUrl("checks")); setTimeout(() => download(exportUrl("outages")), 400) }

  const availSecs = meta?.first_ts ? nowSec() - meta.first_ts : 0
  const histMsg = availSecs > 0 ? `Only ${fmtDur(availSecs)} of history so far` : "No history recorded yet"
  const s = data?.summary
  // Outage list + DNS panel now follow the selected range (no longer a fixed 24h window), so
  // the list agrees with the gauge / Downtime / Outages tiles above it.
  const rangeNet = data ? data.outages.filter((o) => o.kind !== "dns") : []
  // Paginate the outage list so the card can bottom-align with Data & tools instead of growing
  // unbounded. Page size is fixed; pagination controls sit pinned at the bottom of the card.
  const OUT_PAGE = 7
  const outTotalPages = Math.max(1, Math.ceil(rangeNet.length / OUT_PAGE))
  const outCurPage = Math.min(outPage, outTotalPages - 1)
  const shownOut = rangeNet.slice(outCurPage * OUT_PAGE, (outCurPage + 1) * OUT_PAGE)
  const wd = data ? data.end - data.start > 86400 : false
  // Latency headline from healthy (fully-up) buckets, with the same robust outlier fence the
  // chart uses, so latency spikes near the timeout don't inflate Avg/Max.
  const upB = data ? data.buckets.filter((b) => b.total > 0 && b.up === b.total && b.avg != null) : []
  const latFence = latencyFence(upB.map((b) => b.avg as number))
  const latKept = upB.filter((b) => (b.avg as number) <= latFence)
  const latW = latKept.reduce((a, b) => a + b.up, 0)
  const latAvg = latW ? Math.round((latKept.reduce((a, b) => a + (b.avg as number) * b.up, 0) / latW) * 10) / 10 : null
  const latAvgs = latKept.map((b) => b.avg as number)
  const latMin = latAvgs.length ? Math.min(...latAvgs) : null
  const latMax = latAvgs.length ? Math.max(...latAvgs) : null
  const down = s?.down_seconds ?? 0
  const outs = s?.outage_count ?? 0
  // Label suffix = the selected period (e.g. "1H", "1Y", "All", or a compact custom range).
  const periodLabel = preset === "custom" && customRange
    ? fmtRangeShort(customRange.start, customRange.end)
    : PRESETS.find((p) => p.id === preset)?.label ?? ""
  // Current uptime = how long the connection has been continuously online right now (the live
  // up-streak), independent of the selected range.
  const upStreak = live?.status === "up" ? fmtStreak(live.streak_seconds ?? 0)
    : live?.status === "down" ? "Offline" : meta?.paused ? "Paused" : "—"
  const upStreakColor = live?.status === "up" ? "var(--up)" : live?.status === "down" ? "var(--down)" : "var(--muted-foreground)"

  // All-time stats (from the first-check fetch) + live, for the Data & tools panel
  const at = allOutages?.summary
  const netDone = allOutages ? allOutages.outages.filter((o) => o.kind === "net" && !o.ongoing) : []
  const mttr = netDone.length ? netDone.reduce((a, o) => a + o.duration_s, 0) / netDone.length : null
  const mtbf = at && at.outage_count > 0 ? at.monitored_seconds / at.outage_count : null
  const lastOut = allOutages?.outages.find((o) => o.kind === "net")
  const liveLat = live?.latency_ms != null ? `${live.latency_ms} ms` : live?.status === "down" ? "Offline" : "—"
  const dataSections: { title: string; rows: { label: string; hint: ReactNode; value?: ReactNode; control?: ReactNode }[] }[] = meta
    ? [
        {
          title: "Monitoring",
          rows: [
            { label: "Live latency", value: liveLat, hint: "The most recent round-trip time to reach the internet." },
            { label: "All-time uptime", value: at ? pctText(at.availability_pct) : "—", hint: "Connectivity uptime since monitoring began, excluding paused and no-data spans." },
            { label: "Total checks", value: at ? at.checks.toLocaleString() : "—", hint: "Number of connectivity checks recorded." },
            { label: "Avg recovery", value: mttr != null ? fmtDur(mttr) : "No outages", hint: "Mean time to recover: the average length of a connectivity outage." },
            { label: "Between outages", value: mtbf != null ? fmtDur(mtbf) : "No outages", hint: "Mean time between failures: monitored time divided by the number of outages." },
            { label: "Last outage", value: lastOut ? fmtTime(lastOut.start, true) : "None recorded", hint: "When the most recent connectivity outage began." },
          ],
        },
        {
          title: "Configuration",
          rows: [
            { label: "Check interval", control: <ConfigSelect value={meta.interval} options={INTERVAL_OPTS} onChange={(v) => updateConfig("interval", v)} />, hint: "How often a connectivity check runs. Takes effect within a cycle; the rest of the app follows the new cadence." },
            { label: "Response cutoff", control: <ConfigSelect value={meta.timeout_ms} options={TIMEOUT_OPTS} onChange={(v) => updateConfig("timeout_ms", v)} />, hint: "A server must answer within this or the check counts as down (a real outage), so a connection that's technically reachable but too slow to use still registers. Lower is stricter; the retry debounce means only sustained slowness counts, not one-off blips." },
            { label: "Gateway", value: meta.gateway ?? "Unknown", hint: "Your router's local IP. Used to tell a local problem apart from an ISP problem." },
            { label: "Retention", control: <ConfigSelect value={meta.retention_days} options={RETENTION_OPTS} onChange={(v) => updateConfig("retention_days", v)} />, hint: "How long raw per-check data is kept before it's trimmed." },
            {
              label: "Database",
              value: humanBytes(meta.db_size_bytes),
              hint: (
                <div>
                  <p>Local database file size. The raw check log grows at roughly:</p>
                  <ul className="mt-1.5 space-y-0.5">
                    {[5, 10, 15, 30, 60].map((iv) => {
                      const mb = (15 * 15) / iv // ~15 MB/month at the 15s default, scales with the check rate
                      return (
                        <li key={iv} className={`flex justify-between gap-3 ${iv === meta.interval ? "font-semibold text-foreground" : ""}`}>
                          <span>Every {iv}s{iv === meta.interval ? " (current)" : ""}</span>
                          <span>~{mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB/mo</span>
                        </li>
                      )
                    })}
                  </ul>
                  <p className="mt-1.5 text-muted-foreground">Older rows are trimmed at your retention setting, so the file plateaus.</p>
                </div>
              ),
            },
            { label: "Outage history", control: <ConfigSelect value={meta.outage_retention_days} options={OUTAGE_OPTS} onChange={(v) => updateConfig("outage_retention_days", v)} />, hint: "How long resolved outages are kept. Independent of the raw-data retention above." },
          ],
        },
      ]
    : []

  const sectionHeader = (title: string) => (
    <p className="mb-1 px-0.5 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/60">{title}</p>
  )

  return (
    <>
      <Toaster richColors position="bottom-center" />
      <div className="app-shell mx-auto max-w-[1180px] px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 items-end gap-3">
            <img src={watchmanLogo} alt="Connection Watchman logo"
              className="size-20 shrink-0 rounded-xl object-cover shadow-lg shadow-black/40 sm:size-24" />
            <div className="min-w-0">
              <h1 className="wordmark break-words text-3xl font-bold leading-[1.1] tracking-tight sm:text-5xl sm:leading-none">
                Connection Watchman
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {meta?.first_ts && (
              <span className="hidden text-xs font-medium text-foreground/90 sm:inline">
                Scan running since {fmtSince(meta.first_ts)}
              </span>
            )}
            <StatusBadge live={live} meta={meta} />
          </div>
        </header>

        {/* Top: availability gauge + incident tiles (left) | uptime tracker above latency (right). */}
        <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
          {/* Left column: availability gauge, then the incident tiles */}
          <div className="order-2 flex flex-col gap-4 lg:order-1">
            <Card className="flex items-center justify-center p-3">
              <AvailabilityGauge pct={s?.availability_pct ?? null} presetId={preset} />
            </Card>
            <StatCard className="grow" icon={TrendingUp} label="Current uptime" accent="var(--up)"
              value={upStreak} valueColor={upStreakColor}
              hint="How long the connection has been continuously online right now, with no outages. This is the live streak and ignores the selected time range." />
            <StatCard className="grow" icon={TrendingDown} label={`Downtime (${periodLabel})`} accent="var(--down)"
              value={fmtDur(down)} valueColor={down > 0 ? "var(--down)" : "var(--muted-foreground)"}
              hint="Total time your connection was down in the selected period, not counting paused or no-data periods." />
            <StatCard className="grow" icon={Siren} label={`Outages (${periodLabel})`} accent="var(--orange)"
              value={s ? outs : "—"} valueColor={outs > 0 ? "var(--orange)" : "var(--muted-foreground)"}
              hint="How many separate times your connection dropped in the selected period." />
          </div>

          {/* Right column: uptime + latency in one container, shared range tabs and linked hover */}
          <div className="order-1 flex flex-col gap-4 lg:order-2">
            <Card className="grow p-4 sm:p-5">
              {/* shared controls: range tabs + live clock */}
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <div className="flex w-full gap-1 rounded-lg border bg-muted/30 p-1 sm:inline-flex sm:w-auto">
                  {PRESETS.map((p) => {
                    const tooBig = !!(p.span && p.span > availSecs)
                    const btn = (
                      <Button key={p.id} type="button" size="sm" disabled={tooBig}
                        variant={preset === p.id ? "default" : "ghost"}
                        className={`h-8 px-1.5 text-[11px] font-semibold sm:px-3 sm:text-xs ${tooBig ? "w-full sm:w-auto" : "flex-1 sm:flex-none"}`}
                        onClick={() => { setPreset(p.id); setCustomRange(null) }}>
                        {p.label}
                      </Button>
                    )
                    return tooBig ? (
                      <InfoTip key={p.id} focusable={false} className="flex-1 sm:flex-none" label={histMsg}>
                        {btn}
                      </InfoTip>
                    ) : btn
                  })}
                </div>
                <DateRangePicker
                  firstTs={meta?.first_ts ?? null}
                  now={nowSec()}
                  value={customRange}
                  active={preset === "custom"}
                  onApply={(start, end) => { setCustomRange({ start, end }); setPreset("custom") }}
                />
                <span className="font-mono text-2xl font-bold leading-none tabular-nums text-foreground sm:ml-auto sm:text-4xl">
                  {nowTs.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
                </span>
              </div>

              {/* Uptime section: title top-left (mirrors Latency), legend on the right */}
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold tracking-tight">Uptime</h2>
                <div className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
                  {[["var(--up)", "Up"], ["var(--amber)", "Partial"], ["var(--down)", "Down"], ["var(--paused)", "Paused"], ["var(--gap-band)", "No data"]].map(([c, t]) => (
                    <span key={t} className="flex items-center gap-1.5">
                      <span className="inline-block size-2.5 rounded-sm" style={{ background: c }} />{t}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex grow flex-col pl-[34px] pr-3">
                {data ? <Tracker data={data} hoverT={hoverT} onHoverT={setHoverT} fetchRange={fetchRange} /> : <Skeleton h={96} />}
                <div className="mt-2.5 flex justify-between font-mono text-xs text-muted-foreground">
                  <span>{data ? (wd ? fmtDate(data.start) : fmtTime(data.start)) : ""} <span className="opacity-60">(Local Time)</span></span>
                  <span>Now</span>
                </div>
              </div>

              {/* Latency section */}
              <div className="mb-2 mt-5 flex items-center justify-between border-t border-border/40 pt-4">
                <h2 className="text-sm font-semibold tracking-tight">
                  Latency <span className="font-normal text-muted-foreground/70">(lower is faster)</span>
                </h2>
                {latAvg != null && (
                  <span className="font-mono text-xs text-muted-foreground">
                    Avg {latAvg} ms{latMin != null ? ` · Min ${latMin} · Max ${latMax}` : ""}
                  </span>
                )}
              </div>
              <div className="flex flex-col h-[160px]">
                {data ? <LatencyChart data={data} hoverT={hoverT} onHoverT={setHoverT} /> : <Skeleton h={160} />}
              </div>
            </Card>
          </div>
        </div>

        {/* Notifications + outages (left column) | data & tools (right column).
            Columns stretch to equal height so the Outages card bottom-aligns with Data & tools. */}
        <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[1.7fr_1fr]">
          <div className="flex flex-col gap-4">
            {meta && (
              <Card className="p-4 sm:p-5">
                <AlertSettings alerts={meta.alerts} onSaved={refetchMeta} />
              </Card>
            )}
            <Card className="flex grow flex-col p-4 sm:p-5">
              <h2 className="mb-3 text-[0.95rem] font-semibold tracking-tight">
                Outages <span className="font-normal text-muted-foreground">({periodLabel})</span>
              </h2>
              {!data ? <Skeleton h={120} />
                : rangeNet.length
                  ? <>
                      <CauseLegend />
                      <OutagesTimeline outages={shownOut} onSaveNote={saveOutageNote} onDelete={deleteOutage} />
                      {outTotalPages > 1 && (
                        <div className="mt-auto flex items-center justify-between gap-2 pt-4 text-xs text-muted-foreground">
                          <button type="button" disabled={outCurPage === 0}
                            onClick={() => setOutPage((p) => Math.max(0, p - 1))}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium transition hover:text-foreground disabled:pointer-events-none disabled:opacity-30">
                            <ChevronLeft className="size-3.5" />Prev
                          </button>
                          <span className="tabular-nums">Page {outCurPage + 1} of {outTotalPages} &middot; {rangeNet.length} total</span>
                          <button type="button" disabled={outCurPage >= outTotalPages - 1}
                            onClick={() => setOutPage((p) => Math.min(outTotalPages - 1, p + 1))}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium transition hover:text-foreground disabled:pointer-events-none disabled:opacity-30">
                            Next<ChevronRight className="size-3.5" />
                          </button>
                        </div>
                      )}
                    </>
                  : <OutagesEmpty />}
            </Card>
          </div>

          <Card className="p-4 sm:p-5">
            <h2 className="mb-3 text-[0.95rem] font-semibold tracking-tight">Data &amp; tools</h2>
            {dataSections.length > 0 && (
              <div className="mb-4 space-y-3 text-xs">
                {dataSections.map((sec) => (
                  <div key={sec.title}>
                    {sectionHeader(sec.title)}
                    <div className="space-y-0.5">
                      {sec.rows.map(({ label, value, hint, control }) => (
                        <div key={label} className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-1 transition-colors hover:bg-muted/40">
                          <InfoTip label={hint}>
                            <span className="border-b border-dotted border-muted-foreground/40 text-muted-foreground">{label}</span>
                          </InfoTip>
                          {control ?? <span className="text-right font-mono text-foreground/80">{value}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {meta && !!meta.resolvers?.length && (
              <div className="mb-4">
                {sectionHeader("DNS resolvers")}
                <div className="space-y-0.5 text-xs">
                  {meta.resolvers.map((ip) => (
                    <div key={ip} className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-1 transition-colors hover:bg-muted/40">
                      <InfoTip label="A public DNS resolver the monitor queries to confirm name resolution. DNS is tracked as its own signal and never counts as connectivity downtime.">
                        <span className="border-b border-dotted border-muted-foreground/40 text-muted-foreground">{resolverName(ip)}</span>
                      </InfoTip>
                      <span className="text-right font-mono text-foreground/80">{ip}</span>
                    </div>
                  ))}
                </div>
                {/* Compact entry point to the reachability-targets editor (kept out of the way). */}
                <div className="mt-1.5 px-0.5">
                  <TargetsPopover targets={meta.targets} custom={meta.targets_custom} onSaved={refetchMeta} />
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t border-border/40 pt-3">
              <InfoTip focusable={false} className="min-w-[7rem] flex-1" label="Download your full check log and outage log as CSV files.">
                <Button variant="secondary" size="sm" className="w-full" onClick={exportData}><Download className="size-4" />Export</Button>
              </InfoTip>
              <InfoTip focusable={false} className="min-w-[7rem] flex-1" label="Open a clean, printable report of this period's outages to save as PDF or hand to your ISP.">
                <Button variant="secondary" size="sm" className="w-full" disabled={!data} onClick={() => setReportOpen(true)}><FileText className="size-4" />Report</Button>
              </InfoTip>
              <InfoTip focusable={false} className="min-w-[7rem] flex-1" label={meta?.paused ? "Resume recording checks." : "Temporarily stop recording checks."}>
                <Button variant="secondary" size="sm" className="w-full" onClick={() => setPause(!meta?.paused)}>
                  {meta?.paused ? <><Play className="size-4" />Resume</> : <><Pause className="size-4" />Pause</>}
                </Button>
              </InfoTip>
              <InfoTip focusable={false} className="min-w-[7rem] flex-1" label="Permanently erase all recorded data. This cannot be undone.">
                <Button variant="destructive" size="sm" className="w-full" onClick={() => setResetOpen(true)}><Trash2 className="size-4" />Reset</Button>
              </InfoTip>
            </div>
            {/* Timed-pause helpers / resume countdown */}
            {meta?.paused ? (
              meta.pause_until ? (
                <p className="mt-2 text-xs text-muted-foreground">Auto-resumes at {fmtTime(meta.pause_until)}.</p>
              ) : null
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>Pause for:</span>
                {[["1 hour", 60], ["4 hours", 240], ["24 hours", 1440]].map(([label, mins]) => (
                  <button key={label} type="button" onClick={() => setPause(true, mins as number)}
                    className="rounded border border-border/60 px-1.5 py-0.5 transition hover:border-foreground/30 hover:text-foreground">
                    {label}
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>

        <Dialog open={resetOpen} onOpenChange={setResetOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reset all data?</DialogTitle>
              <DialogDescription>
                This permanently deletes every check, outage, and event. There is no backup.
                Type <span className="font-mono font-semibold text-foreground">RESET</span> to confirm.
              </DialogDescription>
            </DialogHeader>
            <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="type RESET" autoComplete="off" />
            <DialogFooter>
              <Button variant="outline" onClick={() => setResetOpen(false)}>Cancel</Button>
              <Button variant="destructive" disabled={token !== "RESET"} onClick={doReset}>Wipe everything</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {reportOpen && data && (
        <ReportView data={data} periodLabel={periodLabel} onClose={() => setReportOpen(false)} />
      )}
    </>
  )
}
