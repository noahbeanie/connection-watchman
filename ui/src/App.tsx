import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  Download, Pause, Play, Siren, Trash2, TrendingDown, TrendingUp,
} from "lucide-react"
import { toast } from "sonner"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
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

  // Recent outages are independent of the time filter: always fetch all-time
  // (the API returns them most-recent-first; the timeline shows the latest 60).
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

  const togglePause = async () => {
    const want = !meta?.paused
    await post("/api/pause", { paused: want })
    await Promise.allSettled([refetchMeta(), refetchLive()])
    toast.success(want ? "Monitoring paused" : "Monitoring resumed")
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
    if (res.ok) { await loadOutages(); toast.success(note ? "Note saved" : "Note cleared") }
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
  // Recent outages list is scoped to the last 24h, independent of the selected range: show
  // anything still ongoing or that ended within the past day. (allOutages stays all-time so
  // the Data & tools stats below remain lifetime figures.)
  const dayCutoff = allOutages ? allOutages.now - 86400 : 0
  const netOutages = allOutages
    ? allOutages.outages.filter((o) => o.kind !== "dns" && (o.ongoing || (o.end != null && o.end >= dayCutoff)))
    : []
  const wd = data ? data.end - data.start > 86400 : false
  // Latency headline from healthy (fully-up) buckets, with the same robust outlier fence the
  // chart uses, so degraded-but-connected spikes near the timeout don't inflate Avg/Max. Min/Max
  // describe the plotted (bucket-average) line, not single-check extremes.
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
  const netDone = allOutages ? allOutages.outages.filter((o) => o.kind !== "dns" && !o.ongoing) : []
  const mttr = netDone.length ? netDone.reduce((a, o) => a + o.duration_s, 0) / netDone.length : null
  const mtbf = at && at.outage_count > 0 ? at.monitored_seconds / at.outage_count : null
  const lastOut = allOutages?.outages.find((o) => o.kind !== "dns")
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
        ...(meta.resolvers?.length
          ? [{
              title: "DNS resolvers",
              rows: meta.resolvers.map((ip) => ({
                label: resolverName(ip),
                value: ip,
                hint: "A public DNS resolver the monitor queries to confirm name resolution. DNS is tracked as its own signal and never counts as connectivity downtime.",
              })),
            }]
          : []),
      ]
    : []

  return (
    <div className="mx-auto max-w-[1180px] px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
      <Toaster richColors position="bottom-center" />

      <header className="mb-6 flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-end gap-3">
          <img src={watchmanLogo} alt="Connection Watchman logo"
            className="size-20 shrink-0 rounded-xl object-cover shadow-lg shadow-black/40 sm:size-24" />
          <div className="min-w-0">
            <h1
              className="text-3xl font-bold leading-none tracking-tight sm:text-5xl"
              style={{
                fontFamily: "'Space Grotesk Variable', sans-serif",
                color: "#000000",
                WebkitTextFillColor: "#000000",       // black interior
                WebkitTextStroke: "1px #c8c8ce",      // thin light-grey border
                textShadow: "0 0 6px rgba(255,255,255,0.17), 0 0 16px rgba(255,255,255,0.08)",
              }}
            >
              Connection Watchman
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {live?.dns_ok === false && (
            <Badge variant="outline" className="gap-1.5 py-1.5 font-normal"
              style={{ color: "var(--primary)", borderColor: "color-mix(in oklab, var(--primary) 45%, transparent)" }}>
              <span className="inline-flex size-2 rounded-full" style={{ background: "var(--primary)" }} />
              DNS degraded
            </Badge>
          )}
          {meta?.first_ts && (
            <span className="hidden text-xs text-foreground/80 sm:inline">
              Scan running since {fmtSince(meta.first_ts)}
            </span>
          )}
          <StatusBadge live={live} meta={meta} />
        </div>
      </header>

      {/* Top: availability gauge + incident tiles (left) | uptime tracker above latency (right).
          The tracker is stacked directly over latency at the same width, and its bar is inset by
          the latency chart's y-axis width so the two time axes line up. */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
        {/* Left column: availability gauge, then the incident tiles */}
        <div className="order-2 flex flex-col gap-4 lg:order-1">
          <Card className="flex items-center justify-center p-4">
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
                {[["var(--up)", "Up"], ["var(--amber)", "Partial"], ["var(--down)", "Down"], ["var(--gap-band)", "No data"]].map(([c, t]) => (
                  <span key={t} className="flex items-center gap-1.5">
                    <span className="inline-block size-2.5 rounded-sm" style={{ background: c }} />{t}
                  </span>
                ))}
              </div>
            </div>
            {/* inset matches LatencyChart's YAxis width (34) + right margin (12) so the axes align.
                Grows to absorb the card's slack so the uptime bars fill the space the shortened
                latency chart leaves, instead of a gap. */}
            <div className="flex grow flex-col pl-[34px] pr-3">
              {data ? <Tracker data={data} hoverT={hoverT} onHoverT={setHoverT} fetchRange={fetchRange} /> : <Skeleton h={96} />}
              <div className="mt-2.5 flex justify-between font-mono text-xs text-muted-foreground">
                <span>{data ? (wd ? fmtDate(data.start) : fmtTime(data.start)) : ""} <span className="opacity-60">(Local Time)</span></span>
                <span>Now</span>
              </div>
            </div>

            {/* Latency section */}
            <div className="mb-2 mt-5 flex items-center justify-between border-t border-border/40 pt-4">
              <h2 className="text-sm font-semibold tracking-tight">Latency</h2>
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

      {/* Outages + tools */}
      <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[1.7fr_1fr]">
        <Card className="p-4 sm:p-5">
          <h2 className="mb-3 text-[0.95rem] font-semibold tracking-tight">Recent outages <span className="font-normal text-muted-foreground">(Past 24 hrs)</span></h2>
          {!allOutages ? <Skeleton h={120} />
            : netOutages.length
              ? <><CauseLegend /><OutagesTimeline outages={netOutages} onSaveNote={saveOutageNote} onDelete={deleteOutage} /></>
              : <OutagesEmpty />}
        </Card>

        <Card className="p-4 sm:p-5">
          <h2 className="mb-3 text-[0.95rem] font-semibold tracking-tight">Data &amp; tools</h2>
          {dataSections.length > 0 && (
            <div className="mb-4 space-y-3 text-xs">
              {dataSections.map((sec) => (
                <div key={sec.title}>
                  <p className="mb-1 px-0.5 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/60">{sec.title}</p>
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
          <div className="flex flex-wrap gap-2">
            <InfoTip focusable={false} className="min-w-[7rem] flex-1" label="Download your full check log and outage log as CSV files.">
              <Button variant="secondary" size="sm" className="w-full" onClick={exportData}><Download className="size-4" />Export data</Button>
            </InfoTip>
            <InfoTip focusable={false} className="min-w-[7rem] flex-1" label={meta?.paused ? "Resume recording checks." : "Temporarily stop recording checks."}>
              <Button variant="secondary" size="sm" className="w-full" onClick={togglePause}>
                {meta?.paused ? <><Play className="size-4" />Resume</> : <><Pause className="size-4" />Pause</>}
              </Button>
            </InfoTip>
            <InfoTip focusable={false} className="min-w-[7rem] flex-1" label="Permanently erase all recorded data. This cannot be undone.">
              <Button variant="destructive" size="sm" className="w-full" onClick={() => setResetOpen(true)}><Trash2 className="size-4" />Reset</Button>
            </InfoTip>
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
  )
}
