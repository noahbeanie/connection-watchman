import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { AlertConfig } from "@/lib/types"

const post = (p: string, body: unknown) =>
  fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

const TYPES = [
  { v: "discord", label: "Discord" },
  { v: "webhook", label: "Webhook" },
]
const PLACEHOLDER: Record<string, string> = {
  discord: "https://discord.com/api/webhooks/...",
  webhook: "https://example.com/hook",
}

// Recovery notifications: ping a Discord channel webhook (or any generic JSON webhook) when the
// connection comes back after an outage. A recovery alert is always deliverable, because the line
// is back by the time it sends.
export function AlertSettings({ alerts, onSaved }: { alerts: AlertConfig; onSaved: () => void }) {
  const [type, setType] = useState(alerts.type === "webhook" ? "webhook" : "discord")
  const [url, setUrl] = useState(alerts.url || "")
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    setType(alerts.type === "webhook" ? "webhook" : "discord")
    setUrl(alerts.url || "")
  }, [alerts.type, alerts.url])

  // Recovery is the only alert now, so it's always on when a URL is set; degraded/brownout off.
  const persist = () => post("/api/alerts", { type, url: url.trim(), recovery: true, degraded: false })

  const save = async () => {
    setSaving(true)
    const res = await persist()
    setSaving(false)
    if (res.ok) { toast.success(url.trim() ? "Notifications saved" : "Notifications turned off"); onSaved() }
    else toast.error("Could not save: " + (await res.text()))
  }
  const test = async () => {
    if (!url.trim()) { toast.error("Add a webhook URL first"); return }
    setTesting(true)
    await persist()                        // save first so the test uses the current URL
    const res = await post("/api/alert/test", {})
    setTesting(false)
    const body = await res.json().catch(() => ({}))
    if (res.ok && body.ok) { toast.success("Test sent. Check your channel.") }
    else toast.error("Test failed" + (body.error ? ": " + body.error : ""))
  }

  return (
    <div className="space-y-2.5 text-xs">
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
      <div className="flex gap-2 pt-0.5">
        <Button size="sm" variant="secondary" className="flex-1" disabled={saving} onClick={save}>
          {saving ? "Saving..." : "Save"}
        </Button>
        <Button size="sm" variant="outline" disabled={testing || !url.trim()} onClick={test}>
          <Send className="size-3.5" />{testing ? "Sending" : "Test"}
        </Button>
      </div>
      <p className="text-[0.7rem] leading-relaxed text-muted-foreground/70">
        {type === "discord"
          ? "Paste a Discord channel webhook URL (Server Settings -> Integrations -> Webhooks). Test sends a sample message to that channel."
          : "Any endpoint; it receives a JSON POST { \"title\", \"message\" }. To try it, point it at a receiver like webhook.site and hit Test."}
      </p>
    </div>
  )
}
