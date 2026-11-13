import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { formatMinutes } from "../lib/tracker";

// Fixed TV palette: dark, high contrast, readable across a room.
const T = {
  emg: "#ff4fa3",
  bg: "#0b1016", panel: "#141c25", line: "#263241", ink: "#f1f5f9", ink2: "#b8c4d0", ink3: "#7f8c99",
  accent: "#5bb8e0", good: "#5fd394", warn: "#f5b84f", bad: "#ff6b6b",
};
const PER_PAGE = 6;
const ROTATE_MS = 12000;
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (iso: string | null) => { if (!iso) return ""; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const firstName = (email: string | null) => { const n = (email || "").split("@")[0]!.split(/[._-]/)[0] || ""; return n.charAt(0).toUpperCase() + n.slice(1); };

export default function WallDisplay({ onSignOut }: { onSignOut: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.loadTransport>> | null>(null);
  const [ok, setOk] = useState(true);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [now, setNow] = useState(new Date());
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    try { setData(await api.loadTransport(30)); setOk(true); setUpdated(new Date()); }
    catch { setOk(false); }
  }, []);

  useEffect(() => {
    load();
    let t: number | undefined;
    const unsub = api.subscribeTransport(() => { clearTimeout(t); t = window.setTimeout(load, 800); });
    const clock = setInterval(() => setNow(new Date()), 1000);
    const safety = setInterval(load, 2 * 60000);                    // in case a live update is missed
    const reload = setTimeout(() => window.location.reload(), 6 * 3600e3); // pick up new versions, free memory
    return () => { unsub(); clearTimeout(t); clearInterval(clock); clearInterval(safety); clearTimeout(reload); };
  }, [load]);

  // Keep the TV's screen awake while this page is showing
  useEffect(() => {
    let lock: any = null;
    const get = async () => { try { lock = await (navigator as any).wakeLock?.request("screen"); } catch { /* not supported */ } };
    get();
    const vis = () => { if (!document.hidden) get(); };
    document.addEventListener("visibilitychange", vis);
    return () => { document.removeEventListener("visibilitychange", vis); lock?.release?.(); };
  }, []);

  const view = useMemo(() => {
    if (!data) return null;
    const t = now.getTime();
    const alert = data.settings.transitAlertMinutes;
    const centreName = (id: number | null) => data.centres.find((c) => c.id === id)?.name || "Unknown centre";
    const onTheWay = data.samples.filter((s) => !s.received_at && s.source === "courier");
    const runIds = [...new Set(onTheWay.map((s) => s.run_id))];
    const runs = runIds.map((id) => {
      const items = onTheWay.filter((s) => s.run_id === id);
      const run = data.runs.find((r) => r.id === id) || null;
      const oldest = Math.min(...items.map((s) => new Date(s.collected_at || t).getTime()));
      const age = (t - oldest) / 60000;
      return { id, run, centreId: run?.centre_id ?? items[0]!.centre_id, items, age, delayed: age > alert, atLab: !!run?.handed_over_at, emergency: !!run?.is_emergency };
    });
    const centres = [...new Set(runs.map((r) => r.centreId))].map((cid) => {
      const rs = runs.filter((r) => r.centreId === cid).sort((a, b) => Number(b.emergency) - Number(a.emergency) || b.age - a.age);
      return { cid, name: centreName(cid), runs: rs, tubes: rs.reduce((n, r) => n + r.items.length, 0), delayed: rs.some((r) => r.delayed), oldest: rs[0]?.age ?? 0, emergency: rs.some((r) => r.emergency) };
    }).sort((a, b) => Number(b.emergency) - Number(a.emergency) || Number(b.delayed) - Number(a.delayed) || b.oldest - a.oldest);
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const today = data.samples.filter((s) => s.received_at && new Date(s.received_at) >= startOfDay)
      .sort((a, b) => b.received_at!.localeCompare(a.received_at!));
    return {
      alert, centres, centreName,
      tubes: onTheWay.length,
      collections: runs.length,
      delayedTubes: runs.filter((r) => r.delayed).reduce((n, r) => n + r.items.length, 0),
      receivedToday: today.length,
      emergencyTubes: runs.filter((r) => r.emergency).reduce((n, r) => n + r.items.length, 0),
      recent: today.slice(0, 9),
    };
  }, [data, now]);

  // Page through centres if they don't all fit
  const pages = view ? Math.max(1, Math.ceil(view.centres.length / PER_PAGE)) : 1;
  useEffect(() => { if (page >= pages) setPage(0); }, [pages, page]);
  useEffect(() => {
    if (pages <= 1) return;
    const i = setInterval(() => setPage((p) => (p + 1) % pages), ROTATE_MS);
    return () => clearInterval(i);
  }, [pages]);

  const fs = (v: number) => `${v}vw`; // font sizes relative to screen width
  const shown = view ? view.centres.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE) : [];

  return (
    <div style={{ background: T.bg, color: T.ink, minHeight: "100vh", height: "100vh", overflow: "hidden", display: "flex", flexDirection: "column",
      fontFamily: "'Atkinson Hyperlegible Next', 'Atkinson Hyperlegible', system-ui, sans-serif", padding: "1.6vw 2vw", gap: "1.2vw", cursor: "none" }}>
      {/* Header */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: fs(2.4), fontWeight: 700, lineHeight: 1.1 }}>Incoming samples</div>
          <div style={{ fontSize: fs(1), color: T.ink2 }}>{now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: fs(3), fontWeight: 600, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{pad(now.getHours())}:{pad(now.getMinutes())}</div>
          <div style={{ fontSize: fs(0.9), color: ok ? T.good : T.bad, display: "flex", gap: "0.5vw", alignItems: "center", justifyContent: "flex-end" }}>
            <span style={{ width: "0.7vw", height: "0.7vw", borderRadius: "50%", background: ok ? T.good : T.bad, display: "inline-block" }} />
            {ok ? `Live, updated ${updated ? `${pad(updated.getHours())}:${pad(updated.getMinutes())}:${pad(updated.getSeconds())}` : ""}` : "Connection lost, retrying…"}
          </div>
        </div>
      </header>

      {/* Headline numbers */}
      {view && (
        <section style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1vw" }}>
          {[
            { label: "Tubes on the way", value: view.tubes, color: T.accent },
            view.emergencyTubes
              ? { label: "EMERGENCY tubes on the way", value: view.emergencyTubes, color: T.emg }
              : { label: "Collections on the way", value: view.collections, color: T.ink },
            { label: `Delayed (over ${formatMinutes(view.alert)})`, value: view.delayedTubes, color: view.delayedTubes ? T.bad : T.ink3 },
            { label: "Received today", value: view.receivedToday, color: T.good },
          ].map((s) => (
            <div key={s.label} style={{ background: T.panel, borderRadius: "0.8vw", padding: "1vw 1.4vw", borderTop: `0.35vw solid ${s.color}` }}>
              <div style={{ fontSize: fs(4.2), fontWeight: 700, color: s.color, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{s.value}</div>
              <div style={{ fontSize: fs(1.1), color: T.ink2, marginTop: "0.4vw" }}>{s.label}</div>
            </div>
          ))}
        </section>
      )}

      {/* Main: centres + just arrived */}
      {view && (
        <main style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "1fr 24vw", gap: "1.2vw" }}>
          <section style={{ minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.6vw" }}>
              <h2 style={{ fontSize: fs(1.4), fontWeight: 600, margin: 0 }}>On the way, by centre</h2>
              {pages > 1 && (
                <span style={{ display: "flex", gap: "0.5vw", alignItems: "center", fontSize: fs(0.9), color: T.ink3 }}>
                  Page {page + 1} of {pages}
                  {Array.from({ length: pages }).map((_, i) => <span key={i} style={{ width: "0.6vw", height: "0.6vw", borderRadius: "50%", background: i === page ? T.ink : T.line }} />)}
                </span>
              )}
            </div>
            {!view.centres.length ? (
              <div style={{ flex: 1, background: T.panel, borderRadius: "0.8vw", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: "0.6vw" }}>
                <div style={{ fontSize: fs(2.2), fontWeight: 600 }}>No samples on the way</div>
                <div style={{ fontSize: fs(1.1), color: T.ink2 }}>Collections appear here as soon as a courier logs them.</div>
              </div>
            ) : (
              <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gridTemplateRows: "repeat(2, 1fr)", gap: "1vw" }}>
                {shown.map((c) => (
                  <div key={c.cid ?? "x"} style={{ background: T.panel, borderRadius: "0.8vw", padding: "1vw 1.2vw", display: "flex", flexDirection: "column", minHeight: 0,
                    borderLeft: `0.45vw solid ${c.emergency ? T.emg : c.delayed ? T.bad : T.accent}`, boxShadow: c.emergency ? `0 0 0 0.2vw ${T.emg} inset` : undefined }}>
                    {c.emergency && <div style={{ alignSelf: "flex-start", background: T.emg, color: "#fff", fontWeight: 800, fontSize: fs(0.95), padding: "0.15vw 0.7vw", borderRadius: "0.4vw", marginBottom: "0.4vw", letterSpacing: "0.05vw" }}>EMERGENCY</div>}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1vw" }}>
                      <div style={{ fontSize: fs(1.7), fontWeight: 700, lineHeight: 1.15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                      <div style={{ fontSize: fs(2.6), fontWeight: 700, color: c.delayed ? T.bad : T.accent, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{c.tubes}</div>
                    </div>
                    <div style={{ fontSize: fs(0.95), color: T.ink3, marginBottom: "0.6vw" }}>tube{c.tubes === 1 ? "" : "s"} on the way</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.6vw", overflow: "hidden" }}>
                      {c.runs.slice(0, 3).map((r) => {
                        const pct = Math.min(100, (r.age / view.alert) * 100);
                        const col = r.delayed ? T.bad : pct > 75 ? T.warn : T.good;
                        return (
                          <div key={String(r.id)}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: fs(1.05), gap: "0.6vw" }}>
                              <span style={{ color: T.ink }}>{r.emergency && <b style={{ color: T.emg }}>Emergency · </b>}{firstName(r.run?.courier_email ?? r.items[0]!.collected_by)} <span style={{ color: T.ink3 }}>· {r.items.length} tube{r.items.length === 1 ? "" : "s"}, from {hhmm(new Date(Math.min(...r.items.map((x) => new Date(x.collected_at || Date.now()).getTime()))).toISOString())}</span></span>
                              <span style={{ color: col, fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{formatMinutes(r.age)}</span>
                            </div>
                            <div style={{ height: "0.45vw", background: T.line, borderRadius: "1vw", overflow: "hidden", marginTop: "0.25vw" }}>
                              <div style={{ width: `${Math.max(4, pct)}%`, height: "100%", background: col }} />
                            </div>
                            <div style={{ fontSize: fs(0.85), color: r.atLab ? T.warn : T.ink3, marginTop: "0.2vw" }}>
                              {r.atLab ? `Handed over at ${hhmm(r.run!.handed_over_at)}: waiting to be scanned in` : r.emergency && r.run?.emergency_reason ? r.run.emergency_reason : r.delayed ? "Delayed: check with the courier" : "Collecting or on the road"}
                            </div>
                          </div>
                        );
                      })}
                      {c.runs.length > 3 && <div style={{ fontSize: fs(0.9), color: T.ink3 }}>+ {c.runs.length - 3} more collection{c.runs.length - 3 === 1 ? "" : "s"}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <aside style={{ background: T.panel, borderRadius: "0.8vw", padding: "1vw 1.2vw", minHeight: 0, overflow: "hidden" }}>
            <h2 style={{ fontSize: fs(1.4), fontWeight: 600, margin: "0 0 0.8vw" }}>Just arrived</h2>
            {!view.recent.length && <div style={{ fontSize: fs(1.05), color: T.ink3 }}>Nothing received yet today.</div>}
            {view.recent.map((s) => {
              const tr = s.collected_at ? (new Date(s.received_at!).getTime() - new Date(s.collected_at).getTime()) / 60000 : null;
              return (
                <div key={s.id} style={{ display: "flex", justifyContent: "space-between", gap: "0.8vw", padding: "0.55vw 0", borderBottom: `1px solid ${T.line}` }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: fs(1.1), fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{s.r_number ? `R#${s.r_number}` : s.barcode}</div>
                    <div style={{ fontSize: fs(0.85), color: s.source === "reception" ? T.warn : T.ink3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {s.source === "reception" ? "Not logged by a courier" : `${view.centreName(s.centre_id)}${tr !== null ? `, ${formatMinutes(tr)} in transit` : ""}`}
                    </div>
                  </div>
                  <div style={{ fontSize: fs(1.1), color: T.good, fontVariantNumeric: "tabular-nums" }}>{hhmm(s.received_at)}</div>
                </div>
              );
            })}
          </aside>
        </main>
      )}

      {!view && <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: fs(1.6), color: T.ink2 }}>Loading…</div>}

      <footer style={{ display: "flex", justifyContent: "space-between", fontSize: fs(0.75), color: T.ink3 }}>
        <span>Post-Analytical Tracker · wall display (read-only)</span>
        <button onClick={() => { if (confirm("Sign this wall display out?")) onSignOut(); }}
          style={{ background: "none", border: "none", color: T.ink3, cursor: "pointer", fontSize: fs(0.75) }}>Sign out</button>
      </footer>
    </div>
  );
}
