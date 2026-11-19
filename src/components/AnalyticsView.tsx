import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { aggNumbers, buildReport } from "../lib/report";
import { REPORT_DEPT_ORDER, formatMinutes, verdict, type Dicts, type Slice } from "../lib/tracker";
import { BarList, ChartCard, Columns, SegBar } from "./charts";
import { Button, C, Note, Stat, csvCell, downloadFile, inputBase, stamp } from "./ui";

type Period = "today" | "yesterday" | "7" | "30" | "90" | "month";
const PERIODS: [Period, string][] = [["today", "Today"], ["yesterday", "Yesterday"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["month", "This month"]];

function periodRange(p: Period): { from: Date; to: Date; days: number } {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const now = new Date();
  if (p === "today") return { from: start, to: now, days: 1 };
  if (p === "yesterday") { const f = new Date(start); f.setDate(f.getDate() - 1); return { from: f, to: start, days: 1 }; }
  if (p === "month") { const f = new Date(start); f.setDate(1); return { from: f, to: now, days: start.getDate() }; }
  const n = Number(p); const f = new Date(start); f.setDate(f.getDate() - (n - 1));
  return { from: f, to: now, days: n };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const mins = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 60000;
const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0);
const fmtMin = (v: number | null) => (v == null ? "–" : formatMinutes(v));
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const count = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  xs.forEach((x) => { const k = key(x); m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
};

type Table = { head: string[]; rows: (string | number)[][] };
const toTable = (head: [string, string], rows: { label: string; value: number }[], fmt: (v: number) => string | number = (v) => v): Table =>
  ({ head, rows: rows.map((r) => [r.label, fmt(r.value)]) });

export default function AnalyticsView({ slices, pasteTimes, dicts, settings }: {
  slices: Slice[]; pasteTimes: string[]; dicts: Dicts; settings: api.Settings;
}) {
  const [period, setPeriod] = useState<Period>("7");
  const [centre, setCentre] = useState("all");
  const [data, setData] = useState<api.AnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const range = useMemo(() => periodRange(period), [period]);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api.loadAnalytics(range.from.toISOString(), range.to.toISOString())); setErr(null); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }, [range]);
  useEffect(() => { load(); }, [load]);

  const a = useMemo(() => {
    if (!data) return null;
    const { from, to } = range;
    const inR = (iso: string | null | undefined) => !!iso && new Date(iso) >= from && new Date(iso) < to;
    const centreName = (id: number | null) => data.centres.find((c) => c.id === id)?.name || "Centre not recorded";
    const who = (email: string | null) => (email ? data.names[email] || email.split("@")[0] : "Unknown");
    const centreOk = (id: number | null) => centre === "all" || String(id) === centre;
    const centreLabel = centre === "all" ? null : centreName(Number(centre));
    const destOk = (d: string) => !centreLabel || d.trim().toLowerCase() === centreLabel.trim().toLowerCase();

    // Days (or hours, for a one-day period) along the x-axis
    const days: Date[] = [];
    for (let d = new Date(from); d < to; d.setDate(d.getDate() + 1)) days.push(new Date(d));
    const oneDay = days.length <= 1;
    const perDay = (isos: string[]) => {
      if (oneDay) {
        const h = Array(24).fill(0); isos.forEach((i) => h[new Date(i).getHours()]++);
        return h.map((v, i) => ({ label: `${String(i).padStart(2, "0")}h`, value: v, tip: `${String(i).padStart(2, "0")}:00–${String(i).padStart(2, "0")}:59` }));
      }
      const m = new Map<string, number>(); isos.forEach((i) => { const k = dayKey(new Date(i)); m.set(k, (m.get(k) || 0) + 1); });
      return days.map((d) => ({ label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }), value: m.get(dayKey(d)) || 0,
        tip: d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) }));
    };
    const byHour = (isos: string[]) => {
      const h = Array(24).fill(0); isos.forEach((i) => h[new Date(i).getHours()]++);
      return h.map((v, i) => ({ label: `${String(i).padStart(2, "0")}`, value: v, tip: `${String(i).padStart(2, "0")}:00–${String(i).padStart(2, "0")}:59, all days` }));
    };

    /* ---- transport ---- */
    const samples = data.samples.filter((s) => centreOk(s.centre_id));
    const collected = samples.filter((s) => s.source === "courier" && inR(s.collected_at));
    const received = samples.filter((s) => inR(s.received_at));
    const transits = received.filter((s) => s.source === "courier" && s.collected_at).map((s) => ({ s, m: mins(s.collected_at!, s.received_at!) }));
    const late = transits.filter((t) => t.m > data.transitAlertMinutes);
    const runs = data.runs.filter((r) => inR(r.started_at) && centreOk(r.centre_id));
    const emergencies = runs.filter((r) => r.is_emergency);
    const stillOut = samples.filter((s) => !s.received_at).length;
    const byCentre = count(collected, (s) => centreName(s.centre_id));
    const transitByCentre = [...new Set(transits.map((t) => t.s.centre_id))].map((id) => {
      const ms = transits.filter((t) => t.s.centre_id === id).map((t) => t.m);
      return { label: centreName(id), value: mean(ms) || 0, detail: `${centreName(id)}: average of ${ms.length} tube${ms.length === 1 ? "" : "s"}` };
    }).sort((x, y) => y.value - x.value);
    const byCourier = count(collected, (s) => who(s.collected_by));

    /* ---- reception ---- */
    const notLogged = received.filter((s) => s.source === "reception");
    const audit = data.audit.filter((r) => inR(r.at));
    const undone = audit.filter((r) => r.action.startsWith("Receipt undone"));
    const byStaff = count(received, (s) => s.received_by_name || who(s.received_by));
    const notLoggedByStaff = count(notLogged, (s) => s.received_by_name || who(s.received_by));

    /* ---- TAT (from the tracker; not split by centre) ---- */
    const rep = buildReport(slices, pasteTimes, from, to, dicts, settings.graceStd, settings.graceAlist);
    const o = aggNumbers(rep.overall);
    const nowMs = Date.now();
    const overdueNow = slices.filter((c) => c.status !== "Completed" &&
      verdict(c, new Date(c.reportDateTime).getTime() + ((c.isAlist ? settings.graceAlist : settings.graceStd) || 0) * 60000, nowMs).kind === "overdue");
    const deptRate = REPORT_DEPT_ORDER.filter((d) => rep.byDept[d]?.total).map((d) => {
      const ag = rep.byDept[d]!; const n = aggNumbers(ag);
      return { label: d, value: n.rate, detail: `${d}: ${n.delayed} of ${ag.onTime + n.delayed} delayed` };
    });
    const deptCases = REPORT_DEPT_ORDER.filter((d) => rep.byDept[d]?.total).map((d) => ({ label: d, value: rep.byDept[d]!.total }));
    const testsDelayed = rep.byTest.map((t) => { const n = aggNumbers(t); return { label: t.key, value: n.delayed, detail: `${t.key} (${t.department}): ${n.delayed} of ${t.total} delayed` }; })
      .filter((t) => t.value > 0);
    const overdueByDept = count(overdueNow, (c) => c.department);

    /* ---- report delivery ---- */
    const releases = data.releases.filter((r) => destOk(r.destination));
    const sheetOf = new Map(data.sheets.map((s) => [s.id, s]));
    const deliveries = data.deliveries.filter((d) => destOk(sheetOf.get(d.sheet_id)?.location || ""));
    const outcome = (st: api.DeliveryStatus) => deliveries.filter((d) => d.status === st).length;
    const delivered = outcome("D"), failed = outcome("ND") + outcome("CU") + outcome("C");
    const firstReceipt = new Map<string, string>();
    data.samples.forEach((s) => { if (s.r_number && s.received_at && (!firstReceipt.has(s.r_number) || s.received_at < firstReceipt.get(s.r_number)!)) firstReceipt.set(s.r_number, s.received_at); });
    const toRelease = releases.map((r) => firstReceipt.has(r.r_number) && firstReceipt.get(r.r_number)! < r.released_at ? mins(firstReceipt.get(r.r_number)!, r.released_at) : null).filter((x): x is number => x != null);
    const toDeliver = deliveries.filter((d) => d.status === "D" && d.recorded_at).map((d) => mins(d.picked_up_at, d.recorded_at!));
    const destRows = [...new Set(deliveries.map((d) => sheetOf.get(d.sheet_id)?.location || "Unknown"))].map((loc) => {
      const ds = deliveries.filter((d) => (sheetOf.get(d.sheet_id)?.location || "Unknown") === loc);
      const ok = ds.filter((d) => d.status === "D").length; const done = ds.filter((d) => d.status !== "pending").length;
      return { label: loc, value: ok, detail: `${loc}: ${ok} delivered of ${done} recorded (${pct(ok, done)}%)` };
    }).sort((x, y) => y.value - x.value);
    const reasons = count(deliveries.filter((d) => d.status !== "D" && d.status !== "pending"),
      (d) => `${d.status}: ${(d.reason || "No reason").trim().replace(/\s+/g, " ").slice(0, 60)}`);
    const byDeliveryCourier = count(deliveries.filter((d) => d.status === "D"), (d) => { const s = sheetOf.get(d.sheet_id); return s?.courier_name || who(s?.courier_email || null); });

    return {
      centreLabel, oneDay,
      t: { collected, received, transits, late, runs, emergencies, stillOut, byCentre, transitByCentre, byCourier,
        perDay: perDay(collected.map((s) => s.collected_at!)), hours: byHour(collected.map((s) => s.collected_at!)) },
      r: { received, notLogged, undone, byStaff, notLoggedByStaff, perDay: perDay(received.map((s) => s.received_at!)), hours: byHour(received.map((s) => s.received_at!)) },
      tat: { rep, o, overdueNow, deptRate, deptCases, testsDelayed, overdueByDept },
      d: { releases, deliveries, delivered, failed, outcome, toRelease, toDeliver, destRows, reasons, byDeliveryCourier,
        perDay: perDay(deliveries.filter((d) => d.status === "D" && d.recorded_at).map((d) => d.recorded_at!)) },
    };
  }, [data, range, centre, slices, pasteTimes, dicts, settings]);

  const tables = useMemo(() => {
    if (!a) return null;
    const dayHead = a.oneDay ? "Hour" : "Day";
    return {
      collectedPerDay: { head: [dayHead, "Samples collected"], rows: a.t.perDay.map((p) => [p.tip, p.value]) },
      byCentre: toTable(["Centre or depot", "Samples collected"], a.t.byCentre),
      transitByCentre: toTable(["Centre or depot", "Average transit"], a.t.transitByCentre, (v) => formatMinutes(v)),
      byCourier: toTable(["Courier", "Samples collected"], a.t.byCourier),
      collectHours: { head: ["Hour", "Samples collected"], rows: a.t.hours.map((p) => [p.tip, p.value]) },
      receivedPerDay: { head: [dayHead, "Samples received"], rows: a.r.perDay.map((p) => [p.tip, p.value]) },
      byStaff: toTable(["Staff member", "Samples received"], a.r.byStaff),
      notLoggedByStaff: toTable(["Staff member", "Received, not logged by courier"], a.r.notLoggedByStaff),
      receiveHours: { head: ["Hour", "Samples received"], rows: a.r.hours.map((p) => [p.tip, p.value]) },
      deptRate: { head: ["Department", "Delay rate %", "Cases"], rows: a.tat.deptRate.map((d, i) => [d.label, d.value, a.tat.deptCases[i]?.value ?? ""]) },
      testsDelayed: toTable(["Test", "Delayed"], a.tat.testsDelayed),
      overdueByDept: toTable(["Department", "Overdue now"], a.tat.overdueByDept),
      outcomes: { head: ["Outcome", "Reports"], rows: [["Delivered (D)", a.d.outcome("D")], ["Not delivered (ND)", a.d.outcome("ND")], ["Client unavailable (CU)", a.d.outcome("CU")], ["Closed (C)", a.d.outcome("C")], ["Still out with courier", a.d.outcome("pending")]] },
      deliveredPerDay: { head: [dayHead, "Reports delivered"], rows: a.d.perDay.map((p) => [p.tip, p.value]) },
      destRows: toTable(["Destination", "Delivered"], a.d.destRows),
      reasons: toTable(["Reason", "Reports"], a.d.reasons),
      byDeliveryCourier: toTable(["Courier", "Reports delivered"], a.d.byDeliveryCourier),
    };
  }, [a]);

  function exportCsv() {
    if (!a || !tables) return;
    const p = PERIODS.find(([k]) => k === period)![1];
    const lines: string[] = [`Analytics,${csvCell(p)},${csvCell(range.from.toLocaleString())} to ${csvCell(range.to.toLocaleString())},${csvCell(a.centreLabel || "All centres")}`, ""];
    const summary: [string, string | number][] = [
      ["Samples collected", a.t.collected.length], ["Samples received", a.r.received.length], ["Average transit (min)", Math.round(mean(a.t.transits.map((t) => t.m)) ?? 0)],
      ["Late (over alert time)", a.t.late.length], ["Collections", a.t.runs.length], ["Emergency collections", a.t.emergencies.length],
      ["Received, not logged by courier", a.r.notLogged.length], ["Receipts undone", a.r.undone.length],
      ["TAT cases", a.tat.rep.cases], ["TAT on time", a.tat.rep.overall.onTime], ["TAT delayed", a.tat.o.delayed], ["TAT delay rate %", a.tat.o.rate], ["Overdue now", a.tat.overdueNow.length],
      ["Reports released", a.d.releases.length], ["Reports picked up", a.d.deliveries.length], ["Delivered", a.d.delivered], ["Not delivered", a.d.failed],
      ["Average receipt to release (min)", Math.round(mean(a.d.toRelease) ?? 0)], ["Average pick-up to delivery (min)", Math.round(mean(a.d.toDeliver) ?? 0)],
    ];
    lines.push("Summary", ...summary.map(([k, v]) => `${csvCell(k)},${v}`), "");
    Object.values(tables).forEach((t) => { lines.push(t.head.map(csvCell).join(","), ...t.rows.map((r) => r.map(csvCell).join(",")), ""); });
    downloadFile(`analytics_${stamp()}.csv`, lines.join("\n"), "text/csv;charset=utf-8;");
  }

  const centreOptions = useMemo(() => (data?.centres || []).filter((c) => c.active || data?.samples.some((s) => s.centre_id === c.id)), [data]);

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-5">
      <h1 className="text-xl font-semibold text-ink mb-1">Analytics</h1>
      <p className="text-sm text-ink-2 mb-4">Everything the app records, from courier collection to report delivery. Only admins can see this page.</p>

      <div className="flex flex-wrap gap-2 items-center mb-5">
        <select className={inputBase} value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label="Period">
          {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className={inputBase} value={centre} onChange={(e) => setCentre(e.target.value)} aria-label="Centre or depot">
          <option value="all">All centres and depots</option>
          {centreOptions.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
        </select>
        {loading && <span className="text-sm text-ink-3">Loading…</span>}
        <span className="ml-auto flex gap-3">
          <Button tone="quiet" onClick={load}>Refresh</Button>
          <Button tone="quiet" onClick={exportCsv} disabled={!a}>Export all (CSV)</Button>
        </span>
      </div>

      {err && <Note tone="err">Couldn't load analytics: {err}</Note>}
      {data?.truncated && <Note tone="warn">This period has more than 30,000 rows of one kind; only the first 30,000 are counted. Pick a shorter period for exact figures.</Note>}
      {!a && !err && <p className="text-ink-3">Loading…</p>}

      {a && tables && (
        <div className={`space-y-8 transition-opacity ${loading ? "opacity-60" : ""}`}>
          {/* ---------- headline ---------- */}
          <section className="card p-5 flex flex-wrap gap-x-12 gap-y-5 items-end">
            <div>
              <p className="text-sm text-ink-2">Samples received{a.centreLabel ? ` from ${a.centreLabel}` : ""}</p>
              <p className="text-5xl font-semibold text-ink leading-tight">{a.r.received.length.toLocaleString()}</p>
            </div>
            <Stat label="Average transit" value={fmtMin(mean(a.t.transits.map((t) => t.m)))} />
            <Stat label="TAT delay rate" value={`${a.tat.o.rate}%`} color={a.tat.o.rate >= 20 ? C.danger : C.ink} sub={`${a.tat.o.delayed} of ${a.tat.rep.overall.onTime + a.tat.o.delayed} cases`} />
            <Stat label="Reports delivered" value={a.d.delivered.toLocaleString()} sub={`${pct(a.d.delivered, a.d.delivered + a.d.failed)}% of attempts`} />
            <Stat label="Overdue now" value={a.tat.overdueNow.length} color={a.tat.overdueNow.length ? C.danger : C.ink} sub="Across the tracker" />
          </section>

          {/* ---------- transport ---------- */}
          <Section title="Sample transport" sub="Courier collections from centres and depots, and time on the road.">
            <div className="flex flex-wrap gap-x-10 gap-y-4 mb-4">
              <Stat label="Samples collected" value={a.t.collected.length.toLocaleString()} />
              <Stat label="Collections" value={a.t.runs.length} />
              <Stat label="Emergency collections" value={a.t.emergencies.length} color={a.t.emergencies.length ? C.warning : C.ink} />
              <Stat label="Average transit" value={fmtMin(mean(a.t.transits.map((t) => t.m)))} />
              <Stat label={`Over ${formatMinutes(data!.transitAlertMinutes)} in transit`} value={a.t.late.length} color={a.t.late.length ? C.danger : C.ink}
                sub={`${pct(a.t.late.length, a.t.transits.length)}% of received tubes`} />
              <Stat label="Still in transit" value={a.t.stillOut} />
            </div>
            <div className="grid lg:grid-cols-2 gap-4">
              <ChartCard className="lg:col-span-2" title={a.oneDay ? "Samples collected by hour" : "Samples collected per day"} table={tables.collectedPerDay}>
                <Columns points={a.t.perDay} />
              </ChartCard>
              <ChartCard title="Samples by centre or depot" sub="Busiest first" table={tables.byCentre}><BarList rows={a.t.byCentre} /></ChartCard>
              <ChartCard title="Average transit time by centre" sub="Collection to reception. Slowest first" table={tables.transitByCentre}>
                <BarList rows={a.t.transitByCentre} format={(v) => formatMinutes(v)} limit={100} />
              </ChartCard>
              <ChartCard title="Samples collected by courier" table={tables.byCourier}><BarList rows={a.t.byCourier} /></ChartCard>
              <ChartCard title="Collections by time of day" sub="All days in the period together" table={tables.collectHours}>
                <Columns points={a.t.hours} height={160} labelEvery={3} />
              </ChartCard>
            </div>
          </Section>

          {/* ---------- reception ---------- */}
          <Section title="Reception and staff" sub="Who received samples at pre-analytical, and when.">
            {data!.auditMissing && <Note tone="info">Receipts undone need the receipt history (12_sample_receipt_audit.sql).</Note>}
            <div className="flex flex-wrap gap-x-10 gap-y-4 mb-4">
              <Stat label="Samples received" value={a.r.received.length.toLocaleString()} />
              <Stat label="Staff receiving" value={a.r.byStaff.length} />
              <Stat label="Received, not logged by courier" value={a.r.notLogged.length} color={a.r.notLogged.length ? C.warning : C.ink}
                sub={`${pct(a.r.notLogged.length, a.r.received.length)}% of receipts`} />
              <Stat label="Receipts undone" value={a.r.undone.length} color={a.r.undone.length ? C.danger : C.ink} />
            </div>
            <div className="grid lg:grid-cols-2 gap-4">
              <ChartCard className="lg:col-span-2" title={a.oneDay ? "Samples received by hour" : "Samples received per day"} table={tables.receivedPerDay}>
                <Columns points={a.r.perDay} />
              </ChartCard>
              <ChartCard title="Samples received by staff member" table={tables.byStaff}><BarList rows={a.r.byStaff} /></ChartCard>
              <ChartCard title="Busiest reception hours" sub="All days in the period together" table={tables.receiveHours}>
                <Columns points={a.r.hours} height={160} labelEvery={3} />
              </ChartCard>
              <ChartCard title="Received without a courier record, by staff member" sub="Samples the courier didn't log" table={tables.notLoggedByStaff}>
                <BarList rows={a.r.notLoggedByStaff} />
              </ChartCard>
            </div>
          </Section>

          {/* ---------- TAT ---------- */}
          <Section title="Test turnaround (TAT)" sub="From the MT outstanding list in the tracker, using the delay report's grace times. Not split by centre.">
            <div className="flex flex-wrap gap-x-10 gap-y-4 mb-4">
              <Stat label="Cases in period" value={a.tat.rep.cases.toLocaleString()} />
              <Stat label="On time" value={a.tat.rep.overall.onTime.toLocaleString()} color={C.success} />
              <Stat label="Delayed" value={a.tat.o.delayed.toLocaleString()} color={a.tat.o.delayed ? C.danger : C.ink} />
              <Stat label="Delay rate" value={`${a.tat.o.rate}%`} />
              <Stat label="Average delay" value={a.tat.o.delayed ? formatMinutes(a.tat.o.avgMax) : "–"} sub="Upper estimate" />
              <Stat label="Overdue now" value={a.tat.overdueNow.length} color={a.tat.overdueNow.length ? C.danger : C.ink} />
            </div>
            <div className="grid lg:grid-cols-2 gap-4">
              <ChartCard title="Delay rate by department" sub="Delayed as a share of cases judged" table={tables.deptRate}>
                <BarList rows={a.tat.deptRate} format={(v) => `${v}`} unit="%" limit={100} />
              </ChartCard>
              <ChartCard title="Tests delayed most often" table={tables.testsDelayed}><BarList rows={a.tat.testsDelayed} /></ChartCard>
              <ChartCard title="Overdue now, by department" sub="Cases past their TAT that are still outstanding" table={tables.overdueByDept}>
                <BarList rows={a.tat.overdueByDept} />
              </ChartCard>
            </div>
          </Section>

          {/* ---------- delivery ---------- */}
          <Section title="Report delivery" sub="Releases by post-analytical and courier deliveries back to centres.">
            <div className="flex flex-wrap gap-x-10 gap-y-4 mb-4">
              <Stat label="Reports released" value={a.d.releases.length.toLocaleString()} />
              <Stat label="Picked up by couriers" value={a.d.deliveries.length.toLocaleString()} />
              <Stat label="Delivered" value={a.d.delivered.toLocaleString()} color={C.success} />
              <Stat label="Not delivered" value={a.d.failed} color={a.d.failed ? C.warning : C.ink} sub="ND, CU or C" />
              <Stat label="Average receipt to release" value={fmtMin(mean(a.d.toRelease))} />
              <Stat label="Average pick-up to delivery" value={fmtMin(mean(a.d.toDeliver))} />
            </div>
            <div className="grid lg:grid-cols-2 gap-4">
              <ChartCard className="lg:col-span-2" title="Delivery outcomes" sub="Reports picked up in the period" table={tables.outcomes}>
                <SegBar parts={[
                  { label: "Delivered (D)", value: a.d.outcome("D"), color: C.success, ink: C.surface },
                  { label: "Not delivered (ND)", value: a.d.outcome("ND"), color: C.danger, ink: C.surface },
                  { label: "Client unavailable (CU)", value: a.d.outcome("CU"), color: C.warning, ink: C.surface },
                  { label: "Closed (C)", value: a.d.outcome("C"), color: C.ink3, ink: C.surface },
                  { label: "Still out with courier", value: a.d.outcome("pending"), color: C.accent, ink: C.surface },
                ]} />
              </ChartCard>
              <ChartCard className="lg:col-span-2" title={a.oneDay ? "Reports delivered by hour" : "Reports delivered per day"} table={tables.deliveredPerDay}>
                <Columns points={a.d.perDay} />
              </ChartCard>
              <ChartCard title="Delivered by destination" table={tables.destRows}><BarList rows={a.d.destRows} /></ChartCard>
              <ChartCard title="Why reports weren't delivered" table={tables.reasons}><BarList rows={a.d.reasons} /></ChartCard>
              <ChartCard title="Reports delivered by courier" table={tables.byDeliveryCourier}><BarList rows={a.d.byDeliveryCourier} /></ChartCard>
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <p className="text-sm text-ink-2 mb-4">{sub}</p>
      {children}
    </section>
  );
}
