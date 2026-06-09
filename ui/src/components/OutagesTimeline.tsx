import { useState } from "react"
import { StickyNote, Trash2 } from "lucide-react"
import { CAUSE_LABEL, fmtTime } from "@/lib/format"
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

  const openNote = (o: Outage) => { setConfirmId(null); setDraft(o.note ?? ""); setNoteId(o.id) }
  const saveNote = (id: number) => { onSaveNote(id, draft.trim()); setNoteId(null); setDraft("") }

  return (
    <>
      {/* column headers */}
      <div className="mb-2 ml-1 flex justify-between pl-5 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground/70">
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
              <span className="absolute -left-[23px] top-1 size-2.5 rounded-full ring-4 ring-background" style={{ background: c }} />
              <div className="flex items-center justify-between gap-x-3">
                <span className="font-mono text-sm tabular-nums">{fmtTime(o.start, true)}</span>
                <span className="font-mono text-sm font-semibold tabular-nums">{o.duration_h}</span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-2">
                  <InfoTip label={CAUSE_DESC[o.cause] ?? CAUSE_DESC.unknown} className="cursor-help">
                    <span className="font-medium" style={{ color: c }}>{CAUSE_LABEL[o.cause] ?? o.cause}</span>
                  </InfoTip>
                  {o.ongoing ? (
                    <span className="rounded-full px-2 py-0.5 text-[0.65rem] font-semibold"
                      style={{ background: "color-mix(in oklab, var(--down) 18%, transparent)", color: "var(--down)" }}>
                      Ongoing
                    </span>
                  ) : o.end != null ? (
                    <span>· Ended {fmtTime(o.end, true)}</span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button type="button" onClick={() => (editing ? setNoteId(null) : openNote(o))}
                    title={o.note ? "Edit note" : "Add note"} aria-label={o.note ? "Edit note" : "Add note"}
                    className={`rounded p-1 transition hover:bg-muted ${o.note ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}>
                    <StickyNote className="size-3.5" />
                  </button>
                  {!o.ongoing && o.kind === "net" && (
                    <button type="button" onClick={() => { setNoteId(null); setConfirmId(confirming ? null : o.id) }}
                      title="Delete outage" aria-label="Delete outage"
                      className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-[var(--down)]">
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {o.note && !editing && (
                <p className="mt-1 rounded-md bg-muted/40 px-2 py-1 text-xs italic text-muted-foreground">{o.note}</p>
              )}

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
                    Remove this outage and mark that time as online? This rewrites the recorded
                    history and can't be undone.
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
