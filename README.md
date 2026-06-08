# Connection Watchman

A tiny, self-contained tool that runs 24/7 on any always-on computer, logs every
internet connectivity check to a database, and serves a live mobile-friendly
dashboard so you can see exactly how often (and why) your connection drops.

- **Zero dependencies.** Pure Python 3 standard library. No `pip install`,
  no virtualenv, nothing to break.
- **Works offline.** The dashboard is inline SVG (no internet CDN), so it loads
  fine *during* an outage when you most want to look at it.
- **Survives reboots & crashes.** Runs as two always-on background services (systemd on
  Linux, launchd on macOS, Scheduled Tasks on Windows) with auto-restart.

## Install

One command sets up the monitor + dashboard as always-on background services that start
on boot. The backend is pure Python 3 standard library, so there is nothing to
`pip install`.

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/noahbeanie/connection-watchman/main/install.sh | bash
```

**Windows** (in an **administrator** PowerShell):

```powershell
irm https://raw.githubusercontent.com/noahbeanie/connection-watchman/main/install.ps1 | iex
```

When it finishes, the installer prints the exact dashboard URLs in your terminal: open the
"this device" one, or from another device on your network use
**`http://<hostname>.local:8080`** (e.g. `myserver.local:8080`). Bookmark the `.local`
address: it keeps working even if the device's IP later changes. The port is chosen once at
install (8080, or the next free port if 8080 is taken) and never changes afterward.

Prerequisites: Python 3 (already present on macOS and Linux; on Windows the installer
fetches it via `winget` if missing). The Linux and macOS installers use `sudo` once to
register the boot services; the Windows installer needs an admin shell.

You can also clone the repo and run the installer locally (`bash install.sh` on
Linux/macOS, `.\install.ps1` on Windows). Uninstall any time with `bash uninstall.sh`
(Linux/macOS) or `.\uninstall.ps1` (admin PowerShell); your `uptime.db` is left in place.

### Running it 24/7 (and what happens on sleep)

The monitor only records checks while the host is awake. If the computer **sleeps**, both
services are suspended and that stretch shows on the dashboard as grey "no data" (never as
downtime, and it is excluded from the uptime math); monitoring resumes automatically on
wake. For continuous monitoring, run it on a device that stays on. A dedicated always-on
machine (a mini PC, NAS, or home server) is ideal: it never sleeps and sips power. On a
laptop you will simply see gaps whenever it is asleep.

## How it decides "up" vs "down" (and the cause)

Every `UPTIME_INTERVAL` seconds (default 15s) the monitor measures two things:

1. **Connectivity** (the headline "uptime") — opens a TCP connection to several
   public IPs (Cloudflare `1.1.1.1`, Google `8.8.8.8`, Quad9 `9.9.9.9`) on **both
   port 443 and port 53**. Up if **any** answers. Trying 443 (what real traffic
   like a video stream uses) alongside 53 across three providers means a router or
   ISP briefly blocking one port to these IPs is not logged as your outage.
   Latency = the connect that answered. TCP-connect is used instead of ICMP ping
   because it needs no root and isn't blocked/rate-limited. **A failed check is
   retried several times over a few seconds before it counts as down**, so a
   single dropped packet (or one bad port) is never an outage. A server must also
   answer within the **response cutoff** (a dashboard setting, default 1 second):
   a connection that is technically reachable but too slow to respond counts as
   down, so a severe slowdown registers as a real outage instead of looking "up".
2. **DNS** (a *separate* signal that does **not** affect the uptime score) — can a
   name be resolved? Checked first via the system resolver (what your devices
   use, usually the router) and, if that fails, directly against several
   independent public resolvers before DNS is declared down. This stops a flaky
   router DNS forwarder from masquerading as an internet outage. DNS is only
   evaluated while connectivity is up.
3. **Gateway** — a TCP connect to your LAN router, only probed *when connectivity
   fails*, to classify the cause (if the internet is up the router is necessarily
   reachable, so the probe is skipped).

Connectivity down-stretches are recorded as outages with a classified **cause**:

| Cause | Meaning |
|-------|---------|
| `local` | The LAN/router itself is unreachable: your equipment or this machine. |
| `isp`   | The router is fine but the internet is not: your ISP / the WAN. |
| `unknown` | Couldn't determine (e.g. gateway IP not known). |

While an outage is open, the cause widens toward the most serious thing observed.
**DNS problems are tracked as their own signal** (shown separately on the
dashboard, never counted as downtime).

## How downtime & uptime are measured (and why you can trust it)

- **Outages** are exact: each one stores its real start and recovery time, so
  durations in the table and the red blocks on the chart are precise (not
  bucket-estimates).
- **Availability %** is connectivity only, computed as `(monitored time − outage
  time) / monitored time`. Crucially, **monitoring gaps count as neither up nor
  down.** If the machine reboots or you pause monitoring, that span is excluded
  from the math instead of silently inflating uptime (the old `up_checks /
  total_checks` approach had that bug). A gap is only declared when the time
  between checks exceeds the worst-case probe time, so a slow cycle during an
  outage is never mistaken for missing data (which would otherwise mask the
  outage). Gaps are recorded as events and drawn in grey on the timeline.
- **DNS is a separate signal** and is never counted as downtime; it is summarised
  on its own in the dashboard.
- A separate sample-based percentage is also kept for reference.

## What you'll see on the dashboard

- **A radial uptime gauge** for the selected range, graded Excellent / Good / Fair /
  Poor so a glance tells you whether the number is healthy (not just what it is).
- **A latency area chart** (lower is faster) with a shaded "slow" zone above your
  degraded threshold, red bands over outages, and amber bands over brownouts.
- **A status-page tracker bar**: green where connectivity was up, amber for partial,
  red where it dropped, grey for no-data gaps. Hover any segment for its uptime,
  cause, and latency.
- **KPI tiles** for the selected range: current uptime streak, downtime, time spent
  slow-but-up, and the connectivity outage count.
- **Outages for the selected range** (the list follows the range you pick) with a
  hover legend explaining each cause, per-outage notes and delete. **Brownouts** (the
  line stayed up but was severely slow for a sustained stretch) appear here in amber as
  their own events, and never count as downtime. A separate **DNS** panel reports
  name-resolution hiccups, also never counted as downtime.
- **Range buttons** (1H / 6H / 24H / 7D / 30D / 6M / 1Y / All) and a custom date range.
  Ranges longer than your recorded history are greyed out; on first load the longest
  available range is auto-selected.
- **A printable report** of the selected period's outages, to save as PDF or hand to
  your ISP.
- **Data & tools**: live database size, configurable check interval / retention / slow
  threshold, notifications, custom probe targets, CSV export, pause (timed or until you
  resume), and a guarded "reset all data".

## Notifications (optional)

By default the dashboard just logs. Turn on alerts under **Data & tools -> Alerts** to be
told when things change. Pick a channel and paste its URL:

- **ntfy** (free, no account): install the ntfy app, pick any topic name, and use
  `https://ntfy.sh/your-topic`.
- **Discord**: a channel webhook URL.
- **Webhook**: any endpoint; it receives `{"title", "message"}` as JSON.

Two alert types, each independently toggleable:

- **Outage recovery** (on by default): sent when the internet comes back, with the outage's
  duration and cause. A recovery alert is always deliverable, because the connection is back
  by the time it sends. (An alert cannot be delivered *while* the internet is actually down,
  which is why there is no "you are down right now" alert from a single box.)
- **Slow connection** (off by default): sent when latency stays above your slow threshold for
  several checks in a row, and again when it returns to normal.

Use **Test** to fire a sample notification and confirm the channel works. Everything runs on
the Python standard library, so there is still nothing to `pip install`.

## Custom targets (optional)

"Up" means *any* reachability target answered. The defaults are Cloudflare, Google, and Quad9
on ports 443 and 53. Under **Data & tools -> Targets** you can replace them with your own
`host:port` list (for example, to also watch a specific service you care about) or reset to the
defaults. The monitor picks up changes within a cycle.

## Files

| File | What it does |
|------|--------------|
| `monitor.py`               | The logging daemon. Probes, classifies causes, writes `uptime.db`. |
| `dashboard.py`             | The web server. Reads the DB, serves the dashboard + JSON API. |
| `web/`                     | The built dashboard UI (React + shadcn, bundled, offline-capable). Served by `dashboard.py`. |
| `ui/`                      | Dashboard UI source (Vite + React + TypeScript). Dev only, not deployed. |
| `templates/dashboard.html` | Legacy single-file UI, served only as a fallback if `web/` is missing. |
| `install.sh` / `install.ps1` | Set up the always-on services with your paths baked in (Linux/macOS, Windows). |
| `uptime-*.service`         | Reference systemd unit files (the installer generates real ones). |
| `seed_test_db.py`          | Dev only, builds a synthetic DB for local UI testing. Not deployed. |

## Upgrading an existing install

The schema changes are additive and applied automatically on startup, so no data
is lost. **Restart the monitor first** (it migrates the database), then the
dashboard:

```bash
sudo systemctl restart uptime-monitor    # runs the additive migration
sudo systemctl restart uptime-dashboard
```

## Day-to-day commands

```bash
systemctl status uptime-monitor      # is the logger running?
systemctl status uptime-dashboard    # is the web UI running?
journalctl -u uptime-monitor -f      # watch outages + causes live
```

Stop: `sudo systemctl stop uptime-monitor uptime-dashboard`.
You can also pause/resume from the dashboard's **Data & tools** panel (it leaves
a `PAUSED` file in the project dir; paused spans show as grey no-data, never as
downtime). A pause can be timed (one hour, four hours, or a day) and resumes on its
own, or indefinite until you click Resume.

## Tuning (optional)

Edit the `Environment=` lines in `/etc/systemd/system/uptime-monitor.service`,
then `sudo systemctl daemon-reload && sudo systemctl restart uptime-monitor`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `UPTIME_INTERVAL` | `15`    | Seconds between checks. Lower = finer detail, more rows. |
| `UPTIME_TIMEOUT`  | `1.5`   | Upper bound for a connect attempt (seconds), used for internal timing. The live **response cutoff** (how fast a server must answer to count as up; default 1.0s) is set in the dashboard under Data & tools. |
| `UPTIME_CONFIRM_RETRIES` | `3` | Extra connectivity re-checks before a cycle counts as down (debounce). |
| `UPTIME_RETRY_GAP` | `1`    | Seconds between those confirmation re-checks. |
| `UPTIME_DEGRADED_MS` | `250` | Latency (ms) over which a check counts as "slow but up". `0` disables the slow signal. Also settable in the dashboard. |
| `UPTIME_BROWNOUT_MS` | `750` | Sustained latency (ms) above which the connection is logged as a "brownout" event (up but very slow). `0` disables it. Also settable in the dashboard. |
| `UPTIME_GATEWAY`  | *(auto)* | Your router's IP, used for the cause probe. Auto-discovered from the default route; set it explicitly (e.g. `192.168.68.1`) if discovery is wrong (multiple interfaces / VPN). |
| `UPTIME_DNS_HOST` | `example.com` | Name resolved for the DNS probe. |
| `UPTIME_RETENTION_DAYS` | `365` | Raw per-check rows older than this are trimmed hourly. |
| `UPTIME_PORT`     | `8080`  | Dashboard web port. |
| `UPTIME_DB`       | `./uptime.db` | Where the log lives. |
| `UPTIME_FWMARK`   | `0` (off) | Firewall mark applied to probe sockets so they bypass a VPN running on this machine and test your **direct** link (see below). Needs `CAP_NET_ADMIN`. |

### Running on a machine that also runs a VPN

If the monitoring machine runs a always-on VPN (WireGuard, NordVPN/NordLynx, etc.), its
policy routing usually forces *all* outbound traffic, including the connectivity probe, through
the tunnel. The monitor then measures "is the internet reachable via the VPN," which can stay up
through Nord's servers even when your real connection (the path your other devices use) is down,
so genuine outages get missed.

To make the probe test the **direct** path instead, give it the VPN's bypass mark. For NordVPN
(NordLynx) the mark is `0xe1f1`; add a systemd drop-in:

```bash
sudo mkdir -p /etc/systemd/system/uptime-monitor.service.d
printf '[Service]\nAmbientCapabilities=CAP_NET_ADMIN\nEnvironment=UPTIME_FWMARK=0xe1f1\n' \
  | sudo tee /etc/systemd/system/uptime-monitor.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart uptime-monitor
```

Confirm it worked: probe latency should drop to your normal direct figure (the VPN's extra hop
disappears). Find your VPN's mark with `ip rule show` (look for the `lookup <table>` rule the VPN
adds). Your other (non-probe) traffic stays on the VPN.

## Database size

At the default 15-second interval the raw `checks` log grows roughly **0.5 MB/day**
(~15 MB/month). With the default 365-day retention the file plateaus **under
~200 MB**, trivial even on a small device, because rows older than the retention
window are deleted hourly. The **outage and event history is kept forever** (it's
tiny). The live size is shown in the dashboard's Data & tools panel.

Note: trimming frees space *inside* the database file for reuse but doesn't shrink
the file on disk; the "Reset all data" tool runs a `VACUUM` to reclaim it. To keep
less history, lower `UPTIME_RETENTION_DAYS`.
</content>
