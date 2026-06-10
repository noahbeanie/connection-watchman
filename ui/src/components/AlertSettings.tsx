import { useEffect, useState, type CSSProperties } from "react"
import { toast } from "sonner"
import { Eye, EyeOff, Save as SaveIcon, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
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
  const [dns, setDns] = useState(!!alerts.dns)
  // A webhook URL is a credential (anyone holding it can post to the channel):
  // masked by default so it can't leak in a glance or a screenshot.
  const [showUrl, setShowUrl] = useState(false)

  useEffect(() => {
    setType(alerts.type === "webhook" ? "webhook" : "discord")
    setUrl(alerts.url || "")
    setDns(!!alerts.dns)
  }, [alerts.type, alerts.url, alerts.dns])

  const persist = () => post("/api/alerts", { type, url: url.trim(), recovery: true, dns })

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
      {/* Masked via CSS (-webkit-text-security), NOT type="password": password inputs
          summon password-manager extensions, which overlay their autofill UI on the
          field - and this is a webhook URL, not a login. The data-* attributes opt out
          of the major managers' field detection for good measure. */}
      <div className="relative">
        <Input
          value={url} onChange={(e) => setUrl(e.target.value)} placeholder={PLACEHOLDER[type]}
          type="text" autoComplete="off" spellCheck={false} inputMode="url"
          data-bwignore="true" data-1p-ignore="true" data-lpignore="true" data-form-type="other"
          style={!showUrl && url ? ({ WebkitTextSecurity: "disc" } as CSSProperties) : undefined}
          className="h-8 w-full pr-9 font-mono text-xs"
        />
        <button
          type="button" onClick={() => setShowUrl((s) => !s)}
          title={showUrl ? "Hide webhook URL" : "Show webhook URL"}
          aria-label={showUrl ? "Hide webhook URL" : "Show webhook URL"}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition hover:text-foreground"
        >
          {showUrl ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      </div>
      <div className="flex gap-2 pt-0.5">
        <Button size="sm" disabled={saving} onClick={save}>
          <SaveIcon className="size-3.5" />{saving ? "Saving..." : "Save"}
        </Button>
        <Button size="sm" variant="outline" disabled={testing || !url.trim()} onClick={test}>
          <Send className="size-3.5" />{testing ? "Sending" : "Test"}
        </Button>
      </div>
      <label className="flex cursor-pointer select-none items-center gap-2 text-xs leading-snug text-muted-foreground">
        <Switch size="sm" checked={dns} onCheckedChange={setDns} />
        Also alert me when DNS fails (sites stop loading on every device even though the line is up).
      </label>
      {/* Both hints share one grid cell, so the tile keeps the height of the taller hint and
          doesn't jump when you toggle between Discord and Webhook. */}
      <div className="grid text-xs leading-relaxed text-muted-foreground">
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
