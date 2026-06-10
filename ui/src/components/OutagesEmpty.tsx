import { CircleCheck } from "lucide-react"

export function OutagesEmpty() {
  return (
    <div className="flex grow flex-col items-center justify-center gap-3 py-10 text-center">
      <div className="flex size-12 items-center justify-center rounded-full"
        style={{ background: "color-mix(in oklab, var(--up) 16%, transparent)" }}>
        <CircleCheck className="size-6" style={{ color: "var(--up)" }} />
      </div>
      <div>
        <p className="text-sm font-semibold">All systems operational</p>
        <p className="text-sm text-muted-foreground">No outages recorded yet.</p>
      </div>
    </div>
  )
}
