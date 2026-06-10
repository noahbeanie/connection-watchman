import { useState } from "react"
import { pctText, rangeWord, uptimeGrade } from "@/lib/format"

// Continuous green -> yellow -> red by availability. Tunable thresholds, calibrated for real
// home internet (three-nines is a datacenter SLA, not a home line): a solid connection can
// actually read green, while a genuinely flaky one still shifts toward amber/red.
const GREEN_AT = 99.5 // at or above this: solid green ("Excellent")
const YELLOW_AT = 98 // pure yellow ("Good"/"Fair" boundary)
const RED_AT = 95 // at or below this: solid red ("Poor")
function arcColor(pct: number | null) {
  if (pct == null) return "var(--muted-foreground)"
  if (pct >= GREEN_AT) return "var(--up)"
  if (pct >= YELLOW_AT) {
    const g = ((pct - YELLOW_AT) / (GREEN_AT - YELLOW_AT)) * 100
    return `color-mix(in oklab, var(--up) ${g.toFixed(1)}%, var(--amber))`
  }
  if (pct >= RED_AT) {
    const y = ((pct - RED_AT) / (YELLOW_AT - RED_AT)) * 100
    return `color-mix(in oklab, var(--amber) ${y.toFixed(1)}%, var(--down))`
  }
  return "var(--down)"
}

// Geometry of the ring, in the 0..100 viewBox. The arc starts at 12 o'clock
// (svg rotated -90) and the lit fraction is revealed via stroke-dashoffset.
const R = 40
const C = 2 * Math.PI * R

export function AvailabilityGauge({ pct, presetId }: { pct: number | null; presetId: string }) {
  const color = arcColor(pct)
  const grade = uptimeGrade(pct)
  const core = `color-mix(in oklab, ${color} 32%, white)` // hot, near-white filament
  const frac = Math.max(0, Math.min(1, (pct ?? 0) / 100))
  const offset = C * (1 - frac)
  const [hov, setHov] = useState(false)

  return (
    <div
      className="relative mx-auto aspect-square w-full max-w-[230px]"
      title="Excellent ≥ 99.5% · Good ≥ 98% · Fair ≥ 95% · Poor below 95%"
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >
      {/* ambient light the lit tube spills onto the dark card, concentrated at the tube radius */}
      <div
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          background: `radial-gradient(circle at 50% 50%, transparent 58%, color-mix(in oklab, ${color} 20%, transparent) 74%, transparent 88%)`,
          filter: "blur(7px)",
          opacity: frac > 0 ? 1 : 0,
        }}
      />
      {/* slow breathing glow while hovering the gauge */}
      <div
        className={`pointer-events-none absolute inset-0 rounded-full transition-opacity duration-700 ${hov ? "gauge-glow" : "opacity-0"}`}
        style={{
          background: `radial-gradient(circle at 50% 50%, color-mix(in oklab, ${color} 45%, transparent) 0%, color-mix(in oklab, ${color} 18%, transparent) 55%, transparent 75%)`,
          filter: "blur(18px)",
        }}
      />
      {/* overflow visible so the glow blooms past the viewBox instead of clipping at the edge */}
      <svg viewBox="0 0 100 100" className="absolute inset-0 size-full -rotate-90" style={{ overflow: "visible" }}>
        <defs>
          <filter id="neonBloom" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
          <filter id="neonGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="1.1" />
          </filter>
          <filter id="neonCore" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="0.45" />
          </filter>
        </defs>
        {/* unlit glass tube (the remainder of the ring) */}
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="7" strokeLinecap="round"
          style={{ stroke: `color-mix(in oklab, ${color} 12%, transparent)` }} />
        {/* wide soft bloom around the lit tube */}
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="8" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={offset} filter="url(#neonBloom)"
          style={{ stroke: color, opacity: 0.3 }} />
        {/* tight inner glow */}
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="7" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={offset} filter="url(#neonGlow)"
          style={{ stroke: color, opacity: 0.95 }} />
        {/* crisp lit tube */}
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="7" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={offset} style={{ stroke: color }} />
        {/* hot near-white filament down the centre of the tube */}
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="2.2" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={offset} filter="url(#neonCore)"
          style={{ stroke: core }} />
      </svg>
      {/* center readout */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="flex w-[62%] flex-col items-center">
          <div
            className="font-mono text-4xl font-bold leading-none tabular-nums tracking-tight"
            style={{ color, textShadow: `0 0 16px color-mix(in oklab, ${color} 28%, transparent)` }}
          >
            {pctText(pct)}
          </div>
          {grade && (
            <div
              className="mt-1 text-xs font-semibold uppercase tracking-wider"
              style={{ color: grade.color }}
            >
              {grade.label}
            </div>
          )}
          <div className="mt-1 text-xs font-medium text-foreground">Uptime · {rangeWord(presetId)}</div>
        </div>
      </div>
    </div>
  )
}
