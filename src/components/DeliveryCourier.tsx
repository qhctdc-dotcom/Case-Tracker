import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { decodePhoto } from "../lib/barcode";
import { STATUS_LABEL } from "../lib/formTemplate";
import { fmtIso, fmtTime } from "../lib/tracker";
import { SignatureImage, SignaturePad } from "./Signature";
import { Badge, Button, C, Field, Note, inputCls, tint } from "./ui";

const statusColor = (s: string) => (s === "D" ? C.success : s === "pending" ? C.accent : C.warning);

export default function DeliveryCourier({ me, toast }: { me: api.Me; toast: (m: string, t?: "ok" | "err") => void }) {
  const [sheets, setSheets] = useState<api.DeliverySheet[]>([]);
  const [rows, setRows] = useState<api.ReportDelivery[]>([]);
  const [centres, setCentres] = useState<api.Centre[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [start, setStart] = useState({ location: "", department: "Post-Analytical", signature: "" });
  const [code, setCode] = useState("");
  const [active, setActive] = useState<api.ReportDelivery | null>(null);
  const [waiting, setWaiting] = useState<api.ReportRelease[]>([]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [showOther, setShowOther] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [mySites, setMySites] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const [d, c, w, routes] = await Promise.all([api.loadDeliveries(14, me.email), api.loadCentres().catch(() => []), api.loadWaitingReleases().catch(() => []), api.loadRoutes().catch(() => [])]);
      setSheets(d.sheets); setRows(d.rows); setCentres(c.filter((x) => x.active)); setWaiting(w);
      setMySites(new Set(routes.filter((r) => r.active && r.couriers.includes(me.email)).flatMap((r) => r.sites)));
    } catch (e: any) { toast(e.message, "err"); }
    finally { setLoading(false); }
  }, [me.email, toast]);
  useEffect(() => {
    load();
    // Show newly released reports as soon as post-analytical releases them
    let t: number | undefined;
    const unsub = api.subscribeReleases(() => { clearTimeout(t); t = window.setTimeout(load, 800); });
    return () => { unsub(); clearTimeout(t); };
  }, [load]);

  const sheet = sheets.find((s) => !s.closed_at) || null;
  const sheetRows = sheet ? rows.filter((r) => r.sheet_id === sheet.id) : [];
  const pending = sheetRows.filter((r) => r.status === "pending").length;

  async function begin() {
    if (!start.location.trim()) return toast("Enter the delivery location.", "err");
    if (!start.signature) return toast("Sign in the box to confirm you are collecting these reports.", "err");
    setBusy("Starting…");
    try { await api.startDeliverySheet(start.location, start.department, start.signature); await load(); }
    catch (e: any) { toast(e.message, "err"); } finally { setBusy(null); }
  }

  async function add(codes: string[]) {
    if (!sheet || !codes.length) return;
    setBusy("Adding…");
    try {
      const res = await api.addReports(sheet.id, codes);
      const added = res.filter((r) => r.result === "added").length;
      const issues = res.filter((r) => r.result !== "added").map((r) =>
        r.result === "no_r_number" ? `"${r.code}" has no R# number.`
        : r.result === "not_released" ? `R#${r.r_number} hasn't been released by post-analytical: hand it back.`
        : r.result === "already_on_this_sheet" ? `R#${r.r_number} is already on this sheet.` : `R#${r.r_number} is already out for delivery on another sheet.`);
      const otherDest = res.filter((r) => r.result === "added" && r.other_destination).map((r) => `R#${r.r_number} was released for ${r.destination}.`);
      issues.push(...otherDest);
      toast([added ? `${added} report${added === 1 ? "" : "s"} added.` : "", ...issues].filter(Boolean).join(" "), issues.length && !added ? "err" : "ok");
      setCode("");
      setPicked({});
      await load();
    } catch (e: any) { toast(e.message, "err"); } finally { setBusy(null); }
  }

  async function onPhoto(file?: File) {
    if (!file) return;
    setBusy("Reading barcodes…");
    try {
      const codes = await decodePhoto(file);
      if (!codes.length) toast("No barcode could be read. Try again closer, or type the R#.", "err");
      else await add(codes);
    } catch (e: any) { toast(e.message, "err"); }
    finally { setBusy(null); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function close() {
    if (!sheet) return;
    if (!confirm(`Close this delivery sheet (${sheetRows.length} reports)? The lab will then review it.`)) return;
    try { await api.closeDeliverySheet(sheet.id); toast("Sheet closed and sent to the lab for review."); await load(); }
    catch (e: any) { toast(e.message, "err"); }
  }

  if (loading) return <p className="p-6 text-ink-3">Loading…</p>;

  if (active && sheet) {
    return <RecordDelivery row={active} onCancel={() => setActive(null)} onSaved={async () => { setActive(null); await load(); }} toast={toast} />;
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-5">
      {!sheet && (
        <>
          <h1 className="text-2xl font-semibold text-ink mb-1">Deliver reports</h1>
          <p className="text-ink-2 mb-4">Start a delivery sheet when you collect reports from the lab. Only reports released by post-analytical can be picked up.</p>
          <ReadyList waiting={waiting} centres={centres} mySites={mySites} chosen={start.location}
            onChoose={(name) => setStart((s) => ({ ...s, location: name }))} />
          <Field label="Delivery location">
            <input className={inputCls} list="delivery-locations" value={start.location} placeholder="e.g. Tema"
              onChange={(e) => setStart({ ...start, location: e.target.value })} />
            <datalist id="delivery-locations">{centres.map((c) => <option key={c.id} value={c.name} />)}</datalist>
          </Field>
          <Field label="Department"><input className={inputCls} value={start.department} onChange={(e) => setStart({ ...start, department: e.target.value })} /></Field>
          <div className="mb-4"><SignaturePad label="Courier signature" onChange={(p) => setStart((s) => ({ ...s, signature: p }))} /></div>
          <Button tone="primary" className="w-full py-3.5 text-lg" disabled={!!busy} onClick={begin}>{busy || "Start delivery sheet"}</Button>
        </>
      )}

      {sheet && (
        <>
          <div className="card p-4 mb-4">
            <p className="text-sm text-ink-3">Delivering to</p>
            <p className="text-2xl font-semibold text-ink">{sheet.location}</p>
            <p className="text-sm text-ink-2">Picked up {fmtTime(sheet.started_at)}. {sheetRows.length} report{sheetRows.length === 1 ? "" : "s"}, {pending} still to deliver.</p>
          </div>

          {(() => {
            const here = waiting.filter((w) => w.destination.trim().toLowerCase() === sheet.location.trim().toLowerCase());
            const elsewhere = waiting.filter((w) => !here.includes(w));
            const chosen = Object.keys(picked).filter((k) => picked[k]);
            const row = (w: api.ReportRelease) => (
              <li key={w.id}>
                <label className="flex items-center gap-3 px-4 py-3 cursor-pointer border-b" style={{ borderColor: C.line }}>
                  <input type="checkbox" className="w-6 h-6 accent-[var(--accent)]" checked={!!picked[w.r_number]}
                    onChange={(e) => setPicked({ ...picked, [w.r_number]: e.target.checked })} />
                  <span className="min-w-0">
                    <span className="num text-lg text-ink">R#{w.r_number}</span>
                    <span className="block text-sm text-ink-2">{w.client_name || ""}{w.destination.toLowerCase() !== sheet.location.toLowerCase() ? ` (for ${w.destination})` : ""}</span>
                  </span>
                </label>
              </li>
            );
            return (
              <div className="card mb-4 overflow-hidden">
                <div className="px-4 py-3 border-b" style={{ borderColor: C.line, background: C.raised }}>
                  <p className="font-semibold text-ink">Ready for you to collect</p>
                  <p className="text-sm text-ink-2">{here.length ? `${here.length} report${here.length === 1 ? "" : "s"} released for ${sheet.location}. Tick the ones you have in hand, or scan them below.` : `No reports released for ${sheet.location} right now.`}</p>
                </div>
                <ul>{here.map(row)}</ul>
                {elsewhere.length > 0 && (
                  <div className="px-4 py-2">
                    <button className="text-sm text-accent underline cursor-pointer" onClick={() => setShowOther(!showOther)}>
                      {showOther ? "Hide" : "Show"} {elsewhere.length} report{elsewhere.length === 1 ? "" : "s"} released for other places
                    </button>
                  </div>
                )}
                {showOther && <ul>{elsewhere.map(row)}</ul>}
                {chosen.length > 0 && (
                  <div className="p-3"><Button tone="primary" className="w-full py-3" disabled={!!busy} onClick={() => add(chosen)}>Pick up {chosen.length} report{chosen.length === 1 ? "" : "s"}</Button></div>
                )}
              </div>
            );
          })()}

          <input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only" id="report-photo"
            onChange={(e) => onPhoto(e.target.files?.[0])} />
          <label htmlFor="report-photo" className={`flex items-center justify-center w-full rounded-xl py-5 text-lg font-semibold cursor-pointer mb-2 ${busy ? "opacity-60 pointer-events-none" : ""}`}
            style={{ background: C.accent, color: "var(--accent-ink)" }}>{busy || "Or scan report barcodes (photo)"}</label>
          <div className="flex gap-2 mb-5">
            <input className={inputCls} inputMode="numeric" placeholder="Or type the R# number" value={code}
              onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && code.trim()) add([code.trim()]); }} />
            <Button disabled={!code.trim() || !!busy} onClick={() => add([code.trim()])}>Add</Button>
          </div>

          {sheetRows.length > 0 && (
            <ul className="space-y-2 mb-5">
              {sheetRows.map((r) => (
                <li key={r.id} className="card px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="num text-lg text-ink">R#{r.r_number}</div>
                      <div className="text-sm text-ink-2">{r.client_name || (
                        <button className="underline text-accent cursor-pointer" onClick={async () => {
                          const n = prompt(`Client name for R#${r.r_number}:`);
                          if (n && n.trim()) { try { await api.setDeliveryClient(r.id, n); await load(); } catch (e: any) { toast(e.message, "err"); } }
                        }}>Add client name</button>)}</div>
                    </div>
                    <Badge color={statusColor(r.status)}>{STATUS_LABEL[r.status]}</Badge>
                  </div>
                  {r.status === "pending" ? (
                    <div className="flex gap-2 mt-3">
                      <Button tone="primary" className="flex-1 py-2.5" onClick={() => setActive(r)}>Record delivery</Button>
                      <Button onClick={async () => { if (confirm(`Remove R#${r.r_number} from this sheet?`)) { try { await api.removeDelivery(r.id); await load(); } catch (e: any) { toast(e.message, "err"); } } }}>Remove</Button>
                    </div>
                  ) : (
                    <div className="text-sm text-ink-2 mt-1 flex items-center gap-2 flex-wrap">
                      {r.status === "D" ? <>Received by {r.receiver_name} <SignatureImage path={r.receiver_signature} height={24} /></> : r.reason}
                      <span className="text-ink-3">{fmtTime(r.recorded_at)}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Button className="w-full py-3" disabled={!sheetRows.length || pending > 0} onClick={close}>
            {pending ? `Record all reports before closing (${pending} left)` : "Close sheet and send to the lab"}
          </Button>
        </>
      )}

      {sheets.filter((s) => s.closed_at).length > 0 && (
        <section className="mt-8">
          <h2 className="font-semibold text-ink mb-2">Recent sheets</h2>
          <ul className="space-y-2">
            {sheets.filter((s) => s.closed_at).slice(0, 8).map((s) => {
              const rs = rows.filter((r) => r.sheet_id === s.id);
              return (
                <li key={s.id} className="card px-4 py-3 text-sm">
                  <div className="flex justify-between gap-3"><span className="text-ink">{s.location}</span><span className="text-ink-3">{fmtIso(s.closed_at)}</span></div>
                  <div className="text-ink-2">{rs.filter((r) => r.status === "D").length} of {rs.length} delivered. {s.reviewed_at ? `Reviewed by ${s.reviewed_by}.` : "Awaiting lab review."}</div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Results released by the lab and waiting to be collected, by centre. The courier's own route sites come first. */
function ReadyList({ waiting, centres, mySites, chosen, onChoose }: {
  waiting: api.ReportRelease[]; centres: api.Centre[]; mySites: Set<number>; chosen: string; onChoose: (name: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const key = (s: string) => s.trim().toLowerCase();
  const onRoute = new Set(centres.filter((c) => mySites.has(c.id)).map((c) => key(c.name)));
  const m = new Map<string, api.ReportRelease[]>();
  waiting.forEach((w) => m.set(w.destination, [...(m.get(w.destination) || []), w]));
  const groups = [...m.entries()].map(([dest, items]) => ({ dest, items, mine: onRoute.has(key(dest)) }))
    .sort((a, b) => (a.mine === b.mine ? a.dest.localeCompare(b.dest) : a.mine ? -1 : 1));
  const mineCount = groups.filter((g) => g.mine).reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="card mb-5 overflow-hidden">
      <div className="px-4 py-3 border-b" style={{ borderColor: C.line, background: C.raised }}>
        <p className="font-semibold text-ink">Results ready for collection</p>
        <p className="text-sm text-ink-2">
          {!waiting.length ? "Nothing has been released yet. This list updates by itself."
            : `${waiting.length} report${waiting.length === 1 ? "" : "s"} ready at the lab${mySites.size ? `, ${mineCount} for sites on your routes` : ""}. Tap a centre to deliver there.`}
        </p>
      </div>
      <ul>
        {groups.map((g) => {
          const isChosen = key(chosen) === key(g.dest);
          return (
            <li key={g.dest} className="border-b last:border-b-0" style={{ borderColor: C.line, background: isChosen ? tint(C.accent, 10) : undefined }}>
              <div className="flex items-center gap-3 px-4 py-3">
                <button className="flex-1 min-w-0 text-left cursor-pointer" onClick={() => onChoose(g.dest)} aria-pressed={isChosen}>
                  <span className="block text-lg font-semibold text-ink truncate">{g.dest}</span>
                  <span className="block text-sm text-ink-2">
                    {g.items.length} report{g.items.length === 1 ? "" : "s"} ready{g.mine ? "" : ". Not on your routes"}
                  </span>
                </button>
                {g.mine && <Badge color={C.success}>Your route</Badge>}
                <button className="text-sm text-accent underline cursor-pointer whitespace-nowrap" onClick={() => setOpen(open === g.dest ? null : g.dest)}
                  aria-expanded={open === g.dest}>{open === g.dest ? "Hide" : "See R#s"}</button>
              </div>
              {open === g.dest && (
                <ul className="px-4 pb-3 -mt-1">
                  {g.items.map((w) => (
                    <li key={w.id} className="text-sm py-0.5"><span className="num text-ink">R#{w.r_number}</span> <span className="text-ink-3">{w.client_name || ""}</span></li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RecordDelivery({ row, onCancel, onSaved, toast }: {
  row: api.ReportDelivery; onCancel: () => void; onSaved: () => void; toast: (m: string, t?: "ok" | "err") => void;
}) {
  const [status, setStatus] = useState<"D" | "ND" | "CU" | "C">("D");
  const [name, setName] = useState("");
  const [sig, setSig] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (status === "D" && (!name.trim() || !sig)) return setErr("Ask the receiver to type their name and sign.");
    if (status !== "D" && !reason.trim()) return setErr("Give the reason it wasn't delivered.");
    setBusy(true); setErr(null);
    try { await api.recordDelivery(row.id, status, name, sig, reason); toast(status === "D" ? "Delivery recorded." : "Recorded as not delivered."); onSaved(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  const options: { v: typeof status; label: string }[] = [
    { v: "D", label: "Delivered" }, { v: "ND", label: "Not delivered" }, { v: "CU", label: "Client unavailable" }, { v: "C", label: "Closed" },
  ];
  return (
    <div className="max-w-lg mx-auto px-4 py-5">
      <button className="text-accent underline text-sm mb-3 cursor-pointer" onClick={onCancel}>Back to sheet</button>
      <h1 className="num text-2xl font-semibold text-ink">R#{row.r_number}</h1>
      <p className="text-ink-2 mb-4">{row.client_name || "Client not set"}</p>
      {err && <Note tone="err">{err}</Note>}
      <div className="grid grid-cols-2 gap-2 mb-5" role="radiogroup" aria-label="Status">
        {options.map((o) => (
          <button key={o.v} role="radio" aria-checked={status === o.v} onClick={() => setStatus(o.v)}
            className="rounded-lg border-2 py-3 px-2 text-base cursor-pointer"
            style={{ borderColor: status === o.v ? C.accent : C.line, background: status === o.v ? "color-mix(in srgb, var(--accent) 10%, transparent)" : C.surface, color: C.ink, fontWeight: status === o.v ? 600 : 400 }}>
            {o.label} <span className="text-ink-3">({o.v})</span>
          </button>
        ))}
      </div>
      {status === "D" ? (
        <>
          <Field label="Receiver's full name"><input className={inputCls} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="mb-5"><SignaturePad label="Receiver's signature" onChange={setSig} /></div>
        </>
      ) : (
        <Field label="Reason not delivered"><textarea className={`${inputCls} h-24`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Reception closed; will return at 2 pm" /></Field>
      )}
      <Button tone="primary" className="w-full py-3.5 text-lg" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</Button>
      <p className="text-xs text-ink-3 mt-3">The date and time are recorded automatically when you save.</p>
    </div>
  );
}
