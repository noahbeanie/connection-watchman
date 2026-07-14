"""Data-quality regression tests for outage detection (monitor.py) and reporting
(dashboard.py). Pure stdlib; every test runs on an in-memory SQLite DB and never
touches the network.

Run from the repo root:  python -m unittest discover -s tests -v
"""
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dashboard
import monitor


def fresh_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    monitor.init_db(conn)
    return conn


class GapThresholdTest(unittest.TestCase):
    def test_budget_scales_with_live_response_cutoff(self):
        """At a 3s cutoff a fully failing confirmed cycle runs ~75s+; the gap threshold
        must stay above it or every failing cycle logs a phantom gap that reclassifies
        the outage's downtime as no-data."""
        n_targets, cutoff = 6, 3.0
        worst_cycle = (n_targets * cutoff) * (1 + monitor.CONFIRM_RETRIES) \
            + monitor.CONFIRM_RETRIES * monitor.RETRY_GAP \
            + len(monitor.GATEWAY_PORTS) * monitor.GW_TIMEOUT
        self.assertGreater(monitor.gap_threshold(5, n_targets, cutoff), worst_cycle)

    def test_budget_scales_with_target_count(self):
        self.assertGreater(monitor.gap_threshold(5, 16, 3.0), monitor.gap_threshold(5, 6, 3.0))


class TransitionTest(unittest.TestCase):
    def test_duration_clamped_at_zero(self):
        """A clock anomaly must never store a negative outage duration."""
        conn = fresh_conn()
        monitor.record_transition(conn, 1000, "net", went_up=False, cause="isp")
        monitor.record_transition(conn, 900, "net", went_up=True)
        dur = conn.execute("SELECT duration_s FROM outages").fetchone()[0]
        self.assertEqual(dur, 0)

    def test_idempotent_self_heal_after_reset(self):
        """Applying the down state every cycle reopens an outage a mid-outage DB reset
        wiped, instead of losing the rest of the outage."""
        conn = fresh_conn()
        monitor.record_transition(conn, 1000, "net", went_up=False, cause="isp")
        conn.execute("DELETE FROM outages")                      # the reset
        monitor.record_transition(conn, 1010, "net", went_up=False, cause="isp")
        rows = conn.execute("SELECT start_ts, end_ts FROM outages").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["start_ts"], 1010)
        self.assertIsNone(rows[0]["end_ts"])
        # and applying it again does NOT open a second one
        monitor.record_transition(conn, 1020, "net", went_up=False, cause="isp")
        self.assertEqual(conn.execute("SELECT COUNT(*) c FROM outages").fetchone()["c"], 1)


class CauseTallyTest(unittest.TestCase):
    def test_dominant_cause_wins(self):
        """A brief local blip inside a long ISP outage must not relabel it 'local'."""
        conn = fresh_conn()
        monitor.record_transition(conn, 1000, "net", went_up=False, cause="isp")
        monitor.tally_cause(conn, "net", "isp", 60)
        monitor.tally_cause(conn, "net", "isp", 60)
        monitor.tally_cause(conn, "net", "local", 10)   # router power-cycled for a moment
        row = conn.execute("SELECT cause, causes FROM outages").fetchone()
        self.assertEqual(row["cause"], "isp")
        self.assertEqual(json.loads(row["causes"]), {"isp": 120, "local": 10})

    def test_cause_flips_when_local_dominates(self):
        conn = fresh_conn()
        monitor.record_transition(conn, 1000, "net", went_up=False, cause="isp")
        monitor.tally_cause(conn, "net", "isp", 30)
        monitor.tally_cause(conn, "net", "local", 300)
        self.assertEqual(conn.execute("SELECT cause FROM outages").fetchone()["cause"], "local")


class BuildRangeTest(unittest.TestCase):
    def test_future_end_clamped(self):
        """Unmonitored future time must not enter the availability denominator."""
        conn = fresh_conn()
        now = int(time.time())
        for ts in range(now - 3600, now, 10):
            conn.execute("INSERT INTO checks (ts, up, latency_ms) VALUES (?, 1, 20)", (ts,))
        data = dashboard.build_range(conn, now - 3600, now + 86400)
        self.assertLessEqual(data["end"], now)
        self.assertLessEqual(data["summary"]["monitored_seconds"], 3600)

    def test_boundary_zero_overlap_outage_not_counted(self):
        """An outage ending exactly at the range edge belongs to the adjacent range."""
        conn = fresh_conn()
        now = int(time.time())
        t0 = now - 600
        conn.execute("INSERT INTO outages (start_ts, end_ts, duration_s, cause, kind) "
                     "VALUES (?, ?, 100, 'isp', 'net')", (t0 - 100, t0))
        after = dashboard.build_range(conn, t0, now)["summary"]
        before = dashboard.build_range(conn, t0 - 300, t0)["summary"]
        self.assertEqual(after["outage_count"], 0)
        self.assertEqual(before["outage_count"], 1)

    def test_gap_event_after_range_end_still_clips_in(self):
        """Gap events are stamped at the gap's END; one landing after the window must
        still contribute its in-window span (else that span counts as monitored-up)."""
        conn = fresh_conn()
        now = int(time.time())
        start, end = now - 1000, now - 500
        # monitor was off (end-50 .. end+50): event stamped at end+50, span 100s back
        conn.execute("INSERT INTO events (ts, kind, detail) VALUES (?, 'gap', '100')",
                     (end + 50,))
        s = dashboard.build_range(conn, start, end)["summary"]
        self.assertEqual(s["gap_seconds"], 50)
        self.assertEqual(s["monitored_seconds"], 450)

    def test_mttr_per_kind_and_gap_corrected(self):
        conn = fresh_conn()
        now = int(time.time())
        start = now - 2000
        o = "INSERT INTO outages (start_ts, end_ts, duration_s, cause, kind) VALUES (?,?,?,?,?)"
        conn.execute(o, (now - 1900, now - 1800, 100, "isp", "net"))       # clean 100s
        conn.execute(o, (now - 1000, now - 800, 200, "isp", "net"))        # 200s, 120s unmonitored
        conn.execute("INSERT INTO events (ts, kind, detail) VALUES (?, 'gap', '120')",
                     (now - 850,))                                          # span now-970..now-850
        conn.execute(o, (now - 500, now - 460, 40, "dns", "dns"))          # DNS 40s
        s = dashboard.build_range(conn, start, now)["summary"]
        self.assertAlmostEqual(s["mttr_net_s"], 90.0)    # (100 + (200-120)) / 2
        self.assertAlmostEqual(s["mttr_dns_s"], 40.0)
        self.assertEqual(s["net_events"], 2)
        self.assertEqual(s["dns_events"], 1)
        self.assertEqual(s["longest_net_s"], 200)        # raw, matches the log rows
        self.assertEqual(s["last_net_outage_start"], now - 1000)
        self.assertEqual(s["last_outage_start"], now - 500)

    def test_dns_counts_toward_downtime(self):
        conn = fresh_conn()
        now = int(time.time())
        conn.execute("INSERT INTO outages (start_ts, end_ts, duration_s, cause, kind) "
                     "VALUES (?, ?, 60, 'dns', 'dns')", (now - 300, now - 240))
        s = dashboard.build_range(conn, now - 600, now)["summary"]
        self.assertEqual(s["down_seconds"], 60)
        self.assertEqual(s["dns_seconds"], 60)


class LiveStreakTest(unittest.TestCase):
    def test_streak_clamped_by_gap_event(self):
        """'Current uptime' is a claim of continuous observation: it must not bridge a
        span where the monitor wasn't running."""
        conn = fresh_conn()
        now = int(time.time())
        for ts in range(now - 1000, now + 1, 10):
            conn.execute("INSERT INTO checks (ts, up, latency_ms) VALUES (?, 1, 20)", (ts,))
        conn.execute("INSERT INTO events (ts, kind, detail) VALUES (?, 'gap', '200')",
                     (now - 300,))
        live = dashboard.get_live(conn, now)
        self.assertEqual(live["status"], "up")
        self.assertLessEqual(live["streak_seconds"], 300)


class PauseReconcileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.orig_pause = monitor.PAUSE_FILE
        monitor.PAUSE_FILE = os.path.join(self.tmp, "PAUSED")

    def tearDown(self):
        monitor.PAUSE_FILE = self.orig_pause

    def test_dangling_pause_closed_at_startup(self):
        """Unpause-while-down must not leave everything since counted as paused."""
        conn = fresh_conn()
        now = int(time.time())
        monitor.log_event(conn, now - 5000, "pause")
        monitor.reconcile_pause_state(conn, now)        # no PAUSE_FILE: not paused anymore
        last = conn.execute("SELECT ts, kind FROM events ORDER BY ts DESC, id DESC").fetchone()
        self.assertEqual(last["kind"], "resume")

    def test_elapsed_timed_pause_resumes_at_expiry(self):
        conn = fresh_conn()
        now = int(time.time())
        monitor.log_event(conn, now - 5000, "pause")
        with open(monitor.PAUSE_FILE, "w") as f:
            f.write(str(now - 100))                     # expired while the daemon was down
        monitor.reconcile_pause_state(conn, now)
        last = conn.execute("SELECT ts, kind FROM events ORDER BY id DESC").fetchone()
        self.assertEqual(last["kind"], "resume")
        self.assertEqual(last["ts"], now - 100)         # stamped at the true expiry
        self.assertFalse(os.path.exists(monitor.PAUSE_FILE))

    def test_active_pause_left_alone(self):
        conn = fresh_conn()
        now = int(time.time())
        monitor.log_event(conn, now - 50, "pause")
        with open(monitor.PAUSE_FILE, "w") as f:
            f.write(str(now + 600))                     # still paused
        monitor.reconcile_pause_state(conn, now)
        last = conn.execute("SELECT kind FROM events ORDER BY id DESC").fetchone()
        self.assertEqual(last["kind"], "pause")


class CompactionTest(unittest.TestCase):
    """Tiered retention: old healthy rows thin to the grid; failure evidence never does."""

    def _insert(self, conn, ts, up=1, dns=1, lat=20):
        conn.execute("INSERT INTO checks (ts, up, latency_ms, dns) VALUES (?, ?, ?, ?)",
                     (ts, up, lat, dns))

    def test_old_healthy_rows_thin_failures_survive(self):
        conn = fresh_conn()
        now = int(time.time())
        base = ((now - 3 * 86400) // monitor.COMPACT_GRID_S) * monitor.COMPACT_GRID_S
        for i in range(30):                       # 30 healthy 1s rows = two 15s grid cells
            self._insert(conn, base + i)
        self._insert(conn, base + 40, up=0, dns=None)   # connectivity failure: evidence
        self._insert(conn, base + 41, up=1, dns=0)      # DNS failure: evidence
        for i in range(5):                        # recent rows: inside the full-res window
            self._insert(conn, now - 100 + i)
        monitor.compact_old_checks(conn, now)
        old_healthy = conn.execute(
            "SELECT ts FROM checks WHERE ts < ? AND up=1 AND (dns IS NULL OR dns != 0) ORDER BY ts",
            (now - 86400,)).fetchall()
        self.assertEqual([r["ts"] for r in old_healthy],
                         [base, base + monitor.COMPACT_GRID_S])   # first of each grid cell
        kept = conn.execute("SELECT COUNT(*) c FROM checks WHERE up=0 OR dns=0").fetchone()["c"]
        self.assertEqual(kept, 2)                 # both failure rows untouched
        recent = conn.execute("SELECT COUNT(*) c FROM checks WHERE ts >= ?",
                              (now - 200,)).fetchone()["c"]
        self.assertEqual(recent, 5)               # full-res window untouched

    def test_incremental_high_water_mark(self):
        conn = fresh_conn()
        now = int(time.time())
        base = ((now - 3 * 86400) // monitor.COMPACT_GRID_S) * monitor.COMPACT_GRID_S
        for i in range(15):
            self._insert(conn, base + i)
        monitor.compact_old_checks(conn, now)
        first = conn.execute("SELECT COUNT(*) c FROM checks").fetchone()["c"]
        monitor.compact_old_checks(conn, now)     # immediate re-run: nothing newly aged
        self.assertEqual(conn.execute("SELECT COUNT(*) c FROM checks").fetchone()["c"], first)
        done = int(monitor.meta_get(conn, "compact_done_ts"))
        self.assertEqual(done, now - int(monitor.COMPACT_AFTER_DAYS * 86400))

    def test_disabled_when_zero_days(self):
        conn = fresh_conn()
        now = int(time.time())
        for i in range(10):
            self._insert(conn, now - 3 * 86400 + i)
        orig = monitor.COMPACT_AFTER_DAYS
        monitor.COMPACT_AFTER_DAYS = 0
        try:
            monitor.compact_old_checks(conn, now)
        finally:
            monitor.COMPACT_AFTER_DAYS = orig
        self.assertEqual(conn.execute("SELECT COUNT(*) c FROM checks").fetchone()["c"], 10)


class FirstRecordTest(unittest.TestCase):
    def test_all_time_anchors_to_oldest_record_not_oldest_check(self):
        """Check rows are trimmed by retention while outages are kept forever; 'all
        time' must not silently shrink to the retention window."""
        conn = fresh_conn()
        now = int(time.time())
        conn.execute("INSERT INTO outages (start_ts, end_ts, duration_s, cause, kind) "
                     "VALUES (?, ?, 60, 'isp', 'net')", (now - 900000, now - 899940))
        conn.execute("INSERT INTO checks (ts, up, latency_ms) VALUES (?, 1, 20)", (now - 100,))
        self.assertEqual(dashboard.first_record_ts(conn), now - 900000)


class SpeedTestRateTest(unittest.TestCase):
    """Rate math for the throughput measurement (no network involved)."""

    def test_slow_start_ramp_skipped(self):
        """A long test's rate comes from the post-ramp window: counting the first
        second's TCP slow start would systematically under-read the line."""
        samples = [(0.0, 0)]
        b = 0
        for i in range(1, 161):                 # 8s of 50ms ticks
            t = i * 0.05
            b += 50_000 if t <= 1.0 else 500_000    # 1 MB/s ramp, then 10 MB/s steady
            samples.append((t, b))
        rate = monitor._st_rate(samples)
        self.assertAlmostEqual(rate, 10e6 * 8, delta=0.05 * 10e6 * 8)

    def test_idle_tail_trimmed_when_cap_exhausted(self):
        """Cap hit at 2s, sampling continues to 8s: the rate must reflect the 2s of
        actual transfer, not average the idle tail into a 4x under-read."""
        samples = [(0.0, 0)]
        for i in range(1, 161):
            t = i * 0.05
            samples.append((t, min(20_000_000, int(10_000_000 * t))))
        rate = monitor._st_rate(samples)
        self.assertAlmostEqual(rate, 10e6 * 8, delta=0.05 * 10e6 * 8)

    def test_none_when_nothing_transferred(self):
        self.assertIsNone(monitor._st_rate([(0.0, 0), (1.0, 0), (2.0, 0)]))
        self.assertIsNone(monitor._st_rate([(0.0, 0)]))

    def test_leading_idle_trimmed_after_retried_request(self):
        """A rejected-then-retried first request leaves a dead leading window; the
        rate must cover only the span where bytes flowed, not average the dead air."""
        samples = [(i * 0.05, 0) for i in range(41)]            # 2s dead (403 + retry pause)
        b = 0
        for i in range(41, 161):                                # then 6s at 10 MB/s
            b += 500_000
            samples.append((i * 0.05, b))
        rate = monitor._st_rate(samples)
        self.assertAlmostEqual(rate, 10e6 * 8, delta=0.05 * 10e6 * 8)


class SpeedTestScheduleTest(unittest.TestCase):
    def test_off_by_default(self):
        conn = fresh_conn()
        self.assertEqual(monitor.speedtest_due(conn, int(time.time())), (False, False))

    def test_period_elapsed(self):
        conn = fresh_conn()
        now = int(time.time())
        monitor.meta_set(conn, "cfg_speedtest_period_h", "8")
        self.assertEqual(monitor.speedtest_due(conn, now), (True, False))   # never ran
        monitor.meta_set(conn, "speedtest_last_ts", now - 3600)
        self.assertEqual(monitor.speedtest_due(conn, now), (False, False))  # 1h ago
        monitor.meta_set(conn, "speedtest_last_ts", now - 9 * 3600)
        self.assertEqual(monitor.speedtest_due(conn, now), (True, False))   # 9h ago

    def test_run_now_request_works_with_scheduling_off(self):
        conn = fresh_conn()
        now = int(time.time())
        monitor.meta_set(conn, "speedtest_request", now)
        self.assertEqual(monitor.speedtest_due(conn, now), (True, True))

    def test_cycle_records_row_and_consumes_request(self):
        """A run (even a failed one) must record a row, advance the schedule, and clear
        the run-now request - otherwise an unreachable endpoint retries every cycle."""
        conn = fresh_conn()
        now = int(time.time())
        monitor.meta_set(conn, "speedtest_request", now)
        orig = monitor.run_speedtest
        monitor.run_speedtest = lambda cap: {"down_bps": None, "up_bps": None, "ping_ms": None,
                                             "bytes_down": 0, "bytes_up": 0, "error": "unreachable: test"}
        try:
            monitor.run_speedtest_cycle(conn, manual=True)
        finally:
            monitor.run_speedtest = orig
        row = conn.execute("SELECT down_bps, error FROM speedtests").fetchone()
        self.assertIsNone(row["down_bps"])
        self.assertEqual(row["error"], "unreachable: test")
        self.assertIsNone(monitor.meta_get(conn, "speedtest_request"))
        self.assertIsNotNone(monitor.meta_get(conn, "speedtest_last_ts"))
        self.assertEqual(monitor.speedtest_due(conn, int(time.time())), (False, False))


class SpeedTestApiTest(unittest.TestCase):
    def _insert(self, conn, ts, down=300e6, up=20e6, error=None):
        conn.execute("INSERT INTO speedtests (ts, down_bps, up_bps, ping_ms, bytes_down, "
                     "bytes_up, error) VALUES (?, ?, ?, 12.0, 1000, 1000, ?)",
                     (ts, down, up, error))

    def test_latest_survives_a_failed_newest_attempt(self):
        """One transient failure must not blank the header until the next scheduled
        run; the failure is surfaced separately, never silently swallowed."""
        conn = fresh_conn()
        now = int(time.time())
        self._insert(conn, now - 3600)
        self._insert(conn, now - 60, down=None, up=None, error="unreachable: x")
        d = dashboard.build_speedtests(conn, now - 7200, now, now)
        self.assertEqual(d["latest"]["ts"], now - 3600)
        self.assertEqual(d["last_error"]["ts"], now - 60)
        self.assertEqual(len(d["tests"]), 2)      # the range list still holds both

    def test_pre_migration_db_tolerated(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)")
        d = dashboard.build_speedtests(conn, 0, int(time.time()), int(time.time()))
        self.assertEqual(d["tests"], [])
        self.assertIsNone(d["latest"])

    def test_pending_reflects_queued_request_and_goes_stale(self):
        conn = fresh_conn()
        now = int(time.time())
        conn.execute("INSERT INTO meta (k, v) VALUES ('speedtest_request', ?)", (str(now - 30),))
        self.assertTrue(dashboard.build_speedtests(conn, 0, now, now)["pending"])
        conn.execute("UPDATE meta SET v=? WHERE k='speedtest_request'", (str(now - 600),))
        self.assertFalse(dashboard.build_speedtests(conn, 0, now, now)["pending"])


if __name__ == "__main__":
    unittest.main()
