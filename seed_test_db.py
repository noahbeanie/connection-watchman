#!/usr/bin/env python3
"""Seed a synthetic uptime_test.db for local dashboard verification.

  python seed_test_db.py            # ~30 days, rich scenario (causes, gap, pause, ongoing)
  python seed_test_db.py --short    # only ~2h of history (to test preset greying)

NOT shipped to the Pi. A verification artifact only.
"""
import os
import random
import sqlite3
import sys
import time

random.seed(20260606)
DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uptime_test.db")
STEP = 120
SHORT = "--short" in sys.argv


def build():
    if os.path.exists(DB):
        os.remove(DB)
    c = sqlite3.connect(DB)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("CREATE TABLE checks (ts INTEGER PRIMARY KEY, up INTEGER NOT NULL, latency_ms REAL, gw INTEGER, dns INTEGER)")
    c.execute("CREATE TABLE outages (id INTEGER PRIMARY KEY AUTOINCREMENT, start_ts INTEGER NOT NULL, end_ts INTEGER, duration_s INTEGER, cause TEXT, kind TEXT)")
    c.execute("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT)")
    c.execute("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)")
    c.executemany("INSERT INTO meta VALUES (?,?)", [("schema_version", "3"), ("gateway", "192.168.68.1")])

    now = int(time.time())
    span_days = 0.083 if SHORT else 30
    start = now - int(span_days * 86400)

    # outage spans: (s, e_or_None, up, gw, dns, cause, kind)
    #   kind 'net' = connectivity (counts toward uptime)
    #   kind 'dns' = name-resolution signal (up=1 throughout, never counts as downtime)
    outages, gaps, pauses = [], [], []
    if not SHORT:
        outages = [
            (now - 12 * 3600, now - 12 * 3600 + 1200, 0, 1, 0, "isp", "net"),    # ISP: router up, net down
            (now - 9 * 3600,  now - 9 * 3600 + 180,   1, 1, 0, "dns", "dns"),    # DNS hiccup 1
            (now - 6 * 3600,  now - 6 * 3600 + 300,   0, 0, 0, "local", "net"),  # LOCAL: gateway down too
            (now - 2 * 3600,  now - 2 * 3600 + 600,   1, 1, 0, "dns", "dns"),    # DNS hiccup 2
            (now - 300,       None,                   0, 1, 0, "isp", "net"),    # ONGOING connectivity
        ]
        gaps = [(now - 5 * 86400, now - 5 * 86400 + 6 * 3600)]             # 6h reboot gap
        pauses = [(now - 7 * 86400, now - 7 * 86400 + 2 * 3600)]          # 2h paused

    def span_of(t):
        for (s, e, up, gw, dns, cause, kind) in outages:
            if (e is None and t >= s) or (e is not None and s <= t < e):
                return (up, gw, dns)
        return None

    def skipped(t):
        for s, e in gaps + pauses:
            if s <= t < e:
                return True
        return False

    rows = []
    base = 28.0
    t = start
    while t <= now:
        if skipped(t):
            t += STEP
            continue
        sp = span_of(t)
        if sp is not None:
            up, gw, dns = sp
            lat = None if up == 0 else round(base + random.uniform(-4, 4), 1)
        else:
            up, gw, dns = 1, 1, 1
            base += random.uniform(-2, 2); base = max(14, min(60, base))
            lat = round(base + random.uniform(-3, 3), 1)
        rows.append((t, up, lat, gw, dns))
        t += STEP
    c.executemany("INSERT INTO checks VALUES (?,?,?,?,?)", rows)

    for (s, e, up, gw, dns, cause, kind) in outages:
        dur = None if e is None else e - s
        c.execute("INSERT INTO outages (start_ts, end_ts, duration_s, cause, kind) VALUES (?,?,?,?,?)",
                  (s, e, dur, cause, kind))

    c.execute("INSERT INTO events (ts, kind, detail) VALUES (?, 'start', 'seed')", (start,))
    for s, e in gaps:
        c.execute("INSERT INTO events (ts, kind, detail) VALUES (?, 'gap', ?)", (e, str(e - s)))
    for s, e in pauses:
        c.execute("INSERT INTO events (ts, kind, detail) VALUES (?, 'pause', NULL)", (s,))
        c.execute("INSERT INTO events (ts, kind, detail) VALUES (?, 'resume', NULL)", (e,))

    c.commit()
    net = sum(1 for o in outages if o[6] == "net")
    dns = sum(1 for o in outages if o[6] == "dns")
    print(f"seeded {len(rows)} checks, {net} net + {dns} dns outages, "
          f"{len(gaps)} gaps, {len(pauses)} pauses over {span_days:g} days "
          f"({'short' if SHORT else 'rich'})")
    c.close()


if __name__ == "__main__":
    build()
