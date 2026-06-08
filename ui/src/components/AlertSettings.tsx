import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Bell, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import type { AlertConfig } from "@/lib/types"

const post = (p: string, body: unknown) =>
  fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

const TYPES = [
  { v: "ntfy", label: "ntfy" },
  { v: "discord", label: "Discord" },
  { v: "webhook", label: "Webhook" },
]
const PLACEHOLDER: Record<string, string> = {
  ntfy: "https://ntfy.sh/your-topic",
  discord: "https://discord.com/api/webhooks/...",
  webhook: "https://example.com/hook",
}

// Notification settings. Channel-agnostic: ntfy (free, no account), a Discord webhook, or any
// generic JSON webhook. The monitor sends recovery alerts (deliverable, since the line is back)
// and, optionally, sustained "slow connection" alerts.
export function AlertSettings({ alerts, onSaved }: { alerts: AlertConfig; onSaved: () => void }) {
  const [type, setType] = useState(alerts.type || "ntfy")
  const [url, setUrl] = useState(alerts.url || "")
  const [recovery, setRecovery] = useState(alerts.recovery)
  const [degraded, setDegraded] = useState(alerts.degraded)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  // Re-sync if the server values change underneath us (another tab, a poll refresh).
  useEffect(() => {
    setType(alerts.type || "ntfy"); setUrl(alerts.url || "")
    setRecovery(alerts.recovery); setDegraded(alerts.degraded)
  }, [alerts.type, alerts.url, alerts.recovery, alerts.degraded])

  const persist = () => post("/api/alerts", { type, url: url.trim(), recovery, degraded })

  const save = async () => {
    setSaving(true)
    const res = await persist()
    setSaving(false)
    if (res.ok) { toast.success(url.trim() ? "Alerts saved" : "Alerts turned off"); onSaved() }
    else toast.error("Could not save alerts: " + (await res.text()))
  }
  const test = async () => {
    if (!url.trim()) { toast.error("Add a notification URL first"); return }
    setTesting(true)
    await persist()                        // save first so the test uses the current URL
    const res = await post("/api/alert/test", {})
    setTesting(false)
    const body = await res.json().catch(() => ({}))
    if (res.ok && body.ok) { toast.success("Test alert sent. Check your device."); onSaved() }
    else toast.error("Test failed" + (body.error ? ": " + body.error : ""))
  }

  return (
    <div className="space-y-2.5 text-xs">
      <div className="flex items-center gap-2">
        <Bell className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground">Notify me when the connection changes</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={type} onChange={(e) => setType(e.target.value)} style={{ colorScheme: "dark" }}
          className="cursor-pointer rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs outline-none transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {TYPES.map((o) => (
            <option key={o.v} value={o.v} style={{ backgroundColor: "var(--popover)", color: "var(--popover-foreground)" }}>{o.label}</option>
          ))}
        </select>
        <Input
          value={url} onChange={(e) => setUrl(e.target.value)} placeholder={PLACEHOLDER[type]}
          autoComplete="off" spellCheck={false} inputMode="url"
          className="h-8 min-w-[11rem] flex-1 font-mono text-xs"
        />
      </div>
      <label className="flex cursor-pointer items-center justify-between gap-3 py-0.5">
        <span className="text-muted-foreground">Outage recovery (back online)</span>
        <Switch checked={recovery} onCheckedChange={(v) => setRecovery(!!v)} />
      </label>
      <label className="flex cursor-pointer items-center justify-between gap-3 py-0.5">
        <span className="text-muted-foreground">Brownout (connection up but very slow)</span>
        <Switch checked={degraded} onCheckedChange={(v) => setDegraded(!!v)} />
      </label>
      <div className="flex gap-2 pt-0.5">
        <Button size="sm" variant="secondary" className="flex-1" disabled={saving} onClick={save}>
          {saving ? "Saving..." : "Save alerts"}
        </Button>
        <Button size="sm" variant="outline" disabled={testing || !url.trim()} onClick={test}>
          <Send className="size-3.5" />{testing ? "Sending" : "Test"}
        </Button>
      </div>
      <p className="text-[0.7rem] leading-relaxed text-muted-foreground/70">
        Recovery alerts fire when the internet comes back (an alert can't be delivered while it's actually down).
        ntfy is free and needs no account: install the ntfy app, pick any topic name, and use
        {" "}<span className="font-mono">https://ntfy.sh/your-topic</span>.
      </p>
    </div>
  )
}
