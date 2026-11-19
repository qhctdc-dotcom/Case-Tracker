import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { fmtIso, fmtTime, formatMinutes, norm } from "../lib/tracker";
import { Badge, Button, C, Modal, Note, Stat, csvCell, downloadFile, inputBase, stamp } from "./ui";

/* ---------- shared helpers for receipt history (sample_audit) ---------- */
export const actionColour = (a: string) =>
  a === "Received (not logged by courier)" ? C.warning
    : a.startsWith("Received") ? C.success
    : a.startsWith("Receipt undone") || a.startsWith("Removed") ? C.danger
    : C.accent;
export const auditWho = (r: api.SampleAuditRow) => r.actor_name || r.actor.split("@")[0] || r.actor;
export function auditDetails(r: api.SampleAuditRow) {
  const d = r.details || {};
  const bits: string[] = [];
  if (d.centre) bits.push(`from ${d.centre}`);
  if (r.action === "Received" && d.collected_by) bits.push(`collected by ${String(d.collected_by).split("@")[0]}`);
  if (d.transit_minutes != null) bits.push(`${formatMinutes(Number(d.transit_minutes))} in transit`);
  if (d.was_received_at) bits.push(`had been received by ${d.was_received_by_name || String(d.was_received_by || "").split("@")[0]} at ${fmtIso(d.was_received_at)}`);
  if (d.backfilled) bits.push("recorded before history was switched on");
  return bits.join(", ");
}

/** Timeline for one barcode, oldest first. */
export function SampleHistory({ barcode }: { barcode: string }) {
  const [rows, setRows] = useState<api.SampleAuditRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.loadSampleHistory(barcode).then((r) => live && setRows(r)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [barcode]);

  if (err) return <Note tone="err">{err}</Note>;
  if (!rows) return <p className="text-ink-3 text-sm">Loading…</p>;
  if (!rows.length) return <p className="text-ink-3 text-sm">No history recorded for this barcode yet.</p>;

  return (
    <ol className="relative border-l-2 ml-2" style={{ borderColor: C.line }}>
      {rows.map((r) => (
        <li key={r.id} className="ml-4 pb-4 last:pb-0 relative">
          <span className="absolute -left-[23px] top-1.5 w-3 h-3 rounded-full" style={{ background: actionColour(r.action) }} aria-hidden="true" />
          <p className="text-sm"><Badge color={actionColour(r.action)}>{r.action}</Badge></p>
          <p className="text-ink mt-1">by <span className="font-semibold">{auditWho(r)}</span>{r.actor.includes("@") && <span className="text-ink-3 text-xs"> ({r.actor})</span>}</p>
          <p className="num text-sm text-ink-2">{fmtIso(r.at)}</p>
          {auditDetails(r) && <p className="text-xs text-ink-3 mt-0.5">{auditDetails(r)}</p>}
        </li>
      ))}
    </ol>
  );
}

/* ---------- the History tab ---------- */
type Range = 1 | 2 | 7 | 30 | 90;
type Kind = "all" | "received" | "notlogged" | "undone" | "logged" | "removed";
const KINDS: [Kind, string][] = [
  ["all", "All events"],
  ["received", "Received"],
  ["notlogged", "Received, not logged by courier"],
  ["undone", "Receipts undone"],
  ["logged", "Logged by courier"],
  ["removed", "Removed by courier"],
];
const kindOf = (a: string): Kind =>
  a === "Received (not logged by courier)" ? "notlogged"
    : a === "Received" ? "received"
    : a.startsWith("Receipt undone") ? "undone"
    : a === "Logged by courier" ? "logged"
    : a === "Removed by courier" ? "removed" : "all";

export default function SampleHistoryView() {
  const [range, setRange] = useState<Range>(1);
  const [data, setData] = useState<{ rows: api.SampleAuditRow[]; truncated: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<Kind>("all");
  const [person, setPerson] = useState("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try { setData(await api.loadSampleAudit(range)); setErr(null); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }, [range]);

  useEffect(() => {
    load();
    // Every history event comes from a change to a sample, so reload when samples change.
    let t: number | undefined;
    const unsub = api.subscribeTransport(() => { clearTimeout(t); t = window.setTimeout(() => load(true), 1200); });
    return () => { unsub(); clearTimeout(t); };
  }, [load]);

  const people = useMemo(() => {
    const m = new Map<string, string>();
    (data?.rows || []).forEach((r) => m.set(r.actor, auditWho(r)));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const shown = useMemo(() => {
    if (!data) return [];
    const q = norm(search).replace(/[^A-Z0-9]/g, "");
    return data.rows.filter((r) =>
      (kind === "all" || kindOf(r.action) === kind) &&
      (person === "all" || r.actor === person) &&
      (!q || r.barcode.includes(q) || (r.r_number || "").includes(q)));
  }, [data, kind, person, search]);

  const counts = useMemo(() => {
    const c = { received: 0, notlogged: 0, undone: 0 };
    shown.forEach((r) => { const k = kindOf(r.action); if (k === "received" || k === "notlogged" || k === "undone") c[k]++; });
    return c;
  }, [shown]);

  const days = useMemo(() => {
    const out: { day: string; rows: api.SampleAuditRow[] }[] = [];
    shown.forEach((r) => {
      const day = new Date(r.at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(r); else out.push({ day, rows: [r] });
    });
    return out;
  }, [shown]);

  function exportCsv() {
    const lines = [["When", "Barcode", "R#", "Event", "By", "By (email)", "Details"].join(",")];
    shown.forEach((r) => lines.push([fmtIso(r.at), r.barcode, r.r_number || "", csvCell(r.action), csvCell(auditWho(r)), r.actor, csvCell(auditDetails(r))].join(",")));
    downloadFile(`sample_history_${stamp()}.csv`, lines.join("\n"), "text/csv;charset=utf-8;");
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2 items-center mb-4">
        <select className={inputBase} value={range} onChange={(e) => setRange(Number(e.target.value) as Range)} aria-label="Period">
          <option value={1}>Today</option>
          <option value={2}>Today and yesterday</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <select className={inputBase} value={kind} onChange={(e) => setKind(e.target.value as Kind)} aria-label="Event">
          {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <select className={inputBase} value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Person">
          <option value="all">Everyone</option>
          {people.map(([email, name]) => <option key={email} value={email}>{name}</option>)}
        </select>
        <input className={`${inputBase} w-56`} placeholder="Find barcode or R#" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find barcode" />
        <span className="ml-auto flex gap-3">
          <Button tone="quiet" onClick={() => load()}>Refresh</Button>
          <Button tone="quiet" onClick={exportCsv} disabled={!shown.length}>Export (CSV)</Button>
        </span>
      </div>

      {err && <Note tone="err">Couldn't load history: {err}</Note>}
      {data?.truncated && <Note tone="warn">Showing the newest 10,000 events only. Pick a shorter period to see everything.</Note>}

      {data && (
        <div className="flex gap-8 sm:gap-12 flex-wrap mb-5">
          <Stat label="Events shown" value={shown.length} />
          <Stat label="Received" value={counts.received} color={C.success} />
          <Stat label="Not logged by courier" value={counts.notlogged} color={counts.notlogged ? C.warning : C.ink} />
          <Stat label="Receipts undone" value={counts.undone} color={counts.undone ? C.danger : C.ink} />
        </div>
      )}

      {loading && !data && <p className="text-ink-3">Loading history…</p>}
      {data && !shown.length && <div className="card p-8 text-center text-ink-3">No history for this selection.</div>}

      {days.map((g) => (
        <section key={g.day} className="mb-6">
          <h3 className="font-semibold text-ink mb-2">{g.day} <span className="num text-sm font-normal text-ink-3">{g.rows.length}</span></h3>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-ink-3 border-b" style={{ borderColor: C.line }}>
                  <th className="px-4 py-2 font-medium w-20">Time</th>
                  <th className="px-4 py-2 font-medium">Barcode</th>
                  <th className="px-4 py-2 font-medium">Event</th>
                  <th className="px-4 py-2 font-medium">By</th>
                  <th className="px-4 py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-b-0 align-top" style={{ borderColor: C.line }}>
                    <td className="px-4 py-2 num text-ink">{fmtTime(r.at)}</td>
                    <td className="px-4 py-2">
                      <button className="num text-accent hover:underline underline-offset-2 cursor-pointer" onClick={() => setOpen(r.barcode)}
                        aria-label={`Full history of ${r.barcode}`}>{r.barcode}</button>
                      {r.r_number && r.r_number !== r.barcode && <span className="block text-xs text-ink-3">R# {r.r_number}</span>}
                    </td>
                    <td className="px-4 py-2"><Badge color={actionColour(r.action)}>{r.action}</Badge></td>
                    <td className="px-4 py-2 text-ink font-semibold whitespace-nowrap" title={r.actor}>{auditWho(r)}</td>
                    <td className="px-4 py-2 text-ink-2">{auditDetails(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <Modal open={!!open} onClose={() => setOpen(null)} title={`History of ${open ?? ""}`}>
        {open && <SampleHistory barcode={open} />}
      </Modal>
    </div>
  );
}
