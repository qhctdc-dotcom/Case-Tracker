import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { EMAIL_ACCOUNT_LABEL, readReport, type ParsedReport, type ReportRow } from "../lib/emailReport";
import { fmtIso } from "../lib/tracker";
import { Badge, Button, C, Modal, Note, Stat, csvCell, downloadFile, inputBase, stamp, tint } from "./ui";

type Tab = "work" | "flagged" | "worked" | "history";
type CheckState = Record<number, { r: string; acc: string; ok: boolean; skip: boolean }>;

/** What an upload would do, compared with what is stored (same rules as the database). */
function plan(rows: { r_number: string }[], items: api.EmailItem[], mode: "full" | "partial") {
  // Matched on Req # only: Acc # is not unique (the same Acc # can be on different requisitions)
  const byR = new Map(items.map((i) => [i.r_number, i]));
  const touched = new Set<number>();
  const seenNew = new Set<string>();
  const p = { new: 0, carried: 0, flagged: [] as string[], back: 0, cleared: 0 };
  for (const row of rows) {
    const it = byR.get(row.r_number);
    if (it && touched.has(it.id)) continue;
    if (!it) { if (!seenNew.has(row.r_number)) { seenNew.add(row.r_number); p.new++; } continue; }
    touched.add(it.id);
    if (it.status === "open") p.carried++;
    else if (it.status === "worked" || it.status === "removed") p.flagged.push(it.r_number);
    else p.back++;
  }
  if (mode === "full") p.cleared = items.filter((i) => i.status !== "cleared" && !touched.has(i.id)).length;
  return p;
}

export default function EmailTrackingView({ toast }: { toast: (m: string, t?: "ok" | "err") => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.loadEmailTracking>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("work");
  const [search, setSearch] = useState("");
  const [sel, setSel] = useState<Record<number, boolean>>({});
  const [reading, setReading] = useState<{ msg: string; pct: number } | null>(null);
  const [report, setReport] = useState<(ParsedReport & { fileName: string }) | null>(null);
  const [checks, setChecks] = useState<CheckState>({});
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { setData(await api.loadEmailTracking()); setErr(null); } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => {
    load();
    let t: number | undefined;
    const unsub = api.subscribeEmail(() => { clearTimeout(t); t = window.setTimeout(load, 700); });
    return () => { unsub(); clearTimeout(t); };
  }, [load]);
  useEffect(() => { setSel({}); }, [tab]);

  /* ---------- upload ---------- */
  async function onFile(file?: File) {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setReading({ msg: "Opening the file…", pct: 0 });
    try {
      const r = await readReport(file, (msg, pct) => setReading({ msg, pct }));
      if (!r.rows.length && !r.unreadable.length) {
        toast(`No ${EMAIL_ACCOUNT_LABEL} rows found in "${file.name}". Check it is the Doctor's Patient Search report.`, "err");
        return;
      }
      const c: CheckState = {};
      r.rows.forEach((row, i) => { if (row.needsCheck) c[i] = { r: row.r_number, acc: row.acc_number, ok: false, skip: false }; });
      setChecks(c);
      setReport({ ...r, fileName: file.name });
    } catch (e: any) {
      toast(`Couldn't read "${file.name}": ${e.message}`, "err");
    } finally { setReading(null); }
  }

  const finalRows = useMemo(() => {
    if (!report) return [];
    return report.rows.flatMap((row, i) => {
      const c = checks[i];
      if (c?.skip) return [];
      const r = (c ? c.r : row.r_number).replace(/\D/g, "");
      return [{ r_number: r, acc_number: c ? c.acc.toUpperCase().replace(/[^A-Z0-9]/g, "") : row.acc_number,
        collection: row.collection, entered: row.entered }];
    });
  }, [report, checks]);

  const unresolved = Object.values(checks).filter((c) => !c.ok && !c.skip).length;
  const badReq = Object.values(checks).filter((c) => !c.skip && !/^\d{9}$/.test(c.r.replace(/\D/g, ""))).length;

  async function apply(mode: "full" | "partial") {
    if (!report) return;
    setSaving(true);
    try {
      const s = await api.emailApplyUpload(report.fileName, report.source, report.runDate, mode, finalRows);
      toast(`Upload saved: ${s.new} new, ${s.carried_over} still to work, ${s.flagged} flagged for removal${mode === "full" ? `, ${s.cleared} cleared` : ""}.`);
      setReport(null);
      setTab(s.flagged ? "flagged" : "work");
      await load();
    } catch (e: any) { toast(`${e.message}. Nothing was saved.`, "err"); }
    finally { setSaving(false); }
  }

  async function undoUpload() {
    const b = data?.batches.find((x) => !x.undone_at);
    if (!b) return;
    if (!confirm(`Undo the upload of "${b.file_name}" (${fmtIso(b.uploaded_at)})?\n\nEvery requisition goes back to how it was before that upload.`)) return;
    try { await api.emailUndoUpload(); toast("Upload undone."); await load(); } catch (e: any) { toast(e.message, "err"); }
  }

  /* ---------- lists ---------- */
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const lists = useMemo(() => {
    const items = data?.items || [];
    const q = search.replace(/\D/g, "");
    const m = (i: api.EmailItem) => !q || i.r_number.includes(q) || (i.acc_number || "").includes(q);
    return {
      work: items.filter((i) => i.status === "open" && m(i)).sort((a, b) => (a.collection || "").localeCompare(b.collection || "")),
      flagged: items.filter((i) => i.duplicate_flag && m(i)).sort((a, b) => (a.flagged_at || "").localeCompare(b.flagged_at || "")),
      worked: items.filter((i) => ((i.status === "worked" && !i.duplicate_flag) || i.status === "removed") && m(i))
        .sort((a, b) => (b.removed_at || b.worked_at || "").localeCompare(a.removed_at || a.worked_at || "")),
    };
  }, [data, search]);
  const latest = data?.batches.find((b) => !b.undone_at) || null;
  const workedToday = (data?.items || []).filter((i) => i.worked_at && new Date(i.worked_at) >= today).length;

  const selected = Object.keys(sel).filter((k) => sel[Number(k)]).map(Number);
  async function markWorked(ids: number[]) {
    try { const n = await api.emailMarkWorked(ids); toast(`${n} marked as worked.`); setSel({}); await load(); } catch (e: any) { toast(e.message, "err"); }
  }
  async function markRemoved(ids: number[]) {
    if (!confirm(`Confirm ${ids.length} duplicate${ids.length === 1 ? " has" : "s have"} been removed from Meditech?`)) return;
    try { const n = await api.emailMarkRemoved(ids); toast(`${n} marked as removed.`); setSel({}); await load(); } catch (e: any) { toast(e.message, "err"); }
  }
  function copyFlagged() {
    const txt = lists.flagged.map((i) => i.r_number).join("\n");
    navigator.clipboard?.writeText(txt).then(() => toast(`${lists.flagged.length} Req #s copied.`), () => toast("Couldn't copy; use Export instead.", "err"));
  }
  function exportCsv(which: "work" | "flagged" | "worked") {
    const rows = [["Req #", "Acc #", "Collected", "Entered", "Status", "Flagged for removal", "Times flagged", "Worked by", "Worked at", "Removed by", "Removed at"].join(",")];
    lists[which].forEach((i) => rows.push([i.r_number, i.acc_number || "", i.collection || "", i.entered || "", i.status, i.duplicate_flag ? "Yes" : "",
      i.times_flagged, csvCell(i.worked_by), fmtIso(i.worked_at), csvCell(i.removed_by), fmtIso(i.removed_at)].join(",")));
    downloadFile(`email_tracking_${which}_${stamp()}.csv`, rows.join("\n"), "text/csv;charset=utf-8;");
  }

  const p = report ? plan(finalRows, data?.items || [], "full") : null;
  const openNow = (data?.items || []).filter((i) => i.status !== "cleared").length;
  const bigClear = p ? p.cleared >= 10 && p.cleared > 0.4 * openNow : false;

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-5">
      {err && <Note tone="err">Couldn't load email tracking: {err}. Has 09_email_tracking.sql been run in Supabase?</Note>}

      <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div>
          <h1 className="text-xl font-semibold text-ink">Email tracking</h1>
          <p className="text-sm text-ink-2">{EMAIL_ACCOUNT_LABEL}. Upload each day's Meditech report (scanned printout or Meditech file).</p>
          {latest && <p className="text-sm text-ink-3 mt-0.5">Last upload: {latest.file_name} ({latest.run_date ? `run ${latest.run_date}, ` : ""}{fmtIso(latest.uploaded_at)} by {latest.uploaded_by.split("@")[0]}). <button className="text-accent underline cursor-pointer" onClick={undoUpload}>Undo it</button></p>}
        </div>
        <div>
          <input ref={fileRef} type="file" accept=".pdf,.txt,application/pdf,text/plain" className="sr-only" id="email-upload" onChange={(e) => onFile(e.target.files?.[0])} />
          <label htmlFor="email-upload" className="inline-flex items-center rounded-md px-4 py-2 text-base font-semibold cursor-pointer bg-accent text-accent-ink">Upload today's report</label>
        </div>
      </div>

      <div className="flex gap-8 sm:gap-12 flex-wrap mb-5">
        <Stat label="To work" value={lists.work.length} color={lists.work.length ? C.accent : C.ink} />
        <Stat label="Flagged for duplicate removal" value={lists.flagged.length} color={lists.flagged.length ? C.danger : C.ink} />
        <Stat label="Worked today" value={workedToday} color={C.success} />
      </div>

      <div className="flex flex-wrap gap-2 items-center mb-4">
        <div role="tablist" className="inline-flex rounded-lg border overflow-hidden" style={{ borderColor: C.line }}>
          {([["work", `To work (${lists.work.length})`], ["flagged", `Flagged for removal (${lists.flagged.length})`], ["worked", "Worked"], ["history", "Uploads"]] as const).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className="px-4 py-2 text-sm cursor-pointer"
              style={{ background: tab === k ? (k === "flagged" && lists.flagged.length ? C.danger : C.ink) : C.surface, color: tab === k ? C.surface : C.ink, fontWeight: tab === k ? 600 : 400 }}>
              {label}
            </button>
          ))}
        </div>
        {tab !== "history" && <input className={`${inputBase} w-56`} placeholder="Find Req # or Acc #" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find" />}
        {tab !== "history" && <Button tone="quiet" className="ml-auto" onClick={() => exportCsv(tab)}>Export (CSV)</Button>}
      </div>

      {tab === "work" && (
        <ItemTable items={lists.work} sel={sel} setSel={setSel} latestBatch={latest?.id ?? null} mode="work"
          bulk={selected.length > 0 && <Button tone="primary" onClick={() => markWorked(selected)}>Mark {selected.length} as worked</Button>}
          rowAction={(i) => <Button onClick={() => markWorked([i.id])}>Worked</Button>}
          empty="Nothing waiting. Upload today's report to see what needs working." />
      )}
      {tab === "flagged" && (
        <>
          <Note tone="warn">These requisitions were already worked but are <b>still in the latest report</b>. Remove the duplicates in Meditech, then mark them here.</Note>
          <ItemTable items={lists.flagged} sel={sel} setSel={setSel} latestBatch={latest?.id ?? null} mode="flagged"
            bulk={<>
              {selected.length > 0 && <Button tone="primary" onClick={() => markRemoved(selected)}>Mark {selected.length} as removed</Button>}
              {lists.flagged.length > 0 && <Button onClick={copyFlagged}>Copy all Req #s</Button>}
            </>}
            rowAction={(i) => <Button onClick={() => markRemoved([i.id])}>Removed</Button>}
            empty="No duplicates flagged." />
        </>
      )}
      {tab === "worked" && (
        <ItemTable items={lists.worked} sel={{}} setSel={() => {}} latestBatch={latest?.id ?? null} mode="worked"
          rowAction={(i) => <Button tone="quiet" onClick={async () => {
            try { if (i.status === "removed") await api.emailUndoRemoved(i.id); else await api.emailUndoWorked(i.id); await load(); } catch (e: any) { toast(e.message, "err"); }
          }}>Undo</Button>}
          empty="Nothing worked yet." />
      )}
      {tab === "history" && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-ink-3" style={{ background: C.raised }}>
              {["Uploaded", "By", "File", "Type", "Report run", "Rows", "New", "To work", "Flagged", "Cleared", ""].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
            </tr></thead>
            <tbody>
              {(data?.batches || []).map((b) => (
                <tr key={b.id} className="border-t" style={{ borderColor: C.line, opacity: b.undone_at ? 0.5 : 1 }}>
                  <td className="px-3 py-2 num">{fmtIso(b.uploaded_at)}</td>
                  <td className="px-3 py-2">{b.uploaded_by.split("@")[0]}</td>
                  <td className="px-3 py-2">{b.file_name}</td>
                  <td className="px-3 py-2">{b.source === "scan" ? "Scanned" : "Meditech file"}{b.mode === "partial" ? ", add only" : ""}</td>
                  <td className="px-3 py-2 num">{b.run_date || ""}</td>
                  <td className="px-3 py-2 num">{b.row_count}</td>
                  <td className="px-3 py-2 num">{b.stats?.new ?? ""}</td>
                  <td className="px-3 py-2 num">{b.stats?.carried_over ?? ""}</td>
                  <td className="px-3 py-2 num">{b.stats?.flagged ?? ""}</td>
                  <td className="px-3 py-2 num">{b.stats?.cleared ?? ""}</td>
                  <td className="px-3 py-2">{b.undone_at && <Badge color={C.ink3}>Undone</Badge>}</td>
                </tr>
              ))}
              {!data?.batches.length && <tr><td className="px-3 py-6 text-ink-3" colSpan={11}>No uploads yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* Reading progress */}
      <Modal open={!!reading} onClose={() => {}} title="Reading the report">
        <p className="text-ink mb-2">{reading?.msg}</p>
        <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--track)" }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${reading?.pct ?? 0}%`, background: C.accent }} />
        </div>
        <p className="text-xs text-ink-3 mt-2">Scanned printouts take about 10 seconds a page. Keep this window open.</p>
      </Modal>

      {/* Review before saving */}
      <Modal open={!!report} onClose={() => !saving && setReport(null)} wide title="Check this upload">
        {report && p && (
          <>
            <p className="text-sm text-ink-2 mb-3">
              <b>{report.fileName}</b>: {report.source === "scan" ? "scanned printout (read by OCR)" : "Meditech file"}
              {report.runDate ? `, report run ${report.runDate}` : ""}, {report.pages} page{report.pages === 1 ? "" : "s"}.
              {" "}{report.rows.length} {EMAIL_ACCOUNT_LABEL} row{report.rows.length === 1 ? "" : "s"} found
              {Object.keys(report.accounts).length > 1 && <> (other accounts ignored: {Object.entries(report.accounts).filter(([k]) => !k.toUpperCase().replace(/[^A-Z]/g, "").includes("LANCETLABORATORIESEMAIL")).map(([k, n]) => `${k} ${n}`).join(", ")})</>}.
            </p>

            <dl className="text-sm mb-4">
              {([["New to the list", p.new], ["Still to work (carried over)", p.carried], ["Already worked: will be FLAGGED for duplicate removal", p.flagged.length],
                ...(p.back ? [["Back in the report after leaving it", p.back]] : []),
                ["No longer in the report: will be cleared", p.cleared]] as [string, number][]).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 py-1.5 border-b" style={{ borderColor: C.line }}>
                  <dt className="text-ink-2">{k}</dt><dd className="num font-semibold" style={{ color: k.includes("FLAGGED") && v ? C.danger : C.ink }}>{v}</dd>
                </div>
              ))}
            </dl>

            {bigClear && <Note tone="warn"><b>Is this the whole report?</b> {p.cleared} requisitions would be cleared. If you uploaded only part of the report, use <b>Add / update only</b>.</Note>}

            {Object.keys(checks).length > 0 && (
              <div className="mb-4">
                <p className="font-semibold text-ink mb-1">Please check {Object.keys(checks).length} row{Object.keys(checks).length === 1 ? "" : "s"} the scan couldn't read clearly</p>
                <p className="text-xs text-ink-3 mb-2">Compare the number with the picture. Correct it if needed, then tick <b>Correct</b>, or <b>Leave out</b> the row.</p>
                <ul className="space-y-2">
                  {Object.entries(checks).map(([k, c]) => {
                    const row = report.rows[Number(k)] as ReportRow;
                    const valid = /^\d{9}$/.test(c.r.replace(/\D/g, ""));
                    return (
                      <li key={k} className="rounded-md p-2.5" style={{ background: c.ok ? tint(C.success, 8) : c.skip ? C.raised : tint(C.warning, 10), border: `1px solid ${C.line}` }}>
                        {row.crop && <img src={row.crop} alt={`Scanned line for Req # ${row.r_number}`} className="w-full max-w-xl rounded mb-2 border bg-white" style={{ borderColor: C.line }} />}
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="text-sm text-ink-2">Req # <input className={`${inputBase} num w-36 ml-1`} value={c.r} disabled={c.skip}
                            onChange={(e) => setChecks({ ...checks, [k]: { ...c, r: e.target.value, ok: false } })} style={!valid && !c.skip ? { borderColor: C.danger } : undefined} /></label>
                          <label className="text-sm text-ink-2">Acc # <input className={`${inputBase} num w-28 ml-1`} value={c.acc} disabled={c.skip}
                            onChange={(e) => setChecks({ ...checks, [k]: { ...c, acc: e.target.value, ok: false } })} /></label>
                          <label className="flex items-center gap-1.5 text-sm text-ink cursor-pointer">
                            <input type="checkbox" className="w-4 h-4" disabled={c.skip || !valid} checked={c.ok} onChange={(e) => setChecks({ ...checks, [k]: { ...c, ok: e.target.checked } })} /> Correct
                          </label>
                          <label className="flex items-center gap-1.5 text-sm text-ink-2 cursor-pointer">
                            <input type="checkbox" className="w-4 h-4" checked={c.skip} onChange={(e) => setChecks({ ...checks, [k]: { ...c, skip: e.target.checked, ok: false } })} /> Leave out
                          </label>
                          <span className="text-xs text-ink-3">page {row.page}: {row.why.join(", ")}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {report.unreadable.length > 0 && (
              <Note tone="err">{report.unreadable.length} line{report.unreadable.length === 1 ? "" : "s"} couldn't be read at all and will be left out. If one of them matters, upload a clearer scan or the Meditech file.</Note>
            )}

            {unresolved > 0 && <p className="text-sm mb-2" style={{ color: C.warning }}>Tick <b>Correct</b> or <b>Leave out</b> on every row above before saving ({unresolved} left).</p>}
            <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-3 items-start">
              <div>
                <Button tone="primary" className="w-full" disabled={saving || unresolved > 0 || badReq > 0} onClick={() => apply("full")}>{saving ? "Saving…" : "Apply full report"}</Button>
                <p className="text-xs text-ink-3 mt-1">This is today's complete report. Requisitions not in it are cleared.</p>
              </div>
              <div>
                <Button className="w-full" disabled={saving || unresolved > 0 || badReq > 0} onClick={() => apply("partial")}>Add / update only</Button>
                <p className="text-xs text-ink-3 mt-1">Part of the report. Nothing is cleared.</p>
              </div>
              <Button tone="quiet" disabled={saving} onClick={() => setReport(null)}>Cancel</Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

function ItemTable({ items, sel, setSel, mode, bulk, rowAction, empty, latestBatch }: {
  items: api.EmailItem[]; sel: Record<number, boolean>; setSel: (s: Record<number, boolean>) => void; mode: "work" | "flagged" | "worked";
  bulk?: React.ReactNode; rowAction: (i: api.EmailItem) => React.ReactNode; empty: string; latestBatch: number | null;
}) {
  const selectable = mode !== "worked";
  const all = items.length > 0 && items.every((i) => sel[i.id]);
  return (
    <div className="card overflow-hidden">
      {(bulk || selectable) && items.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-b flex-wrap" style={{ borderColor: C.line, background: C.raised }}>
          {selectable && <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
            <input type="checkbox" className="w-4 h-4" checked={all} onChange={(e) => setSel(e.target.checked ? Object.fromEntries(items.map((i) => [i.id, true])) : {})} /> Select all
          </label>}
          {bulk}
        </div>
      )}
      {!items.length ? <p className="p-6 text-ink-3 text-sm">{empty}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-ink-3">
              {selectable && <th className="px-4 py-2 w-8"></th>}
              {["Req #", "Acc #", "Collected", "Entered", mode === "work" ? "On the list" : mode === "flagged" ? "Worked" : "Done", mode === "flagged" ? "Flagged" : "", ""].map((h, i) =>
                <th key={i} className="px-3 py-2 font-medium">{h}</th>)}
            </tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-t" style={{ borderColor: C.line, background: sel[i.id] ? tint(C.accent, 7) : undefined }}>
                  {selectable && <td className="px-4 py-2"><input type="checkbox" className="w-4 h-4" checked={!!sel[i.id]} onChange={(e) => setSel({ ...sel, [i.id]: e.target.checked })} aria-label={`Select ${i.r_number}`} /></td>}
                  <td className="px-3 py-2 num font-semibold text-ink">{i.r_number}</td>
                  <td className="px-3 py-2 num text-ink-2">{i.acc_number}</td>
                  <td className="px-3 py-2 num text-ink-2">{i.collection}</td>
                  <td className="px-3 py-2 num text-ink-2">{i.entered}</td>
                  <td className="px-3 py-2 text-ink-2">
                    {mode === "work" && (i.first_batch_id === latestBatch ? <Badge color={C.accent}>New today</Badge> : <Badge color={C.warning}>Carried over</Badge>)}
                    {mode === "flagged" && <>{(i.worked_by || "").split("@")[0]}, <span className="num">{fmtIso(i.worked_at)}</span></>}
                    {mode === "worked" && (i.status === "removed"
                      ? <>Duplicate removed by {(i.removed_by || "").split("@")[0]}, <span className="num">{fmtIso(i.removed_at)}</span></>
                      : <>Worked by {(i.worked_by || "").split("@")[0]}, <span className="num">{fmtIso(i.worked_at)}</span></>)}
                  </td>
                  <td className="px-3 py-2 text-ink-2">{mode === "flagged" && <>{i.times_flagged > 1 ? <Badge color={C.danger}>{i.times_flagged}× flagged</Badge> : "Since"} <span className="num">{fmtIso(i.flagged_at)}</span></>}</td>
                  <td className="px-3 py-2 text-right">{rowAction(i)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
