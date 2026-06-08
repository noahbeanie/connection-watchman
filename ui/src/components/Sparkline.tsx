import { Area, AreaChart } from "recharts"
import { ChartContainer } from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import type { Bucket } from "@/lib/types"

const config = { v: { label: "Latency", color: "var(--lat-line)" } } satisfies ChartConfig

// Tiny axis-less latency trend for the avg-latency KPI card.
export function Sparkline({ buckets }: { buckets: Bucket[] }) {
  const data = buckets.map((b) => ({ v: b.avg }))
  if (!data.some((d) => d.v != null)) return null
  return (
    <ChartContainer config={config} className="h-9 w-full">
      <AreaChart data={data} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
        <defs>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--lat-line)" stopOpacity={0.4} />
            <stop offset="100%" stopColor="var(--lat-line)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area dataKey="v" type="monotone" stroke="var(--lat-line)" strokeWidth={1.5}
          fill="url(#sparkFill)" connectNulls={false} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ChartContainer>
  )
}
