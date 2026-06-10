export interface Summary {
  availability_pct: number | null
  pct: number | null
  checks: number
  down_seconds: number
  down_h: string
  monitored_seconds: number
  gap_seconds: number
  outage_count: number
  net_events: number
  dns_events: number
  dns_seconds: number
  dns_h: string
  avg_lat: number | null
  min_lat: number | null
  max_lat: number | null
  mttr_s: number | null            // mean time to recover, all kinds, gap-corrected
  mttr_net_s: number | null        // connectivity-only mean time to recover
  mttr_dns_s: number | null        // DNS-only mean time to recover
  last_outage_start: number | null // start ts of the most recent outage in range (any kind)
  last_net_outage_start: number | null // most recent connectivity outage start
  longest_net_s: number            // longest connectivity outage in range (seconds)
}
export interface Bucket {
  t: number; total: number; up: number; pct: number | null
  avg: number | null; min: number | null; max: number | null
}
export interface Outage {
  id: number
  start: number; end: number | null; ongoing: boolean
  duration_s: number; duration_h: string; cause: string; kind: string
  note: string | null
}
export interface Gap { start: number; end: number; kind: string }
export interface RangeData {
  start: number; end: number; now: number; bucket: number; interval: number
  first_ts: number | null
  summary: Summary; buckets: Bucket[]; outages: Outage[]; gaps: Gap[]
}
export interface Live {
  status: "up" | "down" | "unknown" | "nodata"
  now: number; latest_ts?: number; latency_ms?: number | null
  dns_ok?: boolean | null
  streak_seconds?: number; streak_h?: string; interval: number
  db_size_bytes?: number
}
export interface Target { host: string; port: number }
export interface AlertConfig { type: string; url: string; recovery: boolean; dns: boolean }
export interface Meta {
  first_ts: number | null; db_size_bytes: number; paused: boolean; pause_until: number | null
  retention_days: number; outage_retention_days: number; timeout_ms: number
  schema_version: string; gateway: string | null
  interval: number; now: number
  targets: Target[]; targets_custom: boolean; resolvers: string[]; dns_host: string | null
  alerts: AlertConfig
}
