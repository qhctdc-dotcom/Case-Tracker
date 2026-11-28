import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { formatMinutes, tatMs, toLocalInput, verdict, type Slice } from "../lib/tracker";
import { Badge, Button, C, Field, Modal, Note, inputBase, inputCls } from "./ui";

/** A case needs a delay reason when it's past TAT and still pending, or was completed after TAT. */
export function needsDelayReason(c: Slice, now: number) {
  const v = verdict(c, tatMs(c), now);
  return v.kind === "overdue" || v.kind === "late" || v.kind === "unclear";
}

/** How late the case is now (pending) or was when it was done (completed), in minutes. */
export function lateMinutes(c: Slice, now: number) {
  const v = verdict(c, tatMs(c), now);
  return Math.max(0, Math.round(v.max));
}

export const delayText = (min: number) => (min > 0 ? formatMinutes(min) : "0m");

export const STATUS_LABEL: Record<api.DelayStatus, string> = { open: "Open", following_up: "Following up", resolved: "Resolved" };
export const STATUS_COLOR: Record<api.DelayStatus, string> = { open: C.danger, following_up: C.warning, resolved: C.success };

export function DelayStatusBadge({ s }: { s: api.DelayStatus }) {
  return <Badge color={STATUS_COLOR[s]}>{STATUS_LABEL[s]}</Badge>;
}

const QUICK: [string, number][] = [["30 min", 30], ["1 h", 60], ["2 h", 120], ["4 h", 240], ["8 h", 480], ["1 day", 1440], ["2 days", 2880], ["3 days", 4320]];

/** Record or change why a case was delayed and by how long. */
export function DelayNoteModal({ c, note, now, onClose, onSaved }: {
  c: Slice | null; note: api.DelayNote | null; now: number; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [category, setCategory] = useState("");
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState(0);
  const [mins, setMins] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!c) return;
    setErr(null); setBusy(false);
    setCategory(note?.reason_category || "");
    setReason(note?.reason || "");
    // Start from the saved delay, or from how late the case is right now (rounded up to 15 minutes)
    const start = note ? note.delay_minutes : Math.ceil(lateMinutes(c, now) / 15) * 15;
    setHours(Math.floor(start / 60)); setMins(start % 60);
  }, [c?.id, note?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!c) return null;
  const tat = tatMs(c);
  const total = Math.max(0, hours * 60 + mins);
  const expected = new Date(tat + total * 60000);
  const late = lateMinutes(c, now);
  const setTotal = (m: number) => { const v = Math.max(0, Math.round(m)); setHours(Math.floor(v / 60)); setMins(v % 60); };

  async function save() {
    if (!c) return;
    if (!category) return setErr("Choose a reason for the delay.");
    if (category === "Other" && !reason.trim()) return setErr("Type the reason when you choose Other.");
    setBusy(true); setErr(null);
    try {
      await api.saveDelayNote({
        rNumber: c.rNumber, department: c.department, patientId: c.patientId, client: c.clientDisplay, isAlist: c.isAlist,
        tests: c.tests.map((t) => t.name).join(", "), tatAt: c.reportDateTime, category, reason: reason.trim(), delayMinutes: total,
      });
      onSaved(note ? "Delay reason updated." : "Delay reason saved.");
      onClose();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  return (
    <Modal open={!!c} onClose={onClose} title={note ? "Change delay reason" : "Record delay reason"}>
      <div className="text-sm text-ink-2 mb-4 leading-relaxed">
        <span className="num font-semibold text-ink">{c.patientId}</span> · {c.department} · {c.clientDisplay}
        {c.isAlist && <> <Badge color={C.alist}>A-List</Badge></>}
        <div className="num text-xs text-ink-3 mt-1">
          TAT {c.reportDate} · {c.status === "Completed" ? `done ${delayText(late)} after TAT` : `${delayText(late)} past TAT now`}
        </div>
      </div>
      {note && (
        <Note tone="info">
          Recorded by {note.recorded_by_name || note.recorded_by} on {new Date(note.recorded_at).toLocaleString("en-GB")}
          {note.status !== "open" && <> · <DelayStatusBadge s={note.status} /></>}
          {note.follow_up_note && <div className="mt-1 text-ink-2">Admin follow-up: {note.follow_up_note}</div>}
        </Note>
      )}

      <Field label="Reason for delay">
        <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} autoFocus>
          <option value="">Choose a reason…</option>
          {api.DELAY_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          {category && !api.DELAY_REASONS.includes(category) && <option value={category}>{category}</option>}
        </select>
      </Field>
      <Field label={category === "Other" ? "Type the reason" : "Details (optional)"} hint="e.g. which analyser, what was repeated, who was informed.">
        <textarea className={`${inputCls} min-h-20`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      </Field>

      <div className="text-sm text-ink-2 mb-3">
        <span className="block mb-1 font-medium">How long is it delayed?</span>
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <input type="number" min={0} className={`${inputBase} w-20`} value={hours} aria-label="Hours"
            onChange={(e) => setHours(Math.max(0, Math.floor(+e.target.value || 0)))} /> <span>h</span>
          <input type="number" min={0} max={59} step={5} className={`${inputBase} w-20`} value={mins} aria-label="Minutes"
            onChange={(e) => setTotal(hours * 60 + Math.max(0, Math.floor(+e.target.value || 0)))} /> <span>min</span>
          <span className="text-ink-3 mx-1">or expected by</span>
          <input type="datetime-local" className={inputBase} value={toLocalInput(expected)} aria-label="Result now expected by"
            onChange={(e) => { const t = new Date(e.target.value).getTime(); if (isFinite(t)) setTotal((t - tat) / 60000); }} />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {QUICK.map(([l, m]) => (
            <button key={l} type="button" onClick={() => setTotal(m)}
              className="px-2 py-0.5 rounded border text-xs cursor-pointer hover:border-line-strong"
              style={{ borderColor: total === m ? C.accent : C.line, color: total === m ? C.accent : C.ink2 }}>{l}</button>
          ))}
        </div>
        <span className="block mt-2 text-xs text-ink-3">
          Delayed by <span className="num text-ink">{delayText(total)}</span>. Result now expected{" "}
          <span className="num text-ink">{expected.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>.
        </span>
      </div>

      {err && <Note tone="err">{err}</Note>}
      <div className="flex justify-end gap-2 mt-4">
        <Button tone="quiet" onClick={onClose}>Cancel</Button>
        <Button tone="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save delay reason"}</Button>
      </div>
    </Modal>
  );
}
