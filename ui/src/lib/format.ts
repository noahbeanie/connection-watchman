export const PRESETS = [
  { id: "1h", label: "1H", span: 3600, word: "last hour" },
  { id: "6h", label: "6H", span: 21600, word: "last 6 hours" },
  { id: "24h", label: "24H", span: 86400, word: "last 24 hours" },
  { id: "7d", label: "7D", span: 604800, word: "last 7 days" },
  { id: "30d", label: "30D", span: 2592000, word: "last 30 days" },
  { id: "6mo", label: "6M", span: 15552000, word: "last 6 months" },
  { id: "1y", label: "1Y", span: 31536000, word: "last year" },
  { id: "all", label: "All", span: null as number | null, word: "all time" },
]

export const CAUSE_LABEL: Record<string, string> = {
  isp: "ISP / Internet", local: "Your network", dns: "DNS", unknown: "Unknown", slow: "Brownout",
}

// Very short, plain-English reason a connectivity stretch went down, shown when you
// hover a red (offline) segment so you can tell at a glance what happened.
export const CAUSE_EXPLAIN: Record<string, string> = {
  isp: "Your internet provider (ISP) went down.",
  local: "Your router or home network went down.",
  unknown: "The connection dropped, cause unknown.",
  dns: "DNS name lookups were failing.",
  slow: "The connection stayed up but was very slow (a brownout).",
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

// Long, human "since" stamp for the header, e.g. "June 8, 2026 @ 1PM" (or "1:47PM" off the
// hour). Minutes are shown only when non-zero so an on-the-hour start reads cleanly.
export function fmtSince(ts: number): string {
  const d = new Date(ts * 1000)
  const date = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
  const h = d.getHours()
  const min = d.getMinutes()
  return `${date} @ ${h % 12 || 12}${min ? ":" + String(min).padStart(2, "0") : ""}${h < 12 ? "AM" : "PM"}`
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

// color for the uptime % headline, by health
export function uptimeColor(p: number | null): string {
  if (p == null) return "var(--muted-foreground)"
  if (p >= 99.9) return "var(--up)"
  if (p >= 95) return "oklch(0.84 0.14 92)"
  if (p > 0) return "oklch(0.77 0.16 58)"
  return "var(--down)"
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
  for (const id of ["1y", "6mo", "30d", "7d"]) {
    const span = PRESETS.find((p) => p.id === id)?.span
    if (span && span <= avail) return id
  }
  return "all"
}

// Robust upper bound for "normal" latency, used to hide spikes that would blow out the
// latency chart's Y axis. Some buckets stay fully "up" yet average near the connect timeout
// (a degraded-but-connected stretch); those are dropped past this fence so the line gaps and
// the axis scales to typical latency. Tukey's upper fence (Q3 + 1.5*IQR), floored at 2x the
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
