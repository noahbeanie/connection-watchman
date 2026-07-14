#!/usr/bin/env python3
"""
Internet uptime dashboard.

A tiny zero-dependency web server (Python stdlib only) that reads the SQLite
log written by monitor.py and serves:
  - "/"                       the dashboard HTML
  - "/api/live"               lightweight current status (polled often, cheap)
  - "/api/range?start=&end="  summary + timeline + buckets + outages for a window
  - "/api/meta"               first record, db size, paused state, retention, gateway
  - "/api/speedtests?start=&end="  speed-test history for a window + latest + settings
  - "/api/export/checks.csv"  streamed raw check log (range or all-time)
  - "/api/export/outages.csv" streamed outage log
  - "/api/export/speedtests.csv"   streamed speed-test log
  - POST "/api/speedtest/run" queues a run-now speed test (the monitor runs it)
  - POST "/api/pause"         {paused: bool, minutes?: int} -> toggles the PAUSED sentinel
  - POST "/api/reset"         {confirm:"RESET"} -> wipes the database (guarded)
  - POST "/api/config"        {interval?, retention_days?, timeout_ms?, ...} -> live settings
  - POST "/api/alerts"        {type, url, recovery} -> notification settings
  - POST "/api/alert/test"    sends a test notification to the configured channel
  - POST "/api/targets"       {targets:[{host,port}]} -> custom probe targets ([] = defaults)
  - POST "/api/outage/note"   {id, note} ; POST "/api/outage/delete" {id}

Open it from any device on your LAN at  http://<pi-ip>:8080
It works even while the internet is down (charts are inline SVG, no CDN).
"""

import json
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("UPTIME_DB", os.path.join(BASE, "uptime.db"))
PORT = int(os.environ.get("UPTIME_PORT", "8080"))
INTERVAL = float(os.environ.get("UPTIME_INTERVAL", "15"))
RETENTION_DAYS = int(os.environ.get("UPTIME_RETENTION_DAYS", "365"))
OUTAGE_RETENTION_DAYS = int(os.environ.get("UPTIME_OUTAGE_RETENTION_DAYS", "0"))  # 0 = forever
PAUSE_FILE = os.path.join(BASE, "PAUSED")

# User-adjustable settings persisted in the meta table (set via /api/config; the monitor
# re-reads them live). Whitelisted so a bad value can never take effect.
CFG_OPTIONS = {
    "interval": (1, 5, 10, 15, 30, 60),
    "retention_days": (0, 30, 90, 180, 365),       # 0 = forever
    "outage_retention_days": (0, 90, 180, 365),    # 0 = forever
    "timeout_ms": (1000, 1500, 2000, 3000),        # response cutoff: answer within this or it's down
    "speedtest_period_h": (0, 4, 6, 8, 12, 24),    # hours between speed tests; 0 = off
    "speedtest_cap_mb": (25, 50, 100, 250, 500),   # MB per direction per speed test
}
CFG_DEFAULT = {"interval": INTERVAL, "retention_days": RETENTION_DAYS,
               "outage_retention_days": OUTAGE_RETENTION_DAYS, "timeout_ms": 1000,
               "speedtest_period_h": int(os.environ.get("UPTIME_SPEEDTEST_PERIOD_H", "0") or 0),
               "speedtest_cap_mb": int(os.environ.get("UPTIME_SPEEDTEST_CAP_MB", "100") or 100)}

ALERT_TYPES = ("discord", "webhook")
# Host label for a custom target: a DNS hostname or IPv4 (no schemes, paths, or spaces).
# Enforces DNS limits (total <= 253, each label <= 63, no leading/trailing hyphen) so an
# over-long label can never reach the monitor's socket layer and raise UnicodeError there.
TARGET_HOST_RE = re.compile(
    r"^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)*"
    r"[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?$"
)


def cfg_get(conn, key):
    """Effective setting: a valid meta override if present, else the env/built-in default."""
    try:
        row = conn.execute("SELECT v FROM meta WHERE k=?", ("cfg_" + key,)).fetchone()
        if row and row[0] is not None:
            n = int(float(row[0]))
            if n in CFG_OPTIONS[key]:
                return n
    except (sqlite3.OperationalError, ValueError, TypeError):
        pass
    return int(CFG_DEFAULT[key])
TEMPLATE = os.path.join(BASE, "templates", "dashboard.html")
WEB_DIR = os.path.join(BASE, "web")     # built React/shadcn app (static, bundled)
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json",
    ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff",
    ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json",
    ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8",
}

NICE_BUCKETS = [1, 5, 10, 15, 30, 60, 300, 900, 1800, 3600, 7200, 21600, 43200, 86400, 172800, 604800]
MAX_BUCKETS = 400


def db():
    # read-only connection; uri mode lets multiple readers + the writer coexist
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def db_rw():
    # writable connection, used only by reset/pause; waits out the monitor's commit
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA busy_timeout=8000")
    conn.row_factory = sqlite3.Row
    return conn


def pick_bucket(window_seconds, min_bucket=1):
    """Smallest nice bucket that keeps the series under MAX_BUCKETS points, floored at
    min_bucket (the live check interval): a bucket finer than the check cadence would
    leave most buckets empty and fragment the latency line into disconnected dots."""
    for b in NICE_BUCKETS:
        if b < min_bucket:
            continue
        if window_seconds / b <= MAX_BUCKETS:
            return b
    return NICE_BUCKETS[-1]


def _db_size():
    size = 0
    for suffix in ("", "-wal", "-shm"):
        try:
            size += os.path.getsize(DB_PATH + suffix)
        except OSError:
            pass
    return size


def fmt_dur(seconds):
    seconds = int(seconds or 0)
    d, r = divmod(seconds, 86400)
    h, r = divmod(r, 3600)
    m, s = divmod(r, 60)
    parts = []
    if d: parts.append(f"{d}d")
    if h: parts.append(f"{h}h")
    if m: parts.append(f"{m}m")
    if s or not parts: parts.append(f"{s}s")
    return " ".join(parts)


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def iso_local(ts):
    # Server-local wall time, space-separated so spreadsheets parse it as a real date.
    # Sits beside the UTC column in exports: local matches what the dashboard shows,
    # UTC stays the unambiguous reference.
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


# Plain-English cause names for exports, matching the dashboard's labels.
CAUSE_LABELS = {"isp": "ISP / Internet", "local": "Your network", "dns": "DNS", "unknown": "Unknown"}


def csv_range_label(start, end):
    # Human file names: checks_2026-06-09_to_2026-06-10.csv instead of epoch soup.
    d1 = datetime.fromtimestamp(start).strftime("%Y-%m-%d")
    d2 = datetime.fromtimestamp(min(end, int(time.time()))).strftime("%Y-%m-%d")
    return d1 if d1 == d2 else f"{d1}_to_{d2}"


# ---- interval math (for gap-corrected availability) ------------------------
def _merge(intervals):
    if not intervals:
        return []
    iv = sorted(intervals)
    out = [list(iv[0])]
    for s, e in iv[1:]:
        if s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def _total(iv):
    return sum(e - s for s, e in iv)


def _subtract(base, cuts):
    """Remove cut intervals from base intervals."""
    cuts = _merge(cuts)
    out = []
    for s, e in base:
        segs = [(s, e)]
        for cs, ce in cuts:
            nxt = []
            for a, b in segs:
                if ce <= a or cs >= b:
                    nxt.append((a, b))
                else:
                    if a < cs: nxt.append((a, cs))
                    if ce < b: nxt.append((ce, b))
            segs = nxt
        out.extend(segs)
    return out


def _overlap_total(s, e, iv):
    """Seconds of (s, e) covered by the merged interval list iv."""
    return sum(max(0, min(e, ce) - max(s, cs)) for cs, ce in iv)


def get_gaps(conn, start, end, now):
    """No-data spans (reboots + pauses) overlapping the window.
    Returns list of (s, e, kind). Tolerates a pre-migration DB with no events.
    Events are fetched WITHOUT an upper ts bound: a gap event is stamped at the gap's
    END with a backward-looking span, so one ending just after the window (e.g. monitor
    off 23:50-00:30, range = yesterday) still has to contribute its in-window part -
    filtering ts<=end dropped it and counted that span as monitored-up."""
    try:
        rows = conn.execute(
            "SELECT ts, kind, detail FROM events "
            "WHERE kind IN ('gap','pause','resume') ORDER BY ts",
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    spans, open_pause = [], None
    for r in rows:
        if r["kind"] == "gap":
            try:
                d = int(r["detail"] or 0)
            except (TypeError, ValueError):
                d = 0
            spans.append((r["ts"] - d, r["ts"], "gap"))
        elif r["kind"] == "pause":
            open_pause = r["ts"]
        elif r["kind"] == "resume":
            if open_pause is not None:
                spans.append((open_pause, r["ts"], "paused"))
                open_pause = None
    if open_pause is not None:
        spans.append((open_pause, min(now, end), "paused"))
    clipped = []
    for s, e, k in spans:
        s2, e2 = max(s, start), min(e, end)
        if e2 > s2:
            clipped.append((s2, e2, k))
    return clipped


def get_live(conn, now):
    interval = cfg_get(conn, "interval")
    # A FAILING check cycle can legitimately take the full probe budget (all targets time out and
    # retry, ~40-50s) while the connection is merely struggling, not gone. Treat the latest reading
    # as stale ("No signal") only once it is older than the monitor's own no-data gap threshold, so
    # a slow cycle shows the real up/down state instead of falsely flipping to "No signal".
    stale_after = max(30, interval * 6)
    try:
        import monitor as _mon
        # budget with the LIVE response cutoff: at a 2-3s cutoff a fully failing cycle
        # legitimately runs longer, and a too-small bound flips the header to "No
        # signal" in the middle of a real outage
        stale_after = max(stale_after, int(_mon.gap_threshold(
            interval, len(_mon.cfg_targets(conn)), cfg_get(conn, "timeout_ms") / 1000.0)) + interval)
    except Exception:
        pass
    latest = conn.execute(
        "SELECT ts, up, latency_ms, dns FROM checks ORDER BY ts DESC LIMIT 1"
    ).fetchone()
    if latest is None:
        return {"status": "nodata", "now": now, "interval": interval, "db_size_bytes": _db_size()}

    age = now - latest["ts"]
    # headline status = raw connectivity only; DNS is a separate signal
    up = bool(latest["up"])
    status = "unknown" if age > stale_after else ("up" if up else "down")
    dns_ok = None if latest["dns"] is None else bool(latest["dns"])

    # Where the current connectivity state began: the newest check with the OPPOSITE
    # state (a reverse scan of the ts primary-key index that stops at the first flip,
    # all in SQLite - no rows shipped to Python), then the first check after it.
    flip = conn.execute(
        "SELECT ts FROM checks WHERE up != ? ORDER BY ts DESC LIMIT 1",
        (1 if up else 0,),
    ).fetchone()
    if flip is None:   # never flipped: streak spans the whole log
        first = conn.execute("SELECT MIN(ts) m FROM checks").fetchone()
        streak_since = first["m"] if first and first["m"] is not None else latest["ts"]
    else:
        nxt = conn.execute("SELECT MIN(ts) m FROM checks WHERE ts > ?", (flip["ts"],)).fetchone()
        streak_since = nxt["m"] if nxt and nxt["m"] is not None else latest["ts"]
    # A streak is a claim of CONTINUOUS observation: it must not silently bridge
    # unmonitored time. Clamp its start to the newest no-data boundary inside it
    # (gap events are stamped at the gap's end; 'resume' ends a pause; 'clockstep'
    # marks a timeline integrity break).
    try:
        ev = conn.execute(
            "SELECT MAX(ts) m FROM events WHERE kind IN ('gap','resume','clockstep')"
        ).fetchone()
        if ev and ev["m"] is not None and ev["m"] > streak_since:
            streak_since = min(ev["m"], latest["ts"])
    except sqlite3.OperationalError:
        pass
    streak_s = now - streak_since

    return {
        "status": status,
        "now": now,
        "latest_ts": latest["ts"],
        "latency_ms": round(latest["latency_ms"], 1) if latest["latency_ms"] is not None else None,
        "dns_ok": dns_ok,
        "streak_seconds": streak_s,
        "streak_h": fmt_dur(streak_s),
        "interval": interval,
        "db_size_bytes": _db_size(),   # rides the fast poll so the size reads near-live
    }


def first_record_ts(conn):
    """Earliest recorded moment across ALL tables, not just checks. Check rows are
    trimmed by retention while outage/event history is kept forever; anchoring
    "all time" to MIN(checks.ts) silently shrank it to the retention window and
    dropped older outages from the All view."""
    vals = []
    for sql in ("SELECT MIN(ts) m FROM checks",
                "SELECT MIN(start_ts) m FROM outages",
                "SELECT MIN(ts) m FROM events"):
        try:
            r = conn.execute(sql).fetchone()
            if r and r["m"] is not None:
                vals.append(r["m"])
        except sqlite3.OperationalError:
            pass
    return min(vals) if vals else None


def _has_col(conn, table, col):
    return col in {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def build_range(conn, start, end):
    now = int(time.time())
    start = max(0, int(start))
    end = int(end)
    # The future hasn't been monitored. An end past `now` would sit in the availability
    # denominator as monitored-up time and dilute every number (a "today" range asked at
    # 6am would read ~100% no matter what happened) - clamp before any math.
    end = min(end, now)
    if end <= start:
        start = end - 1
    window = end - start
    bucket = pick_bucket(window, max(1, cfg_get(conn, "interval")))

    # latency / sample summary
    s = conn.execute(
        """SELECT COUNT(*) total, COALESCE(SUM(up),0) up,
                  AVG(latency_ms) avg_lat, MIN(latency_ms) min_lat, MAX(latency_ms) max_lat
           FROM checks WHERE ts>=? AND ts<?""",
        (start, end),
    ).fetchone()
    total, up = s["total"], s["up"]
    sample_pct = (up / total * 100.0) if total else None

    # per-bucket data (drives the latency chart + scrub lookup)
    buckets = []
    for row in conn.execute(
        """SELECT (ts/?)*? AS b, COUNT(*) total, COALESCE(SUM(up),0) up,
                  AVG(latency_ms) avg_lat, MIN(latency_ms) min_lat, MAX(latency_ms) max_lat
           FROM checks WHERE ts>=? AND ts<? GROUP BY b ORDER BY b""",
        (bucket, bucket, start, end),
    ):
        bt = row["total"]
        buckets.append({
            "t": row["b"], "total": bt, "up": row["up"],
            "pct": (row["up"] / bt * 100.0) if bt else None,
            "avg": round(row["avg_lat"], 1) if row["avg_lat"] is not None else None,
            "min": round(row["min_lat"], 1) if row["min_lat"] is not None else None,
            "max": round(row["max_lat"], 1) if row["max_lat"] is not None else None,
        })

    # No-data spans first: the outage aggregation below corrects durations against them.
    gaps = get_gaps(conn, start, end, now)
    gap_merged = _merge([(g[0], g[1]) for g in gaps])
    gap_seconds = _total(gap_merged)

    has_cause = _has_col(conn, "outages", "cause")
    has_kind = _has_col(conn, "outages", "kind")
    has_note = _has_col(conn, "outages", "note")
    cause_sel = "cause" if has_cause else "NULL AS cause"
    note_sel = "note" if has_note else "NULL AS note"
    if has_kind:
        kind_sel = "kind"
    elif has_cause:
        kind_sel = "CASE WHEN cause='dns' THEN 'dns' ELSE 'net' END AS kind"
    else:
        kind_sel = "'net' AS kind"

    # ALL outages overlapping the window (small rows; full set powers exact math).
    # kind 'net' = connectivity (counts toward uptime); kind 'dns' = a separate
    # name-resolution signal that never counts as downtime.
    raw = conn.execute(
        f"""SELECT id, start_ts, end_ts, duration_s, {cause_sel}, {kind_sel}, {note_sel} FROM outages
            WHERE start_ts < ? AND (end_ts IS NULL OR end_ts >= ?)
            ORDER BY start_ts DESC""",
        (end, start),
    ).fetchall()

    outages = []
    net_iv, dns_iv = [], []
    net_count, dns_count = 0, 0
    # Aggregates over ALL overlapping outages (the JSON list below is capped at 200, so the
    # client must never derive stats from it), kept PER KIND so connectivity-labeled stats
    # never silently mix in DNS events. MTTR durations exclude no-data overlap: an outage
    # closed at a restart shouldn't count the unmonitored span as time-to-recover.
    mttr = {"net": [0, 0], "dns": [0, 0]}                # kind -> [sum_seconds, count]
    last_outage_start = last_net_outage_start = None
    longest_net = 0
    for row in raw:
        kind = row["kind"] or "net"
        if kind in ("slow", "unstable"):   # removed quality signals; ignore any legacy rows
            continue
        ongoing = row["end_ts"] is None
        o_end = now if ongoing else row["end_ts"]
        a, b = max(row["start_ts"], start), min(o_end, end)
        if b <= a:
            continue   # touches the boundary with zero overlap: belongs to the adjacent range
        if not ongoing:
            dur = (o_end - row["start_ts"]) - _overlap_total(row["start_ts"], o_end, gap_merged)
            k = mttr["dns" if kind == "dns" else "net"]
            k[0] += max(0, dur)
            k[1] += 1
        if last_outage_start is None or row["start_ts"] > last_outage_start:
            last_outage_start = row["start_ts"]
        if kind != "dns":
            if last_net_outage_start is None or row["start_ts"] > last_net_outage_start:
                last_net_outage_start = row["start_ts"]
            longest_net = max(longest_net, o_end - row["start_ts"])
        outages.append({
            "id": row["id"],
            "start": row["start_ts"], "end": row["end_ts"], "ongoing": ongoing,
            "duration_s": o_end - row["start_ts"], "duration_h": fmt_dur(o_end - row["start_ts"]),
            "cause": row["cause"] or "unknown", "kind": kind,
            "note": row["note"],
        })
        if kind == "dns":
            dns_count += 1
            dns_iv.append((a, b))
        else:
            net_count += 1
            net_iv.append((a, b))

    # gap-corrected availability: gaps count as neither up nor down. Downtime = time the internet
    # was unusable, which includes BOTH connectivity (net) outages AND confirmed DNS outages (DNS
    # down on every resolver = no usable internet). The two never overlap (DNS is only probed while
    # the line is up), so merging them is exact. dns_seconds is also kept on its own as a breakdown.
    down_iv = _subtract(_merge(net_iv + dns_iv), gap_merged)   # net + DNS time minus gaps
    down_seconds = _total(down_iv)
    dns_seconds = _total(_subtract(_merge(dns_iv), gap_merged))
    monitored = max(0, window - gap_seconds)
    availability = ((monitored - down_seconds) / monitored * 100.0) if monitored > 0 else None
    mttr_all_n = mttr["net"][1] + mttr["dns"][1]
    mttr_all_s = ((mttr["net"][0] + mttr["dns"][0]) / mttr_all_n) if mttr_all_n else None

    return {
        "start": start, "end": end, "now": now, "bucket": bucket,
        "interval": cfg_get(conn, "interval"), "first_ts": first_record_ts(conn),
        "summary": {
            "availability_pct": availability,
            "pct": sample_pct,                      # sample-based, for reference
            "checks": total,
            "down_seconds": down_seconds,           # exact, gap-excluded (connectivity + DNS)
            "down_h": fmt_dur(down_seconds),
            "monitored_seconds": monitored,
            "gap_seconds": gap_seconds,
            "outage_count": net_count + dns_count,  # total outages (connectivity + DNS)
            "net_events": net_count,                # connectivity-only breakdown
            "dns_events": dns_count,                # DNS-only breakdown
            "dns_seconds": dns_seconds,
            "dns_h": fmt_dur(dns_seconds),
            # mean time to recover over completed outages, gap-corrected; per kind so
            # connectivity-labeled stats never mix in DNS events
            "mttr_s": mttr_all_s,
            "mttr_net_s": (mttr["net"][0] / mttr["net"][1]) if mttr["net"][1] else None,
            "mttr_dns_s": (mttr["dns"][0] / mttr["dns"][1]) if mttr["dns"][1] else None,
            "last_outage_start": last_outage_start,
            "last_net_outage_start": last_net_outage_start,
            "longest_net_s": longest_net,
            "avg_lat": round(s["avg_lat"], 1) if s["avg_lat"] is not None else None,
            "min_lat": round(s["min_lat"], 1) if s["min_lat"] is not None else None,
            "max_lat": round(s["max_lat"], 1) if s["max_lat"] is not None else None,
        },
        "buckets": buckets,
        "outages": outages[:200],
        "gaps": [{"start": g[0], "end": g[1], "kind": g[2]} for g in gaps],
    }


def build_speedtests(conn, start, end, now):
    """Speed-test rows in the window, plus the newest result overall (the panel header
    shows the latest reading even when the selected range holds none) and the live
    settings, so the speed panel needs exactly one request. Tolerates a pre-migration
    DB whose monitor hasn't created the speedtests table yet."""
    has_engine = _has_col(conn, "speedtests", "engine")   # False for a pre-ookla DB

    def j(r):
        d = {"ts": r["ts"], "down_bps": r["down_bps"], "up_bps": r["up_bps"],
             "ping_ms": r["ping_ms"], "bytes_down": r["bytes_down"],
             "bytes_up": r["bytes_up"], "error": r["error"]}
        if has_engine:
            d.update({"jitter_ms": r["jitter_ms"], "loss_pct": r["loss_pct"],
                      "engine": r["engine"]})
        return d
    cols = "ts, down_bps, up_bps, ping_ms, bytes_down, bytes_up, error" \
        + (", jitter_ms, loss_pct, engine" if has_engine else "")
    tests, latest, last_error = [], None, None
    try:
        tests = [j(r) for r in conn.execute(
            f"SELECT {cols} FROM speedtests WHERE ts>=? AND ts<? ORDER BY ts", (start, end))]
        # latest = newest USABLE reading: one transient failure must not blank the
        # header until the next scheduled run. A failed newest attempt is surfaced
        # separately so it is still visible, never silently swallowed.
        row = conn.execute(f"SELECT {cols} FROM speedtests WHERE down_bps IS NOT NULL "
                           "ORDER BY ts DESC LIMIT 1").fetchone()
        latest = j(row) if row else None
        newest = conn.execute(f"SELECT {cols} FROM speedtests ORDER BY ts DESC LIMIT 1").fetchone()
        if newest is not None and newest["error"] and (latest is None or newest["ts"] > latest["ts"]):
            last_error = j(newest)
    except sqlite3.OperationalError:
        pass
    # A queued run-now request the monitor hasn't consumed yet drives the UI's
    # "Running..." state; it goes stale after 3 minutes so a stopped monitor can't
    # leave the button stuck forever.
    pending = False
    try:
        r = conn.execute("SELECT v FROM meta WHERE k='speedtest_request'").fetchone()
        pending = bool(r) and (now - int(float(r["v"] or 0))) < 180
    except (sqlite3.OperationalError, ValueError, TypeError):
        pass
    # Which engine the NEXT test will use, so the panel can label itself and swap
    # the data-use estimate (Ookla ignores the cap; its tests adapt to the line).
    try:
        import monitor as _mon
        engine = "ookla" if _mon._ookla_available() else "http"
    except Exception:
        engine = "http"
    return {"start": start, "end": min(end, now), "now": now,
            "tests": tests, "latest": latest, "last_error": last_error, "pending": pending,
            "period_h": cfg_get(conn, "speedtest_period_h"),
            "cap_mb": cfg_get(conn, "speedtest_cap_mb"), "engine": engine}


def pause_status():
    """(paused: bool, pause_until: int|None) from the sentinel file. An empty file is an
    indefinite pause; a numeric file is a timed pause (reported until it elapses, after
    which the monitor clears it)."""
    try:
        with open(PAUSE_FILE) as f:
            raw = f.read().strip()
    except OSError:
        return (False, None)
    if not raw:
        return (True, None)
    try:
        until = int(float(raw))
    except ValueError:
        return (True, None)
    if until <= 0:
        return (True, None)
    if int(time.time()) >= until:
        return (False, None)
    return (True, until)


def build_meta(conn):
    size = _db_size()
    def m(k, d=None):
        try:
            row = conn.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
            return row["v"] if row else d
        except sqlite3.OperationalError:
            return d
    # Probe configuration, surfaced for the technical Data & tools panel. Imported
    # lazily and guarded so the dashboard never breaks if monitor.py is unavailable
    # (module-level import is side-effect-free; the daemon loop is under __main__).
    # Targets reflect the effective list (a custom set from meta, or the built-in default).
    try:
        import monitor as _mon
        targets = [{"host": h, "port": p} for h, p in _mon.cfg_targets(conn)]
        resolvers = list(_mon.DNS_RESOLVERS)
        dns_host = ", ".join(_mon.DNS_PROBE_HOSTS)
    except Exception:
        targets, resolvers, dns_host = [], [], None
    targets_custom = bool(m("cfg_targets"))
    paused, pause_until = pause_status()
    return {
        "first_ts": first_record_ts(conn),
        "db_size_bytes": size,
        "paused": paused,
        "pause_until": pause_until,
        "retention_days": cfg_get(conn, "retention_days"),
        "outage_retention_days": cfg_get(conn, "outage_retention_days"),
        "timeout_ms": cfg_get(conn, "timeout_ms"),
        "schema_version": m("schema_version", "1"),
        "gateway": (m("gateway") or None),
        "interval": cfg_get(conn, "interval"),
        "targets": targets,
        "targets_custom": targets_custom,
        "resolvers": resolvers,
        "dns_host": dns_host,
        "alerts": {
            "type": m("cfg_alert_type", "discord"),
            "url": m("cfg_alert_url", "") or "",
            "recovery": (m("cfg_alert_recovery", "1") or "1") == "1",
            "dns": (m("cfg_alert_dns", "0") or "0") == "1",
        },
        "now": int(time.time()),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _resolve_range(self, q, conn, now):
        def _int(vals, d):
            try:
                return int(vals[0])
            except (TypeError, ValueError, IndexError):
                return d
        start = _int(q.get("start", [0]), 0)
        end = _int(q.get("end", [now]), now)
        if start <= 0:
            fts = first_record_ts(conn)
            start = fts if fts is not None else now - 3600
        return start, end

    def _stream_csv(self, filename, header, rowsql, params, fmtrow):
        conn = db()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write((header + "\n").encode("utf-8"))
            batch = []
            for row in conn.execute(rowsql, params):       # lazy cursor, no materialization
                batch.append(fmtrow(row))
                if len(batch) >= 1000:
                    self.wfile.write("".join(batch).encode("utf-8"))
                    batch = []
            if batch:
                self.wfile.write("".join(batch).encode("utf-8"))
        finally:
            conn.close()

    def _serve_static(self, path):
        """Serve the built React/shadcn app from web/. Falls back to the legacy
        single-file template if the app hasn't been built/deployed."""
        index = os.path.join(WEB_DIR, "index.html")
        if not os.path.exists(index):
            try:
                with open(TEMPLATE, "r", encoding="utf-8") as f:
                    self._send(200, f.read(), "text/html; charset=utf-8")
            except FileNotFoundError:
                self._send(404, "UI not built", "text/plain")
            return
        rel = path.lstrip("/") or "index.html"
        web_root = os.path.normpath(WEB_DIR)
        target = os.path.normpath(os.path.join(web_root, rel))
        # Confine to web_root: equal to it, or a path strictly beneath it (the trailing
        # separator stops a sibling like web_tmp/ from passing a bare prefix check).
        if target != web_root and not target.startswith(web_root + os.sep):
            self._send(403, "forbidden", "text/plain")
            return
        if not os.path.isfile(target):
            target = index                       # SPA fallback
        with open(target, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(os.path.splitext(target)[1].lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if "/assets/" in path else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _csrf_ok(self):
        # Block cross-site POSTs (CSRF): browsers always attach an Origin header on POST, so a
        # request whose Origin host:port doesn't match this server's Host is cross-origin and is
        # rejected. Requests with no Origin (curl / scripts, never browsers) are allowed through.
        origin = self.headers.get("Origin")
        if not origin:
            return True
        return urlparse(origin).netloc == self.headers.get("Host", "")

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            q = parse_qs(parsed.query)
            now = int(time.time())

            if path == "/api/live":
                conn = db()
                try:
                    self._send(200, json.dumps(get_live(conn, now)), "application/json")
                finally:
                    conn.close()

            elif path == "/api/range":
                conn = db()
                try:
                    start, end = self._resolve_range(q, conn, now)
                    self._send(200, json.dumps(build_range(conn, start, end)), "application/json")
                finally:
                    conn.close()

            elif path == "/api/meta":
                conn = db()
                try:
                    self._send(200, json.dumps(build_meta(conn)), "application/json")
                finally:
                    conn.close()

            elif path == "/api/speedtests":
                conn = db()
                try:
                    start, end = self._resolve_range(q, conn, now)
                    self._send(200, json.dumps(build_speedtests(conn, start, end, now)), "application/json")
                finally:
                    conn.close()

            elif path == "/api/export/checks.csv":
                conn = db()
                try:
                    start, end = self._resolve_range(q, conn, now)
                finally:
                    conn.close()
                self._export_checks(start, end)

            elif path == "/api/export/outages.csv":
                conn = db()
                try:
                    start, end = self._resolve_range(q, conn, now)
                finally:
                    conn.close()
                self._export_outages(start, end)

            elif path == "/api/export/speedtests.csv":
                conn = db()
                try:
                    start, end = self._resolve_range(q, conn, now)
                finally:
                    conn.close()
                self._export_speedtests(start, end)

            else:
                self._serve_static(path)
        except FileNotFoundError:
            self._send(503, "no database yet, is monitor.py running?", "text/plain")
        except Exception as e:  # noqa
            print(f"[dashboard] GET {self.path} failed: {e}", flush=True)
            self._send(500, "internal error", "text/plain")

    # CSV exports kept as explicit methods (schema-aware, streamed)
    def _export_checks(self, start, end):
        conn = db()
        has_gw = _has_col(conn, "checks", "gw")
        has_dns = _has_col(conn, "checks", "dns")
        has_target = _has_col(conn, "checks", "target")
        conn.close()
        cols = "ts, up, latency_ms" + (", gw" if has_gw else "") + (", dns" if has_dns else "") \
            + (", target" if has_target else "")

        def fmt(r):
            lat = "" if r["latency_ms"] is None else f'{r["latency_ms"]:.1f}'
            gw = (r["gw"] if has_gw and r["gw"] is not None else "")
            dns = (r["dns"] if has_dns and r["dns"] is not None else "")
            tgt = (r["target"] if has_target and r["target"] is not None else "")
            return f'{iso(r["ts"])},{iso_local(r["ts"])},{r["up"]},{lat},{gw},{dns},{tgt}\n'

        self._stream_csv(
            f"checks_{csv_range_label(start, end)}.csv",
            "timestamp_utc,timestamp_local,connectivity_up,latency_ms,gateway_reachable,dns_ok,target_answered",
            f"SELECT {cols} FROM checks WHERE ts>=? AND ts<? ORDER BY ts",
            (start, end), fmt,
        )

    def _export_outages(self, start, end):
        conn = db()
        has_cause = _has_col(conn, "outages", "cause")
        has_kind = _has_col(conn, "outages", "kind")
        has_note = _has_col(conn, "outages", "note")
        conn.close()
        cause_sel = "cause" if has_cause else "NULL AS cause"
        note_sel = "note" if has_note else "NULL AS note"
        if has_kind:
            kind_sel = "kind"
        elif has_cause:
            kind_sel = "CASE WHEN cause='dns' THEN 'dns' ELSE 'net' END AS kind"
        else:
            kind_sel = "'net' AS kind"
        now = int(time.time())

        def fmt(r):
            ongoing = r["end_ts"] is None
            o_end = now if ongoing else r["end_ts"]
            dur = o_end - r["start_ts"]
            end_iso = "" if ongoing else iso(r["end_ts"])
            end_local = "" if ongoing else iso_local(r["end_ts"])
            cause = r["cause"] or "unknown"
            kind = "dns" if (r["kind"] or "net") == "dns" else "connectivity"
            note = r["note"] or ""
            if note[:1] in ("=", "+", "-", "@", "\t"):
                note = "'" + note            # neutralize spreadsheet formula injection
            note = note.replace('"', '""').replace("\n", " ").replace("\r", " ")
            return (f'{r["id"]},{iso(r["start_ts"])},{iso_local(r["start_ts"])},{end_iso},{end_local},'
                    f'{dur},{fmt_dur(dur)},{cause},{CAUSE_LABELS.get(cause, "Unknown")},'
                    f'{kind},{1 if ongoing else 0},"{note}"\n')

        # legacy 'slow'/'unstable' rows (removed quality signals) are filtered like the UI
        kind_where = " AND (kind IS NULL OR kind NOT IN ('slow','unstable'))" if has_kind else ""
        self._stream_csv(
            f"outages_{csv_range_label(start, end)}.csv",
            "outage_id,start_time_utc,start_time_local,end_time_utc,end_time_local,"
            "duration_seconds,duration_human,cause,cause_label,outage_type,is_ongoing,note",
            f"SELECT id, start_ts, end_ts, duration_s, {cause_sel}, {kind_sel}, {note_sel} FROM outages "
            f"WHERE start_ts < ? AND (end_ts IS NULL OR end_ts >= ?){kind_where} ORDER BY start_ts",
            (end, start), fmt,
        )

    SPEEDTEST_CSV_HEADER = ("timestamp_utc,timestamp_local,download_mbps,upload_mbps,"
                            "ping_ms,jitter_ms,packet_loss_pct,bytes_downloaded,"
                            "bytes_uploaded,engine,error")

    def _export_speedtests(self, start, end):
        conn = db()
        try:
            has = conn.execute("SELECT name FROM sqlite_master WHERE type='table' "
                               "AND name='speedtests'").fetchone()
            has_engine = bool(has) and _has_col(conn, "speedtests", "engine")
        finally:
            conn.close()
        if not has:   # pre-migration DB: a valid, empty CSV instead of a 500
            self._send(200, self.SPEEDTEST_CSV_HEADER + "\n", "text/csv; charset=utf-8")
            return
        cols = "ts, down_bps, up_bps, ping_ms, bytes_down, bytes_up, error" \
            + (", jitter_ms, loss_pct, engine" if has_engine else "")

        def fmt(r):
            down = "" if r["down_bps"] is None else f'{r["down_bps"] / 1e6:.2f}'
            up = "" if r["up_bps"] is None else f'{r["up_bps"] / 1e6:.2f}'
            ping = "" if r["ping_ms"] is None else f'{r["ping_ms"]:.1f}'
            jitter = "" if not has_engine or r["jitter_ms"] is None else f'{r["jitter_ms"]:.1f}'
            loss = "" if not has_engine or r["loss_pct"] is None else f'{r["loss_pct"]:.2f}'
            engine = (r["engine"] or "http") if has_engine else "http"
            err = r["error"] or ""
            if err[:1] in ("=", "+", "-", "@", "\t"):
                err = "'" + err            # neutralize spreadsheet formula injection
            err = err.replace('"', '""').replace("\n", " ").replace("\r", " ")
            return (f'{iso(r["ts"])},{iso_local(r["ts"])},{down},{up},{ping},{jitter},{loss},'
                    f'{r["bytes_down"] or 0},{r["bytes_up"] or 0},{engine},"{err}"\n')

        self._stream_csv(
            f"speedtests_{csv_range_label(start, end)}.csv",
            self.SPEEDTEST_CSV_HEADER,
            f"SELECT {cols} FROM speedtests WHERE ts>=? AND ts<? ORDER BY ts",
            (start, end), fmt,
        )

    def do_POST(self):
        try:
            parsed = urlparse(self.path)
            if not self._csrf_ok():
                self._send(403, json.dumps({"error": "cross-origin request blocked"}), "application/json")
                return
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b""
            try:
                data = json.loads(raw) if raw else {}
            except ValueError:
                data = {}

            if parsed.path == "/api/pause":
                want = bool(data.get("paused"))
                if want:
                    # Optional timed pause: an integer "minutes" writes a resume epoch the
                    # monitor honors and auto-clears. No minutes (or 0) is an indefinite pause.
                    try:
                        mins = int(data.get("minutes") or 0)
                    except (TypeError, ValueError):
                        mins = 0
                    mins = max(0, min(mins, 7 * 24 * 60))   # cap at one week
                    until = int(time.time()) + mins * 60 if mins > 0 else None
                    with open(PAUSE_FILE, "w") as f:
                        if until:
                            f.write(str(until))
                    self._send(200, json.dumps({"paused": True, "pause_until": until}), "application/json")
                else:
                    try:
                        os.remove(PAUSE_FILE)
                    except FileNotFoundError:
                        pass
                    self._send(200, json.dumps({"paused": False, "pause_until": None}), "application/json")

            elif parsed.path == "/api/reset":
                if data.get("confirm") != "RESET":
                    self._send(400, json.dumps({"error": "type RESET to confirm"}), "application/json")
                    return
                conn = db_rw()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    conn.execute("DELETE FROM checks")
                    conn.execute("DELETE FROM outages")
                    try:
                        conn.execute("DELETE FROM events")
                    except sqlite3.OperationalError:
                        pass
                    conn.execute("COMMIT")
                    conn.execute("VACUUM")
                    try:
                        conn.execute("INSERT INTO events (ts, kind, detail) VALUES (?, 'start', 'post-reset')",
                                     (int(time.time()),))
                        conn.commit()
                    except sqlite3.OperationalError:
                        pass
                    self._send(200, json.dumps({"ok": True}), "application/json")
                except sqlite3.OperationalError as e:
                    self._send(503, json.dumps({"error": f"database busy: {e}"}), "application/json")
                finally:
                    conn.close()
            elif parsed.path == "/api/config":
                updates = {}
                for key, opts in CFG_OPTIONS.items():
                    if key in data:
                        try:
                            v = int(data[key])
                        except (TypeError, ValueError):
                            self._send(400, json.dumps({"error": f"invalid {key}"}), "application/json")
                            return
                        if v not in opts:
                            self._send(400, json.dumps({"error": f"invalid {key}"}), "application/json")
                            return
                        updates[key] = v
                if not updates:
                    self._send(400, json.dumps({"error": "no valid settings provided"}), "application/json")
                    return
                conn = db_rw()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    for key, v in updates.items():
                        conn.execute("INSERT INTO meta (k, v) VALUES (?, ?) "
                                     "ON CONFLICT(k) DO UPDATE SET v=excluded.v", ("cfg_" + key, str(v)))
                    conn.execute("COMMIT")
                    self._send(200, json.dumps({"ok": True, **updates}), "application/json")
                except sqlite3.OperationalError as e:
                    self._send(503, json.dumps({"error": f"database busy: {e}"}), "application/json")
                finally:
                    conn.close()
            elif parsed.path == "/api/outage/note":
                try:
                    oid = int(data.get("id"))
                except (TypeError, ValueError):
                    self._send(400, json.dumps({"error": "invalid id"}), "application/json")
                    return
                note = data.get("note")
                note = "" if note is None else str(note)[:1000]
                conn = db_rw()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    if not _has_col(conn, "outages", "note"):
                        conn.execute("ALTER TABLE outages ADD COLUMN note TEXT")
                    cur = conn.execute("UPDATE outages SET note=? WHERE id=?", (note or None, oid))
                    conn.execute("COMMIT")
                    if cur.rowcount == 0:
                        self._send(404, json.dumps({"error": "outage not found"}), "application/json")
                    else:
                        self._send(200, json.dumps({"ok": True, "id": oid, "note": note}), "application/json")
                except sqlite3.OperationalError as e:
                    self._send(503, json.dumps({"error": f"database busy: {e}"}), "application/json")
                finally:
                    conn.close()
            elif parsed.path == "/api/outage/delete":
                try:
                    oid = int(data.get("id"))
                except (TypeError, ValueError):
                    self._send(400, json.dumps({"error": "invalid id"}), "application/json")
                    return
                conn = db_rw()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    row = conn.execute("SELECT start_ts, end_ts, kind FROM outages WHERE id=?", (oid,)).fetchone()
                    if row is None:
                        conn.execute("COMMIT")
                        self._send(404, json.dumps({"error": "outage not found"}), "application/json")
                        return
                    if row["end_ts"] is None:
                        conn.execute("COMMIT")
                        self._send(400, json.dumps({"error": "can't delete an ongoing outage"}), "application/json")
                        return
                    # Only a connectivity outage means "the internet was actually fine" (e.g. a modem
                    # reset): mark that window back online AND clear its latency samples (a partial
                    # outage's survivors sit near the timeout; cleared, the chart fills an estimated
                    # line instead of lingering as a hidden-spike gap). A DNS event was up the whole
                    # time, so deleting it just drops the event row, never rewriting data.
                    if (row["kind"] or "net") == "net":
                        conn.execute("UPDATE checks SET up=1, latency_ms=NULL WHERE ts>=? AND ts<?",
                                     (row["start_ts"], row["end_ts"]))
                    # audit trail: deleting an outage rewrites the record, so leave a
                    # tamper-evident event for anyone auditing exported data later
                    try:
                        conn.execute(
                            "INSERT INTO events (ts, kind, detail) VALUES (?, 'outage_deleted', ?)",
                            (int(time.time()), json.dumps({
                                "id": oid, "start": row["start_ts"], "end": row["end_ts"],
                                "kind": row["kind"] or "net"})),
                        )
                    except sqlite3.OperationalError:
                        pass
                    conn.execute("DELETE FROM outages WHERE id=?", (oid,))
                    conn.execute("COMMIT")
                    self._send(200, json.dumps({"ok": True, "id": oid}), "application/json")
                except sqlite3.OperationalError as e:
                    self._send(503, json.dumps({"error": f"database busy: {e}"}), "application/json")
                finally:
                    conn.close()
            elif parsed.path == "/api/speedtest/run":
                # Queue a run-now request for the MONITOR to execute between check
                # cycles. Running the test here would saturate the link while probes
                # fire (contaminating readings) and block this handler ~30 seconds.
                # Consumed by the monitor within one cycle; works with scheduling off.
                conn = db_rw()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    conn.execute("INSERT INTO meta (k, v) VALUES ('speedtest_request', ?) "
                                 "ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                                 (str(int(time.time())),))
                    conn.execute("COMMIT")
                    self._send(200, json.dumps({"ok": True, "pending": True}), "application/json")
                except sqlite3.OperationalError as e:
                    self._send(503, json.dumps({"error": f"database busy: {e}"}), "application/json")
                finally:
                    conn.close()
            elif parsed.path == "/api/alerts":
                atype = str(data.get("type", "discord"))
                if atype not in ALERT_TYPES:
                    self._send(400, json.dumps({"error": "invalid alert type"}), "application/json")
                    return
                url = data.get("url")
                url = "" if url is None else str(url).strip()[:500]
                if url:
                    pu = urlparse(url)
                    if pu.scheme not in ("http", "https") or not pu.netloc:
                        self._send(400, json.dumps({"error": "URL must start with http:// or https://"}), "application/json")
                        return
                recovery = "1" if data.get("recovery", True) else "0"
                dns_alert = "1" if data.get("dns", False) else "0"
                conn = db_rw()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    for k, v in (("cfg_alert_type", atype), ("cfg_alert_url", url),
                                 ("cfg_alert_recovery", recovery), ("cfg_alert_dns", dns_alert)):
                        conn.execute("INSERT INTO meta (k, v) VALUES (?, ?) "
                                     "ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))
                    conn.execute("COMMIT")
                    self._send(200, json.dumps({"ok": True}), "application/json")
                except sqlite3.OperationalError as e:
                    self._send(503, json.dumps({"error": f"database busy: {e}"}), "application/json")
                finally:
                    conn.close()
            elif parsed.path == "/api/alert/test":
                # Test the client's DRAFT when provided, WITHOUT saving it: the UI has a
                # separate Save button, so Test must never silently persist config.
                # Saved config remains the fallback for requests with no body fields.
                url = str(data.get("url") or "").strip()
                atype = data.get("type") if data.get("type") in ALERT_TYPES else ""
                if not url or not atype:
                    conn = db()
                    try:
                        def mv(k, d=""):
                            r = conn.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
                            return (r["v"] if r else d) or d
                        url = url or mv("cfg_alert_url", "")
                        atype = atype or mv("cfg_alert_type", "discord")
                    finally:
                        conn.close()
                if not url:
                    self._send(400, json.dumps({"error": "Add a notification URL first"}), "application/json")
                    return
                try:
                    import monitor as _mon
                    ok = _mon.send_alert(url, atype, "Connection Watchman",
                                         "Test alert: your Connection Watchman notifications are working.")
                except Exception as e:
                    self._send(200, json.dumps({"ok": False, "error": str(e)}), "application/json")
                    return
                self._send(200, json.dumps({"ok": bool(ok)}), "application/json")
            elif parsed.path == "/api/targets":
                items = data.get("targets")
                if not isinstance(items, list):
                    self._send(400, json.dumps({"error": "targets must be a list"}), "application/json")
                    return
                cleaned = []
                for it in items:
                    try:
                        host = str(it.get("host", "")).strip() if isinstance(it, dict) else str(it[0]).strip()
                        port = int(it.get("port") if isinstance(it, dict) else it[1])
                    except (TypeError, ValueError, IndexError, AttributeError):
                        self._send(400, json.dumps({"error": "each target needs a host and port"}), "application/json")
                        return
                    if not TARGET_HOST_RE.match(host) or not (0 < port < 65536):
                        self._send(400, json.dumps({"error": f"invalid target {host}:{port}"}), "application/json")
                        return
                    cleaned.append([host, port])
                if len(cleaned) > 16:
                    self._send(400, json.dumps({"error": "at most 16 targets"}), "application/json")
                    return
                conn = db_rw()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    if cleaned:
                        conn.execute("INSERT INTO meta (k, v) VALUES ('cfg_targets', ?) "
                                     "ON CONFLICT(k) DO UPDATE SET v=excluded.v", (json.dumps(cleaned),))
                    else:
                        conn.execute("DELETE FROM meta WHERE k='cfg_targets'")   # empty = restore defaults
                    conn.execute("COMMIT")
                    self._send(200, json.dumps({"ok": True, "count": len(cleaned)}), "application/json")
                except sqlite3.OperationalError as e:
                    self._send(503, json.dumps({"error": f"database busy: {e}"}), "application/json")
                finally:
                    conn.close()
            else:
                self._send(404, "not found", "text/plain")
        except Exception as e:  # noqa
            print(f"[dashboard] POST {self.path} failed: {e}", flush=True)
            self._send(500, "internal error", "text/plain")


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"dashboard on http://0.0.0.0:{PORT}  (db={DB_PATH})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()


if __name__ == "__main__":
    main()
