import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  ChevronLeft, ChevronRight, Download, FileText, Globe, Pause, Play, Siren, Trash2, TrendingDown, TrendingUp,
} from "lucide-react"
import { toast } from "sonner"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Toaster } from "@/components/ui/sonner"
import { AvailabilityGauge } from "@/components/AvailabilityGauge"
import { LatencyChart, LiveTicker } from "@/components/LatencyChart"
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
  PRESETS, defaultPreset, fmtDate, fmtDur, fmtRangeShort, fmtSince, fmtStreak, fmtTime, humanBytes, nowSec, pctText, resolverName,
} from "@/lib/format"
import watchmanLogo from "@/assets/watchman.png"

const api = async (p: string) => (await fetch(p, { cache: "no-store" })).json()
const post = (p: string, body: unknown) =>
  fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

// Editable settings (values must match the backend whitelist in dashboard.py CFG_OPTIONS).
const INTERVAL_OPTS = [1, 5, 10, 15, 30, 60].map((v) => ({ v, label: `Every ${v}s` }))
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

// Settings dropdown: a real styled popup (Base UI Select) instead of the OS-native
// <select>, so the open menu matches the app's dark chrome on every platform.
function ConfigSelect({ value, options, onChange }: {
  value: number; options: { v: number; label: string }[]; onChange: (v: number) => void
}) {
  return (
    <Select
      items={options.map((o) => ({ value: o.v, label: o.label }))}
      value={value}
      onValueChange={(v) => { if (v != null) onChange(Number(v)) }}
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

function download(url: string) {
  const a = document.createElement("a"); a.href = url; a.download = ""
  document.body.appendChild(a); a.click(); a.remove()
}
function windowFor(presetId: string) {
  // LIVE renders a conveyor belt: hold its window one second behind the clock so the
  // newest bucket is always committed before it scrolls into view (no right-edge
  // pop-in). The whole live card runs ~2 s behind reality; nothing else does.
  const end = nowSec() - (presetId === "live" ? 1 : 0)
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
    // Tiny windows are a live troubleshooting view: the LIVE preset crawls forward every
    // second, 15M refreshes every few seconds, day-scale every 10s, and so on up.
    const ms = span <= 180 ? 1000 : span <= 900 ? 5000 : span <= 86400 ? 10000 : span <= 2592000 ? 30000 : 60000
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

  // Mobile browsers suspend JS timers while the tab is backgrounded or the screen is locked, so the
  // polling intervals stop firing and the view goes stale until a manual refresh. Re-sync everything
  // the instant the page becomes visible again (or regains focus / the network returns), so coming
  // back to the tab snaps to current data instead of waiting on a suspended timer.
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState === "hidden") return
      setNowTs(new Date())
      refetchLive(); refetchMeta(); loadRange(); loadOutages()
    }
    document.addEventListener("visibilitychange", resync)
    window.addEventListener("focus", resync)
    window.addEventListener("online", resync)
    return () => {
      document.removeEventListener("visibilitychange", resync)
      window.removeEventListener("focus", resync)
      window.removeEventListener("online", resync)
    }
  }, [refetchLive, refetchMeta, loadRange, loadOutages])

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
  const exportUrl = (kind: string) => {
    // Same range resolution as loadRange, so a custom range exports exactly what's on screen.
    const { start, end } = preset === "custom" && customRange ? customRange : windowFor(preset)
    return `/api/export/${kind}.csv?start=${start}&end=${end}`
  }
  const exportData = () => { download(exportUrl("checks")); setTimeout(() => download(exportUrl("outages")), 400) }

  const availSecs = meta?.first_ts ? nowSec() - meta.first_ts : 0
  const histMsg = availSecs > 0 ? `Only ${fmtDur(availSecs)} of history so far` : "No history recorded yet"
  const s = data?.summary
  // Outage list + DNS panel now follow the selected range (no longer a fixed 24h window), so
  // the list agrees with the gauge / Downtime / Outages tiles above it.
  // The outage list shows connectivity (net) outages AND DNS outages (a DNS failure means sites
  // won't load on any device, so it belongs here), each clearly labeled. DNS stays out of the
  // downtime math; that's handled server-side.
  const rangeNet = data ? data.outages.filter((o) => o.kind === "net" || o.kind === "dns") : []
  // Paginate the outage list so the card can bottom-align with Data & tools instead of growing
  // unbounded. Page size is fixed; pagination controls sit pinned at the bottom of the card.
  const OUT_PAGE = 7
  const outTotalPages = Math.max(1, Math.ceil(rangeNet.length / OUT_PAGE))
  const outCurPage = Math.min(outPage, outTotalPages - 1)
  const shownOut = rangeNet.slice(outCurPage * OUT_PAGE, (outCurPage + 1) * OUT_PAGE)
  const wd = data ? data.end - data.start > 86400 : false
  // Latency headline: the TRUE numbers (typical avg + peak) straight from the summary, not a
  // fenced/smoothed version, so a real spike actually shows instead of hiding.
  const latAvg = s?.avg_lat ?? null
  const latMax = s?.max_lat ?? null
  const down = s?.down_seconds ?? 0
  const outs = s?.outage_count ?? 0
  const dnsEvents = s?.dns_events ?? 0
  // Label suffix = the selected period (e.g. "1H", "1Y", "All", or a compact custom range).
  const periodLabel = preset === "custom" && customRange
    ? fmtRangeShort(customRange.start, customRange.end)
    : PRESETS.find((p) => p.id === preset)?.label ?? ""
  // Current uptime = how long the connection has been continuously online right now (the live
  // up-streak), independent of the selected range.
  const upStreak = live?.status === "up" ? fmtStreak(live.streak_seconds ?? 0)
    : live?.status === "down" ? "Offline" : meta?.paused ? "Paused" : "—"
  // Colour is reserved for exceptional state (offline) and for dimming empty values;
  // healthy numbers stay foreground so the icon chips carry the category colours alone.
  const upStreakColor = live?.status === "down" ? "var(--down)"
    : live?.status === "up" ? undefined : "var(--muted-foreground)"

  // All-time stats (from the first-check fetch) + live, for the Data & tools panel.
  // MTTR / last outage come from server-side aggregates over ALL outages — the outages
  // array is capped at 200 rows, so deriving stats from it would silently truncate.
  // The net-only fields are used here because these rows are labeled "connectivity".
  const at = allOutages?.summary
  const mttr = at?.mttr_net_s ?? null
  const mtbf = at && at.outage_count > 0 ? at.monitored_seconds / at.outage_count : null
  const lastOut = at?.last_net_outage_start ?? null
  const liveLat = live?.latency_ms != null ? `${live.latency_ms} ms` : live?.status === "down" ? "Offline" : "—"
  const dataSections: { title: string; rows: { label: string; hint: ReactNode; value?: ReactNode; control?: ReactNode }[] }[] = meta
    ? [
        {
          title: "Monitoring",
          rows: [
            { label: "Live latency", value: liveLat, hint: "The most recent round-trip time to reach the internet." },
            { label: "All-time uptime", value: at ? pctText(at.availability_pct) : "—", hint: "Connectivity uptime since monitoring began, excluding paused and no-data spans." },
            { label: "Total checks", value: at ? at.checks.toLocaleString() : "—", hint: "Number of connectivity checks recorded." },
            { label: "Avg recovery", value: mttr != null ? fmtDur(mttr) : "No outages", hint: "Mean time to recover: the average length of a connectivity outage. Time the monitor wasn't running is excluded, so a reboot can't inflate it." },
            { label: "Between outages", value: mtbf != null ? fmtDur(mtbf) : "No outages", hint: "Mean time between failures: monitored time divided by the number of outages." },
            { label: "Last outage", value: lastOut != null ? fmtTime(lastOut, true) : "None recorded", hint: "When the most recent connectivity outage began." },
          ],
        },
        {
          title: "Configuration",
          rows: [
            { label: "Check interval", control: <ConfigSelect value={meta.interval} options={INTERVAL_OPTS} onChange={(v) => updateConfig("interval", v)} />, hint: "How often a connectivity check runs. Takes effect within a cycle; the rest of the app follows the new cadence. 1s gives the LIVE view per-second resolution but grows the database fastest (see Database below)." },
            { label: "Response cutoff", control: <ConfigSelect value={meta.timeout_ms} options={TIMEOUT_OPTS} onChange={(v) => updateConfig("timeout_ms", v)} />, hint: "A server must answer within this or the check counts as down (a real outage), so a connection that's technically reachable but too slow to use still registers. Lower is stricter; the retry debounce means only sustained slowness counts, not one-off blips." },
            { label: "Gateway", value: meta.gateway ?? "Unknown", hint: "Your router's local IP. Used to tell a local problem apart from an ISP problem." },
            { label: "Retention", control: <ConfigSelect value={meta.retention_days} options={RETENTION_OPTS} onChange={(v) => updateConfig("retention_days", v)} />, hint: "How long raw per-check data is kept before it's trimmed." },
            {
              label: "Database",
              // live endpoint carries the size on the 5s poll; meta (30s) is the fallback
              value: humanBytes(live?.db_size_bytes ?? meta.db_size_bytes),
              hint: (
                <div>
                  <p>Local database file size. The raw check log grows at roughly:</p>
                  <ul className="mt-1.5 space-y-0.5">
                    {[1, 5, 10, 15, 30, 60].map((iv) => {
                      const mb = (15 * 15) / iv // ~15 MB/month at the 15s default, scales with the check rate
                      return (
                        <li key={iv} className={`flex justify-between gap-3 ${iv === meta.interval ? "font-semibold text-foreground" : ""}`}>
                          <span>Every {iv}s{iv === meta.interval ? " (current)" : ""}</span>
                          <span>~{mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB/mo</span>
                        </li>
                      )
                    })}
                  </ul>
                  <p className="mt-1.5 text-muted-foreground">
                    Those rates apply to the last 2 days. Older healthy checks are thinned to one
                    per 15 s (failures are never thinned), and rows past your retention are trimmed,
                    so long-term growth stays near the 15 s rate even at 1 s checks.
                  </p>
                </div>
              ),
            },
            { label: "Outage history", control: <ConfigSelect value={meta.outage_retention_days} options={OUTAGE_OPTS} onChange={(v) => updateConfig("outage_retention_days", v)} />, hint: "How long resolved outages are kept. Independent of the raw-data retention above." },
          ],
        },
      ]
    : []

  const sectionHeader = (title: string) => (
    <p className="mb-1.5 flex items-center gap-2 px-0.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground after:h-px after:grow after:bg-border/60 after:content-['']">
      {title}
    </p>
  )

  return (
    <>
      <Toaster richColors position="bottom-center" />
      <div className="app-shell">
        {/* Full-width sticky bar: the page identity + live status stay in view while the
            content scrolls beneath a frosted edge. */}
        <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
          <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-2 px-4 py-2.5 sm:gap-4 sm:px-6 lg:px-8">
            {/* Baseline alignment: an img's flex baseline is its bottom edge, so on >=sm the
                wordmark's baseline sits exactly on the logo's bottom. Phones stay centered
                because the wordmark can wrap to two lines there. */}
            <div className="flex min-w-0 items-center gap-2.5 sm:items-baseline sm:gap-3.5">
              <img src={watchmanLogo} alt="Connection Watchman logo"
                className="size-12 shrink-0 rounded-lg object-cover shadow-md shadow-black/40 sm:size-18" />
              <div className="min-w-0">
                <h1 className="wordmark break-words text-xl font-semibold leading-[1.1] tracking-tight sm:text-4xl sm:leading-none">
                  Connection Watchman
                </h1>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {meta?.first_ts && (
                <span className="hidden text-xs text-muted-foreground md:inline">
                  Monitoring since {fmtSince(meta.first_ts)}
                </span>
              )}
              <StatusBadge live={live} meta={meta} />
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-[1180px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">

        {/* Top: availability gauge + incident tiles (left) | uptime tracker above latency (right). */}
        <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
          {/* Left column: availability gauge, then the incident tiles */}
          <div className="order-2 flex flex-col gap-4 lg:order-1">
            <Card className="fade-up flex items-center justify-center p-3">
              <AvailabilityGauge pct={s?.availability_pct ?? null} presetId={preset} />
            </Card>
            <Card className="fade-up grow gap-0 divide-y divide-border/40 py-0" style={{ animationDelay: "60ms" }}>
              <StatCard className="grow" icon={TrendingUp} label="Current uptime" accent="var(--up)"
                value={upStreak} valueColor={upStreakColor}
                hint="How long the connection has been continuously online right now, with no outages. This is the live streak and ignores the selected time range." />
              <StatCard className="grow" icon={TrendingDown} label={`Downtime (${periodLabel})`} accent="var(--down)"
                value={fmtDur(down)} valueColor={down > 0 ? undefined : "var(--muted-foreground)"}
                hint="Total time the internet was unusable in the selected period: connectivity outages plus DNS failures. Excludes paused and no-data periods." />
              <StatCard className="grow" icon={Siren} label={`Outages (${periodLabel})`} accent="var(--orange)"
                value={s ? outs : "—"} valueColor={outs > 0 ? undefined : "var(--muted-foreground)"}
                hint="How many separate times the internet went unusable in the selected period, both connectivity drops and DNS outages. The list below labels each one's kind." />
              <StatCard className="grow" icon={Globe} label={`DNS outages (${periodLabel})`} accent="var(--primary)"
                value={s ? dnsEvents : "—"} valueColor={dnsEvents > 0 ? undefined : "var(--muted-foreground)"}
                hint="Times name resolution failed in the selected period. Counts as downtime (sites won't load on any device even though the line is up), but tracked as its own kind so you can tell a DNS outage from a connectivity drop." />
            </Card>
          </div>

          {/* Right column: uptime + latency in one container, shared range tabs and linked hover */}
          <div className="order-1 flex flex-col gap-4 lg:order-2">
            <Card className="fade-up grow p-4 sm:p-5" style={{ animationDelay: "120ms" }}>
              {/* shared controls: range tabs + live clock */}
              <div className="mb-4 flex flex-wrap items-center gap-3">
                {/* Wraps on phones: eleven chips don't fit one narrow row. */}
                <div className="flex w-full flex-wrap gap-1 rounded-lg bg-background/50 p-1 ring-1 ring-border/70 shadow-[inset_0_1px_3px_rgba(0,0,0,0.35)] sm:inline-flex sm:w-auto sm:flex-nowrap">
                  {PRESETS.map((p) => {
                    const tooBig = !!(p.span && p.span > availSecs)
                    const active = preset === p.id
                    const btn = (
                      <Button key={p.id} type="button" size="sm" disabled={tooBig}
                        variant={active ? "default" : "ghost"}
                        className={`h-8 px-1.5 font-mono text-xs font-semibold sm:px-3 ${active ? "shadow-[0_0_14px_-4px_var(--primary)]" : ""} ${tooBig ? "w-full sm:w-auto" : "flex-1 sm:flex-none"}`}
                        onClick={() => { setPreset(p.id); setCustomRange(null) }}>
                        {p.id === "live" && active && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-current" />}
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
                {/* Ambient chrome, not data: the user's OS shows a clock, so this stays quiet. */}
                <span className="font-mono text-sm leading-none tabular-nums text-muted-foreground/70 sm:ml-auto">
                  {nowTs.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
                </span>
              </div>

              {/* LIVE wants per-second data. A view click must never silently rewrite the
                  monitoring config (it changes collection for everyone, 15x the storage),
                  so the mismatch is surfaced with a one-click, explicit switch instead. */}
              {preset === "live" && meta && meta.interval > 1 && (
                <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-[color-mix(in_oklab,var(--amber)_35%,transparent)] bg-[color-mix(in_oklab,var(--amber)_10%,transparent)] px-3 py-2 text-xs">
                  <span className="text-muted-foreground">
                    LIVE shows one point per check. Checks run every {meta.interval}s right now, so this
                    view only gets {Math.max(1, Math.round(120 / meta.interval))} points; at 1s it gets 120.
                  </span>
                  <Button size="sm" variant="secondary" className="h-6 px-2 text-xs"
                    onClick={() => updateConfig("interval", 1)}>
                    Switch checks to every 1s
                  </Button>
                </div>
              )}

              {/* Uptime section: title top-left (mirrors Latency), legend on the right */}
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold tracking-tight">Uptime</h2>
                <div className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
                  {[["var(--up)", "Up"], ["var(--amber)", "Partial"], ["var(--down)", "Down"], ["var(--paused)", "Paused"], ["var(--gap-band)", "No data"]].map(([c, t]) => (
                    <span key={t} className="flex items-center gap-1.5">
                      <span className="inline-block size-2.5 rounded-sm"
                        style={{ background: `linear-gradient(to bottom, color-mix(in oklab, ${c} 88%, white), ${c} 55%)` }} />{t}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex grow flex-col pl-[34px] pr-3">
                {data ? <Tracker data={data} hoverT={hoverT} onHoverT={setHoverT} fetchRange={fetchRange} /> : <Skeleton h={96} />}
                {/* Quarter-point time labels, mirroring the latency chart's axis below (the
                    pl/pr above match its y-axis width + right margin, so positions line up).
                    The end label reads "Now" only when the range actually ends at the present. */}
                <div className="mt-2.5 flex justify-between font-mono text-xs text-muted-foreground">
                  {data
                    ? [0, 0.25, 0.5, 0.75, 1].map((f, i, arr) => {
                        const t = data.start + (data.end - data.start) * f
                        const last = i === arr.length - 1
                        const endsNow = data.end >= data.now - 2 * (data.interval || 15)
                        return (
                          <span key={f} className={!last && i > 0 ? "hidden sm:inline" : ""}>
                            {last && endsNow ? "Now" : wd ? fmtDate(t) : fmtTime(t)}
                          </span>
                        )
                      })
                    : <span />}
                </div>
              </div>

              {/* Latency section */}
              <div className="mb-2 mt-5 flex items-center justify-between border-t border-border/40 pt-4">
                <h2 className="text-sm font-semibold tracking-tight">Latency</h2>
                {latAvg != null && (
                  <span className="font-mono text-xs text-muted-foreground">
                    Avg {latAvg} ms{latMax != null ? ` · Peak ${latMax} ms` : ""}
                  </span>
                )}
              </div>
              <div className="flex flex-col h-[160px]">
                {data
                  ? data.end - data.start <= 180
                    ? <LiveTicker data={data} />
                    : <LatencyChart data={data} hoverT={hoverT} onHoverT={setHoverT} />
                  : <Skeleton h={160} />}
              </div>
            </Card>
          </div>
        </div>

        {/* Notifications + outages (left column) | data & tools (right column).
            The columns stretch to one shared height so both card bottoms always sit on the
            same line: the Outages card grows to absorb the difference, its pagination footer
            pins to the bottom (mt-auto), and the page size caps how tall the list can get. */}
        <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[1.7fr_1fr]">
          <div className="flex flex-col gap-4">
            {meta && (
              <Card className="fade-up p-4 sm:p-5" style={{ animationDelay: "180ms" }}>
                <AlertSettings alerts={meta.alerts} onSaved={refetchMeta} />
              </Card>
            )}
            <Card className="fade-up flex grow flex-col p-4 sm:p-5" style={{ animationDelay: "240ms" }}>
              <h2 className="mb-3 text-sm font-semibold tracking-tight">
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
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium transition hover:bg-muted/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-30">
                            <ChevronLeft className="size-3.5" />Prev
                          </button>
                          <span className="font-mono tabular-nums">Page {outCurPage + 1} of {outTotalPages} &middot; {rangeNet.length} total</span>
                          <button type="button" disabled={outCurPage >= outTotalPages - 1}
                            onClick={() => setOutPage((p) => Math.min(outTotalPages - 1, p + 1))}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium transition hover:bg-muted/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-30">
                            Next<ChevronRight className="size-3.5" />
                          </button>
                        </div>
                      )}
                    </>
                  : <OutagesEmpty />}
            </Card>
          </div>

          <Card className="fade-up p-4 sm:p-5" style={{ animationDelay: "300ms" }}>
            <h2 className="mb-3 text-sm font-semibold tracking-tight">Data &amp; tools</h2>
            {dataSections.length > 0 && (
              <div className="mb-4 space-y-3 text-xs">
                {dataSections.map((sec) => (
                  <div key={sec.title}>
                    {sectionHeader(sec.title)}
                    <div className="space-y-0.5">
                      {sec.rows.map(({ label, value, hint, control }) => (
                        <div key={label} className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-1 transition-colors hover:bg-muted/40">
                          <InfoTip label={hint}>
                            <span className="border-b border-dotted border-muted-foreground/30 text-muted-foreground">{label}</span>
                          </InfoTip>
                          {control ?? <span className="text-right font-mono text-foreground">{value}</span>}
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
                      <InfoTip label="A public DNS resolver the monitor queries to confirm name resolution. A confirmed DNS failure counts as downtime, tracked as its own kind.">
                        <span className="border-b border-dotted border-muted-foreground/30 text-muted-foreground">{resolverName(ip)}</span>
                      </InfoTip>
                      <span className="text-right font-mono text-foreground">{ip}</span>
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
            {/* Destructive action demoted to a quiet text button: the rarest action on the
                page should be the least prominent, not a full-width filled CTA. */}
            <div className="mt-3 border-t border-border/40 pt-2">
              <Button variant="ghost" size="sm"
                className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setResetOpen(true)}>
                <Trash2 className="size-3.5" />Reset all data
              </Button>
            </div>
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
      </div>

      {reportOpen && data && (
        <ReportView data={data} periodLabel={periodLabel} onClose={() => setReportOpen(false)} />
      )}
    </>
  )
}
