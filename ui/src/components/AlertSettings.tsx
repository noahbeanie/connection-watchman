import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Save as SaveIcon, Send } from "lucide-react"
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
    await persist()
    const res = await post("/api/alert/test", {})
    setTesting(false)
    const body = await res.json().catch(() => ({}))
    if (res.ok && body.ok) { toast.success("Test sent. Check your channel.") }
    else toast.error("Test failed" + (body.error ? ": " + body.error : ""))
  }

  return (
    <div className="space-y-2.5 text-xs">
      {/* Title with the channel toggle (two buttons) on the right of the same row. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="text-[0.95rem] font-semibold tracking-tight">Notify me when my connection returns</h2>
        <div className="inline-flex shrink-0 rounded-md border border-border bg-muted/30 p-0.5">
          {TYPES.map((o) => (
            <button
              key={o.v} type="button" onClick={() => setType(o.v)}
              className={`rounded px-2.5 py-1 font-medium transition ${type === o.v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <Input
        value={url} onChange={(e) => setUrl(e.target.value)} placeholder={PLACEHOLDER[type]}
        autoComplete="off" spellCheck={false} inputMode="url"
        className="h-8 w-full font-mono text-xs"
      />
      <div className="flex gap-2 pt-0.5">
        <Button size="sm" variant="secondary" disabled={saving} onClick={save}>
          <SaveIcon className="size-3.5" />{saving ? "Saving..." : "Save"}
        </Button>
        <Button size="sm" variant="outline" disabled={testing || !url.trim()} onClick={test}>
          <Send className="size-3.5" />{testing ? "Sending" : "Test"}
        </Button>
      </div>
      {/* Both hints share one grid cell, so the tile keeps the height of the taller hint and
          doesn't jump when you toggle between Discord and Webhook. */}
      <div className="grid text-[0.7rem] leading-relaxed text-muted-foreground/70">
        <p className={`col-start-1 row-start-1 ${type === "discord" ? "" : "invisible"}`}>
          {"Paste a Discord channel webhook URL (Server Settings -> Integrations -> Webhooks). Test sends a sample message to that channel."}
        </p>
        <p className={`col-start-1 row-start-1 ${type === "webhook" ? "" : "invisible"}`}>
          {"Any endpoint; it receives a JSON POST { \"title\", \"message\" }. To try it, point it at a receiver like webhook.site and hit Test."}
        </p>
      </div>
    </div>
  )
}
