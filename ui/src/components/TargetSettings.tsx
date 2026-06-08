import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Plus, RotateCcw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Target } from "@/lib/types"

const post = (p: string, body: unknown) =>
  fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

// Editor for the probe targets. "Up" means ANY listed target answered, so the list is a set of
// internet reference points (and can include a specific service you care about). Empty = the
// built-in defaults (Cloudflare / Google / Quad9 on 443 + 53).
export function TargetSettings({ targets, custom, onSaved }: {
  targets: Target[]; custom: boolean; onSaved: () => void
}) {
  const key = targets.map((t) => `${t.host}:${t.port}`).join(",")
  const [rows, setRows] = useState<{ host: string; port: string }[]>(
    () => targets.map((t) => ({ host: t.host, port: String(t.port) })),
  )
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setRows(targets.map((t) => ({ host: t.host, port: String(t.port) })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const setRow = (i: number, patch: Partial<{ host: string; port: string }>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const addRow = () => setRows((rs) => [...rs, { host: "", port: "443" }])
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i))

  const save = async () => {
    const payload = rows.map((r) => ({ host: r.host.trim(), port: parseInt(r.port, 10) })).filter((r) => r.host)
    if (!payload.length) { toast.error("Add at least one target, or reset to defaults"); return }
    if (payload.some((r) => !Number.isInteger(r.port) || r.port < 1 || r.port > 65535)) {
      toast.error("Each target needs a valid port (1-65535)"); return
    }
    setSaving(true)
    const res = await post("/api/targets", { targets: payload })
    setSaving(false)
    if (res.ok) { toast.success("Targets saved"); onSaved() }
    else toast.error("Could not save targets: " + (await res.text()))
  }
  const reset = async () => {
    setSaving(true)
    const res = await post("/api/targets", { targets: [] })
    setSaving(false)
    if (res.ok) { toast.success("Restored default targets"); onSaved() }
    else toast.error("Could not reset: " + (await res.text()))
  }

  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted-foreground">
        Reachability targets. The connection counts as up when <span className="font-medium text-foreground">any</span> of these answers.
        {custom ? "" : " (Currently using the built-in defaults.)"}
      </p>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              value={r.host} onChange={(e) => setRow(i, { host: e.target.value })}
              placeholder="1.1.1.1 or example.com" autoComplete="off" spellCheck={false}
              className="h-7 flex-1 font-mono text-xs"
            />
            <span className="text-muted-foreground">:</span>
            <Input
              value={r.port} onChange={(e) => setRow(i, { port: e.target.value.replace(/[^0-9]/g, "") })}
              placeholder="443" inputMode="numeric"
              className="h-7 w-16 font-mono text-xs"
            />
            <button
              type="button" onClick={() => removeRow(i)} title="Remove target" aria-label="Remove target"
              className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-[var(--down)]"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
        {rows.length === 0 && <p className="italic text-muted-foreground/60">No targets. Add one or reset to defaults.</p>}
      </div>
      <div className="flex flex-wrap gap-2 pt-0.5">
        <Button size="sm" variant="ghost" className="px-2" onClick={addRow}><Plus className="size-3.5" />Add target</Button>
        <Button size="sm" variant="secondary" className="ml-auto" disabled={saving} onClick={save}>Save targets</Button>
        <Button size="sm" variant="outline" disabled={saving} onClick={reset} title="Restore the built-in defaults">
          <RotateCcw className="size-3.5" />Defaults
        </Button>
      </div>
    </div>
  )
}
