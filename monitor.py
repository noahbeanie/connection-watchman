#!/usr/bin/env python3
"""
Internet uptime monitor (diagnostic).

Runs forever. Every INTERVAL seconds (default 15) it measures two things:

  1. CONNECTIVITY  (the headline "uptime"): TCP connect to several public DNS
     servers by IP (1.1.1.1, 8.8.8.8, 9.9.9.9). "up" if ANY answers. To avoid
     false alarms from a single dropped packet, a failed check is retried a few
     times over a few seconds before it is believed (CONFIRM_RETRIES). The first
     target that answers is recorded, along with its connect latency.

  2. DNS: can well-known names be resolved? Each probe name is tried via the
     system resolver first (what your own devices use, usually the router), then
     directly against several independent public resolvers. DNS is declared down
     only when EVERY name fails on EVERY path, so one flaky forwarder or one
     zone having a bad day is never logged as your outage.

Connectivity down-stretches are recorded as outages of kind "net" with a cause:
  - "local"   : the LAN/router itself is unreachable (your equipment / the Pi).
  - "isp"     : the router is fine but the internet is not (ISP / WAN).
  - "unknown" : couldn't determine (gateway address not known).
An outage's headline cause is the one that DOMINATED it (most attributed time),
not the worst one ever seen, so briefly power-cycling the router during a long
ISP outage doesn't relabel the whole thing "local".
DNS down-stretches are recorded as outages of kind "dns" (cause "dns"). A
confirmed DNS failure means no usable internet on any device, so it counts as
downtime, kept as its own kind so a DNS outage is distinguishable from a line
drop. DNS is only evaluated while connectivity is up (when the line is down,
DNS fails too and is already covered by the connectivity outage).

Reboots / pauses create GAPS in the log; gaps are recorded as events and count
as neither up nor down (so they can never inflate uptime). Storage is tiered:
recent checks keep full resolution, older HEALTHY checks are thinned to a coarse
grid (failures are never thinned), and rows past UPTIME_RETENTION_DAYS are
trimmed; the tiny outage + event history is kept forever.

Pure standard library: no pip installs required.
"""

import json
import os
import socket
import sqlite3
import signal
import struct
import sys
import threading
import time
from datetime import datetime, timezone

# ---- Configuration (override with environment variables) -------------------
BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("UPTIME_DB", os.path.join(BASE, "uptime.db"))
INTERVAL = float(os.environ.get("UPTIME_INTERVAL", "15"))       # seconds between checks
TIMEOUT = float(os.environ.get("UPTIME_TIMEOUT", "1.5"))       # internet connect timeout
GW_TIMEOUT = float(os.environ.get("UPTIME_GW_TIMEOUT", "1"))   # gateway connect timeout
DNS_TIMEOUT = float(os.environ.get("UPTIME_DNS_TIMEOUT", "2")) # name resolution timeout
# Names used to test DNS (comma-separated to override). Several UNRELATED zones on purpose:
# a DNS failure counts as downtime, so it must take every name failing on every resolver,
# never one zone's bad day, to register. Probing short-circuits on the first success.
DNS_PROBE_HOSTS = [h.strip() for h in os.environ.get(
    "UPTIME_DNS_HOST", "example.com,cloudflare.com,wikipedia.org").split(",") if h.strip()] \
    or ["example.com"]
GATEWAY_IP = os.environ.get("UPTIME_GATEWAY")                  # blank -> auto-discover
RETENTION_DAYS = int(os.environ.get("UPTIME_RETENTION_DAYS", "365"))
OUTAGE_RETENTION_DAYS = int(os.environ.get("UPTIME_OUTAGE_RETENTION_DAYS", "0"))  # 0 = forever
# Tiered retention: the last COMPACT_AFTER_DAYS keep every check (live-zoom territory);
# beyond that, HEALTHY rows are thinned to one per COMPACT_GRID_S seconds so long-term
# growth stays near the grid rate no matter how fast checks run. Failure rows (up=0, or
# a confirmed DNS failure) are NEVER thinned - outage evidence keeps full fidelity, and
# the outage/event tables are untouched. 0 days disables thinning entirely.
try:
    COMPACT_AFTER_DAYS = float(os.environ.get("UPTIME_COMPACT_AFTER_DAYS", "2"))
except ValueError:
    COMPACT_AFTER_DAYS = 2.0
COMPACT_GRID_S = max(1, int(os.environ.get("UPTIME_COMPACT_GRID", "15") or 15))
# User-adjustable settings (persisted in meta by the dashboard, re-read each cycle).
# Whitelisted so a bad value can never break the loop.
CFG_INTERVAL_OPTIONS = (1, 5, 10, 15, 30, 60)
CFG_RETENTION_OPTIONS = (0, 30, 90, 180, 365)
CFG_OUTAGE_RETENTION_OPTIONS = (0, 90, 180, 365)
# Response cutoff: a target must answer a TCP connect within this many ms or it doesn't count as
# answering, so a connection that's technically reachable but crawling counts as DOWN (a real
# outage) rather than "up". The retry burst still debounces, so only SUSTAINED slowness registers.
# Lower = stricter. Re-read live; whitelisted.
CFG_TIMEOUT_OPTIONS = (1000, 1500, 2000, 3000)
TIMEOUT_MS_DEFAULT = 1000
CONFIRM_RETRIES = int(os.environ.get("UPTIME_CONFIRM_RETRIES", "3"))  # extra tries before "down"
RETRY_GAP = float(os.environ.get("UPTIME_RETRY_GAP", "1.0"))   # seconds between confirm tries
PAUSE_FILE = os.path.join(BASE, "PAUSED")
# Optional firewall mark applied to probe sockets so they BYPASS a policy-routed VPN on the host
# and test the DIRECT path your other devices use (otherwise the probe measures the VPN tunnel, not
# your ISP link). 0 = off (default; portable). When set (your VPN's bypass fwmark, found via
# `ip rule show`) the service needs CAP_NET_ADMIN to apply SO_MARK. Parsed base-0 so "0x..." or
# decimal both work.
try:
    FWMARK = int(os.environ.get("UPTIME_FWMARK", "0") or "0", 0)
except ValueError:
    FWMARK = 0
SO_MARK = getattr(socket, "SO_MARK", 36)   # 36 on Linux; only used when FWMARK is set

# Plain-English phrase for a connectivity cause, used in alert messages.
CAUSE_PHRASE = {
    "isp": "your ISP or the wider internet",
    "local": "your router or local network",
    "unknown": "an unknown cause",
}

# Internet targets. Up if ANY connects. Diverse providers AND ports on purpose:
# 443 first (the port normal web traffic uses), then 53, so a router or
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
# burned, resolvers stall). A "gap" (reboot / the monitor not running) is only
# declared when the gap between checks exceeds this, so a slow cycle during an
# outage is never mistaken for missing data and never masks the outage. Scales with
# the number of targets AND the live response cutoff: the loop probes with the
# user-set timeout_ms, so budgeting with a smaller constant would make every fully
# failing cycle look like a gap and reclassify real downtime as no-data.
def probe_budget(n_targets, timeout=TIMEOUT):
    return (n_targets * timeout) * (1 + CONFIRM_RETRIES) + CONFIRM_RETRIES * RETRY_GAP \
        + len(GATEWAY_PORTS) * GW_TIMEOUT \
        + len(DNS_PROBE_HOSTS) * (1 + len(DNS_RESOLVERS)) * DNS_TIMEOUT
def gap_threshold(interval, n_targets=len(TARGETS), timeout=TIMEOUT):
    """A gap (reboot / monitor down) is only declared when the time between checks
    exceeds this; scales with the current interval so a slower cadence isn't a gap."""
    return max(2 * interval, probe_budget(n_targets, timeout) + interval)

# severity ordering so a connectivity outage reports the worst cause observed
CAUSE_SEVERITY = {"unknown": 0, "isp": 2, "local": 3}

_running = True
_gateway = "unset"   # cached discovery result
_gateway_checked = 0.0   # monotonic time of the last discovery attempt
GW_REDISCOVER_S = 300    # re-discover the gateway at most this often (router IP can change)


def _now():
    return int(time.time())


# A wall-vs-monotonic divergence bigger than this is a clock STEP (NTP jump, manual
# change), which would corrupt the timeline if written through. Sleep/scheduling
# jitter is well under it.
CLOCK_STEP_S = 30
_HAS_BOOTTIME = hasattr(time, "CLOCK_BOOTTIME")


def _mono_boot():
    """Monotonic seconds INCLUDING time spent suspended where the platform offers it
    (CLOCK_BOOTTIME on Linux), so wall-vs-monotonic drift means a clock step, never a
    host sleep. Where unavailable, forward-step detection is disabled (a laptop waking
    from sleep would otherwise look like a step) and only backward steps are handled."""
    if _HAS_BOOTTIME:
        return time.clock_gettime(time.CLOCK_BOOTTIME)
    return time.monotonic()


# ---- probes -----------------------------------------------------------------
def _connect_direct(host, port, timeout):
    """TCP connect with the bypass fwmark set, so a policy-routed VPN on the host doesn't capture
    the probe and we test the direct path. Raises OSError on failure (like create_connection)."""
    last = None
    for af, st, proto, _cn, sa in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM):
        s = socket.socket(af, st, proto)
        try:
            s.setsockopt(socket.SOL_SOCKET, SO_MARK, FWMARK)
            s.settimeout(timeout)
            s.connect(sa)
            return
        except OSError as e:
            last = e
        finally:
            s.close()
    raise last or OSError("getaddrinfo returned no addresses")


def check_once(targets=TARGETS, timeout=TIMEOUT):
    """Return (up: bool, latency_ms: float|None, target: str|None). Short-circuits: returns as
    soon as ANY target answers WITHIN `timeout`. `target` is the answering "host:port" (None if
    all failed), recorded so a future "why wasn't this caught" can be traced from the data."""
    for host, port in targets:
        start = time.monotonic()
        try:
            if FWMARK:
                _connect_direct(host, port, timeout)   # bypass a host VPN -> test the direct path
            else:
                with socket.create_connection((host, port), timeout=timeout):
                    pass
            return True, (time.monotonic() - start) * 1000.0, f"{host}:{port}"
        except (OSError, UnicodeError):
            # UnicodeError (e.g. an over-long DNS label in a custom target) is NOT an OSError;
            # catch it too so a malformed target is just "unreachable", never a daemon crash.
            continue
    return False, None, None


def check_connectivity(targets=TARGETS, timeout=TIMEOUT):
    """check_once() with a fast retry burst, so a single dropped packet (or one slow blip past
    the cutoff) is not logged as an outage. Returns (up: bool, latency_ms: float|None, target)."""
    up, latency, target = check_once(targets, timeout)
    if up:
        return True, latency, target
    for _ in range(CONFIRM_RETRIES):
        if not _running:
            break
        time.sleep(RETRY_GAP)
        up, latency, target = check_once(targets, timeout)
        if up:
            return True, latency, target
    return False, None, None


def _resolve_system(host):
    """True if the system resolver (what your devices use) resolves the name.
    getaddrinfo ignores socket timeouts (the libc resolver runs its own multi-second
    retry schedule, 10-30s worst case), so it runs on a disposable daemon thread
    bounded by DNS_TIMEOUT: a hung resolver costs the cycle at most DNS_TIMEOUT and
    falls through to the direct public-resolver probes."""
    res = []

    def _work():
        try:
            socket.getaddrinfo(host, 80, type=socket.SOCK_STREAM)
            res.append(True)
        except OSError:
            res.append(False)

    t = threading.Thread(target=_work, daemon=True)
    t.start()
    t.join(DNS_TIMEOUT)
    return bool(res and res[0])


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
            if FWMARK:
                s.setsockopt(socket.SOL_SOCKET, SO_MARK, FWMARK)   # bypass a host VPN, like the TCP probe
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


def probe_dns(hosts=None):
    """True if ANY probe name resolves anywhere. Each name is tried via the system
    resolver first (what your devices use), then against independent public
    resolvers. DNS is declared down only when EVERY name fails on EVERY path, so a
    flaky forwarder or a single zone's outage is never a false alarm. Short-circuits
    on the first success, so the healthy path costs a single lookup."""
    for host in (hosts or DNS_PROBE_HOSTS):
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
    Gateway is optional - if it can't be found, outages are classified as 'unknown'.

    Re-discovered every GW_REDISCOVER_S (the router IP can change: DHCP, a new router),
    so cause classification doesn't probe a stale address until the daemon restarts.
    If a re-discovery fails (e.g. the default route vanished mid-outage), the last
    known address is kept - the router is still at that IP, which is exactly what
    the local-vs-isp classification needs to probe."""
    global _gateway, _gateway_checked
    if GATEWAY_IP:
        _gateway = GATEWAY_IP
        return _gateway
    mono = time.monotonic()
    if _gateway != "unset" and (mono - _gateway_checked) < GW_REDISCOVER_S:
        return _gateway
    _gateway_checked = mono
    if sys.platform == "darwin":
        found = _gw_from_macos()
    elif sys.platform.startswith("win"):
        found = _gw_from_windows()
    else:
        found = _gw_from_proc() or _gw_from_ip_route()   # Linux / other POSIX
    if found or _gateway == "unset":
        _gateway = found
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
    _add_col(conn, "checks", "target", "TEXT")    # which "host:port" answered the check (diagnostic)
    _add_col(conn, "outages", "cause", "TEXT")    # local | isp | dns | unknown (dominant)
    _add_col(conn, "outages", "kind", "TEXT")     # net (connectivity) | dns
    _add_col(conn, "outages", "note", "TEXT")     # optional user-entered annotation
    _add_col(conn, "outages", "causes", "TEXT")   # JSON seconds-per-cause tally for the outage
    # backfill: legacy DNS-caused outages become their own signal; the rest are
    # connectivity. This retroactively stops old DNS blips from counting as
    # downtime.
    conn.execute("UPDATE outages SET kind='dns' WHERE kind IS NULL AND cause='dns'")
    conn.execute("UPDATE outages SET kind='net' WHERE kind IS NULL")
    # The "slow"/"unstable" quality signals were removed from the app: drop any historical rows so
    # they never resurface. They never counted toward downtime, so no uptime math changes.
    conn.execute("DELETE FROM outages WHERE kind IN ('slow', 'unstable')")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS events (
            id     INTEGER PRIMARY KEY AUTOINCREMENT,
            ts     INTEGER NOT NULL,
            kind   TEXT NOT NULL,        -- start|stop|pause|resume|gap|gateway|clockstep|outage_deleted
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


def cfg_timeout_ms(conn):
    return _cfg(conn, "timeout_ms", TIMEOUT_MS_DEFAULT, CFG_TIMEOUT_OPTIONS)


def cfg_targets(conn):
    """Effective probe targets: a validated custom list from meta if present, else the
    built-in TARGETS. Any malformed value falls back to the defaults so the loop is safe."""
    raw = meta_get(conn, "cfg_targets")
    if raw:
        try:
            out = []
            for item in json.loads(raw):
                host = str(item[0]).strip()
                port = int(item[1])
                if host and 0 < port < 65536:
                    out.append((host, port))
            if out:
                return out[:16]
        except (ValueError, TypeError, IndexError):
            pass
    return list(TARGETS)


def alert_cfg(conn):
    """Notification settings from meta. url='' means alerts are off."""
    return {
        "url": meta_get(conn, "cfg_alert_url", "") or "",
        "type": meta_get(conn, "cfg_alert_type", "discord") or "discord",
        "recovery": (meta_get(conn, "cfg_alert_recovery", "1") or "1") == "1",
        "dns": (meta_get(conn, "cfg_alert_dns", "0") or "0") == "1",
    }


def send_alert(url, atype, title, message):
    """POST a notification to the configured channel. Pure stdlib, best-effort: any
    failure is swallowed so alerting can never disturb the monitor loop. Returns True on
    a 2xx response. Supports a Discord webhook and a generic JSON webhook."""
    if not url:
        return False
    import urllib.request
    # A real User-Agent is required: Discord sits behind Cloudflare, which 403s the default
    # "Python-urllib/x" agent (error 1010). Send our own on every channel.
    ua = "ConnectionWatchman/1.0"
    try:
        if atype == "discord":
            body = json.dumps({"content": f"**{title}**\n{message}"}).encode("utf-8")
        else:  # generic JSON webhook
            body = json.dumps({"title": title, "message": message}).encode("utf-8")
        req = urllib.request.Request(
            url, data=body,
            headers={"Content-Type": "application/json", "User-Agent": ua},
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            return 200 <= getattr(resp, "status", 200) < 300
    except Exception as e:
        print(f"[{datetime.now(timezone.utc).isoformat()}] alert send failed: {e}", flush=True)
        return False


def _human_dur(seconds):
    """Short human duration for alert text, e.g. '2m 36s' or '1h 4m'."""
    s = int(seconds or 0)
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60}s"
    if s < 86400:
        return f"{s // 3600}h {(s % 3600) // 60}m"
    return f"{s // 86400}d {(s % 86400) // 3600}h"


def last_closed_net_outage(conn):
    """(duration_s, cause) of the most recently resolved connectivity outage, or None."""
    return conn.execute(
        "SELECT duration_s, cause FROM outages WHERE kind='net' AND end_ts IS NOT NULL "
        "ORDER BY end_ts DESC LIMIT 1"
    ).fetchone()


def pause_until():
    """Resume epoch if a timed pause is active, 0 for an indefinite pause, or None if not
    paused. An elapsed timed pause is auto-cleared (the file removed) and reported as None,
    so 'pause for 1 hour' resumes on its own."""
    try:
        with open(PAUSE_FILE) as f:
            raw = f.read().strip()
    except OSError:
        return None
    if not raw:
        return 0
    try:
        until = int(float(raw))
    except ValueError:
        return 0
    if until <= 0:
        return 0
    if _now() >= until:
        # Re-read right before deleting: if the dashboard rewrote PAUSE_FILE in the gap since
        # we read it (a new pause), don't clobber it. Treat as paused this cycle and re-evaluate
        # the fresh value next cycle.
        try:
            with open(PAUSE_FILE) as f:
                if f.read().strip() != raw:
                    return 0
        except OSError:
            return None
        try:
            os.remove(PAUSE_FILE)
        except OSError:
            pass
        return None
    return until


def log_event(conn, now, kind, detail=None):
    conn.execute("INSERT INTO events (ts, kind, detail) VALUES (?, ?, ?)", (now, kind, detail))


def reconcile_pause_state(conn, now):
    """Close a dangling pause at startup. A timed pause can expire (or the file be
    removed) while the daemon is down; the matching 'resume' event is then never
    written, and the dashboard would count everything since the old 'pause' as paused
    time - collapsing the availability denominator and subtracting real outages out of
    downtime. If the newest pause/resume event is an unmatched 'pause' and we are NOT
    currently paused, write the missing resume: at the recorded expiry when the pause
    was timed, else now."""
    row = conn.execute("SELECT ts, kind FROM events WHERE kind IN ('pause','resume') "
                       "ORDER BY ts DESC, id DESC LIMIT 1").fetchone()
    if row is None or row[1] != "pause":
        return
    expiry = None
    try:        # capture a timed pause's expiry BEFORE pause_until() auto-clears the file
        with open(PAUSE_FILE) as f:
            raw = f.read().strip()
            if raw:
                expiry = int(float(raw))
    except (OSError, ValueError):
        pass
    if pause_until() is not None:
        return  # genuinely still paused; the loop writes the resume when it ends
    ts = expiry if (expiry and row[0] < expiry <= now) else now
    log_event(conn, ts, "resume", "reconciled at startup")
    print(f"[{datetime.now(timezone.utc).isoformat()}] closed a dangling pause "
          f"(resume reconciled at {datetime.fromtimestamp(ts, timezone.utc).isoformat()})", flush=True)


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
    """Idempotent: opens an outage only if none is open, closes only if one is. Safe to
    apply every cycle, which also self-heals a wiped/edited DB mid-outage. Duration is
    clamped at zero so a clock anomaly can never store a negative one."""
    if went_up:
        oid = open_outage(conn, kind)
        if oid is not None:
            row = conn.execute("SELECT start_ts FROM outages WHERE id=?", (oid,)).fetchone()
            conn.execute("UPDATE outages SET end_ts=?, duration_s=? WHERE id=?",
                         (now, max(0, now - row[0]), oid))
    else:
        if open_outage(conn, kind) is None:
            default = "dns" if kind == "dns" else "unknown"
            conn.execute("INSERT INTO outages (start_ts, cause, kind) VALUES (?, ?, ?)",
                         (now, cause or default, kind))


def tally_cause(conn, kind, cause, dt):
    """Attribute dt seconds of the OPEN outage to `cause` and keep the outage's headline
    cause as the one with the MOST attributed time (ties go to the more severe). This
    replaces most-severe-ever escalation, under which power-cycling the router for a
    minute relabeled a two-hour ISP outage as 'local' - backwards for ISP evidence.
    The full tally is kept in the JSON `causes` column for transparency."""
    if not cause:
        return
    oid = open_outage(conn, kind)
    if oid is None:
        return
    row = conn.execute("SELECT causes FROM outages WHERE id=?", (oid,)).fetchone()
    try:
        tally = json.loads(row[0]) if row and row[0] else {}
        if not isinstance(tally, dict):
            tally = {}
    except ValueError:
        tally = {}
    tally[cause] = int(tally.get(cause, 0)) + int(dt)
    dominant = max(tally.items(), key=lambda kv: (kv[1], CAUSE_SEVERITY.get(kv[0], 0)))[0]
    conn.execute("UPDATE outages SET causes=?, cause=? WHERE id=?",
                 (json.dumps(tally), dominant, oid))


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


def compact_old_checks(conn, now):
    """Tiered retention. Checks older than COMPACT_AFTER_DAYS are thinned so that HEALTHY
    rows keep one sample per COMPACT_GRID_S grid cell (the first in each cell, which makes
    old latency a deterministic sample rather than an estimate). Rows recording a failure
    (up=0, or a confirmed DNS failure) are never deleted here, so the evidence record keeps
    full resolution forever. Incremental via a high-water mark in meta: each hourly run
    processes only rows that aged past the cutoff since the previous run."""
    if COMPACT_AFTER_DAYS <= 0:
        return
    cutoff = now - int(COMPACT_AFTER_DAYS * 86400)
    done = int(float(meta_get(conn, "compact_done_ts", "0") or 0))
    if cutoff <= done:
        return
    conn.execute(
        """DELETE FROM checks
           WHERE ts >= ? AND ts < ? AND up = 1 AND (dns IS NULL OR dns != 0)
             AND ts NOT IN (
               SELECT MIN(ts) FROM checks
               WHERE ts >= ? AND ts < ? AND up = 1 AND (dns IS NULL OR dns != 0)
               GROUP BY ts / ?)""",
        (done, cutoff, done, cutoff, COMPACT_GRID_S),
    )
    meta_set(conn, "compact_done_ts", cutoff)


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
    reconcile_pause_state(conn, _now())
    gw_ip = discover_gateway()

    meta_set(conn, "gateway", gw_ip or "")
    prev_up, prev_dns, prev_ts = last_state(conn)
    log_event(conn, _now(), "start", f"prev_up={prev_up} gw={gw_ip}")
    conn.commit()
    print(f"[{datetime.now(timezone.utc).isoformat()}] monitor started "
          f"(db={DB_PATH}, interval={cfg_interval(conn)}s, gateway={gw_ip}, prev_up={prev_up})", flush=True)

    was_paused = False
    last_trim = float(meta_get(conn, "last_trim_ts", "0") or 0)
    prev_wall = prev_boot = None   # wall-vs-monotonic baseline for clock-step detection
    clock_warned = False

    while _running:
        cycle_start = time.monotonic()
        now = _now()
        interval = cfg_interval(conn)
        targets = cfg_targets(conn)
        timeout_s = cfg_timeout_ms(conn) / 1000.0   # response cutoff: must answer within this
        alerts = alert_cfg(conn)

        # --- pause handling (sentinel file toggled by the dashboard; may auto-expire) ---
        pu = pause_until()
        if pu is not None:
            if not was_paused:
                log_event(conn, now, "pause"); conn.commit()
                print(f"[{datetime.now(timezone.utc).isoformat()}] paused"
                      f"{f' until {datetime.fromtimestamp(pu, timezone.utc).isoformat()}' if pu else ''}", flush=True)
                was_paused = True
            prev_ts = None          # the paused span is recorded via events, not as a gap
            _sleep_interval(cycle_start, interval)
            continue
        if was_paused:
            log_event(conn, now, "resume"); conn.commit()
            print(f"[{datetime.now(timezone.utc).isoformat()}] resumed", flush=True)
            was_paused = False
            prev_ts = None

        # --- clock sanity: a stepping clock corrupts the timeline if written through ---
        boot_now = _mono_boot()
        drift = ((now - prev_wall) - (boot_now - prev_boot)) if prev_wall is not None else 0.0
        prev_wall, prev_boot = now, boot_now
        if (prev_ts is not None and now <= prev_ts) or drift < -CLOCK_STEP_S:
            # Clock went BACKWARD (NTP correcting a fast clock, manual change): writing now
            # would overwrite or interleave with already-recorded history. Mark it once and
            # idle until the clock passes the last written timestamp again.
            if not clock_warned:
                log_event(conn, now, "clockstep", str(int(drift)))
                conn.commit()
                print(f"[{datetime.now(timezone.utc).isoformat()}] clock stepped backward "
                      f"({int(drift)}s); pausing writes until it catches up", flush=True)
                clock_warned = True
            _sleep_interval(cycle_start, interval)
            continue
        clock_warned = False
        if drift > CLOCK_STEP_S and _HAS_BOOTTIME:
            # Forward step (e.g. first NTP sync after booting with a stale clock). The
            # monitor was running the whole time, so don't let the jump register as a
            # no-data gap; record the integrity boundary instead.
            log_event(conn, now, "clockstep", str(int(drift)))
            print(f"[{datetime.now(timezone.utc).isoformat()}] clock stepped forward "
                  f"{int(drift)}s", flush=True)
            prev_ts = None

        # --- gap detection (reboot / long stall): record, never synthesize ---
        # Threshold exceeds the worst-case probe time AT THE LIVE response cutoff, so a
        # slow fully-failing cycle is not mislabeled as a gap (which would reclassify
        # the outage's downtime as no-data and mask it in availability).
        if prev_ts is not None and (now - prev_ts) > gap_threshold(interval, len(targets), timeout_s):
            log_event(conn, now, "gap", str(now - prev_ts))

        # --- probes ---
        # Refresh the gateway (cheap: cached, re-discovered every GW_REDISCOVER_S) so a
        # router/DHCP change updates cause classification without a daemon restart.
        new_gw = discover_gateway()
        if new_gw != gw_ip:
            gw_ip = new_gw
            meta_set(conn, "gateway", gw_ip or "")
            log_event(conn, now, "gateway", gw_ip or "")
            print(f"[{datetime.now(timezone.utc).isoformat()}] gateway changed -> {gw_ip}", flush=True)
        up, latency, target = check_connectivity(targets, timeout_s)   # confirmed (retry burst on failure)
        gw = True if up else probe_gateway(gw_ip)     # internet up => LAN up
        net_cause = None if up else classify_net_cause(gw)

        # DNS is a separate signal, only meaningful while the line is up. When
        # the line is down, DNS fails too and is covered by the net outage, so
        # close any open DNS outage and record dns as unknown for this cycle.
        if up:
            dns_ok = probe_dns()
        else:
            dns_ok = None
            record_transition(conn, now, "dns", went_up=True)

        # OR IGNORE, never REPLACE: if a clock anomaly slips past the guards above, an
        # already-recorded row must win - history is never silently overwritten.
        conn.execute(
            "INSERT OR IGNORE INTO checks (ts, up, latency_ms, gw, dns, target) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (now, 1 if up else 0, latency,
             (None if gw is None else (1 if gw else 0)),
             (None if dns_ok is None else (1 if dns_ok else 0)),
             target),
        )

        # --- connectivity (kind 'net') transitions ---
        # Alerts are captured here and SENT only after the commit below, so a notification is
        # never dispatched for a transition a crash/rollback would undo.
        # The outage state is applied EVERY cycle (record_transition is idempotent), not just
        # on flips: that self-heals the invariant "down => an open net outage exists" after a
        # mid-outage reset or manual DB edit, which previously lost the rest of the outage.
        pending_alerts = []
        transitioned = prev_up is not None and up != prev_up
        record_transition(conn, now, "net", went_up=up, cause=net_cause)
        if not up:
            # Attribute this down stretch to the cause observed THIS cycle; the outage's
            # headline cause becomes the one that dominated. Clamped so a restart into an
            # ongoing outage can't attribute the unmonitored span to one cause.
            dt = (now - prev_ts) if prev_ts is not None else interval
            dt = max(1, min(int(dt), int(gap_threshold(interval, len(targets), timeout_s))))
            tally_cause(conn, "net", net_cause, dt)
        if transitioned:
            print(f"[{datetime.now(timezone.utc).isoformat()}] "
                  f"{'RECOVERED' if up else 'OUTAGE'} cause={net_cause} latency={latency}", flush=True)
            # Recovery alert: the line just came back, so the network is available to send on.
            # (An outage-start alert can't be delivered while the internet is actually down.)
            if up and alerts["recovery"] and alerts["url"]:
                oc = last_closed_net_outage(conn)   # the outage record_transition just closed
                if oc is not None:
                    pending_alerts.append((
                        "Connection restored",
                        f"Your connection has returned after being down for {_human_dur(oc[0])}. "
                        f"Cause: {CAUSE_PHRASE.get(oc[1] or 'unknown', 'an unknown cause')}."))

        # --- DNS (kind 'dns') transitions, only while the line is up. A DNS failure means sites
        # won't load on any device even though the line is up, so it is alertable (and deliverable,
        # since the line is up). It is still kept out of the connectivity downtime math. ---
        DNS_DOWN_MSG = ("Your connection is up but DNS lookups are failing, so sites won't load on "
                        "any device until it recovers.")
        if up:
            dns_transitioned = (prev_dns is not None and dns_ok != prev_dns) \
                or (prev_dns is None and not dns_ok)
            # applied every cycle (idempotent): also closes/opens correctly after a
            # restart or manual edit left the table out of sync with reality
            record_transition(conn, now, "dns", went_up=dns_ok, cause="dns")
            if dns_transitioned:
                print(f"[{datetime.now(timezone.utc).isoformat()}] "
                      f"DNS {'OK' if dns_ok else 'FAILING'}", flush=True)
                if alerts["dns"] and alerts["url"]:
                    pending_alerts.append(("DNS recovered", "Name resolution is working again.")
                                          if dns_ok else ("DNS failing", DNS_DOWN_MSG))

        # --- hourly retention trim + tiered compaction ---
        if now - last_trim >= 3600:
            trim_old_checks(conn, now, cfg_retention_days(conn))
            trim_old_outages(conn, now, cfg_outage_retention(conn))
            compact_old_checks(conn, now)
            meta_set(conn, "last_trim_ts", now)
            last_trim = now

        conn.commit()
        # Alerts fire only after their event is durably committed.
        for _title, _message in pending_alerts:
            send_alert(alerts["url"], alerts["type"], _title, _message)
        prev_up = up
        prev_dns = dns_ok if up else None      # re-baseline DNS after a line outage
        prev_ts = now
        _sleep_interval(cycle_start, interval)

    log_event(conn, _now(), "stop"); conn.commit()
    conn.close()
    print(f"[{datetime.now(timezone.utc).isoformat()}] monitor stopped", flush=True)


if __name__ == "__main__":
    main()

