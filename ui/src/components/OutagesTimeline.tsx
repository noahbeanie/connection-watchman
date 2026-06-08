import { CAUSE_LABEL, fmtTime } from "@/lib/format"
import { CAUSE_DESC } from "@/components/CauseLegend"
import { InfoTip } from "@/components/InfoTip"
import type { Outage } from "@/lib/types"

const causeColor: Record<string, string> = {
  isp: "var(--orange)", local: "var(--down)", dns: "var(--primary)", unknown: "var(--muted-foreground)",
}

export function OutagesTimeline({ outages }: { outages: Outage[] }) {
  return (
    <ol className="relative ml-1 space-y-4 border-l border-border/60 pl-5">
      {outages.slice(0, 60).map((o, i) => {
        const c = causeColor[o.cause] ?? causeColor.unknown
        return (
          <li key={i} className="relative">
            <span className="absolute -left-[23px] top-1 size-2.5 rounded-full ring-4 ring-background" style={{ background: c }} />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
              <span className="font-mono text-sm tabular-nums">{fmtTime(o.start, true)}</span>
              <span className="font-mono text-sm font-semibold tabular-nums">{o.duration_h}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <InfoTip label={CAUSE_DESC[o.cause] ?? CAUSE_DESC.unknown} className="cursor-help">
                <span className="font-medium" style={{ color: c }}>{CAUSE_LABEL[o.cause] ?? o.cause}</span>
              </InfoTip>
              {o.ongoing ? (
                <span className="rounded-full px-2 py-0.5 text-[0.65rem] font-semibold"
                  style={{ background: "color-mix(in oklab, var(--down) 18%, transparent)", color: "var(--down)" }}>
                  Ongoing
                </span>
              ) : o.end != null ? (
                <span>· Ended {fmtTime(o.end, true)}</span>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
