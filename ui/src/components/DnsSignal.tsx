import { fmtTime } from "@/lib/format"
import type { Live, Outage, Summary } from "@/lib/types"

// DNS is tracked separately from connectivity and never counts as downtime.
// This block reads as its own small status panel under the outages list.
export function DnsSignal({
  summary, outages, live,
}: { summary: Summary; outages: Outage[]; live: Live | null }) {
  const events = summary.dns_events ?? 0
  const degradedNow = live?.dns_ok === false
  const healthy = events === 0 && !degradedNow
  const color = healthy ? "var(--up)" : "var(--primary)"

  return (
    <div className="mt-5 border-t border-border/60 pt-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex size-2.5 rounded-full" style={{ background: color }} />
        <h3 className="text-sm font-semibold tracking-tight">DNS</h3>
        <span className="text-xs text-muted-foreground">Name resolution, tracked separately and not counted as downtime</span>
      </div>

      {healthy ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Name resolution looks healthy. No DNS hiccups in this range.
        </p>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {degradedNow ? "Name resolution is failing right now. " : ""}
          {events > 0
            ? `${events} DNS hiccup${events === 1 ? "" : "s"} in this range, ${summary.dns_h} total. These are usually a flaky router DNS forwarder rather than a real internet outage.`
            : "Checked against your router and several public resolvers before anything is flagged."}
        </p>
      )}

      {outages.length > 0 && (
        <ul className="mt-2.5 space-y-1.5">
          {outages.slice(0, 5).map((o, i) => (
            <li key={i} className="flex items-center justify-between gap-3 font-mono text-xs">
              <span className="text-muted-foreground">{fmtTime(o.start, true)}</span>
              <span className="tabular-nums font-medium text-foreground/80">
                {o.duration_h}{o.ongoing ? " · ongoing" : ""}
              </span>
            </li>
          ))}
          {outages.length > 5 && (
            <li className="font-mono text-xs text-muted-foreground">+{outages.length - 5} more</li>
          )}
        </ul>
      )}
    </div>
  )
}
