import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { fmtIso, formatMinutes, norm } from "../lib/tracker";
import { Badge, Button, C, Note, Stat, csvCell, downloadFile, inputBase, stamp, tint } from "./ui";

type Range = 1 | 2 | 7 | 14 | 30;
type Show = "all" | "ready" | "outstanding";
const NO_CENTRE = "Centre not recorded";

const stateOf = (it: api.DueBackItem) =>
  !it.known_to_tracker ? { key: "unknown" as const, label: "Not in tracker", color: C.ink3 }
    : it.pending_tests > 0 ? { key: "outstanding" as const, label: `${it.pending_tests} of ${it.total_tests} test${it.total_tests === 1 ? "" : "s"} outstanding`, color: C.warning }
    : { key: "ready" as const, label: "Tests complete: ready to release", color: C.success };

export default function DueBackView({ toast, onOpenSheets }: { toast: (m: string, t?: "ok" | "err") => void; onOpenSheets: () => void }) {
  const [range, setRange] = useState<Range>(7);
  const [items, setItems] = useState<api.DueBackItem[] | null>(null);
  const [centres, setCentres] = useState<api.Centre[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [centre, setCentre] = useState("all");
  const [show, setShow] = useState<Show>("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [sent, setSent] = useState<{ count: number; destination: string; rs: string[] } | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([api.loadDueBack(range), api.loadCentres()]);
      setItems(d); setCentres(c); setErr(null);
    } catch (e: any) { setErr(e.message); }
  }, [range]);
  useEffect(() => {
    load();
    let t: number | undefined;
    const later = () => { clearTimeout(t); t = window.setTimeout(load, 1000); };
    const u1 = api.subscribeTransport(later);
    const u2 = api.subscribeReleases(later);
    // Test results change when the MT list is pasted; check again every 2 minutes.
    const poll = setInterval(load, 120000);
    const tick = setInterval(() => setNow(Date.now()), 60000);
    return () => { u1(); u2(); clearTimeout(t); clearInterval(poll); clearInterval(tick); };
  }, [load]);

  const centreName = useCallback((id: number | null) => centres.find((c) => c.id === id)?.name || NO_CENTRE, [centres]);

  const groups = useMemo(() => {
    if (!items) return [];
    const q = norm(search).replace(/[^A-Z0-9]/g, "");
    const m = new Map<string, api.DueBackItem[]>();
    items.forEach((it) => {
      const name = centreName(it.centre_id);
      if (centre !== "all" && name !== centre) return;
      if (show !== "all" && stateOf(it).key !== show) return;
      if (q && !it.r_number.includes(q) && !it.barcodes.some((b) => b.includes(q))) return;
      m.set(name, [...(m.get(name) || []), it]);
    });
    return [...m.entries()]
      .map(([name, rows]) => ({ name, rows: rows.sort((a, b) => a.received_at.localeCompare(b.received_at)) }))
      .sort((a, b) => (a.name === NO_CENTRE ? 1 : b.name === NO_CENTRE ? -1 : a.name.localeCompare(b.name)));
  }, [items, centre, show, search, centreName]);

  const totals = useMemo(() => {
    const all = items || [];
    return {
      all: all.length,
      ready: all.filter((i) => stateOf(i).key === "ready").length,
      outstanding: all.filter((i) => stateOf(i).key === "outstanding").length,
      centres: new Set(all.map((i) => i.centre_id)).size,
    };
  }, [items]);
  const centreOptions = useMemo(() => [...new Set((items || []).map((i) => centreName(i.centre_id)))].sort(), [items, centreName]);

  async function release(rows: api.DueBackItem[], destination: string) {
    if (!rows.length) return;
    const outstanding = rows.filter((r) => stateOf(r).key === "outstanding");
    if (outstanding.length && !confirm(`${outstanding.length === 1 ? `R#${outstanding[0].r_number} still has` : `${outstanding.length} of these still have`} tests outstanding in the tracker.\n\nRelease for ${destination} anyway?`)) return;
    setBusy(rows.length === 1 ? rows[0].r_number : destination);
    try {
      const res = await api.releaseReports(rows.map((r) => r.r_number), destination);
      const ok = res.filter((r) => r.result === "released").length;
      const other = res.filter((r) => r.result !== "released");
      if (ok) setSent({ count: ok, destination, rs: res.filter((r) => r.result === "released").map((r) => r.r_number!) });
      toast(ok ? `${ok} report${ok === 1 ? "" : "s"} released for ${destination}: now on Delivery sheets for courier pick-up.${other.length ? ` ${other.length} already released or with a courier.` : ""}`
        : `Nothing released: ${other.map((r) => `R#${r.r_number} ${r.result.replace(/_/g, " ")}`).join(", ")}`, ok ? "ok" : "err");
      await load();
    } catch (e: any) { toast(e.message, "err"); }
    finally { setBusy(null); }
  }

  function exportCsv() {
    const lines = [["Centre", "R#", "Client", "Tubes", "Collected", "Received", "Tests outstanding", "Tests total", "Status"].join(",")];
    groups.forEach((g) => g.rows.forEach((r) => lines.push([csvCell(g.name), r.r_number, csvCell(r.client_name), r.barcodes.length,
      fmtIso(r.collected_at), fmtIso(r.received_at), r.pending_tests, r.total_tests, csvCell(stateOf(r).label)].join(","))));
    downloadFile(`reports_due_back_${stamp()}.csv`, lines.join("\n"), "text/csv;charset=utf-8;");
  }

  const ago = (iso: string) => ((m) => (m < 1 ? "just now" : `${formatMinutes(m)} ago`))((now - new Date(iso).getTime()) / 60000);

  return (
    <div>
      {err && <Note tone="err">Couldn't load reports due back: {err}</Note>}
      <h2 className="text-lg font-semibold text-ink mb-1">Reports due back to centres</h2>
      <p className="text-sm text-ink-2 mb-4">
        Every R# a courier brought in and the lab received, grouped by the centre or depot it was collected from. Once you release a report it moves to <b>Delivery sheets</b>, and couriers see it on their phones as ready to collect.
      </p>

      {sent && (
        <div className="rounded-lg p-4 mb-5 flex items-center justify-between gap-4 flex-wrap" role="status" aria-live="polite"
          style={{ background: tint(C.success, 12), borderLeft: `6px solid ${C.success}` }}>
          <div className="min-w-0">
            <p className="font-semibold" style={{ color: C.success }}>
              {sent.count === 1 ? `R#${sent.rs[0]}` : `${sent.count} reports`} released for {sent.destination}
            </p>
            <p className="text-sm text-ink">Now on Delivery sheets under <b>Ready for courier pick-up</b>, and showing on couriers' phones.</p>
          </div>
          <span className="flex gap-2">
            <Button tone="primary" onClick={onOpenSheets}>Open Delivery sheets</Button>
            <Button tone="quiet" onClick={() => setSent(null)}>Dismiss</Button>
          </span>
        </div>
      )}

      <div className="flex gap-8 sm:gap-12 flex-wrap mb-5">
        <Stat label="R#s due back" value={totals.all} color={totals.all ? C.accent : C.ink} />
        <Stat label="Ready to release" value={totals.ready} color={totals.ready ? C.success : C.ink} />
        <Stat label="Tests outstanding" value={totals.outstanding} color={totals.outstanding ? C.warning : C.ink} />
        <Stat label="Centres and depots" value={totals.centres} />
      </div>

      <div className="flex flex-wrap gap-2 items-center mb-4">
        <select className={inputBase} value={range} onChange={(e) => setRange(Number(e.target.value) as Range)} aria-label="Received">
          <option value={1}>Received today</option>
          <option value={2}>Received today and yesterday</option>
          <option value={7}>Received in the last 7 days</option>
          <option value={14}>Received in the last 14 days</option>
          <option value={30}>Received in the last 30 days</option>
        </select>
        <select className={inputBase} value={centre} onChange={(e) => setCentre(e.target.value)} aria-label="Centre">
          <option value="all">All centres and depots</option>
          {centreOptions.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <select className={inputBase} value={show} onChange={(e) => setShow(e.target.value as Show)} aria-label="Show">
          <option value="all">All</option>
          <option value="ready">Ready to release</option>
          <option value="outstanding">Tests outstanding</option>
        </select>
        <input className={`${inputBase} w-52`} placeholder="Find R# or barcode" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find R#" />
        <span className="ml-auto flex gap-3">
          <Button tone="quiet" onClick={load}>Refresh</Button>
          <Button tone="quiet" onClick={exportCsv} disabled={!groups.length}>Export (CSV)</Button>
        </span>
      </div>

      {!items && !err && <p className="text-ink-3">Loading…</p>}
      {items && !groups.length && <div className="card p-8 text-center text-ink-3">Nothing due back for this selection.</div>}

      <div className="grid lg:grid-cols-2 gap-5 items-start">
        {groups.map((g) => {
          const ready = g.rows.filter((r) => stateOf(r).key === "ready");
          const known = g.name !== NO_CENTRE;
          return (
            <section key={g.name} className="card overflow-hidden">
              <div className="px-4 py-2.5 flex items-center justify-between gap-3 border-b flex-wrap" style={{ borderColor: C.line, background: C.raised }}>
                <span>
                  <span className="font-semibold text-ink">{g.name}</span>
                  <span className="text-sm text-ink-2"> · {g.rows.length} R#{g.rows.length === 1 ? "" : "s"}{ready.length ? `, ${ready.length} ready` : ""}</span>
                </span>
                {known && ready.length > 0 && (
                  <Button tone="primary" onClick={() => release(ready, g.name)} disabled={!!busy}>{busy === g.name ? "Releasing…" : `Release ${ready.length} ready`}</Button>
                )}
              </div>
              {!known && <p className="px-4 pt-2 text-xs text-ink-3">These were scanned in without a courier record. Release them from <b>Release reports</b> and choose the destination.</p>}
              <ul>
                {g.rows.map((r) => {
                  const st = stateOf(r);
                  return (
                    <li key={r.r_number} className="flex items-center justify-between gap-3 px-4 py-2.5 border-b last:border-b-0" style={{ borderColor: C.line }}>
                      <span className="min-w-0">
                        <span className="num text-ink font-semibold">R#{r.r_number}</span>
                        {r.client_name && <span className="text-ink-2 text-sm"> {r.client_name}</span>}
                        <span className="block text-xs text-ink-3">
                          {r.barcodes.length} tube{r.barcodes.length === 1 ? "" : "s"}. Received {ago(r.received_at)} ({fmtIso(r.received_at)})
                          {r.withdrawn && ". Release was withdrawn"}
                        </span>
                        <span className="block mt-1"><Badge color={st.color}>{st.label}</Badge></span>
                      </span>
                      {known && (
                        <Button tone={st.key === "ready" ? "ghost" : "quiet"} disabled={!!busy} onClick={() => release([r], g.name)}>
                          {busy === r.r_number ? "Releasing…" : "Release"}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
