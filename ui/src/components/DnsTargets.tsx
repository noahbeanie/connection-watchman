import { Globe } from "lucide-react"
import { Card } from "@/components/ui/card"
import { resolverName } from "@/lib/format"

// Lists the public DNS resolvers the monitor queries, with their friendly names
// (e.g. Cloudflare / Google / Quad9). Replaces the old always-zero DNS count tile.
export function DnsTargets({ resolvers, className = "" }: { resolvers: string[]; className?: string }) {
  return (
    <Card className={`group relative flex flex-col justify-center gap-3 overflow-hidden p-4${className ? " " + className : ""}`}>
      {/* soft accent glow, matching the stat tiles */}
      <div
        className="pointer-events-none absolute -right-8 -top-8 size-24 rounded-full opacity-50 blur-2xl"
        style={{ background: "color-mix(in oklab, var(--primary) 22%, transparent)" }}
      />
      <div className="relative flex items-center gap-3">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "color-mix(in oklab, var(--primary) 16%, transparent)", color: "var(--primary)" }}
        >
          <Globe className="size-4" />
        </span>
        <span className="text-sm font-medium text-muted-foreground">DNS Resolvers being queried:</span>
      </div>
      <ul className="relative flex flex-col gap-2">
        {resolvers.length ? (
          resolvers.map((ip) => (
            <li key={ip} className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-foreground">{resolverName(ip)}</span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">{ip}</span>
            </li>
          ))
        ) : (
          <li className="text-sm text-muted-foreground">—</li>
        )}
      </ul>
    </Card>
  )
}
