export interface Summary {
  availability_pct: number | null
  pct: number | null
  checks: number
  down_seconds: number
  down_h: string
  monitored_seconds: number
  gap_seconds: number
  outage_count: number
  dns_events: number
  dns_seconds: number
  dns_h: string
  avg_lat: number | null
  min_lat: number | null
  max_lat: number | null
}
export interface Bucket {
  t: number; total: number; up: number; pct: number | null
  avg: number | null; min: number | null; max: number | null
}
export interface Outage {
  start: number; end: number | null; ongoing: boolean
  duration_s: number; duration_h: string; cause: string; kind: string
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
}
export interface Meta {
  first_ts: number | null; db_size_bytes: number; paused: boolean
  retention_days: number; outage_retention_days: number; schema_version: string; gateway: string | null
  interval: number; now: number
  targets: string[]; target_ports: number[]; resolvers: string[]; dns_host: string | null
}
