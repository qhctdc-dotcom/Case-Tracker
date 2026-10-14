import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { fmtIso, formatMinutes } from "../lib/tracker";
import { Badge, Button, C, Note, Stat, inputBase, tint } from "./ui";

type Feedback = { tone: "ok" | "warn" | "err"; title: string; detail: string; releaseRnumber?: string } | null;

export default function ReleaseView({ toast }: { toast: (m: string, t?: "ok" | "err") => void }) {
  const [releases, setReleases] = useState<api.ReportRelease[] | null>(null);
  const [centres, setCentres] = useState<api.Centre[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [dest, setDest] = useState<string>(() => { try { return localStorage.getItem("pat-release-dest") || ""; } catch { return ""; } });
  const [other, setOther] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([api.loadReleases(14), api.loadCentres()]);
      setReleases(r); setCentres(c.filter((x) => x.active)); setErr(null);
    } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => {
    load();
    let t: number | undefined;
    const unsub = api.subscribeReleases(() => { clearTimeout(t); t = window.setTimeout(load, 700); });
    const tick = setInterval(() => setNow(Date.now()), 60000);
    return () => { unsub(); clearTimeout(t); clearInterval(tick); };
  }, [load]);

  // Keep the scan box ready for the handheld scanner
  useEffect(() => {
    const refocus = () => {
      const a = document.activeElement as HTMLElement | null;
      const typing = a && ["INPUT", "SELECT", "TEXTAREA"].includes(a.tagName) && a !== inputRef.current;
      if (!typing && !document.querySelector('[role="dialog"]')) inputRef.current?.focus();
    };
    const i = setInterval(refocus, 1000);
    return () => clearInterval(i);
  }, []);

  const destination = dest === "__other" ? other.trim() : dest;
  useEffect(() => { try { if (dest) localStorage.setItem("pat-release-dest", dest); } catch { /* ignore */ } }, [dest]);

  async function release(raw: string) {
    const v = raw.trim();
    if (!v || busy) return;
    if (!destination) { setFeedback({ tone: "err", title: "Choose a destination first", detail: "Pick the centre these reports are going to, then scan again." }); return; }
    setBusy(true); setCode("");
    try {
      const [r] = await api.releaseReports([v], destination);
      if (!r) return;
      if (r.result === "released") {
        const warn = (r.pending_tests || 0) > 0 || !r.known_to_tracker;
        setFeedback({
          tone: warn ? "warn" : "ok", releaseRnumber: r.r_number,
          title: `R#${r.r_number} released for ${destination}`,
          detail: !r.known_to_tracker ? "This R# isn't in the tracker. Check the number on the report."
            : (r.pending_tests || 0) > 0 ? `${r.client_name || ""}. The tracker still shows ${r.pending_tests} test${r.pending_tests === 1 ? "" : "s"} outstanding: is this report complete?`
            : `${r.client_name || ""}. Ready for the courier.`,
        });
      } else if (r.result === "already_released") {
        setFeedback({ tone: "warn", title: `R#${r.r_number} is already released`, detail: `Waiting for pick-up to ${r.destination}. Nothing changed.` });
      } else if (r.result === "already_with_courier") {
        setFeedback({ tone: "warn", title: `R#${r.r_number} is already with a courier`, detail: `On its way to ${r.destination}. Nothing changed.` });
      } else {
        setFeedback({ tone: "err", title: "No R# number found", detail: `"${r.code}" doesn't contain a requisition number.` });
      }
      await load();
    } catch (e: any) {
      setFeedback({ tone: "err", title: "Not released", detail: e.message });
    } finally { setBusy(false); inputRef.current?.focus(); }
  }

  async function withdraw(rel: api.ReportRelease, label: string) {
    const note = prompt(`${label} R#${rel.r_number}?\n\nOptional note (e.g. "client will collect", "report amended"):`, "");
    if (note === null) return;
    try { await api.cancelRelease(rel.id, note); toast(`R#${rel.r_number} withdrawn.`); setFeedback(null); await load(); }
    catch (e: any) { toast(e.message, "err"); }
  }

  async function releaseAgain(rel: api.ReportRelease) {
    try {
      const [r] = await api.releaseReports([rel.r_number], rel.destination);
      toast(r?.result === "released" ? `R#${rel.r_number} released again for ${rel.destination}.` : `R#${rel.r_number}: ${r?.result.replace(/_/g, " ")}`);
      await load();
    } catch (e: any) { toast(e.message, "err"); }
  }

  const view = useMemo(() => {
    if (!releases) return null;
    const waiting = releases.filter((r) => r.status === "released");
    const withCourier = releases.filter((r) => r.status === "picked_up");
    // A report released again after being returned is no longer "returned"
    const live = new Set([...waiting, ...withCourier].map((r) => r.r_number));
    const returned = releases.filter((r) => r.status === "returned" && !live.has(r.r_number));
    const dests = [...new Set(waiting.map((r) => r.destination))].sort();
    return { waiting, withCourier, returned, dests };
  }, [releases]);

  const fbColor = feedback?.tone === "ok" ? C.success : feedback?.tone === "warn" ? C.warning : C.danger;

  return (
    <div>
      {err && <Note tone="err">Couldn't load released reports: {err}. Has 06_report_release.sql been run in Supabase?</Note>}

      <section className="card p-5 mb-5">
        <h2 className="text-lg font-semibold text-ink mb-1">Release reports for delivery</h2>
        <p className="text-sm text-ink-2 mb-3">Choose the destination, then scan each finished report. Couriers can only pick up reports released here.</p>
        <div className="flex flex-wrap gap-2 mb-3 items-center">
          <label className="text-sm text-ink-2" htmlFor="release-dest">Destination</label>
          <select id="release-dest" className={inputBase} value={dest} onChange={(e) => setDest(e.target.value)}>
            <option value="">Choose…</option>
            {centres.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            <option value="__other">Other…</option>
          </select>
          {dest === "__other" && <input className={`${inputBase} w-56`} placeholder="Destination name" value={other} onChange={(e) => setOther(e.target.value)} />}
        </div>
        <input ref={inputRef} value={code} onChange={(e) => setCode(e.target.value)} aria-label="Scan report barcode"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); release(code); } }}
          autoComplete="off" spellCheck={false} autoFocus
          className="num w-full rounded-lg px-4 py-4 text-2xl outline-none border-2 bg-surface text-ink"
          style={{ borderColor: destination ? C.accent : C.line }}
          placeholder={destination ? `Scan reports for ${destination}…` : "Choose a destination first"} />
        {feedback && (
          <div className="mt-4 rounded-lg p-4 flex items-start justify-between gap-4 flex-wrap" role="status" aria-live="assertive"
            style={{ background: tint(fbColor, 12), borderLeft: `6px solid ${fbColor}` }}>
            <div>
              <p className="text-xl font-semibold" style={{ color: fbColor }}>{feedback.title}</p>
              <p className="text-ink mt-0.5">{feedback.detail}</p>
            </div>
            {feedback.releaseRnumber && (
              <Button onClick={() => { const r = releases?.find((x) => x.r_number === feedback.releaseRnumber && x.status === "released"); if (r) withdraw(r, "Withdraw the release of"); }}>
                Undo this release
              </Button>
            )}
          </div>
        )}
      </section>

      {view && (
        <>
          <div className="flex gap-8 sm:gap-12 flex-wrap mb-5">
            <Stat label="Waiting for pick-up" value={view.waiting.length} color={view.waiting.length ? C.accent : C.ink} />
            <Stat label="With couriers" value={view.withCourier.length} />
            <Stat label="Returned, not delivered" value={view.returned.length} color={view.returned.length ? C.warning : C.ink} />
          </div>

          <div className="grid lg:grid-cols-2 gap-5">
            <section>
              <h3 className="font-semibold text-ink mb-2">Waiting for pick-up</h3>
              {!view.waiting.length && <div className="card p-6 text-sm text-ink-3">Nothing waiting.</div>}
              {view.dests.map((d) => {
                const items = view.waiting.filter((r) => r.destination === d);
                return (
                  <div key={d} className="card mb-3 overflow-hidden">
                    <div className="px-4 py-2.5 flex justify-between border-b" style={{ borderColor: C.line, background: C.raised }}>
                      <span className="font-semibold text-ink">{d}</span><span className="text-sm text-ink-2">{items.length} report{items.length === 1 ? "" : "s"}</span>
                    </div>
                    <ul>
                      {items.map((r) => (
                        <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2 border-b last:border-b-0" style={{ borderColor: C.line }}>
                          <span className="min-w-0">
                            <span className="num text-ink">R#{r.r_number}</span>
                            <span className="block text-xs text-ink-3">{r.client_name || "Not in tracker"}. Released {((m) => (m < 1 ? "just now" : `${formatMinutes(m)} ago`))((now - new Date(r.released_at).getTime()) / 60000)} by {r.released_by.split("@")[0]}</span>
                          </span>
                          <Button tone="quiet" onClick={() => withdraw(r, "Withdraw")}>Withdraw</Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </section>

            <section>
              <h3 className="font-semibold text-ink mb-2">Returned, not delivered</h3>
              {!view.returned.length && <div className="card p-6 text-sm text-ink-3">No returned reports.</div>}
              {view.returned.length > 0 && (
                <ul className="card overflow-hidden mb-5">
                  {view.returned.map((r) => (
                    <li key={r.id} className="px-4 py-3 border-b last:border-b-0" style={{ borderColor: C.line }}>
                      <div className="flex justify-between gap-3">
                        <span className="num text-ink">R#{r.r_number}</span>
                        <Badge color={C.warning}>{(r.note || "").split(":")[0] || "Returned"}</Badge>
                      </div>
                      <p className="text-sm text-ink-2">{r.client_name || ""} to {r.destination}. {(r.note || "").split(":").slice(1).join(":").trim()}</p>
                      <p className="text-xs text-ink-3">Returned {fmtIso(r.closed_at)}</p>
                      <div className="flex gap-2 mt-2">
                        <Button onClick={() => releaseAgain(r)}>Release again</Button>
                        <Button tone="quiet" onClick={() => withdraw(r, "Close")}>Close (no further delivery)</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="font-semibold text-ink mb-2">With couriers now</h3>
              {!view.withCourier.length ? <div className="card p-6 text-sm text-ink-3">None.</div> : (
                <ul className="card overflow-hidden">
                  {view.withCourier.map((r) => (
                    <li key={r.id} className="flex justify-between gap-3 px-4 py-2 border-b last:border-b-0 text-sm" style={{ borderColor: C.line }}>
                      <span><span className="num text-ink">R#{r.r_number}</span> <span className="text-ink-3">{r.client_name || ""}</span></span>
                      <span className="text-ink-2">{r.destination}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
