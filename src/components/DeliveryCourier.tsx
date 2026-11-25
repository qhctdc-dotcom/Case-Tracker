import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { decodePhoto } from "../lib/barcode";
import { fmtIso, fmtTime } from "../lib/tracker";
import { SignaturePad } from "./Signature";
import { Badge, Button, C, Field, Note, inputCls, tint } from "./ui";

/*
  Courier: deliver reports. Three simple screens.
    Home     - every centre, with the reports ready for it at the lab and the reports already with you.
    Pick up  - tick the reports you have in hand, sign once, done.
    Deliver  - at the centre: the receiver signs once for everything handed over;
               anything not handed over gets a reason. The sheet then goes to the lab by itself.
*/

type Screen = { kind: "home" } | { kind: "pickup"; place: string } | { kind: "deliver"; sheetId: number };
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export default function DeliveryCourier({ me, toast }: { me: api.Me; toast: (m: string, t?: "ok" | "err") => void }) {
  const [sheets, setSheets] = useState<api.DeliverySheet[]>([]);
  const [rows, setRows] = useState<api.ReportDelivery[]>([]);
  const [centres, setCentres] = useState<api.Centre[]>([]);
  const [waiting, setWaiting] = useState<api.ReportRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<Screen>({ kind: "home" });
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, c, w] = await Promise.all([api.loadDeliveries(14, me.email), api.loadCentres().catch(() => []), api.loadWaitingReleases().catch(() => [])]);
      setSheets(d.sheets); setRows(d.rows); setCentres(c.filter((x) => x.active)); setWaiting(w);
    } catch (e: any) { toast(e.message, "err"); }
    finally { setLoading(false); }
  }, [me.email, toast]);
  useEffect(() => { load(); }, [load]);
  // Keep the lists current: when the app comes back on screen, and every minute
  useEffect(() => {
    const onShow = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onShow);
    const t = window.setInterval(onShow, 60_000);
    return () => { document.removeEventListener("visibilitychange", onShow); clearInterval(t); };
  }, [load]);

  const openSheets = sheets.filter((s) => !s.closed_at);
  useEffect(() => {
    if (screen.kind === "deliver" && !sheets.some((x) => x.id === screen.sheetId && !x.closed_at)) setScreen({ kind: "home" });
  }, [screen, sheets]);
  // Sheets left empty for more than 10 minutes (e.g. from the old screen) are closed quietly
  useEffect(() => {
    const stale = sheets.filter((s) => !s.closed_at && !rows.some((r) => r.sheet_id === s.id) && Date.now() - new Date(s.started_at).getTime() > 600e3);
    if (stale.length) Promise.all(stale.map((s) => api.closeDeliverySheet(s.id).catch(() => {}))).then(() => load());
  }, [sheets, rows, load]);
  const sheetRows = (id: number) => rows.filter((r) => r.sheet_id === id);

  /** Every place: active centres plus any other destination reports were released for. */
  const places = useMemo(() => {
    const m = new Map<string, { name: string; ready: api.ReportRelease[]; sheet: api.DeliverySheet | null }>();
    const get = (name: string) => { const k = norm(name); if (!m.has(k)) m.set(k, { name, ready: [], sheet: null }); return m.get(k)!; };
    centres.forEach((c) => get(c.name));
    waiting.forEach((w) => get(w.destination).ready.push(w));
    openSheets.forEach((s) => { const p = get(s.location); if (!p.sheet) p.sheet = s; });
    return [...m.values()];
  }, [centres, waiting, openSheets]);

  if (loading) return <p className="p-6 text-ink-3">Loading…</p>;

  if (screen.kind === "pickup") {
    const place = places.find((p) => norm(p.name) === norm(screen.place));
    return <PickUp place={screen.place} ready={place?.ready || []} existing={place?.sheet || null} toast={toast}
      onBack={() => setScreen({ kind: "home" })} onDone={async () => { await load(); setScreen({ kind: "home" }); }} />;
  }
  const deliverSheet = screen.kind === "deliver" ? sheets.find((x) => x.id === screen.sheetId && !x.closed_at) : undefined;
  if (screen.kind === "deliver" && deliverSheet) {
    const s = deliverSheet;
    return <Deliver sheet={s} rows={sheetRows(s.id)} toast={toast} reload={load}
      onBack={() => setScreen({ kind: "home" })} onFinished={async () => { await load(); setScreen({ kind: "home" }); }} />;
  }

  /* ---------------- Home ---------------- */
  const q = norm(search);
  const withYou = openSheets.filter((s) => sheetRows(s.id).length).map((s) => ({ s, pending: sheetRows(s.id).filter((r) => r.status === "pending") }));
  const readyPlaces = places.filter((p) => p.ready.length && (!q || norm(p.name).includes(q))).sort((a, b) => b.ready.length - a.ready.length || a.name.localeCompare(b.name));
  const quiet = places.filter((p) => !p.ready.length && (!q || norm(p.name).includes(q))).sort((a, b) => a.name.localeCompare(b.name));
  const totalReady = waiting.length;
  const recent = sheets.filter((s) => s.closed_at && sheetRows(s.id).length).slice(0, 6);

  return (
    <div className="max-w-lg mx-auto px-4 py-5">
      {withYou.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xl font-semibold text-ink mb-2">With you: deliver now</h2>
          <ul className="space-y-2">
            {withYou.map(({ s, pending }) => (
              <li key={s.id}>
                <button onClick={() => setScreen({ kind: "deliver", sheetId: s.id })} className="card w-full text-left px-4 py-4 cursor-pointer flex items-center gap-3"
                  style={{ borderLeft: `6px solid ${C.accent}` }}>
                  <span className="min-w-0 flex-1">
                    <span className="block text-lg font-semibold text-ink">{s.location}</span>
                    <span className="block text-sm text-ink-2">{pending.length ? `${pending.length} report${pending.length === 1 ? "" : "s"} to hand over.` : "All recorded: send the sheet to the lab."} Picked up {fmtTime(s.started_at)}.</span>
                  </span>
                  <span className="text-accent font-semibold">Deliver ›</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-6">
        <h2 className="text-xl font-semibold text-ink mb-1">Ready at the lab</h2>
        <p className="text-sm text-ink-2 mb-3">{totalReady ? `${totalReady} report${totalReady === 1 ? "" : "s"} released and waiting for pick-up. Tap a centre to pick up its reports.` : "No reports are waiting for pick-up right now."}</p>
        {places.length > 8 && <input className={`${inputCls} mb-3`} placeholder="Find a centre" value={search} onChange={(e) => setSearch(e.target.value)} />}
        <ul className="space-y-2">
          {readyPlaces.map((p) => (
            <li key={p.name}>
              <button onClick={() => setScreen({ kind: "pickup", place: p.name })} className="card w-full text-left px-4 py-3.5 cursor-pointer">
                <span className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 text-lg font-semibold text-ink">{p.name}</span>
                  <span className="rounded-full px-3 py-1 text-base font-bold num" style={{ background: tint(C.success, 15), color: C.success }}>{p.ready.length}</span>
                </span>
                <span className="block text-sm text-ink-2 mt-1 num">
                  {p.ready.slice(0, 4).map((w) => `R#${w.r_number}`).join("  ")}{p.ready.length > 4 ? `  +${p.ready.length - 4} more` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {quiet.length > 0 && (
        <section className="mb-6">
          <button className="text-sm text-accent underline cursor-pointer" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Hide" : "Show"} the other {quiet.length} centre{quiet.length === 1 ? "" : "s"} (nothing ready)
          </button>
          {showAll && (
            <ul className="card mt-2 overflow-hidden">
              {quiet.map((p) => (
                <li key={p.name} className="flex items-center justify-between px-4 py-2.5 border-b last:border-b-0" style={{ borderColor: C.line }}>
                  <span className="text-ink">{p.name}</span><span className="text-sm text-ink-3">Nothing ready</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {recent.length > 0 && (
        <section>
          <h2 className="font-semibold text-ink mb-2">Done recently</h2>
          <ul className="space-y-2">
            {recent.map((s) => {
              const rs = sheetRows(s.id); const d = rs.filter((r) => r.status === "D").length;
              return (
                <li key={s.id} className="card px-4 py-3 text-sm">
                  <div className="flex justify-between gap-3"><span className="text-ink font-medium">{s.location}</span><span className="text-ink-3">{fmtIso(s.closed_at)}</span></div>
                  <div className="text-ink-2">{d} of {rs.length} delivered{d < rs.length ? `, ${rs.length - d} brought back` : ""}. {s.reviewed_at ? "Checked by the lab." : "Waiting for the lab to check."}</div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

/* ---------------- Pick up at the lab ---------------- */
function PickUp({ place, ready, existing, onBack, onDone, toast }: {
  place: string; ready: api.ReportRelease[]; existing: api.DeliverySheet | null;
  onBack: () => void; onDone: () => void; toast: (m: string, t?: "ok" | "err") => void;
}) {
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(ready.map((w) => [w.r_number, true])));
  const [extra, setExtra] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [sig, setSig] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const chosen = [...ready.filter((w) => picked[w.r_number]).map((w) => w.r_number), ...extra];

  function addCode(c: string) {
    const r = c.replace(/\s/g, "");
    if (!r) return;
    const known = ready.find((w) => w.r_number === r.replace(/\D/g, "") || r.includes(w.r_number));
    if (known) setPicked((p) => ({ ...p, [known.r_number]: true }));
    else if (!extra.includes(r)) setExtra((x) => [...x, r]);
    setCode("");
  }
  async function onPhoto(file?: File) {
    if (!file) return;
    setBusy("Reading barcodes…");
    try { const codes = await decodePhoto(file); if (!codes.length) toast("No barcode could be read. Try again closer, or type the R#.", "err"); else codes.forEach(addCode); }
    catch (e: any) { toast(e.message, "err"); }
    finally { setBusy(null); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function confirm() {
    if (!chosen.length) return setErr("Tick the reports you have in hand.");
    if (!existing && !sig) return setErr("Sign in the box to confirm you are taking these reports.");
    setErr(null); setBusy("Saving…");
    try {
      const sheetId = existing ? existing.id : await api.startDeliverySheet(place, "Post-Analytical", sig);
      const res = await api.addReports(sheetId, chosen);
      const added = res.filter((r) => r.result === "added").length;
      const problems = res.filter((r) => r.result !== "added").map((r) =>
        r.result === "no_r_number" ? `"${r.code}" is not an R# number`
        : r.result === "not_released" ? `R#${r.r_number} has not been released: give it back to post-analytical`
        : r.result === "already_on_this_sheet" ? `R#${r.r_number} is already with you` : `R#${r.r_number} is already with another courier`);
      if (!added && !existing) await api.closeDeliverySheet(sheetId).catch(() => {}); // nothing picked up: don't leave an empty sheet
      toast([added ? `${added} report${added === 1 ? "" : "s"} for ${place} picked up.` : "Nothing was picked up.", ...problems].join(" "), problems.length && !added ? "err" : "ok");
      onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-5">
      <button className="text-accent underline text-sm mb-3 cursor-pointer" onClick={onBack}>‹ All centres</button>
      <p className="text-sm text-ink-3">Pick up reports for</p>
      <h1 className="text-2xl font-semibold text-ink mb-3">{place}</h1>
      {err && <Note tone="err">{err}</Note>}

      <div className="card overflow-hidden mb-4">
        <div className="flex items-center justify-between px-4 py-2.5 border-b" style={{ borderColor: C.line, background: C.raised }}>
          <span className="text-sm text-ink-2">Untick any report you don't have in hand.</span>
          {ready.length > 1 && <button className="text-sm text-accent underline cursor-pointer" onClick={() => {
            const all = ready.every((w) => picked[w.r_number]); setPicked(Object.fromEntries(ready.map((w) => [w.r_number, !all])));
          }}>{ready.every((w) => picked[w.r_number]) ? "Untick all" : "Tick all"}</button>}
        </div>
        <ul>
          {ready.map((w) => (
            <li key={w.id}>
              <label className="flex items-center gap-3 px-4 py-3 cursor-pointer border-b" style={{ borderColor: C.line }}>
                <input type="checkbox" className="w-7 h-7 accent-[var(--accent)]" checked={!!picked[w.r_number]} onChange={(e) => setPicked({ ...picked, [w.r_number]: e.target.checked })} />
                <span className="min-w-0"><span className="num text-lg text-ink">R#{w.r_number}</span>
                  {w.client_name && <span className="block text-sm text-ink-2">{w.client_name}</span>}</span>
              </label>
            </li>
          ))}
          {extra.map((r) => (
            <li key={r} className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: C.line }}>
              <span className="num text-lg text-ink flex-1">R#{r.replace(/\D/g, "") || r}</span>
              <Badge color={C.warning}>Added by you</Badge>
              <button className="text-sm text-accent underline cursor-pointer" onClick={() => setExtra(extra.filter((x) => x !== r))}>Remove</button>
            </li>
          ))}
          {!ready.length && !extra.length && <li className="px-4 py-4 text-ink-3">No reports released for {place} right now. If you have one in hand, add it below.</li>}
        </ul>
      </div>

      <details className="mb-5">
        <summary className="text-sm text-accent underline cursor-pointer">Have a report that isn't in the list?</summary>
        <div className="mt-3">
          <input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only" id="pickup-photo" onChange={(e) => onPhoto(e.target.files?.[0])} />
          <label htmlFor="pickup-photo" className="flex items-center justify-center w-full rounded-lg py-3 font-semibold cursor-pointer mb-2 border-2" style={{ borderColor: C.accent, color: C.accent }}>Scan its barcode (photo)</label>
          <div className="flex gap-2">
            <input className={inputCls} inputMode="numeric" placeholder="Or type the R#" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addCode(code); }} />
            <Button disabled={!code.trim()} onClick={() => addCode(code)}>Add</Button>
          </div>
          <p className="text-xs text-ink-3 mt-1">Only reports released by post-analytical can be taken.</p>
        </div>
      </details>

      {existing ? (
        <p className="text-sm text-ink-2 mb-4">You already signed for reports for {place} at {fmtTime(existing.started_at)}. These will be added to the same sheet.</p>
      ) : (
        <div className="mb-4"><SignaturePad label="Your signature" onChange={setSig} /></div>
      )}
      <Button tone="primary" className="w-full py-4 text-lg" disabled={!!busy || !chosen.length} onClick={confirm}>
        {busy || `Take ${chosen.length} report${chosen.length === 1 ? "" : "s"} for ${place}`}
      </Button>
    </div>
  );
}

/* ---------------- Deliver at the centre ---------------- */
const NOT_DELIVERED: { v: "ND" | "CU" | "C"; label: string }[] = [
  { v: "CU", label: "Client unavailable" }, { v: "C", label: "Centre closed" }, { v: "ND", label: "Other reason" },
];

function Deliver({ sheet, rows, onBack, onFinished, reload, toast }: {
  sheet: api.DeliverySheet; rows: api.ReportDelivery[]; onBack: () => void; onFinished: () => void; reload: () => Promise<void>;
  toast: (m: string, t?: "ok" | "err") => void;
}) {
  const pending = rows.filter((r) => r.status === "pending");
  const done = rows.filter((r) => r.status !== "pending");
  const [given, setGiven] = useState<Record<number, boolean>>(() => Object.fromEntries(pending.map((r) => [r.id, true])));
  const [name, setName] = useState("");
  const [sig, setSig] = useState("");
  const [why, setWhy] = useState<"ND" | "CU" | "C" | "">("");
  const [whyText, setWhyText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handed = pending.filter((r) => given[r.id]);
  const back = pending.filter((r) => !given[r.id]);

  async function save() {
    if (!pending.length) {
      setBusy(true);
      try { await api.closeDeliverySheet(sheet.id); toast("The sheet has been sent to the lab."); onFinished(); }
      catch (e: any) { setErr(e.message); } finally { setBusy(false); }
      return;
    }
    if (handed.length && (!name.trim() || !sig)) return setErr("Ask the person receiving the reports to type their name and sign.");
    if (back.length && !why) return setErr(`Say why ${back.length === 1 ? "this report wasn't" : "these reports weren't"} handed over.`);
    if (back.length && why === "ND" && !whyText.trim()) return setErr("Type the reason.");
    setBusy(true); setErr(null);
    try {
      for (const r of handed) await api.recordDelivery(r.id, "D", name, sig, "");
      const reasonText = why === "ND" ? whyText.trim() : `${NOT_DELIVERED.find((x) => x.v === why)?.label}${whyText.trim() ? `: ${whyText.trim()}` : ""}`;
      for (const r of back) await api.recordDelivery(r.id, why as "ND" | "CU" | "C", "", "", reasonText);
      await api.closeDeliverySheet(sheet.id);
      toast(`${handed.length} delivered${back.length ? `, ${back.length} to bring back to the lab` : ""}. The sheet has been sent to the lab.`);
      onFinished();
    } catch (e: any) { setErr(e.message); await reload(); } finally { setBusy(false); }
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-5">
      <button className="text-accent underline text-sm mb-3 cursor-pointer" onClick={onBack}>‹ All centres</button>
      <p className="text-sm text-ink-3">Hand over at</p>
      <h1 className="text-2xl font-semibold text-ink mb-3">{sheet.location}</h1>
      {err && <Note tone="err">{err}</Note>}

      <div className="card overflow-hidden mb-4">
        <div className="px-4 py-2.5 border-b text-sm text-ink-2" style={{ borderColor: C.line, background: C.raised }}>
          Untick any report you could <b>not</b> hand over.
        </div>
        <ul>
          {pending.map((r) => (
            <li key={r.id}>
              <label className="flex items-center gap-3 px-4 py-3 cursor-pointer border-b" style={{ borderColor: C.line }}>
                <input type="checkbox" className="w-7 h-7 accent-[var(--accent)]" checked={!!given[r.id]} onChange={(e) => setGiven({ ...given, [r.id]: e.target.checked })} />
                <span className="min-w-0 flex-1"><span className="num text-lg text-ink">R#{r.r_number}</span>
                  {r.client_name && <span className="block text-sm text-ink-2">{r.client_name}</span>}</span>
                {!given[r.id] && <Badge color={C.warning}>Not handed over</Badge>}
              </label>
            </li>
          ))}
          {done.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-4 py-3 border-b text-ink-3" style={{ borderColor: C.line }}>
              <span className="num flex-1">R#{r.r_number}</span>
              <Badge color={r.status === "D" ? C.success : C.warning}>{r.status === "D" ? "Delivered" : "Not delivered"}</Badge>
            </li>
          ))}
        </ul>
      </div>

      {handed.length > 0 && (
        <section className="mb-5">
          <h2 className="font-semibold text-ink mb-2">Person receiving {handed.length} report{handed.length === 1 ? "" : "s"}</h2>
          <Field label="Their full name"><input className={inputCls} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <SignaturePad label="Their signature" onChange={setSig} />
        </section>
      )}

      {back.length > 0 && (
        <section className="mb-5">
          <h2 className="font-semibold text-ink mb-2">Why {back.length === 1 ? "wasn't 1 report" : `weren't ${back.length} reports`} handed over?</h2>
          <div className="grid grid-cols-3 gap-2 mb-3" role="radiogroup" aria-label="Reason">
            {NOT_DELIVERED.map((o) => (
              <button key={o.v} role="radio" aria-checked={why === o.v} onClick={() => setWhy(o.v)} className="rounded-lg border-2 py-3 px-1 text-sm cursor-pointer"
                style={{ borderColor: why === o.v ? C.accent : C.line, background: why === o.v ? tint(C.accent, 10) : C.surface, color: C.ink, fontWeight: why === o.v ? 600 : 400 }}>
                {o.label}
              </button>
            ))}
          </div>
          {why && <input className={inputCls} value={whyText} onChange={(e) => setWhyText(e.target.value)} placeholder={why === "ND" ? "Type the reason" : "Add a note (optional)"} />}
          <p className="text-xs text-ink-3 mt-1">Bring {back.length === 1 ? "it" : "them"} back to post-analytical.</p>
        </section>
      )}

      <Button tone="primary" className="w-full py-4 text-lg" disabled={busy} onClick={save}>
        {busy ? "Saving…" : !pending.length ? "Send the sheet to the lab" : handed.length && back.length ? `Confirm: ${handed.length} delivered, ${back.length} not` : handed.length ? `Confirm ${handed.length} delivered` : `Confirm none delivered`}
      </Button>
      <p className="text-xs text-ink-3 mt-3">The date and time are recorded automatically. The delivery sheet is then sent to the lab.</p>
    </div>
  );
}
