import { CircleCheck } from "lucide-react"

export function OutagesEmpty() {
  return (
    <div className="flex grow flex-col items-center justify-center gap-3 py-10 text-center">
      {/* radar sweep: rings ripple out from the all-clear mark (off under reduced motion) */}
      <div className="relative flex size-12 items-center justify-center">
        <span
          className="radar-ping pointer-events-none absolute inset-0 rounded-full"
          style={{ border: "1px solid color-mix(in oklab, var(--up) 45%, transparent)" }}
        />
        <span
          className="radar-ping pointer-events-none absolute inset-0 rounded-full"
          style={{ border: "1px solid color-mix(in oklab, var(--up) 45%, transparent)", animationDelay: "1.5s" }}
        />
        <div className="flex size-12 items-center justify-center rounded-full"
          style={{ background: "color-mix(in oklab, var(--up) 16%, transparent)" }}>
          <CircleCheck className="size-6" style={{ color: "var(--up)" }} />
        </div>
      </div>
      <div>
        <p className="text-sm font-semibold">All systems operational</p>
        <p className="text-sm text-muted-foreground">No outages recorded yet.</p>
      </div>
    </div>
  )
}
