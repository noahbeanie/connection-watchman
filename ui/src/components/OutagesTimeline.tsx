import { useEffect, useState, type CSSProperties } from "react"
import { StickyNote, Trash2 } from "lucide-react"
import { CAUSE_LABEL, fmtDur, fmtTime, nowSec } from "@/lib/format"
import { CAUSE_DESC } from "@/components/CauseLegend"
import { InfoTip } from "@/components/InfoTip"
import type { Outage } from "@/lib/types"

const causeColor: Record<string, string> = {
  isp: "var(--orange)", local: "var(--down)", dns: "var(--primary)", unknown: "var(--muted-foreground)",
}

export function OutagesTimeline({ outages, onSaveNote, onDelete }: {
  outages: Outage[]
  onSaveNote: (id: number, note: string) => void
  onDelete: (id: number) => void
}) {
  const [noteId, setNoteId] = useState<number | null>(null)
  const [draft, setDraft] = useState("")
  const [confirmId, setConfirmId] = useState<number | null>(null)
  // Ongoing outages tick their duration live (the server string is frozen at fetch
  // time, which reads oddly next to a pulsing "live" dot). 1s timer only while needed.
  const anyOngoing = outages.some((o) => o.ongoing)
  const [tick, setTick] = useState(() => nowSec())
  useEffect(() => {
    if (!anyOngoing) return
    setTick(nowSec())
    const id = setInterval(() => setTick(nowSec()), 1000)
    return () => clearInterval(id)
  }, [anyOngoing])

  const openNote = (o: Outage) => { setConfirmId(null); setDraft(o.note ?? ""); setNoteId(o.id) }
  const saveNote = (id: number) => { onSaveNote(id, draft.trim()); setNoteId(null); setDraft("") }

  return (
    <>
      {/* column headers */}
      <div className="mb-2 ml-1 flex justify-between pl-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Started</span>
        <span>Duration</span>
      </div>
      <ol className="relative ml-1 space-y-4 border-l border-border/60 pl-5">
        {outages.map((o) => {
          const c = causeColor[o.cause] ?? causeColor.unknown
          const editing = noteId === o.id
          const confirming = confirmId === o.id
          return (
            <li key={o.id} className="relative">
              {/* the rail dot: a glossy LED orb (radial highlight up-left, darker rim) that
                  breathes while the outage is still ongoing; pointer-transparent so the
                  extended tooltip trigger beneath catches the hover (no dead zones) */}
              <span
                className={`pointer-events-none absolute -left-[23px] top-1 size-2.5 rounded-full${o.ongoing ? " led-pulse" : ""}`}
                style={{
                  background: `radial-gradient(circle at 33% 30%, color-mix(in oklab, ${c} 55%, white) 0%, ${c} 60%, color-mix(in oklab, ${c} 78%, black) 100%)`,
                  ...(o.ongoing ? ({ "--led-c": c } as CSSProperties) : {}),
                }}
              />
              <div className="flex items-start justify-between gap-x-3">
                {/* The whole identity block triggers the explanation tip: the colored rail
                    dot, the start time, and the cause name (the grey label alone was too
                    easy to miss). The trigger box is pulled left across the rail so the
                    dot and the space beside it count too. */}
                <InfoTip label={CAUSE_DESC[o.cause] ?? CAUSE_DESC.unknown} className="-ml-[27px] min-w-0 cursor-help pl-[27px]">
                  <span className="block min-w-0">
                    <span className="block font-mono text-sm tabular-nums">{fmtTime(o.start, true)}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium">{CAUSE_LABEL[o.cause] ?? o.cause}</span>
                      {o.ongoing ? (
                        <span className="rounded-full px-2 py-0.5 font-semibold"
                          style={{ background: "color-mix(in oklab, var(--down) 18%, transparent)", color: "var(--down)" }}>
                          Ongoing
                        </span>
                      ) : o.end != null ? (
                        <span>· Ended {fmtTime(o.end, true)}</span>
                      ) : null}
                    </span>
                  </span>
                </InfoTip>
                <div className="flex shrink-0 flex-col items-end">
                  <span className="font-mono text-sm font-semibold tabular-nums">
                    {o.ongoing ? fmtDur(Math.max(0, tick - o.start)) : o.duration_h}
                  </span>
                  <div className="mt-0.5 flex items-center gap-0.5 text-xs text-muted-foreground">
                    {/* The note lives in a hover tip on the icon (highlighted when one exists)
                        instead of inline below the row: every entry stays the same height, so
                        flipping between pages with and without notes can't shift the layout. */}
                    <InfoTip focusable={false} label={o.note
                      ? <><span className="font-semibold">Note</span><span className="mt-0.5 block italic text-muted-foreground">{o.note}</span></>
                      : "Add a note to this outage (e.g. reset the modem)."}>
                      <button type="button" onClick={() => (editing ? setNoteId(null) : openNote(o))}
                        aria-label={o.note ? "Edit note" : "Add note"}
                        className={`rounded p-1 transition hover:bg-muted ${o.note ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}>
                        <StickyNote className="size-3.5" />
                      </button>
                    </InfoTip>
                    {!o.ongoing && (
                      <button type="button" onClick={() => { setNoteId(null); setConfirmId(confirming ? null : o.id) }}
                        title="Delete outage" aria-label="Delete outage"
                        className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-[var(--down)]">
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {editing && (
                <div className="mt-1.5">
                  <textarea
                    autoFocus rows={2} maxLength={1000} value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveNote(o.id)
                      if (e.key === "Escape") setNoteId(null)
                    }}
                    placeholder="Add a note (e.g. reset the modem)"
                    className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <div className="mt-1 flex justify-end gap-2">
                    <button type="button" onClick={() => setNoteId(null)}
                      className="rounded px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground">Cancel</button>
                    <button type="button" onClick={() => saveNote(o.id)}
                      className="rounded bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground transition hover:opacity-90">Save</button>
                  </div>
                </div>
              )}

              {confirming && (
                <div className="mt-1.5 rounded-md border px-2.5 py-2 text-xs"
                  style={{ borderColor: "color-mix(in oklab, var(--down) 40%, transparent)" }}>
                  <p className="text-muted-foreground">
                    {o.kind === "dns"
                      ? "Remove this DNS outage from the record? This can't be undone."
                      : "Remove this outage and mark that time as online? This rewrites the recorded history and can't be undone."}
                  </p>
                  <div className="mt-1.5 flex justify-end gap-2">
                    <button type="button" onClick={() => setConfirmId(null)}
                      className="rounded px-2 py-1 text-muted-foreground transition hover:text-foreground">Cancel</button>
                    <button type="button" onClick={() => { onDelete(o.id); setConfirmId(null) }}
                      className="rounded bg-[var(--down)] px-2.5 py-1 font-semibold text-white transition hover:opacity-90">Delete</button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </>
  )
}
