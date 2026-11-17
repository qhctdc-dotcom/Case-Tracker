import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { Badge, Button, C, Field, Note, Panel, inputCls } from "./ui";

type Draft = { id: number | null; name: string; active: boolean; sites: number[]; couriers: string[] };

/** Admin: courier routes, the sites on each (in visiting order) and who is assigned. */
export default function RoutesPanel({ isAdmin, toast }: { isAdmin: boolean; toast: (m: string, t?: "ok" | "err") => void }) {
  const [routes, setRoutes] = useState<api.CourierRoute[] | null>(null);
  const [centres, setCentres] = useState<api.Centre[]>([]);
  const [couriers, setCouriers] = useState<api.StaffRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [addSite, setAddSite] = useState("");
  const [saving, setSaving] = useState(false);
  const [moveCouriers, setMoveCouriers] = useState(true);

  async function load() {
    try {
      const [r, c] = await Promise.all([api.loadRoutes(), api.loadCentres()]);
      setRoutes(r); setCentres(c); setErr(null);
      if (isAdmin) {
        const s = await api.staffFn<{ staff: api.StaffRow[] }>({ action: "list" }).catch(() => ({ staff: [] as api.StaffRow[] }));
        setCouriers(s.staff.filter((x) => x.role === "courier"));
      }
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const centreName = (id: number) => centres.find((c) => c.id === id)?.name || "Unknown site";
  const courierName = (email: string) => couriers.find((c) => c.email === email)?.display_name || email.split("@")[0];
  /** Other routes (in use) a courier is assigned to, besides the one being edited */
  const otherRoutes = (email: string, exceptId: number | null) =>
    (routes || []).filter((r) => r.id !== exceptId && r.active && r.couriers.includes(email));
  const multi = couriers.map((c) => ({ c, rs: otherRoutes(c.email, null) })).filter((x) => x.rs.length > 1);

  function move(i: number, d: -1 | 1) {
    if (!draft) return;
    const s = [...draft.sites]; const j = i + d;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j]!, s[i]!];
    setDraft({ ...draft, sites: s });
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) return toast("Give the route a name.", "err");
    if (!draft.sites.length) return toast("Add at least one site to the route.", "err");
    setSaving(true);
    try {
      await api.saveRoute(draft);
      // A courier normally works one route: take the ticked couriers off their other routes
      let moved = 0;
      if (moveCouriers && draft.active) {
        for (const r of routes || []) {
          if (r.id === draft.id) continue;
          const keep = r.couriers.filter((e) => !draft.couriers.includes(e));
          if (keep.length !== r.couriers.length) { await api.saveRoute({ ...r, couriers: keep }); moved += r.couriers.length - keep.length; }
        }
      }
      toast(`Route "${draft.name}" saved.${moved ? ` ${moved} courier assignment${moved === 1 ? "" : "s"} removed from other routes.` : ""}`);
      setDraft(null); await load();
    }
    catch (e: any) { toast(e.message, "err"); }
    finally { setSaving(false); }
  }

  return (
    <Panel title="Courier routes" action={isAdmin && !draft ? <Button tone="primary" onClick={() => setDraft({ id: null, name: "", active: true, sites: [], couriers: [] })}>New route</Button> : undefined}>
      {err && <Note tone="err">Couldn't load routes: {err}. Has 08_courier_routes.sql been run in Supabase?</Note>}
      <p className="text-sm text-ink-2 mb-3">Couriers see only the routes assigned to them, with the sites in this order. Any courier can still make an emergency collection at any site.{!isAdmin && " Only admins can change routes."}</p>

      {draft && (
        <div className="rounded-lg p-4 mb-4" style={{ background: C.raised, border: `1px solid ${C.line}` }}>
          <h3 className="font-semibold text-ink mb-3">{draft.id ? "Edit route" : "New route"}</h3>
          <Field label="Route name"><input className={inputCls} placeholder="e.g. Route 1: East" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>

          <p className="text-sm font-medium text-ink-2 mb-1">Sites, in visiting order</p>
          <ol className="mb-2">
            {draft.sites.map((cid, i) => (
              <li key={cid} className="flex items-center gap-2 py-1.5 border-b" style={{ borderColor: C.line }}>
                <span className="w-6 text-sm text-ink-3 num">{i + 1}.</span>
                <span className="flex-1 text-ink">{centreName(cid)}</span>
                <Button tone="quiet" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
                <Button tone="quiet" aria-label="Move down" disabled={i === draft.sites.length - 1} onClick={() => move(i, 1)}>↓</Button>
                <Button tone="quiet" onClick={() => setDraft({ ...draft, sites: draft.sites.filter((x) => x !== cid) })}>Remove</Button>
              </li>
            ))}
            {!draft.sites.length && <li className="text-sm text-ink-3 py-1">No sites yet.</li>}
          </ol>
          <div className="flex gap-2 mb-4 max-w-md">
            <select className={inputCls} value={addSite} onChange={(e) => setAddSite(e.target.value)} aria-label="Site to add">
              <option value="">Choose a site to add…</option>
              {centres.filter((c) => c.active && !draft.sites.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <Button disabled={!addSite} onClick={() => { setDraft({ ...draft, sites: [...draft.sites, Number(addSite)] }); setAddSite(""); }}>Add</Button>
          </div>

          <p className="text-sm font-medium text-ink-2 mb-1">Assigned couriers</p>
          {!couriers.length && <p className="text-sm text-ink-3 mb-3">No courier accounts yet. Add them under Staff with the role Courier.</p>}
          <div className="flex flex-wrap gap-x-5 gap-y-2 mb-4">
            {couriers.map((c) => (
              <label key={c.email} className="flex items-center gap-2 text-ink cursor-pointer">
                <input type="checkbox" className="w-4 h-4 accent-[var(--accent)]" checked={draft.couriers.includes(c.email)}
                  onChange={(e) => setDraft({ ...draft, couriers: e.target.checked ? [...draft.couriers, c.email] : draft.couriers.filter((x) => x !== c.email) })} />
                {c.display_name || c.email}{!c.active && <span className="text-ink-3"> (deactivated)</span>}
                {otherRoutes(c.email, draft.id).length > 0 && <span className="text-xs text-ink-3">(now on {otherRoutes(c.email, draft.id).map((r) => r.name).join(", ")})</span>}
              </label>
            ))}
          </div>
          {draft.couriers.some((e) => otherRoutes(e, draft.id).length) && (
            <label className="flex items-start gap-2 text-sm text-ink mb-4 cursor-pointer max-w-xl">
              <input type="checkbox" className="w-4 h-4 mt-0.5 accent-[var(--accent)]" checked={moveCouriers} onChange={(e) => setMoveCouriers(e.target.checked)} />
              <span><b>Move</b> the ticked couriers to this route only (take them off {[...new Set(draft.couriers.flatMap((e) => otherRoutes(e, draft.id).map((r) => r.name)))].join(", ")}). Untick to keep them on both.</span>
            </label>
          )}

          <label className="flex items-center gap-2 text-ink mb-4 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 accent-[var(--accent)]" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
            Route in use (untick to hide it from couriers)
          </label>
          <div className="flex gap-2">
            <Button tone="primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save route"}</Button>
            <Button onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {multi.length > 0 && !draft && (
        <Note tone="warn">{multi.map(({ c, rs }) => `${c.display_name || c.email} is on ${rs.length} routes (${rs.map((r) => r.name).join(", ")})`).join(". ")}. Couriers see every route they are on. Edit a route and untick a courier to take them off it.</Note>
      )}
      {routes && !routes.length && !draft && <p className="text-sm text-ink-3">No routes yet.</p>}
      {routes && routes.length > 0 && (
        <ul>
          {routes.map((r) => (
            <li key={r.id} className="py-3 border-b last:border-b-0" style={{ borderColor: C.line }}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{r.name} {!r.active && <Badge color={C.ink3}>Not in use</Badge>}</p>
                  <p className="text-sm text-ink-2">{r.sites.map(centreName).join(" → ") || "No sites"}</p>
                  <p className="text-sm text-ink-3">Couriers: {r.couriers.length ? r.couriers.map(courierName).join(", ") : "none assigned"}</p>
                </div>
                {isAdmin && <Button onClick={() => { setMoveCouriers(true); setDraft({ id: r.id, name: r.name, active: r.active, sites: [...r.sites], couriers: [...r.couriers] }); }}>Edit</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
