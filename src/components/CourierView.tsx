import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { compressPhoto, decodePhoto, normBarcode } from "../lib/barcode";
import { fmtIso, fmtTime, formatMinutes } from "../lib/tracker";
import { Badge, Button, C, Field, Modal, Note, inputCls, tint } from "./ui";

type Pending = { preview: string; photo: Blob; codes: string[]; chosen: Record<string, boolean> } | null;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

export default function CourierView({ me, toast }: { me: api.Me; toast: (m: string, t?: "ok" | "err") => void }) {
  const [centres, setCentres] = useState<api.Centre[]>([]);
  const [routes, setRoutes] = useState<api.CourierRoute[]>([]);
  const [runs, setRuns] = useState<api.CourierRun[]>([]);
  const [samples, setSamples] = useState<api.SampleRow[]>([]);
  const [retention, setRetention] = useState(14);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [current, setCurrent] = useState<number | null>(null); // run being collected
  const [pending, setPending] = useState<Pending>(null);
  const [manual, setManual] = useState("");
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [emg, setEmg] = useState<{ centre: string; reason: string }>({ centre: "", reason: "" });
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [c, mine, st, r] = await Promise.all([api.loadCentres(), api.myOpenRun(me.email), api.loadTransportSettings(), api.loadRoutes().catch(() => [])]);
      setCentres(c); setRuns(mine.runs); setSamples(mine.samples); setRetention(st.photoRetentionDays);
      setRoutes(r.filter((x) => x.active && x.couriers.includes(me.email)));
      setErr(null);
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }, [me.email]);
  useEffect(() => { load(); }, [load]);
  // Keep routes and collections up to date: when the app comes back to the screen, and every minute
  useEffect(() => {
    const onShow = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    const t = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 60_000);
    return () => { document.removeEventListener("visibilitychange", onShow); window.removeEventListener("focus", onShow); clearInterval(t); };
  }, [load]);

  const centreName = (id: number | null) => centres.find((c) => c.id === id)?.name || "Unknown site";
  const routeName = (id: number | null | undefined) => routes.find((r) => r.id === id)?.name || "";
  const openRuns = runs.filter((r) => !r.handed_over_at);
  const tubesIn = (runId: number) => samples.filter((s) => s.run_id === runId);
  const openTubes = openRuns.reduce((n, r) => n + tubesIn(r.id).length, 0);
  const today = startOfToday();
  const run = current ? runs.find((r) => r.id === current) || null : null;

  /** Today's status of a site on a route */
  function siteStatus(routeId: number, centreId: number) {
    const todays = runs.filter((r) => r.centre_id === centreId && r.route_id === routeId && new Date(r.started_at) >= today);
    const open = todays.find((r) => !r.handed_over_at);
    const tubes = todays.reduce((n, r) => n + tubesIn(r.id).length, 0);
    return { open, tubes, handed: !open && todays.length > 0, last: todays[0] };
  }

  async function openSite(routeId: number | null, centreId: number, emergency = false, reason = "") {
    if (!emergency && routeId !== null) {
      const st = siteStatus(routeId, centreId);
      if (st.open) { setCurrent(st.open.id); return; }
    }
    setBusy("Starting…");
    try {
      const id = await api.startRun(centreId, routeId, emergency, reason);
      await load();
      setCurrent(id);
    } catch (e: any) { toast(e.message, "err"); }
    finally { setBusy(null); }
  }

  async function startEmergency() {
    const cid = Number(emg.centre);
    if (!cid) return toast("Choose the site for the emergency collection.", "err");
    if (!emg.reason.trim()) return toast("Give a short reason for the emergency.", "err");
    setEmergencyOpen(false);
    await openSite(null, cid, true, emg.reason.trim());
    setEmg({ centre: "", reason: "" });
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setBusy("Reading barcodes…");
    try {
      const [codes, small] = await Promise.all([decodePhoto(file), compressPhoto(file)]);
      setPending({ preview: URL.createObjectURL(small), photo: small, codes, chosen: Object.fromEntries(codes.map((c) => [c, true])) });
    } catch (e: any) { toast(`Couldn't read that photo: ${e.message}`, "err"); }
    finally { setBusy(null); if (fileRef.current) fileRef.current.value = ""; }
  }

  function addManual() {
    const v = manual.trim();
    if (!v || !pending || !normBarcode(v)) return;
    setPending({ ...pending, codes: [...new Set([...pending.codes, v])], chosen: { ...pending.chosen, [v]: true } });
    setManual("");
  }

  async function confirmPhoto() {
    if (!pending || !run) return;
    const codes = pending.codes.filter((c) => pending.chosen[c]);
    if (!codes.length) return toast("Tick at least one barcode, or type the number.", "err");
    setBusy("Saving…");
    try {
      const path = await api.uploadSamplePhoto(pending.photo);
      const res = await api.logSamples(run.id, codes, path);
      const logged = res.filter((r) => r.result === "logged").length;
      const dup = res.length - logged;
      toast(`${logged} sample${logged === 1 ? "" : "s"} logged${dup ? `, ${dup} already logged earlier` : ""}.`);
      URL.revokeObjectURL(pending.preview);
      setPending(null);
      await load();
    } catch (e: any) { toast(`${e.message}. Nothing was saved; try again.`, "err"); }
    finally { setBusy(null); }
  }

  async function remove(s: api.SampleRow) {
    if (!confirm(`Remove ${s.barcode} from this collection? Only do this if it was logged by mistake.`)) return;
    try { await api.removeSample(s.id); await load(); } catch (e: any) { toast(e.message, "err"); }
  }

  async function handOverAll() {
    const withTubes = openRuns.filter((r) => tubesIn(r.id).length);
    const empty = openRuns.filter((r) => !tubesIn(r.id).length);
    if (!withTubes.length) return toast("No tubes to hand over yet.", "err");
    if (!confirm(`Hand over ${openTubes} tube${openTubes === 1 ? "" : "s"} from ${withTubes.length} site${withTubes.length === 1 ? "" : "s"} to the lab?`)) return;
    setBusy("Handing over…");
    try {
      for (const r of [...withTubes, ...empty]) await api.handOver(r.id);
      toast("Handed over. The lab will scan them in.");
      setCurrent(null);
      await load();
    } catch (e: any) { toast(e.message, "err"); await load(); }
    finally { setBusy(null); }
  }

  if (loading) return <p className="p-6 text-ink-3">Loading…</p>;

  /* ---------------- Collecting at one site ---------------- */
  if (run && !pending) {
    const items = tubesIn(run.id);
    return (
      <div className="max-w-lg mx-auto px-4 py-5">
        <button className="text-accent underline text-sm mb-3 cursor-pointer" onClick={() => setCurrent(null)}>Back to my route</button>
        <div className="card p-4 mb-4" style={run.is_emergency ? { borderLeft: `6px solid ${C.danger}` } : undefined}>
          {run.is_emergency
            ? <p className="text-sm font-bold" style={{ color: C.danger }}>EMERGENCY COLLECTION</p>
            : <p className="text-sm text-ink-3">{routeName(run.route_id) || "Collecting from"}</p>}
          <p className="text-2xl font-semibold text-ink">{centreName(run.centre_id)}</p>
          {run.is_emergency && run.emergency_reason && <p className="text-sm text-ink-2">Reason: {run.emergency_reason}</p>}
          <p className="text-sm text-ink-2">Started {fmtTime(run.started_at)}. {items.length} tube{items.length === 1 ? "" : "s"} here so far.</p>
        </div>

        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only" id="photo-input" onChange={(e) => onPhoto(e.target.files?.[0])} />
        <label htmlFor="photo-input"
          className={`flex items-center justify-center gap-3 w-full rounded-xl py-6 text-xl font-semibold cursor-pointer mb-2 ${busy ? "opacity-60 pointer-events-none" : ""}`}
          style={{ background: run.is_emergency ? C.danger : C.accent, color: "#fff" }}>
          {busy || "Take photo of samples"}
        </label>
        <p className="text-sm text-ink-3 mb-5 text-center">Several tubes can go in one photo. Keep the barcodes flat, in focus and well lit.</p>

        {items.length > 0 && (
          <ul className="card mb-5">
            {items.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3 border-b last:border-b-0" style={{ borderColor: C.line }}>
                <span><span className="num text-lg text-ink">{s.barcode}</span><span className="block text-xs text-ink-3">Logged {fmtTime(s.collected_at)}</span></span>
                {s.received_at ? <Badge color={C.success}>At lab</Badge>
                  : <button onClick={() => remove(s)} className="text-sm text-danger underline cursor-pointer px-2 py-2">Remove</button>}
              </li>
            ))}
          </ul>
        )}
        <Button className="w-full py-3 text-base" onClick={() => setCurrent(null)}>Done at this site, back to my route</Button>
      </div>
    );
  }

  /* ---------------- Checking barcodes from a photo ---------------- */
  if (run && pending) {
    return (
      <div className="max-w-lg mx-auto px-4 py-5">
        <h1 className="text-xl font-semibold text-ink mb-1">Check the barcodes</h1>
        <p className="text-sm text-ink-2 mb-3">{centreName(run.centre_id)}{run.is_emergency ? " (emergency)" : ""}</p>
        <img src={pending.preview} alt="Photo of the samples" className="w-full rounded-lg mb-3 border" style={{ borderColor: C.line }} />
        {!pending.codes.length && <Note tone="warn">No barcode could be read. Retake the photo closer and in better light, or type the number below.</Note>}
        <ul className="space-y-2 mb-4">
          {pending.codes.map((c) => (
            <li key={c}>
              <label className="card flex items-center gap-3 px-4 py-3 cursor-pointer">
                <input type="checkbox" className="w-6 h-6 accent-[var(--accent)]" checked={!!pending.chosen[c]}
                  onChange={(e) => setPending({ ...pending, chosen: { ...pending.chosen, [c]: e.target.checked } })} />
                <span className="num text-lg text-ink">{c}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="flex gap-2 mb-5">
          <input className={inputCls} placeholder="Type a barcode number" value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addManual(); }} />
          <Button onClick={addManual}>Add</Button>
        </div>
        <Button tone="primary" className="w-full py-3.5 text-lg mb-2" disabled={!!busy} onClick={confirmPhoto}>
          {busy || `Log ${pending.codes.filter((c) => pending.chosen[c]).length} sample(s)`}
        </Button>
        <Button className="w-full py-3" disabled={!!busy} onClick={() => { URL.revokeObjectURL(pending.preview); setPending(null); }}>Cancel</Button>
        <p className="text-xs text-ink-3 mt-3">The photo is kept as proof of pickup and deleted automatically after {retention} days.</p>
      </div>
    );
  }

  /* ---------------- My routes (home) ---------------- */
  const emergencies = openRuns.filter((r) => r.is_emergency);
  return (
    <div className="max-w-lg mx-auto px-4 py-5">
      {err && <Note tone="err">{err}</Note>}

      <button onClick={() => setEmergencyOpen(true)} disabled={!!busy}
        className="w-full rounded-xl py-4 mb-5 text-lg font-bold cursor-pointer disabled:opacity-50"
        style={{ background: tint(C.danger, 12), color: C.danger, border: `2px solid ${C.danger}` }}>
        Emergency collection
      </button>

      {emergencies.length > 0 && (
        <section className="mb-5">
          <h2 className="font-semibold mb-2" style={{ color: C.danger }}>Open emergency collections</h2>
          <ul className="space-y-2">
            {emergencies.map((r) => (
              <li key={r.id}>
                <button onClick={() => setCurrent(r.id)} className="card w-full text-left px-4 py-3 cursor-pointer" style={{ borderLeft: `6px solid ${C.danger}` }}>
                  <span className="block text-lg text-ink">{centreName(r.centre_id)}</span>
                  <span className="block text-sm text-ink-2">{r.emergency_reason}. {tubesIn(r.id).length} tube{tubesIn(r.id).length === 1 ? "" : "s"}, started {fmtTime(r.started_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!routes.length && (
        <Note tone="info">No route has been assigned to you yet. Ask an admin to assign one. You can still make an emergency collection.</Note>
      )}

      {routes.map((rt) => {
        const done = rt.sites.filter((cid) => siteStatus(rt.id, cid).tubes > 0 || siteStatus(rt.id, cid).handed).length;
        return (
          <section key={rt.id} className="mb-5">
            <div className="flex items-baseline justify-between mb-2">
              <h2 className="text-xl font-semibold text-ink">{rt.name}</h2>
              <span className="text-sm text-ink-3">{done} of {rt.sites.length} sites today</span>
            </div>
            <ol className="card overflow-hidden">
              {rt.sites.map((cid, i) => {
                const st = siteStatus(rt.id, cid);
                return (
                  <li key={cid} className="border-b last:border-b-0" style={{ borderColor: C.line }}>
                    <button disabled={!!busy} onClick={() => openSite(rt.id, cid)}
                      className="w-full text-left px-4 py-3.5 flex items-center gap-3 cursor-pointer hover:bg-raised disabled:opacity-50">
                      <span className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                        style={{ background: st.tubes || st.handed ? C.success : C.raised, color: st.tubes || st.handed ? "#fff" : C.ink2, border: `1px solid ${C.line}` }}>
                        {st.tubes || st.handed ? "✓" : i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-lg text-ink">{centreName(cid)}</span>
                        <span className="block text-sm" style={{ color: st.open ? C.accent : st.handed ? C.success : C.ink3 }}>
                          {st.open ? `Collecting: ${st.tubes} tube${st.tubes === 1 ? "" : "s"} so far`
                            : st.handed ? `Handed over today (${st.tubes} tube${st.tubes === 1 ? "" : "s"})`
                            : "Not collected yet today"}
                        </span>
                      </span>
                      <span className="text-ink-3 text-xl" aria-hidden>›</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}

      {openRuns.length > 0 && (
        <div className="sticky bottom-3">
          <Button tone="primary" className="w-full py-4 text-lg shadow-lg" disabled={!!busy || !openTubes} onClick={handOverAll}>
            {busy || `Hand over everything to the lab (${openTubes} tube${openTubes === 1 ? "" : "s"})`}
          </Button>
        </div>
      )}

      <PastRuns runs={runs.filter((r) => r.handed_over_at)} samples={samples} centreName={centreName} />

      <Modal open={emergencyOpen} onClose={() => setEmergencyOpen(false)} title="Emergency collection">
        <p className="text-sm text-ink-2 mb-3">Use this for urgent samples, at any site, even one not on your route. The lab sees it marked EMERGENCY.</p>
        <Field label="Site">
          <select className={inputCls} value={emg.centre} onChange={(e) => setEmg({ ...emg, centre: e.target.value })}>
            <option value="">Choose a site…</option>
            {centres.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Reason"><input className={inputCls} placeholder="e.g. STAT troponin requested by Dr Mensah" value={emg.reason} onChange={(e) => setEmg({ ...emg, reason: e.target.value })} /></Field>
        <Button className="w-full py-3 text-base" style={{ background: C.danger, color: "#fff", borderColor: C.danger }} onClick={startEmergency}>Start emergency collection</Button>
      </Modal>
    </div>
  );
}

function PastRuns({ runs, samples, centreName }: { runs: api.CourierRun[]; samples: api.SampleRow[]; centreName: (id: number) => string }) {
  if (!runs.length) return null;
  return (
    <section className="mt-8">
      <h2 className="font-semibold text-ink mb-2">Recent handovers</h2>
      <ul className="space-y-2">
        {runs.slice(0, 8).map((r) => {
          const s = samples.filter((x) => x.run_id === r.id);
          const got = s.filter((x) => x.received_at).length;
          const waiting = s.length - got;
          const age = (Date.now() - new Date(r.handed_over_at!).getTime()) / 60000;
          return (
            <li key={r.id} className="card px-4 py-3">
              <div className="flex justify-between gap-3">
                <span className="text-ink">{centreName(r.centre_id)} {r.is_emergency && <Badge color={C.danger}>Emergency</Badge>}</span>
                <span className="text-sm text-ink-3">{fmtIso(r.handed_over_at)}</span>
              </div>
              <div className="text-sm mt-1" style={{ color: waiting ? C.warning : C.success }}>
                {got} of {s.length} received by the lab
                {waiting > 0 && <span className="text-ink-3"> ({waiting} waiting, handed over {formatMinutes(age)} ago)</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
