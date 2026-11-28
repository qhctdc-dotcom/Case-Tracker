import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { REPORT_DEPT_ORDER, norm, tatMs, type Slice, type SliceDept as SliceDeptLike } from "../lib/tracker";
import { Badge, Button, C, Cap, Field, Modal, Note, Stat, csvCell, downloadFile, inputBase, inputCls, stamp } from "./ui";
import { BarList, ChartCard, Columns, SegBar } from "./charts";
import { DelayNoteModal, DelayStatusBadge, STATUS_COLOR, STATUS_LABEL, delayText, lateMinutes, needsDelayReason } from "./DelayNote";

/* Admin-only: every recorded delay, why it happened, how long it lasted,
   and the follow-up on each one. Also lists late cases nobody has explained. */

type Period = "7" | "30" | "90" | "month" | "all";
const PERIODS: [Period, string][] = [["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["month", "This month"], ["all", "All time"]];
type StatusFilter = "all" | "unresolved" | api.DelayStatus;

function periodStart(p: Period): Date | null {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (p === "all") return null;
  if (p === "month") { d.setDate(1); return d; }
  d.setDate(d.getDate() - (Number(p) - 1)); return d;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

function countBy<T>(xs: T[], key: (x: T) => string) {
  const m = new Map<string, T[]>();
  xs.forEach((x) => { const k = key(x); m.set(k, [...(m.get(k) || []), x]); });
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}

export default function DelaysView({ slices, now, toast }: {
  slices: Slice[]; now: number; toast: (text: string, tone?: "ok" | "err") => void;
}) {
  const [period, setPeriod] = useState<Period>("30");
  const [dept, setDept] = useState<string>("all");
  const [status, setStatus] = useState<StatusFilter>("unresolved");
  const [search, setSearch] = useState("");
  const [notes, setNotes] = useState<api.DelayNote[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);

  const load = useCallback(() => {
    api.loadDelayNotes().then((n) => { setNotes(n); setErr(null); }).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    load();
    let t: number | undefined;
    const unsub = api.subscribeDelayNotes(() => { clearTimeout(t); t = window.setTimeout(load, 600); });
    return () => { unsub(); clearTimeout(t); };
  }, [load]);

  const from = periodStart(period);
  const all = notes || [];
  // Charts and figures: everything recorded in the period (and department), whatever its status.
  const inPeriod = all.filter((n) => (!from || new Date(n.recorded_at) >= from) && (dept === "all" || n.department === dept));
  // Follow-up list: also filtered by status and search.
  const list = useMemo(() => {
    const q = norm(search);
    return inPeriod.filter((n) => {
      if (status === "unresolved" && n.status === "resolved") return false;
      if (status !== "all" && status !== "unresolved" && n.status !== status) return false;
      if (q && !norm([n.patient_id, n.r_number, n.client, n.reason_category, n.reason, n.tests, n.recorded_by_name, n.follow_up_note].join(" ")).includes(q)) return false;
      return true;
    });
  }, [inPeriod, status, search]); // eslint-disable-line react-hooks/exhaustive-deps

  // Late cases in the tracker that nobody has explained yet.
  const noted = new Set(all.map((n) => `${n.r_number}__${n.department}`));
  const unexplained = slices
    .filter((c) => needsDelayReason(c, now) && !noted.has(c.id) && (dept === "all" || c.department === dept))
    .sort((a, b) => tatMs(a) - tatMs(b));

  const stats = useMemo(() => {
    const byReason = countBy(inPeriod, (n) => n.reason_category);
    const byDept = countBy(inPeriod, (n) => n.department);
    const byClient = countBy(inPeriod, (n) => n.client || "Client not recorded");
    const byStaff = countBy(inPeriod, (n) => n.recorded_by_name || n.recorded_by);
    const start = from || (inPeriod.length ? new Date(Math.min(...inPeriod.map((n) => new Date(n.recorded_at).getTime()))) : new Date());
    const days: Date[] = [];
    for (const d = new Date(start); d <= new Date() && days.length < 120; d.setDate(d.getDate() + 1)) days.push(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
    const perDayMap = new Map<string, number>();
    inPeriod.forEach((n) => { const k = dayKey(new Date(n.recorded_at)); perDayMap.set(k, (perDayMap.get(k) || 0) + 1); });
    const resolved = inPeriod.filter((n) => n.resolved_at);
    return {
      byReason: byReason.map(([k, v]) => ({ label: k, value: v.length, detail: `${v.length} delays · average ${delayText(mean(v.map((n) => n.delay_minutes)))}` })),
      avgByReason: byReason.map(([k, v]) => ({ label: k, value: Math.round(mean(v.map((n) => n.delay_minutes))), detail: `${v.length} delays` }))
        .sort((a, b) => b.value - a.value),
      byDept: REPORT_DEPT_ORDER.map((d) => { const v = byDept.find(([k]) => k === d)?.[1] || []; return { label: d, value: v.length, detail: `average ${delayText(mean(v.map((n) => n.delay_minutes)))}` }; }).filter((r) => r.value),
      byClient: byClient.map(([k, v]) => ({ label: k, value: v.length })),
      byStaff: byStaff.map(([k, v]) => ({ label: k, value: v.length })),
      perDay: days.map((d) => ({ label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }), value: perDayMap.get(dayKey(d)) || 0,
        tip: d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) })),
      avg: mean(inPeriod.map((n) => n.delay_minutes)),
      longest: inPeriod.reduce((m, n) => Math.max(m, n.delay_minutes), 0),
      alist: inPeriod.filter((n) => n.is_alist).length,
      open: inPeriod.filter((n) => n.status === "open").length,
      following: inPeriod.filter((n) => n.status === "following_up").length,
      resolved: resolved.length,
      avgResolveMin: mean(resolved.map((n) => (new Date(n.resolved_at!).getTime() - new Date(n.recorded_at).getTime()) / 60000)),
    };
  }, [inPeriod, from?.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = (head: string[], rows: { label: string; value: number }[], fmt = (v: number) => String(v)) => ({ head, rows: rows.map((r) => [r.label, fmt(r.value)]) });

  function exportCsv() {
    const head = ["Recorded", "Recorded by", "R#", "Department", "Client", "A-List", "Tests", "TAT", "Reason", "Details", "Delayed by (min)",
      "Expected by", "Status", "Follow-up note", "Followed up by", "Followed up", "Resolved"];
    const rows = list.map((n) => [new Date(n.recorded_at).toLocaleString("en-GB"), n.recorded_by_name || n.recorded_by, n.patient_id || n.r_number,
      n.department, n.client || "", n.is_alist ? "A-List" : "", n.tests || "", n.tat_at ? new Date(n.tat_at).toLocaleString("en-GB") : "",
      n.reason_category, n.reason, n.delay_minutes, n.expected_at ? new Date(n.expected_at).toLocaleString("en-GB") : "", STATUS_LABEL[n.status],
      n.follow_up_note || "", n.followed_up_by_name || "", n.followed_up_at ? new Date(n.followed_up_at).toLocaleString("en-GB") : "",
      n.resolved_at ? new Date(n.resolved_at).toLocaleString("en-GB") : ""].map((v) => csvCell(String(v))).join(","));
    downloadFile(`delays_${stamp()}.csv`, [head.join(","), ...rows].join("\n"), "text/csv;charset=utf-8;");
  }

  const selected = openId ? all.find((n) => n.id === openId) || null : null;
  const depts = REPORT_DEPT_ORDER.filter((d) => d !== "Unclassified" || all.some((n) => n.department === d) || slices.some((c) => c.department === d));

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-5">
      <h1 className="text-xl font-semibold text-ink mb-1">Delays</h1>
      <p className="text-sm text-ink-2 mb-4">Why cases went past TAT, how long they were delayed, and the follow-up on each one. Staff record the reason from the Tracker; only admins can see this page.</p>

      <div className="flex flex-wrap gap-2 items-center mb-5">
        <select className={inputBase} value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label="Period">
          {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className={inputBase} value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
          <option value="all">All departments</option>
          {depts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <span className="ml-auto flex gap-3">
          <Button tone="quiet" onClick={load}>Refresh</Button>
          <Button tone="quiet" onClick={exportCsv} disabled={!list.length}>Export list (CSV)</Button>
        </span>
      </div>

      {err && <Note tone="err">{err}</Note>}
      {!notes && !err && <p className="text-ink-3">Loading…</p>}

      {notes && (
        <div className="space-y-8">
          {/* ---------- headline ---------- */}
          <section className="card p-5 flex flex-wrap gap-x-12 gap-y-5 items-end">
            <div>
              <p className="text-sm text-ink-2">Delays recorded</p>
              <p className="text-5xl font-semibold text-ink leading-tight">{inPeriod.length.toLocaleString()}</p>
            </div>
            <Stat label="Open" value={stats.open} color={stats.open ? C.danger : C.ink} />
            <Stat label="Following up" value={stats.following} color={stats.following ? C.warning : C.ink} />
            <Stat label="Resolved" value={stats.resolved} color={C.success} sub={stats.resolved ? `average ${delayText(stats.avgResolveMin)} to resolve` : undefined} />
            <Stat label="Average delay" value={delayText(stats.avg)} sub={stats.longest ? `longest ${delayText(stats.longest)}` : undefined} />
            <Stat label="A-List delays" value={stats.alist} color={stats.alist ? C.alist : C.ink} />
            <Stat label="Late, no reason yet" value={unexplained.length} color={unexplained.length ? C.danger : C.ink} sub="In the tracker now" />
          </section>

          {/* ---------- late cases with no reason ---------- */}
          {unexplained.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-ink mb-1">Late cases with no reason recorded</h2>
              <p className="text-sm text-ink-2 mb-3">Past TAT in the tracker right now, or completed after TAT, and nobody has said why. Chase the department or add the reason here.</p>
              <div className="card overflow-hidden">
                {unexplained.slice(0, 50).map((c) => (
                  <div key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 border-b last:border-b-0 text-sm" style={{ borderColor: C.line }}>
                    <span className="flex items-center gap-2 w-36 text-ink-2"><Cap dept={c.department} /> {c.department}</span>
                    <span className="num font-semibold text-ink w-32">{c.patientId}</span>
                    {c.isAlist && <Badge color={C.alist}>A-List</Badge>}
                    <span className="text-ink-2 flex-1 min-w-40 truncate">{c.clientDisplay}</span>
                    <span className="num font-semibold" style={{ color: C.danger }}>
                      {c.status === "Completed" ? `done ${delayText(lateMinutes(c, now))} late` : `${delayText(lateMinutes(c, now))} over`}
                    </span>
                    <Button onClick={() => setReasonFor(c.id)}>Add reason</Button>
                  </div>
                ))}
                {unexplained.length > 50 && <p className="px-4 py-2 text-xs text-ink-3">Showing the 50 oldest of {unexplained.length}.</p>}
              </div>
            </section>
          )}

          {/* ---------- statistics ---------- */}
          <section>
            <h2 className="text-lg font-semibold text-ink mb-3">Why cases are delayed</h2>
            <div className="grid lg:grid-cols-2 gap-4">
              <ChartCard title="Delays by reason" sub="Most common first" table={t(["Reason", "Delays"], stats.byReason)}>
                <BarList rows={stats.byReason} limit={100} />
              </ChartCard>
              <ChartCard title="Average delay by reason" sub="Longest first" table={t(["Reason", "Average delay"], stats.avgByReason, delayText)}>
                <BarList rows={stats.avgByReason} format={delayText} limit={100} />
              </ChartCard>
              <ChartCard title="Delays recorded per day" table={{ head: ["Day", "Delays"], rows: stats.perDay.map((p) => [p.tip, p.value]) }} className="lg:col-span-2">
                <Columns points={stats.perDay} />
              </ChartCard>
              <ChartCard title="Delays by department" table={t(["Department", "Delays"], stats.byDept)}>
                <BarList rows={stats.byDept} />
              </ChartCard>
              <ChartCard title="Follow-up status" sub="Every delay recorded in the period" table={{ head: ["Status", "Delays"], rows: [["Open", stats.open], ["Following up", stats.following], ["Resolved", stats.resolved]] }}>
                <SegBar parts={[
                  { label: "Open", value: stats.open, color: STATUS_COLOR.open },
                  { label: "Following up", value: stats.following, color: STATUS_COLOR.following_up },
                  { label: "Resolved", value: stats.resolved, color: STATUS_COLOR.resolved },
                ]} />
              </ChartCard>
              <ChartCard title="Clients with the most delays" sub="Top 10" table={t(["Client", "Delays"], stats.byClient)}>
                <BarList rows={stats.byClient} />
              </ChartCard>
              <ChartCard title="Reasons recorded by" table={t(["Staff member", "Delays"], stats.byStaff)}>
                <BarList rows={stats.byStaff} />
              </ChartCard>
            </div>
          </section>

          {/* ---------- follow-up list ---------- */}
          <section>
            <h2 className="text-lg font-semibold text-ink mb-3">Follow up</h2>
            <div className="flex flex-wrap gap-2 items-center mb-3">
              <select className={inputBase} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status">
                <option value="unresolved">Open and following up</option>
                <option value="open">Open only</option>
                <option value="following_up">Following up only</option>
                <option value="resolved">Resolved only</option>
                <option value="all">All statuses</option>
              </select>
              <input type="search" className={`${inputBase} w-64 max-w-full`} placeholder="Search R#, client, reason or name" value={search}
                onChange={(e) => setSearch(e.target.value)} aria-label="Search delays" />
              <span className="text-sm text-ink-3">{list.length} {list.length === 1 ? "delay" : "delays"}</span>
            </div>
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-ink-3 border-b" style={{ borderColor: C.line, background: C.raised }}>
                    {["Recorded", "Requisition", "Reason", "Delayed by", "Expected by", "Status", "Follow-up", ""].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {list.map((n) => (
                    <tr key={n.id} className="border-b last:border-b-0 align-top hover:bg-raised cursor-pointer" style={{ borderColor: C.line }} onClick={() => setOpenId(n.id)}>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className="num text-ink">{when(n.recorded_at)}</span>
                        <span className="block text-xs text-ink-3">{n.recorded_by_name || n.recorded_by}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-1.5"><span className="num font-semibold text-ink">{n.patient_id || n.r_number}</span>{n.is_alist && <Badge color={C.alist}>A-List</Badge>}</span>
                        <span className="flex items-center gap-1.5 text-xs text-ink-2"><Cap dept={n.department as SliceDeptLike} size={11} /> {n.department} · {n.client}</span>
                      </td>
                      <td className="px-3 py-2.5 max-w-72">
                        <span className="text-ink">{n.reason_category}</span>
                        {n.reason && <span className="block text-xs text-ink-2 line-clamp-2">{n.reason}</span>}
                      </td>
                      <td className="px-3 py-2.5 num whitespace-nowrap text-ink">{delayText(n.delay_minutes)}</td>
                      <td className="px-3 py-2.5 num whitespace-nowrap text-ink-2">{when(n.expected_at)}</td>
                      <td className="px-3 py-2.5"><DelayStatusBadge s={n.status} /></td>
                      <td className="px-3 py-2.5 max-w-64">
                        {n.follow_up_note ? <span className="text-xs text-ink-2 line-clamp-2">{n.follow_up_note}</span> : <span className="text-xs text-ink-3">None yet</span>}
                        {n.followed_up_at && <span className="block text-xs text-ink-3">{n.followed_up_by_name} · {when(n.followed_up_at)}</span>}
                      </td>
                      <td className="px-3 py-2.5"><span className="text-accent text-sm whitespace-nowrap">Follow up ›</span></td>
                    </tr>
                  ))}
                  {!list.length && <tr><td colSpan={8} className="px-3 py-8 text-center text-ink-3">No delays match these filters.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      <FollowUpModal n={selected} onClose={() => setOpenId(null)} toast={toast} />
      <DelayNoteModal c={reasonFor ? slices.find((s) => s.id === reasonFor) || null : null} note={null} now={now}
        onClose={() => setReasonFor(null)} onSaved={(m) => toast(m)} />
    </div>
  );
}

function FollowUpModal({ n, onClose, toast }: { n: api.DelayNote | null; onClose: () => void; toast: (t: string, tone?: "ok" | "err") => void }) {
  const [status, setStatus] = useState<api.DelayStatus>("open");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!n) return;
    setStatus(n.status === "open" ? "following_up" : n.status); setNote(""); setErr(null); setBusy(false);
  }, [n?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!n) return null;

  async function save() {
    if (!n) return;
    setBusy(true); setErr(null);
    try { await api.followUpDelay(n.id, status, note); toast("Follow-up saved."); onClose(); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  }
  async function remove() {
    if (!n || !confirm(`Remove the delay note for ${n.patient_id || n.r_number} (${n.department})? Only do this if it was recorded by mistake. It can't be undone.`)) return;
    try { await api.deleteDelayNote(n.id); toast("Delay note removed."); onClose(); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <Modal open={!!n} onClose={onClose} title="Follow up delay" wide>
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm mb-4">
        <div><span className="text-ink-3">Requisition</span><div className="num font-semibold text-ink">{n.patient_id || n.r_number} {n.is_alist && <Badge color={C.alist}>A-List</Badge>}</div></div>
        <div><span className="text-ink-3">Department · client</span><div className="text-ink">{n.department} · {n.client}</div></div>
        <div><span className="text-ink-3">Tests</span><div className="text-ink">{n.tests || "—"}</div></div>
        <div><span className="text-ink-3">TAT · now expected</span><div className="num text-ink">{when(n.tat_at)} → {when(n.expected_at)}</div></div>
        <div className="sm:col-span-2"><span className="text-ink-3">Reason</span>
          <div className="text-ink">{n.reason_category} · delayed by <span className="num">{delayText(n.delay_minutes)}</span></div>
          {n.reason && <div className="text-ink-2 whitespace-pre-wrap">{n.reason}</div>}
        </div>
      </div>

      <div className="mb-4">
        <span className="block text-sm font-medium text-ink-2 mb-1.5">Status</span>
        <div className="flex gap-2 flex-wrap" role="radiogroup" aria-label="Status">
          {(["open", "following_up", "resolved"] as api.DelayStatus[]).map((s) => (
            <button key={s} role="radio" aria-checked={status === s} onClick={() => setStatus(s)}
              className="px-3 py-1.5 rounded-full border text-sm cursor-pointer"
              style={{ borderColor: status === s ? STATUS_COLOR[s] : C.line, color: status === s ? STATUS_COLOR[s] : C.ink2, fontWeight: status === s ? 600 : 400 }}>
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </div>
      <Field label="Follow-up note" hint={n.follow_up_note ? `Last note: ${n.follow_up_note}` : "e.g. spoke to the bench lead, analyser fixed, client informed, preventive action agreed."}>
        <textarea className={`${inputCls} min-h-20`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </Field>

      <details className="mb-4">
        <summary className="text-sm text-accent cursor-pointer">History ({n.history?.length || 0})</summary>
        <ol className="mt-2 space-y-2 text-sm">
          {[...(n.history || [])].reverse().map((h, i) => (
            <li key={i} className="border-l-2 pl-3" style={{ borderColor: C.line }}>
              <span className="text-ink font-medium">{h.action}</span> <span className="text-ink-3">· {h.by} · {when(h.at)}</span>
              {h.category && <div className="text-ink-2">{h.category}{h.delay_minutes != null && <> · {delayText(h.delay_minutes)}</>}{h.reason && <>: {h.reason}</>}</div>}
              {h.note && <div className="text-ink-2">{h.note}</div>}
            </li>
          ))}
        </ol>
      </details>

      {err && <Note tone="err">{err}</Note>}
      <div className="flex gap-2 justify-end flex-wrap">
        <Button tone="danger" className="mr-auto" onClick={remove}>Remove note</Button>
        <Button tone="quiet" onClick={onClose}>Cancel</Button>
        <Button tone="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save follow-up"}</Button>
      </div>
    </Modal>
  );
}
