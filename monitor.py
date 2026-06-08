#!/usr/bin/env python3
"""
Internet uptime monitor (diagnostic).

Runs forever. Every INTERVAL seconds (default 15) it measures two things:

  1. CONNECTIVITY  (the headline "uptime"): TCP connect to several public DNS
     servers by IP (1.1.1.1, 8.8.8.8, 9.9.9.9). "up" if ANY answers. To avoid
     false alarms from a single dropped packet, a failed check is retried a few
     times over a few seconds before it is believed (CONFIRM_RETRIES). The
     fastest successful connect is recorded as the latency.

  2. DNS  (a SEPARATE signal that does NOT affect the uptime score): can a name
     be resolved? First via the system resolver (what your own devices use,
     usually the router), and if that fails, directly against several independent
     public resolvers before DNS is declared down. This keeps a flaky router DNS
     forwarder from masquerading as an internet outage.

Connectivity down-stretches are recorded as outages of kind "net" with a cause:
  - "local"   : the LAN/router itself is unreachable (your equipment / the Pi).
  - "isp"     : the router is fine but the internet is not (ISP / WAN).
  - "unknown" : couldn't determine (gateway address not known).
DNS down-stretches are recorded as outages of kind "dns" (cause "dns") and are
reported separately; they never count against uptime. DNS is only evaluated
while connectivity is up (when the line is down, DNS fails too and is already
covered by the connectivity outage).

Reboots / pauses create GAPS in the log; gaps are recorded as events and count
as neither up nor down (so they can never inflate uptime). Raw per-check rows
are trimmed after UPTIME_RETENTION_DAYS; the tiny outage + event history is kept
forever.

Pure standard library: no pip installs required.
"""

import os
import socket
import sqlite3
import signal
import struct
import sys
import time
from datetime import datetime, timezone

# ---- Configuration (override with environment variables) -------------------
BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("UPTIME_DB", os.path.join(BASE, "uptime.db"))
INTERVAL = float(os.environ.get("UPTIME_INTERVAL", "15"))       # seconds between checks
TIMEOUT = float(os.environ.get("UPTIME_TIMEOUT", "1.5"))       # internet connect timeout
GW_TIMEOUT = float(os.environ.get("UPTIME_GW_TIMEOUT", "1"))   # gateway connect timeout
DNS_TIMEOUT = float(os.environ.get("UPTIME_DNS_TIMEOUT", "2")) # name resolution timeout
DNS_PROBE_HOST = os.environ.get("UPTIME_DNS_HOST", "example.com")
GATEWAY_IP = os.environ.get("UPTIME_GATEWAY")                  # blank -> auto-discover
RETENTION_DAYS = int(os.environ.get("UPTIME_RETENTION_DAYS", "365"))
OUTAGE_RETENTION_DAYS = int(os.environ.get("UPTIME_OUTAGE_RETENTION_DAYS", "0"))  # 0 = forever
# User-adjustable settings (persisted in meta by the dashboard, re-read each cycle).
# Whitelisted so a bad value can never break the loop.
CFG_INTERVAL_OPTIONS = (5, 10, 15, 30, 60)
CFG_RETENTION_OPTIONS = (0, 30, 90, 180, 365)
CFG_OUTAGE_RETENTION_OPTIONS = (0, 90, 180, 365)
CONFIRM_RETRIES = int(os.environ.get("UPTIME_CONFIRM_RETRIES", "3"))  # extra tries before "down"
RETRY_GAP = float(os.environ.get("UPTIME_RETRY_GAP", "1.0"))   # seconds between confirm tries
PAUSE_FILE = os.path.join(BASE, "PAUSED")

# Internet targets. Up if ANY connects. Diverse providers AND ports on purpose:
# 443 first (what real traffic like a video stream uses), then 53, so a router or
# ISP that briefly blocks/rate-limits one port to these IPs is not logged as an
# outage while the rest of the internet is fine.
TARGETS = [
    ("1.1.1.1", 443),    # Cloudflare (HTTPS)
    ("8.8.8.8", 443),    # Google (HTTPS)
    ("9.9.9.9", 443),    # Quad9 (HTTPS)
    ("1.1.1.1", 53),     # Cloudflare (DNS)
    ("8.8.8.8", 53),     # Google (DNS)
    ("9.9.9.9", 53),     # Quad9 (DNS)
]
# Independent resolvers queried directly over UDP to confirm a DNS failure.
DNS_RESOLVERS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"]
# Ports tried on the LAN gateway (routers usually answer on at least one).
GATEWAY_PORTS = (80, 443, 53)

# Worst-case time a single cycle's probes can block (all timeouts hit, retries
# burned, getaddrinfo stalls). A "gap" (reboot / the monitor not running) is only
# declared when the gap between checks exceeds this, so a slow cycle during an
# outage is never mistaken for missing data and never masks the outage.
PROBE_BUDGET = (len(TARGETS) * TIMEOUT) * (1 + CONFIRM_RETRIES) + CONFIRM_RETRIES * RETRY_GAP \
    + len(GATEWAY_PORTS) * GW_TIMEOUT + (1 + len(DNS_RESOLVERS)) * DNS_TIMEOUT
def gap_threshold(interval):
    """A gap (reboot / monitor down) is only declared when the time between checks
    exceeds this; scales with the current interval so a slower cadence isn't a gap."""
    return max(2 * interval, PROBE_BUDGET + interval)

# severity ordering so a connectivity outage reports the worst cause observed
CAUSE_SEVERITY = {"unknown": 0, "isp": 2, "local": 3}

_running = True
_gateway = "unset"   # cached discovery result


def _now():
    return int(time.time())


# ---- probes -----------------------------------------------------------------
def check_once():
    """Return (up: bool, latency_ms: float|None). Short-circuits: returns as soon
    as ANY target answers, so a healthy cycle is fast and only a real outage pays
    the full set of timeouts. Latency = the connect that answered."""
    for host, port in TARGETS:
        start = time.monotonic()
        try:
            with socket.create_connection((host, port), timeout=TIMEOUT):
                pass
            return True, (time.monotonic() - start) * 1000.0
        except OSError:
            continue
    return False, None


def check_connectivity():
    """check_once() with a fast retry burst, so a single dropped packet is not
    logged as an outage. Returns (up: bool, latency_ms: float|None)."""
    up, latency = check_once()
    if up:
        return True, latency
    for _ in range(CONFIRM_RETRIES):
        if not _running:
            break
        time.sleep(RETRY_GAP)
        up, latency = check_once()
        if up:
            return True, latency
    return False, None


def _resolve_system(host):
    """True if the system resolver (what your devices use) resolves the name."""
    old = socket.getdefaulttimeout()
    socket.setdefaulttimeout(DNS_TIMEOUT)
    try:
        socket.getaddrinfo(host, 80, type=socket.SOCK_STREAM)
        return True
    except OSError:
        return False
    finally:
        socket.setdefaulttimeout(old)


def _dns_query_udp(resolver, host, timeout):
    """Ask a specific resolver for an A record over UDP. True on a valid answer.
    Pure stdlib, so we can test public resolvers the system config doesn't use."""
    try:
        txid = int.from_bytes(os.urandom(2), "big")
        header = struct.pack(">HHHHHH", txid, 0x0100, 1, 0, 0, 0)   # RD=1, 1 question
        qname = b"".join(bytes([len(p)]) + p.encode("ascii")
                         for p in host.split(".") if p) + b"\x00"
        pkt = header + qname + struct.pack(">HH", 1, 1)             # QTYPE=A, QCLASS=IN
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.settimeout(timeout)
            s.sendto(pkt, (resolver, 53))
            data, _ = s.recvfrom(512)
        finally:
            s.close()
        if len(data) < 12:
            return False
        rid, flags, _qd, an, _ns, _ar = struct.unpack(">HHHHHH", data[:12])
        return rid == txid and (flags & 0x000F) == 0 and an > 0     # rcode 0, >=1 answer
    except OSError:
        return False


def probe_dns(host):
    """True if the name resolves. Checks the system resolver first (what your
    devices use); if that fails, confirms against independent public resolvers
    before declaring DNS down, so one flaky forwarder is not a false alarm."""
    if _resolve_system(host):
        return True
    for r in DNS_RESOLVERS:
        if _dns_query_udp(r, host, DNS_TIMEOUT):
            return True
    return False


def probe_gateway(gw):
    """True/False if the LAN gateway answers a TCP connect, None if unknown IP."""
    if not gw:
        return None
    for port in GATEWAY_PORTS:
        try:
            with socket.create_connection((gw, port), timeout=GW_TIMEOUT):
                return True
        except OSError:
            continue
    return False


def _gw_from_proc():
    """Read the default-route gateway from /proc/net/route (Linux, no root)."""
    try:
        with open("/proc/net/route") as f:
            for line in f.read().splitlines()[1:]:
                parts = line.split()
                if len(parts) >= 3 and parts[1] == "00000000":   # destination 0.0.0.0
                    b = bytes.fromhex(parts[2])                   # gateway, little-endian
                    return ".".join(str(x) for x in reversed(b))
    except (OSError, ValueError):
        pass
    return None


def _gw_from_ip_route():
    try:
        import subprocess
        out = subprocess.run(["ip", "route"], capture_output=True, text=True, timeout=3).stdout
        for line in out.splitlines():
            if line.startswith("default via "):
                return line.split()[2]
    except Exception:
        pass
    return None


def _gw_from_macos():
    """Default gateway on macOS via `route -n get default`, fallback `netstat -rn`."""
    try:
        import subprocess
        out = subprocess.run(["route", "-n", "get", "default"], capture_output=True, text=True, timeout=3).stdout
        for line in out.splitlines():
            if "gateway:" in line:
                return line.split(":", 1)[1].strip()
    except Exception:
        pass
    try:
        import subprocess
        out = subprocess.run(["netstat", "-rn"], capture_output=True, text=True, timeout=3).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0] in ("default", "0.0.0.0") and parts[1][:1].isdigit():
                return parts[1]
    except Exception:
        pass
    return None


def _gw_from_windows():
    """Default gateway on Windows. Prefer `route print -4` (numeric rows, locale-independent);
    fall back to parsing `ipconfig`."""
    try:
        import subprocess
        out = subprocess.run(["route", "print", "-4"], capture_output=True, text=True, timeout=5).stdout
        for line in out.splitlines():
            parts = line.split()
            # default-route rows look like: "0.0.0.0  0.0.0.0  <gateway>  <iface>  <metric>"
            if len(parts) >= 3 and parts[0] == "0.0.0.0" and parts[1] == "0.0.0.0":
                gw = parts[2]
                if gw[:1].isdigit():       # skip "On-link"
                    return gw
    except Exception:
        pass
    try:
        import subprocess
        out = subprocess.run(["ipconfig"], capture_output=True, text=True, timeout=5).stdout
        for line in out.splitlines():
            if "Gateway" in line and ":" in line:
                val = line.split(":", 1)[1].strip()
                if val[:1].isdigit():
                    return val
    except Exception:
        pass
    return None


def discover_gateway():
    """Gateway IP: env override, else the OS-appropriate default-route lookup, else None.
    Gateway is optional - if it can't be found, outages are classified as 'unknown'."""
    global _gateway
    if _gateway != "unset":
        return _gateway
    if GATEWAY_IP:
        _gateway = GATEWAY_IP
    elif sys.platform == "darwin":
        _gateway = _gw_from_macos()
    elif sys.platform.startswith("win"):
        _gateway = _gw_from_windows()
    else:
        _gateway = _gw_from_proc() or _gw_from_ip_route()   # Linux / other POSIX
    return _gateway


def classify_net_cause(gw):
    """Cause of a connectivity-down cycle (DNS is tracked separately now)."""
    if gw is True:
        return "isp"      # router reachable, internet not -> upstream / ISP / WAN
    if gw is False:
        return "local"    # router itself unreachable -> your equipment / the Pi
    return "unknown"      # gateway unknown - don't guess


# ---- database ---------------------------------------------------------------
def _cols(conn, table):
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def _add_col(conn, table, name, decl):
    if name not in _cols(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def init_db(conn):
    conn.execute("PRAGMA journal_mode=WAL")          # let dashboard read while we write
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS checks (
            ts         INTEGER PRIMARY KEY,
            up         INTEGER NOT NULL,
            latency_ms REAL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS outages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            start_ts   INTEGER NOT NULL,
            end_ts     INTEGER,
            duration_s INTEGER
        )
    """)
    # additive migrations (safe to run on an existing live DB)
    _add_col(conn, "checks", "gw", "INTEGER")     # gateway reachable (1/0/NULL)
    _add_col(conn, "checks", "dns", "INTEGER")    # name resolution ok (1/0/NULL)
    _add_col(conn, "outages", "cause", "TEXT")    # local | isp | dns | unknown
    _add_col(conn, "outages", "kind", "TEXT")     # net (connectivity) | dns
    _add_col(conn, "outages", "note", "TEXT")     # optional user-entered annotation
    # backfill: legacy DNS-caused outages become their own signal; the rest are
    # connectivity. This retroactively stops old DNS blips from counting as
    # downtime.
    conn.execute("UPDATE outages SET kind='dns' WHERE kind IS NULL AND cause='dns'")
    conn.execute("UPDATE outages SET kind='net' WHERE kind IS NULL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS events (
            id     INTEGER PRIMARY KEY AUTOINCREMENT,
            ts     INTEGER NOT NULL,
            kind   TEXT NOT NULL,        -- start | stop | pause | resume | gap
            detail TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)")
    conn.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
    conn.execute("INSERT INTO meta (k, v) VALUES ('schema_version', '3') "
                 "ON CONFLICT(k) DO UPDATE SET v='3'")
    # one-time cleanup: earlier versions logged a phantom "gap" whenever a cycle's
    # probes ran long during an outage, which masked that outage in availability.
    # Any gap shorter than the (probe-aware) threshold is such an artifact.
    if conn.execute("SELECT v FROM meta WHERE k='gap_artifact_cleanup'").fetchone() is None:
        conn.execute("DELETE FROM events WHERE kind='gap' "
                     "AND CAST(COALESCE(detail,'0') AS INTEGER) < ?", (int(gap_threshold(INTERVAL)),))
        conn.execute("INSERT INTO meta (k, v) VALUES ('gap_artifact_cleanup', '1') "
                     "ON CONFLICT(k) DO UPDATE SET v='1'")
    conn.commit()


def meta_get(conn, k, default=None):
    row = conn.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return row[0] if row else default


def meta_set(conn, k, v):
    conn.execute(
        "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        (k, str(v)),
    )


def _cfg(conn, key, default, options):
    """A user setting from meta if valid, else the env/built-in default."""
    try:
        v = meta_get(conn, "cfg_" + key)
        if v is not None:
            n = int(float(v))
            if n in options:
                return n
    except (ValueError, TypeError):
        pass
    return int(default)


def cfg_interval(conn):
    return _cfg(conn, "interval", INTERVAL, CFG_INTERVAL_OPTIONS)


def cfg_retention_days(conn):
    return _cfg(conn, "retention_days", RETENTION_DAYS, CFG_RETENTION_OPTIONS)


def cfg_outage_retention(conn):
    return _cfg(conn, "outage_retention_days", OUTAGE_RETENTION_DAYS, CFG_OUTAGE_RETENTION_OPTIONS)


def log_event(conn, now, kind, detail=None):
    conn.execute("INSERT INTO events (ts, kind, detail) VALUES (?, ?, ?)", (now, kind, detail))


def last_state(conn):
    """Return (prev_up: bool|None, prev_dns: bool|None, ts: int|None) for the
    most recent check. prev_dns is None when DNS wasn't evaluated (line down)."""
    row = conn.execute("SELECT ts, up, dns FROM checks ORDER BY ts DESC LIMIT 1").fetchone()
    if row is None:
        return (None, None, None)
    up = bool(row[1])
    dns = None if row[2] is None else bool(row[2])
    return (up, dns, row[0])


def open_outage(conn, kind):
    row = conn.execute(
        "SELECT id FROM outages WHERE end_ts IS NULL AND kind=? ORDER BY id DESC LIMIT 1",
        (kind,),
    ).fetchone()
    return None if row is None else row[0]


def record_transition(conn, now, kind, went_up, cause=None):
    if went_up:
        oid = open_outage(conn, kind)
        if oid is not None:
            row = conn.execute("SELECT start_ts FROM outages WHERE id=?", (oid,)).fetchone()
            conn.execute("UPDATE outages SET end_ts=?, duration_s=? WHERE id=?",
                         (now, now - row[0], oid))
    else:
        if open_outage(conn, kind) is None:
            default = "dns" if kind == "dns" else "unknown"
            conn.execute("INSERT INTO outages (start_ts, cause, kind) VALUES (?, ?, ?)",
                         (now, cause or default, kind))


def escalate_cause(conn, kind, cause):
    """While a connectivity outage is open, widen its cause toward the most
    severe seen."""
    if not cause:
        return
    oid = open_outage(conn, kind)
    if oid is None:
        return
    row = conn.execute("SELECT cause FROM outages WHERE id=?", (oid,)).fetchone()
    cur = row[0] if row else None
    if CAUSE_SEVERITY.get(cause, 0) > CAUSE_SEVERITY.get(cur, 0):
        conn.execute("UPDATE outages SET cause=? WHERE id=?", (cause, oid))


def trim_old_checks(conn, now, retention_days):
    """Delete raw checks older than the retention window. Outages/events kept."""
    if retention_days <= 0:
        return
    conn.execute("DELETE FROM checks WHERE ts < ?", (now - retention_days * 86400,))


def trim_old_outages(conn, now, retention_days):
    """Delete resolved outages that ended before the cutoff (ongoing ones kept).
    retention_days <= 0 means keep forever."""
    if retention_days <= 0:
        return
    conn.execute("DELETE FROM outages WHERE end_ts IS NOT NULL AND end_ts < ?",
                 (now - retention_days * 86400,))


# ---- main loop --------------------------------------------------------------
def stop(signum, frame):
    global _running
    _running = False


def _sleep_interval(cycle_start, interval):
    remaining = max(0.0, interval - (time.monotonic() - cycle_start))
    slept = 0.0
    while _running and slept < remaining:
        time.sleep(min(0.5, remaining - slept))
        slept += 0.5


def main():
    # SIGINT works everywhere; SIGTERM is POSIX-only. Register defensively so the
    # daemon starts cleanly on Windows too.
    for _signame in ("SIGTERM", "SIGINT"):
        _sig = getattr(signal, _signame, None)
        if _sig is not None:
            try:
                signal.signal(_sig, stop)
            except (OSError, ValueError):
                pass

    conn = sqlite3.connect(DB_PATH, timeout=10)
    init_db(conn)
    gw_ip = discover_gateway()

    meta_set(conn, "gateway", gw_ip or "")
    prev_up, prev_dns, prev_ts = last_state(conn)
    log_event(conn, _now(), "start", f"prev_up={prev_up} gw={gw_ip}")
    conn.commit()
    print(f"[{datetime.now(timezone.utc).isoformat()}] monitor started "
          f"(db={DB_PATH}, interval={cfg_interval(conn)}s, gateway={gw_ip}, prev_up={prev_up})", flush=True)

    was_paused = False
    last_trim = float(meta_get(conn, "last_trim_ts", "0") or 0)

    while _running:
        cycle_start = time.monotonic()
        now = _now()
        interval = cfg_interval(conn)

        # --- pause handling (sentinel file toggled by the dashboard) ---
        if os.path.exists(PAUSE_FILE):
            if not was_paused:
                log_event(conn, now, "pause"); conn.commit()
                print(f"[{datetime.now(timezone.utc).isoformat()}] paused", flush=True)
                was_paused = True
            prev_ts = None          # the paused span is recorded via events, not as a gap
            _sleep_interval(cycle_start, interval)
            continue
        if was_paused:
            log_event(conn, now, "resume"); conn.commit()
            print(f"[{datetime.now(timezone.utc).isoformat()}] resumed", flush=True)
            was_paused = False
            prev_ts = None

        # --- gap detection (reboot / long stall): record, never synthesize ---
        # Threshold exceeds the worst-case probe time so a slow outage cycle is
        # not mislabeled as a gap (which would mask the outage in availability).
        if prev_ts is not None and (now - prev_ts) > gap_threshold(interval):
            log_event(conn, now, "gap", str(now - prev_ts))

        # --- probes ---
        up, latency = check_connectivity()           # confirmed (retry burst on failure)
        gw = True if up else probe_gateway(gw_ip)     # internet up => LAN up
        net_cause = None if up else classify_net_cause(gw)

        # DNS is a separate signal, only meaningful while the line is up. When
        # the line is down, DNS fails too and is covered by the net outage, so
        # close any open DNS outage and record dns as unknown for this cycle.
        if up:
            dns_ok = probe_dns(DNS_PROBE_HOST)
        else:
            dns_ok = None
            record_transition(conn, now, "dns", went_up=True)

        conn.execute(
            "INSERT OR REPLACE INTO checks (ts, up, latency_ms, gw, dns) VALUES (?, ?, ?, ?, ?)",
            (now, 1 if up else 0, latency,
             (None if gw is None else (1 if gw else 0)),
             (None if dns_ok is None else (1 if dns_ok else 0))),
        )

        # --- connectivity (kind 'net') transitions ---
        if prev_up is not None and up != prev_up:
            record_transition(conn, now, "net", went_up=up, cause=net_cause)
            print(f"[{datetime.now(timezone.utc).isoformat()}] "
                  f"{'RECOVERED' if up else 'OUTAGE'} cause={net_cause} latency={latency}", flush=True)
        elif prev_up is None and not up:
            record_transition(conn, now, "net", went_up=False, cause=net_cause)
        elif not up:
            escalate_cause(conn, "net", net_cause)     # ongoing outage: widen cause if worse

        # --- DNS (kind 'dns') transitions, only while the line is up ---
        if up:
            if prev_dns is not None and dns_ok != prev_dns:
                record_transition(conn, now, "dns", went_up=dns_ok, cause="dns")
                print(f"[{datetime.now(timezone.utc).isoformat()}] "
                      f"DNS {'OK' if dns_ok else 'DEGRADED'}", flush=True)
            elif prev_dns is None and not dns_ok:
                record_transition(conn, now, "dns", went_up=False, cause="dns")

        # --- hourly retention trim ---
        if now - last_trim >= 3600:
            trim_old_checks(conn, now, cfg_retention_days(conn))
            trim_old_outages(conn, now, cfg_outage_retention(conn))
            meta_set(conn, "last_trim_ts", now)
            last_trim = now

        conn.commit()
        prev_up = up
        prev_dns = dns_ok if up else None      # re-baseline DNS after a line outage
        prev_ts = now
        _sleep_interval(cycle_start, interval)

    log_event(conn, _now(), "stop"); conn.commit()
    conn.close()
    print(f"[{datetime.now(timezone.utc).isoformat()}] monitor stopped", flush=True)


if __name__ == "__main__":
    main()
