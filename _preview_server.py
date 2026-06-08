import os
BASE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("UPTIME_DB", os.path.join(BASE, "uptime_test.db"))
os.environ.setdefault("UPTIME_PORT", "8099")
os.environ.setdefault("UPTIME_INTERVAL", "120")  # matches the synthetic seed cadence
import dashboard
dashboard.main()
