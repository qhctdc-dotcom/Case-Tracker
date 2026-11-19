import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { formatMinutes } from "../lib/tracker";
import { C, Note } from "./ui";

/** Lab view: released reports waiting for a courier, grouped by the centre they are going to. */
export default function ReadyForPickup() {
  const [rows, setRows] = useState<api.ReportRelease[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try { setRows(await api.loadWaitingReleases()); setErr(null); } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => {
    load();
    let t: number | undefined;
    const unsub = api.subscribeReleases(() => { clearTimeout(t); t = window.setTimeout(load, 700); });
    const tick = setInterval(() => setNow(Date.now()), 60000);
    return () => { unsub(); clearTimeout(t); clearInterval(tick); };
  }, [load]);

  const groups = useMemo(() => {
    const m = new Map<string, api.ReportRelease[]>();
    (rows || []).forEach((r) => m.set(r.destination, [...(m.get(r.destination) || []), r]));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const ago = (iso: string) => ((m) => (m < 1 ? "just now" : `${formatMinutes(m)} ago`))((now - new Date(iso).getTime()) / 60000);

  return (
    <section className="mb-6">
      <h2 className="font-semibold text-ink mb-1">Ready for courier pick-up <span className="num text-sm font-normal text-ink-3">{rows?.length ?? ""}</span></h2>
      <p className="text-sm text-ink-2 mb-3">Released reports, by the centre they are going back to. Couriers see these on their phones under <b>Deliver reports</b>. When a courier picks one up it moves onto their delivery sheet below.</p>
      {err && <Note tone="err">Couldn't load released reports: {err}</Note>}
      {rows && !rows.length && <div className="card p-6 text-sm text-ink-3">Nothing waiting for a courier.</div>}
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
        {groups.map(([dest, items]) => {
          const oldest = items.reduce((a, b) => (a.released_at < b.released_at ? a : b));
          const shown = open[dest] ? items : items.slice(0, 5);
          return (
            <div key={dest} className="card overflow-hidden">
              <div className="px-4 py-2.5 flex justify-between gap-3 border-b" style={{ borderColor: C.line, background: C.raised }}>
                <span className="font-semibold text-ink">{dest}</span>
                <span className="text-sm text-ink-2 whitespace-nowrap">{items.length} report{items.length === 1 ? "" : "s"}</span>
              </div>
              <p className="px-4 pt-2 text-xs text-ink-3">Oldest released {ago(oldest.released_at)}</p>
              <ul className="pb-1">
                {shown.map((r) => (
                  <li key={r.id} className="px-4 py-1.5 text-sm flex justify-between gap-3">
                    <span className="min-w-0 truncate"><span className="num text-ink">R#{r.r_number}</span> <span className="text-ink-3">{r.client_name || ""}</span></span>
                    <span className="text-xs text-ink-3 whitespace-nowrap">{ago(r.released_at)}</span>
                  </li>
                ))}
              </ul>
              {items.length > 5 && (
                <button className="px-4 pb-2 text-sm text-accent underline cursor-pointer" onClick={() => setOpen({ ...open, [dest]: !open[dest] })}>
                  {open[dest] ? "Show fewer" : `Show all ${items.length}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
