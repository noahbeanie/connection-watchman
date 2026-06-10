// A roughly geometric ladder (each step ~3-6x the last) so no wanted range falls in a
// crack between chips - below 24H the presets are the only way to get a window at all,
// since Custom picks whole days. 30D matches an ISP billing cycle (the refund-claim
// unit); 90D is the quarter. LIVE is a rolling ticker refreshed every second (see
// loadRange's poll tiers): two minutes keeps each 1 s sample wide enough that real
// jitter reads as a waveform instead of a dense comb.
export const PRESETS = [
  { id: "live", label: "LIVE", span: 120, word: "last 2 minutes" },
  { id: "15m", label: "15M", span: 900, word: "last 15 minutes" },
  { id: "1h", label: "1H", span: 3600, word: "last hour" },
  { id: "6h", label: "6H", span: 21600, word: "last 6 hours" },
  { id: "24h", label: "24H", span: 86400, word: "last 24 hours" },
  { id: "3d", label: "3D", span: 259200, word: "last 3 days" },
  { id: "7d", label: "7D", span: 604800, word: "last 7 days" },
  { id: "30d", label: "30D", span: 2592000, word: "last 30 days" },
  { id: "90d", label: "90D", span: 7776000, word: "last 90 days" },
  { id: "1y", label: "1Y", span: 31536000, word: "last year" },
  { id: "all", label: "All", span: null as number | null, word: "all time" },
]

export const CAUSE_LABEL: Record<string, string> = {
  isp: "ISP / Internet", local: "Your network", dns: "DNS", unknown: "Unknown",
}

// Very short, plain-English reason a connectivity stretch went down, shown when you
// hover a red (offline) segment so you can tell at a glance what happened.
export const CAUSE_EXPLAIN: Record<string, string> = {
  isp: "Your internet provider (ISP) went down.",
  local: "Your router or home network went down.",
  unknown: "The connection dropped, cause unknown.",
  dns: "DNS name lookups were failing.",
}

// Friendly names for well-known public DNS resolvers, shown in the DNS servers card.
const RESOLVER_NAMES: Record<string, string> = {
  "1.1.1.1": "Cloudflare", "1.0.0.1": "Cloudflare",
  "8.8.8.8": "Google", "8.8.4.4": "Google",
  "9.9.9.9": "Quad9", "149.112.112.112": "Quad9",
  "208.67.222.222": "OpenDNS", "208.67.220.220": "OpenDNS",
  "94.140.14.14": "AdGuard", "94.140.15.15": "AdGuard",
}
export function resolverName(ip: string): string {
  return RESOLVER_NAMES[ip] ?? "Custom DNS"
}

export const nowSec = () => Math.floor(Date.now() / 1000)

export function fmtDur(sec: number | null | undefined): string {
  let s = Math.round(sec || 0)
  if (s < 60) return s + "s"
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s"
  if (s < 86400) return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m"
  return Math.floor(s / 86400) + "d " + Math.floor((s % 86400) / 3600) + "h"
}

// Compact human duration for the streak: largest unit plus the next non-zero
// unit (y / mo / w / d / h / m / s). Stays ~6 chars at any scale so it fits the
// gauge ring whether the streak is seconds or years.
export function fmtStreak(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const units: [number, string][] = [
    [31536000, "y"], [2592000, "mo"], [604800, "w"], [86400, "d"],
    [3600, "h"], [60, "m"], [1, "s"],
  ]
  for (let i = 0; i < units.length; i++) {
    const [size, label] = units[i]
    if (s >= size) {
      const big = Math.floor(s / size)
      const next = units[i + 1]
      const small = next ? Math.floor((s - big * size) / next[0]) : 0
      return next && small > 0 ? `${big}${label} ${small}${next[1]}` : `${big}${label}`
    }
  }
  return "0s"
}

export function fmtTime(ts: number, withDate = false): string {
  const d = new Date(ts * 1000)
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })
  return withDate ? d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t : t
}

export function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })
}

// Compact label for a custom date range, always including the year:
// "Jun 1, 2026", "Jun 1-8, 2026", "Jun 1 - Jul 3, 2026", or "Dec 30, 2025 - Jan 2, 2026".
export function fmtRangeShort(startSec: number, endSec: number): string {
  const a = new Date(startSec * 1000)
  const b = new Date(endSec * 1000)
  const mo = (d: Date) => d.toLocaleDateString("en-US", { month: "short" })
  if (a.getFullYear() === b.getFullYear()) {
    if (a.getMonth() === b.getMonth()) {
      const days = a.getDate() === b.getDate() ? `${a.getDate()}` : `${a.getDate()}-${b.getDate()}`
      return `${mo(a)} ${days}, ${a.getFullYear()}`
    }
    return `${mo(a)} ${a.getDate()} - ${mo(b)} ${b.getDate()}, ${b.getFullYear()}`
  }
  return `${mo(a)} ${a.getDate()}, ${a.getFullYear()} - ${mo(b)} ${b.getDate()}, ${b.getFullYear()}`
}

// Human "since" stamp for the header, e.g. "Jun 8, 2026, 1:47 PM".
export function fmtSince(ts: number): string {
  const d = new Date(ts * 1000)
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })
  return `${date}, ${time}`
}

export function pctText(p: number | null): string {
  if (p == null) return "—"
  return (p >= 99.995 ? "100" : p.toFixed(p >= 99.9 ? 3 : 2)) + "%"
}

export function humanBytes(n: number): string {
  if (!n) return "0 B"
  const u = ["B", "KB", "MB", "GB"]
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return n.toFixed(i ? 1 : 0) + " " + u[i]
}

// Plain-language grade for an availability %, with a matching color. Gives the gauge a
// reference so a glance answers "is this good?" instead of leaving a bare number. Aligned
// to the gauge's arc thresholds (Excellent >= 99.5, Good >= 98, Fair >= 95, else Poor).
export function uptimeGrade(p: number | null): { label: string; color: string } | null {
  if (p == null) return null
  if (p >= 99.5) return { label: "Excellent", color: "var(--up)" }
  if (p >= 98) return { label: "Good", color: "color-mix(in oklab, var(--up) 55%, var(--amber))" }
  if (p >= 95) return { label: "Fair", color: "var(--amber)" }
  return { label: "Poor", color: "var(--down)" }
}

export function rangeWord(presetId: string): string {
  if (presetId === "custom") return "custom range"
  return PRESETS.find((p) => p.id === presetId)?.word ?? ""
}

// Default range on first load: All, unless enough history has been collected to fill
// a longer calendar window, in which case use the longest that fits (7D, then 30D, 6M,
// 1Y as data grows). Sub-day presets (1H/6H/24H) are never auto-selected as the default.
export function defaultPreset(firstTs: number | null): string {
  const avail = firstTs ? nowSec() - firstTs : 0
  for (const id of ["1y", "90d", "30d", "7d"]) {
    const span = PRESETS.find((p) => p.id === id)?.span
    if (span && span <= avail) return id
  }
  return "all"
}

// Absolute latency quality scale, shared by the latency charts and the Live latency
// stat: green at or under LAT_GOOD, blending through amber around LAT_MID, fully red
// from LAT_BAD up. Built on the status tokens so the colors track the theme.
export const LAT_GOOD = 100
export const LAT_MID = 250
export const LAT_BAD = 400

export function latencyColor(ms: number | null | undefined): string {
  if (ms == null) return "var(--muted-foreground)"
  if (ms <= LAT_GOOD) return "var(--up)"
  if (ms >= LAT_BAD) return "var(--down)"
  if (ms <= LAT_MID) {
    const f = ((ms - LAT_GOOD) / (LAT_MID - LAT_GOOD)) * 100
    return `color-mix(in oklab, var(--amber) ${f.toFixed(1)}%, var(--up))`
  }
  const f = ((ms - LAT_MID) / (LAT_BAD - LAT_MID)) * 100
  return `color-mix(in oklab, var(--down) ${f.toFixed(1)}%, var(--amber))`
}

// Stops for a vertical latency gradient whose 0% offset sits at value topV and 100% at
// value bottomV (chart top is the slow end). Boundary colors plus whichever of the
// GOOD/MID/BAD waypoints fall strictly inside the span, so the thresholds land at their
// true heights: a quiet 0-80 ms window comes out solid green (red simply is not on
// screen), a spiky window shows the full ramp. This is what the early attempt at a
// quality gradient got wrong: fixed percentage stops made the colors relative to each
// view's spread instead of absolute milliseconds. Degenerate spans collapse to one stop.
export function latGradientStops(topV: number, bottomV: number): { offset: number; color: string }[] {
  if (!(topV > bottomV)) return [{ offset: 0, color: latencyColor(topV) }]
  const span = topV - bottomV
  const stops = [{ offset: 0, color: latencyColor(topV) }]
  for (const v of [LAT_BAD, LAT_MID, LAT_GOOD]) {
    if (v < topV && v > bottomV) stops.push({ offset: (topV - v) / span, color: latencyColor(v) })
  }
  stops.push({ offset: 1, color: latencyColor(bottomV) })
  return stops
}

// Robust upper bound for "normal" latency, used to hide spikes that would blow out the
// latency chart's Y axis. Some buckets stay fully "up" yet average near the connect timeout;
// those are clamped past this fence so the axis scales to typical latency instead of the
// spike. Tukey's upper fence (Q3 + 1.5*IQR), floored at 2x the
// median so mild jitter is never hidden. Returns Infinity when there are too few samples to
// judge, leaving short / sparse ranges untouched.
export function latencyFence(values: number[]): number {
  if (values.length < 12) return Infinity
  const s = [...values].sort((a, b) => a - b)
  const q = (p: number) => {
    const idx = (s.length - 1) * p
    const lo = Math.floor(idx), hi = Math.ceil(idx)
    return s[lo] + (s[hi] - s[lo]) * (idx - lo)
  }
  const med = q(0.5), q1 = q(0.25), q3 = q(0.75)
  return Math.max(q3 + 1.5 * (q3 - q1), med * 2)
}
