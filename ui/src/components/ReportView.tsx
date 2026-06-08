import { useMemo } from "react"
import { ArrowLeft, Printer } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CAUSE_LABEL, fmtDur, fmtTime, pctText } from "@/lib/format"
import type { RangeData } from "@/lib/types"
import watchmanLogo from "@/assets/watchman.png"

// A clean, printable connection report for the selected period. Rendered light (it's a
// document) regardless of the dashboard theme, so "Print / Save as PDF" produces a tidy page
// you can hand to your ISP. The print stylesheet (index.css) hides the dashboard behind it.
export function ReportView({ data, periodLabel, onClose }: {
  data: RangeData; periodLabel: string; onClose: () => void
}) {
  const s = data.summary
  const nets = useMemo(() => data.outages.filter((o) => o.kind !== "dns"), [data.outages])
  const resolved = nets.filter((o) => !o.ongoing)
  const mttr = resolved.length ? resolved.reduce((a, o) => a + o.duration_s, 0) / resolved.length : null
  const longest = nets.reduce((m, o) => Math.max(m, o.duration_s), 0)
  const generated = new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" })

  const stat = (label: string, value: string) => (
    <div className="rounded-lg border border-zinc-200 px-3 py-2">
      <div className="text-[0.7rem] font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-0.5 font-mono text-lg font-semibold text-zinc-900">{value}</div>
    </div>
  )

  return (
    <div className="report-sheet fixed inset-0 z-[60] overflow-auto bg-white text-zinc-900">
      <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-zinc-200 bg-white/90 px-4 py-2.5 backdrop-blur">
        <Button variant="outline" size="sm" onClick={onClose}><ArrowLeft className="size-3.5" />Back to dashboard</Button>
        <span className="text-xs text-zinc-500">Use Print to save as PDF</span>
        <Button variant="default" size="sm" onClick={() => window.print()}><Printer className="size-3.5" />Print / Save PDF</Button>
      </div>

      <div className="mx-auto max-w-[820px] px-8 py-8">
        <header className="flex items-center gap-3 border-b border-zinc-200 pb-5">
          <img src={watchmanLogo} alt="" className="size-12 rounded-lg object-cover" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Connection report</h1>
            <p className="text-sm text-zinc-500">{periodLabel} &middot; generated {generated}</p>
          </div>
        </header>

        <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {stat("Uptime", pctText(s.availability_pct))}
          {stat("Total downtime", s.down_seconds > 0 ? fmtDur(s.down_seconds) : "None")}
          {stat("Outages", String(s.outage_count))}
          {stat("Avg recovery", mttr != null ? fmtDur(mttr) : "n/a")}
          {stat("Longest outage", longest > 0 ? fmtDur(longest) : "None")}
          {stat("Avg latency", s.avg_lat != null ? `${s.avg_lat} ms` : "n/a")}
        </section>

        <section className="mt-7">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-600">
            Outage log ({nets.length})
          </h2>
          {nets.length ? (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-300 text-left text-[0.7rem] uppercase tracking-wide text-zinc-500">
                  <th className="py-1.5 pr-3 font-semibold">Started</th>
                  <th className="py-1.5 pr-3 font-semibold">Ended</th>
                  <th className="py-1.5 pr-3 font-semibold">Duration</th>
                  <th className="py-1.5 pr-3 font-semibold">Cause</th>
                  <th className="py-1.5 font-semibold">Note</th>
                </tr>
              </thead>
              <tbody>
                {nets.map((o) => (
                  <tr key={o.id} className="border-b border-zinc-100 align-top">
                    <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{fmtTime(o.start, true)}</td>
                    <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{o.ongoing ? "ongoing" : o.end != null ? fmtTime(o.end, true) : "-"}</td>
                    <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{o.duration_h}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{CAUSE_LABEL[o.cause] ?? o.cause}</td>
                    <td className="py-1.5 text-zinc-600">{o.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-zinc-500">No connectivity outages in this period.</p>
          )}
          {nets.length >= 200 && (
            <p className="mt-2 text-xs text-zinc-400">Showing the most recent 200 outages for this period.</p>
          )}
        </section>

        <footer className="mt-8 border-t border-zinc-200 pt-4 text-xs text-zinc-400">
          Uptime excludes paused and no-data spans. DNS hiccups are tracked separately and are not
          counted as downtime. Generated by Connection Watchman.
        </footer>
      </div>
    </div>
  )
}
