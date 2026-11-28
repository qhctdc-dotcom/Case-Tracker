import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import {
  REPORT_DEPT_ORDER, fmtIso, fmtTime, formatMinutes, norm, rangeText, tatMs, verdict,
  type Slice, type SliceDept, type TrackedTest,
} from "../lib/tracker";
import { Badge, Button, C, Cap, DEPT_COLORS, Stat, csvCell, downloadFile, inputBase, stamp, tint } from "./ui";
import { DelayNoteModal, DelayStatusBadge, STATUS_LABEL, delayText, needsDelayReason } from "./DelayNote";

type StatusFilter = "open" | "all" | "done";
type SortMode = "priority" | "due" | "r" | "client";
type Group = "overdue" | "soon" | "later" | "done";
const GROUP_LABEL: Record<Group, string> = { overdue: "Overdue", soon: "Due within the hour", later: "Due later", done: "Completed" };
const HOUR = 3600e3;

type Cleared = Record<string, { at: string; overdue: boolean }>;
const CLEARED_KEY = "tracker.cleared";
function loadCleared(): Cleared {
  try { return JSON.parse(localStorage.getItem(CLEARED_KEY) || "{}") || {}; } catch { return {}; }
}
function saveCleared(v: Cleared) {
  try { localStorage.setItem(CLEARED_KEY, JSON.stringify(v)); } catch { /* storage full or blocked */ }
}

/** Today's date and a ticking clock, so staff can read TAT times against the real time. */
function DateClock() {
  const [t, setT] = useState(new Date());
  useEffect(() => { const i = setInterval(() => setT(new Date()), 1000); return () => clearInterval(i); }, []);
  return (
    <div className="leading-tight" aria-live="off">
      <div className="text-sm text-ink-2">{t.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div>
      <div className="num text-2xl font-semibold text-ink">{t.toLocaleTimeString("en-GB", { hour12: false })}</div>
    </div>
  );
}

/** "27/11 14:05", with the year only when it isn't this year. */
function shortStamp(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso); if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  const y = d.getFullYear() !== new Date().getFullYear() ? `/${d.getFullYear()}` : "";
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}${y} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function groupOf(c: Slice, now: number): Group {
  if (c.status === "Completed") return "done";
  const t = tatMs(c);
  if (now > t) return "overdue";
  return t - now <= HOUR ? "soon" : "later";
}

function statusText(c: Slice, now: number): { text: string; color: string } {
  const tat = tatMs(c);
  if (c.status !== "Completed") {
    const diff = (now - tat) / 60000;
    if (diff > 0) return { text: `${formatMinutes(diff)} over`, color: C.danger };
    return { text: `${formatMinutes(-diff)} left`, color: diff > -60 ? C.warning : C.ink2 };
  }
  const v = verdict(c, tat, now);
  if (v.kind === "ontime") return { text: "Done on time", color: C.success };
  if (v.kind === "late") return { text: `Done ${rangeText(v.min, v.max)} late`, color: C.danger };
  return { text: "Done, on time?", color: C.warning };
}

/** The TAT fuse: how much of the time between first sighting and TAT has burned. */
function Fuse({ c, now }: { c: Slice; now: number }) {
  const tat = tatMs(c);
  if (c.status === "Completed") {
    return <div className="h-1.5 rounded-full" style={{ background: tint(C.success, 55) }} />;
  }
  const start = Math.min(new Date(c.dateAdded || c.reportDateTime).getTime(), tat - HOUR);
  const frac = (now - start) / Math.max(tat - start, 1);
  const over = now > tat;
  const color = over ? C.danger : frac > 0.75 ? C.warning : C.accent;
  return (
    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--track)" }}
      role="img" aria-label={over ? "Past TAT" : `${Math.round(frac * 100)}% of time to TAT used`}>
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(4, frac * 100))}%`, background: color }} />
    </div>
  );
}

function TestChips({ tests, showDone }: { tests: TrackedTest[]; showDone: boolean }) {
  const pending = tests.filter((t) => t.status !== "Completed");
  const done = tests.filter((t) => t.status === "Completed");
  const list = showDone ? tests : pending;
  return (
    <div className="flex flex-wrap gap-1 items-center">
      {list.slice(0, 7).map((t) => (
        <span key={t.name} className={`num text-xs px-1.5 py-0.5 rounded border ${t.status === "Completed" && !showDone ? "" : ""}`}
          style={{ borderColor: C.line, background: C.raised, color: t.status === "Completed" ? C.ink3 : C.ink,
            textDecoration: t.status === "Completed" && !showDone ? "line-through" : undefined }}>
          {t.name}
        </span>
      ))}
      {list.length > 7 && <span className="text-xs text-ink-3">+{list.length - 7} more</span>}
      {!showDone && done.length > 0 && <span className="text-xs text-success">{done.length} done</span>}
    </div>
  );
}

export default function TrackerView({ slices, now, lastPaste, onOpenPaste, toast }: {
  slices: Slice[]; now: number; lastPaste: { at: string; by_email: string } | null; onOpenPaste: () => void;
  toast?: (text: string, tone?: "ok" | "err") => void;
}) {
  const [dept, setDept] = useState<SliceDept | "all">("all");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [alistOnly, setAlistOnly] = useState(false);
  const [sort, setSort] = useState<SortMode>("priority");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [arrange, setArrangeState] = useState<"dept" | "due">(() =>
    (typeof localStorage !== "undefined" && localStorage.getItem("tracker.arrange") === "due") ? "due" : "dept");
  const setArrange = (v: "dept" | "due") => { setArrangeState(v); try { localStorage.setItem("tracker.arrange", v); } catch { /* ignore */ } };

  // Delay reasons recorded by staff, keyed like slices ("R#__Department"). Shared with everyone, live.
  const [notes, setNotes] = useState<Record<string, api.DelayNote>>({});
  const [delayId, setDelayId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.loadDelayNotes(new Date(Date.now() - 180 * 86400e3).toISOString())
      .then((rows) => { if (alive) setNotes(Object.fromEntries(rows.map((n) => [`${n.r_number}__${n.department}`, n]))); })
      .catch(() => { /* not set up yet: saving explains what to run */ });
    load();
    let t: number | undefined; let unsub = () => {};
    try { unsub = api.subscribeDelayNotes(() => { clearTimeout(t); t = window.setTimeout(load, 600); }); } catch { /* offline */ }
    return () => { alive = false; unsub(); clearTimeout(t); };
  }, []);

  // Cases this person cleared from their own screen (kept in this browser only; nothing is deleted).
  const [cleared, setClearedState] = useState<Cleared>(loadCleared);
  const [showCleared, setShowCleared] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [undo, setUndo] = useState<{ ids: string[]; prev: Cleared } | null>(null);
  const setCleared = (next: Cleared) => { setClearedState(next); saveCleared(next); };
  // Forget entries for cases no longer in the tracker.
  useEffect(() => {
    if (!slices.length) return;
    const ids = new Set(slices.map((c) => c.id));
    const keep = Object.fromEntries(Object.entries(cleared).filter(([id]) => ids.has(id)));
    if (Object.keys(keep).length !== Object.keys(cleared).length) setCleared(keep);
  }, [slices]); // eslint-disable-line react-hooks/exhaustive-deps

  const isHidden = (c: Slice) => {
    const e = cleared[c.id];
    if (!e) return false;
    if (c.status !== "Completed") {
      if (c.lastSeen && new Date(c.lastSeen).getTime() > new Date(e.at).getTime()) return false; // still pending in a newer MT paste
      if (now > tatMs(c) && !e.overdue) return false; // went overdue after it was cleared
    }
    return true;
  };
  const hiddenIds = new Set(slices.filter(isHidden).map((c) => c.id));
  const shown = showCleared ? slices : slices.filter((c) => !hiddenIds.has(c.id));

  function clearIds(ids: string[]) {
    if (!ids.length) return;
    const at = new Date().toISOString();
    const next = { ...cleared };
    ids.forEach((id) => { const c = slices.find((s) => s.id === id); next[id] = { at, overdue: !!c && c.status !== "Completed" && now > tatMs(c) }; });
    setUndo({ ids, prev: cleared });
    setCleared(next); setPicked(new Set()); setPicking(false);
  }
  function restore(ids: string[]) {
    const next = { ...cleared }; ids.forEach((id) => delete next[id]); setCleared(next);
  }

  const open = slices.filter((c) => c.status !== "Completed");
  const depts: SliceDept[] = ["Hematology", "Microbiology", "Chemistry", "Immunology",
    ...(slices.some((c) => c.department === "Unclassified") ? ["Unclassified" as SliceDept] : [])];

  const visible = useMemo(() => {
    const q = norm(search);
    const v = shown.filter((c) => {
      if (dept !== "all" && c.department !== dept) return false;
      if (status === "open" && c.status === "Completed") return false;
      if (status === "done" && c.status !== "Completed") return false;
      if (alistOnly && !c.isAlist) return false;
      if (q && !norm([c.patientId, c.clientDisplay, c.clientRaw, c.tests.map((t) => t.name).join(" ")].join(" ")).includes(q)) return false;
      return true;
    });
    v.sort((a, b) => {
      if (sort === "priority" && a.isAlist !== b.isAlist) return a.isAlist ? -1 : 1;
      if (sort === "r") return Number(a.rNumber) - Number(b.rNumber);
      if (sort === "client") return a.clientDisplay.localeCompare(b.clientDisplay) || tatMs(a) - tatMs(b);
      return tatMs(a) - tatMs(b);
    });
    return v;
  }, [shown, dept, status, alistOnly, sort, search]); // eslint-disable-line react-hooks/exhaustive-deps

  const sel: Selection = {
    picking, picked, hidden: hiddenIds, restore: (id) => restore([id]), notes, onDelay: setDelayId,
    toggle: (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
  };
  // Completed cases still on screen for the chosen department (whatever the Show filter says).
  const completedShown = slices.filter((c) => c.status === "Completed" && !hiddenIds.has(c.id) && (dept === "all" || c.department === dept));

  const groups = (["overdue", "soon", "later", "done"] as Group[])
    .map((g) => ({ g, rows: visible.filter((c) => groupOf(c, now) === g) }))
    .filter((x) => x.rows.length);

  // Arrange by department: one section per department, overdue first inside each.
  const rank: Record<Group, number> = { overdue: 0, soon: 1, later: 2, done: 3 };
  const deptGroups = REPORT_DEPT_ORDER
    .map((d) => ({ d, rows: visible.filter((c) => c.department === d)
      .sort((a, b) => rank[groupOf(a, now)] - rank[groupOf(b, now)]) }))
    .filter((x) => x.rows.length);

  const selected = openId ? slices.find((c) => c.id === openId) || null : null;
  const overdue = open.filter((c) => now > tatMs(c)).length;
  const soon = open.filter((c) => groupOf(c, now) === "soon").length;
  const staleMin = lastPaste ? (now - new Date(lastPaste.at).getTime()) / 60000 : null;

  function exportCsv() {
    const rows = [["R#", "Client", "A-List", "Department", "Pending tests", "Tests done", "TAT", "Status", "Completed (detected)", "Last seen pending", "Delay reason", "Delay details", "Delayed by (min)", "Delay follow-up"].join(",")];
    (arrange === "dept" ? deptGroups.flatMap((x) => x.rows) : visible).forEach((c) => {
      const pend = c.tests.filter((t) => t.status !== "Completed").map((t) => t.name).join(", ");
      const done = c.tests.filter((t) => t.status === "Completed").map((t) => t.name).join(", ");
      rows.push([c.patientId, csvCell(c.clientDisplay), c.isAlist ? "A-List" : "", c.department, csvCell(pend), csvCell(done),
        c.reportDate, csvCell(statusText(c, now).text), fmtIso(c.completedAt), fmtIso(c.lastSeen),
        csvCell(notes[c.id]?.reason_category || ""), csvCell(notes[c.id]?.reason || ""), notes[c.id]?.delay_minutes ?? "",
        notes[c.id] ? STATUS_LABEL[notes[c.id].status] : ""].join(","));
    });
    downloadFile(`tracker_export_${stamp()}.csv`, rows.join("\n"), "text/csv;charset=utf-8;");
  }

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-5">
      {/* Headline numbers + primary action */}
      <div className="flex items-end justify-between gap-6 flex-wrap mb-5">
        <div className="flex gap-8 sm:gap-12 flex-wrap items-end">
          <div className="pr-8 sm:pr-12 border-r" style={{ borderColor: C.line }}><DateClock /></div>
          <Stat label="Outstanding" value={open.length} />
          <Stat label="Overdue" value={overdue} color={overdue ? C.danger : C.ink} />
          <Stat label="Due within the hour" value={soon} color={soon ? C.warning : C.ink} />
          <Stat label="A-List outstanding" value={open.filter((c) => c.isAlist).length} color={C.alist} />
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button tone="primary" className="px-4 py-2 text-base" onClick={onOpenPaste}>Paste MT list</Button>
          <span className="text-xs" style={{ color: staleMin !== null && staleMin > 120 && open.length ? C.warning : C.ink3 }}>
            {lastPaste ? `Last updated ${fmtTime(lastPaste.at)}${staleMin !== null && staleMin > 120 ? ", paste a fresh list" : ""}` : "No list pasted yet"}
          </span>
        </div>
      </div>

      {/* Department filter */}
      <div className="flex flex-wrap gap-2 mb-3" role="group" aria-label="Department">
        <button onClick={() => setDept("all")} aria-pressed={dept === "all"}
          className="px-3 py-1.5 rounded-full text-sm border cursor-pointer"
          style={{ borderColor: dept === "all" ? C.ink : C.line, background: dept === "all" ? C.ink : C.surface, color: dept === "all" ? C.surface : C.ink }}>
          All departments <span className="num ml-1 opacity-80">{shown.filter((c) => c.status !== "Completed").length}</span>
        </button>
        {depts.map((d) => {
          const on = dept === d;
          const n = shown.filter((c) => c.status !== "Completed" && c.department === d).length;
          return (
            <button key={d} onClick={() => setDept(on ? "all" : d)} aria-pressed={on}
              className="flex items-center gap-2 pl-2.5 pr-3 py-1.5 rounded-full text-sm border cursor-pointer"
              style={{ borderColor: on ? DEPT_COLORS[d] : C.line, background: on ? tint(DEPT_COLORS[d], 14) : C.surface, color: C.ink }}>
              <Cap dept={d} size={12} /> {d} <span className="num text-ink-2">{n}</span>
            </button>
          );
        })}
      </div>

      {/* Tools */}
      <div className="flex flex-wrap gap-2 items-center mb-4">
        <input type="search" placeholder="Search R#, client or test" value={search} onChange={(e) => setSearch(e.target.value)}
          className={`${inputBase} w-64 max-w-full`} aria-label="Search" />
        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className={inputBase} aria-label="Show">
          <option value="open">Outstanding only</option>
          <option value="all">Outstanding and completed</option>
          <option value="done">Completed only</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)} className={inputBase} aria-label="Sort">
          <option value="priority">A-List first, then oldest TAT</option>
          <option value="due">Oldest TAT first</option>
          <option value="r">By R# number</option>
          <option value="client">By client</option>
        </select>
        <div className="flex rounded-lg border overflow-hidden text-sm" role="group" aria-label="Arrange by" style={{ borderColor: C.line }}>
          {([["dept", "By department"], ["due", "By due time"]] as const).map(([v, label]) => (
            <button key={v} onClick={() => setArrange(v)} aria-pressed={arrange === v}
              className="px-3 py-1.5 cursor-pointer"
              style={{ background: arrange === v ? C.ink : C.surface, color: arrange === v ? C.surface : C.ink }}>{label}</button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-2 cursor-pointer px-1">
          <input type="checkbox" checked={alistOnly} onChange={(e) => setAlistOnly(e.target.checked)} className="w-4 h-4 accent-[var(--alist)]" />
          A-List only
        </label>
        <Button tone="quiet" className="ml-auto" onClick={exportCsv}>Export this view (CSV)</Button>
      </div>

      {/* Clear cases from this person's screen */}
      <div className="flex flex-wrap gap-2 items-center mb-4 text-sm">
        {!picking ? (
          <>
            <Button onClick={() => { setPicking(true); setPicked(new Set()); }}>Select cases to clear</Button>
            <Button tone="quiet" disabled={!completedShown.length}
              onClick={() => clearIds(completedShown.map((c) => c.id))}>Clear completed ({completedShown.length})</Button>
          </>
        ) : (
          <>
            <span className="text-ink-2"><span className="num font-semibold text-ink">{picked.size}</span> selected</span>
            <Button tone="quiet" onClick={() => setPicked(new Set(visible.filter((c) => !hiddenIds.has(c.id)).map((c) => c.id)))}>Select all shown</Button>
            <Button tone="primary" disabled={!picked.size} onClick={() => clearIds([...picked])}>Clear selected from my screen</Button>
            <Button tone="quiet" onClick={() => { setPicking(false); setPicked(new Set()); }}>Cancel</Button>
          </>
        )}
        {hiddenIds.size > 0 && (
          <label className="flex items-center gap-2 text-ink-2 cursor-pointer px-1 ml-auto">
            <input type="checkbox" checked={showCleared} onChange={(e) => setShowCleared(e.target.checked)} className="w-4 h-4" />
            Show cleared <span className="num">({hiddenIds.size})</span>
          </label>
        )}
        {hiddenIds.size > 0 && <Button tone="quiet" onClick={() => restore([...hiddenIds])}>Restore all</Button>}
      </div>
      {undo && (
        <div className="card px-4 py-2.5 mb-4 flex items-center gap-3 flex-wrap text-sm" role="status">
          <span className="text-ink">Cleared {undo.ids.length} {undo.ids.length === 1 ? "case" : "cases"} from your screen. Nothing was deleted; other staff still see them.</span>
          <Button tone="quiet" onClick={() => { setCleared(undo.prev); setUndo(null); }}>Undo</Button>
          <Button tone="quiet" className="ml-auto" onClick={() => setUndo(null)}>Dismiss</Button>
        </div>
      )}

      {/* Worklist */}
      {!visible.length ? (
        <div className="card p-10 text-center">
          <p className="text-ink-2 mb-4">{slices.length ? "No cases match these filters." : "Nothing is being tracked yet. Paste the MT outstanding list to start."}</p>
          {!slices.length && <Button tone="primary" onClick={onOpenPaste}>Paste MT list</Button>}
        </div>
      ) : arrange === "dept" ? deptGroups.map(({ d, rows }) => {
        const out = rows.filter((c) => c.status !== "Completed");
        const late = out.filter((c) => now > tatMs(c)).length;
        const alist = out.filter((c) => c.isAlist).length;
        return (
          <section key={d} className="mb-6" aria-label={d}>
            <h2 className="flex items-center gap-2 mb-2 text-base font-semibold text-ink flex-wrap">
              <Cap dept={d} size={14} /> {d}
              <span className="num text-sm font-normal text-ink-3">{rows.length}</span>
              <span className="flex gap-1.5 ml-1 font-normal">
                {late > 0 && <Badge color={C.danger}>{late} overdue</Badge>}
                {alist > 0 && <Badge color={C.alist}>{alist} A-List</Badge>}
              </span>
            </h2>
            <Worklist rows={rows} now={now} lead="Due" onOpen={setOpenId} accent={DEPT_COLORS[d]} sel={sel} />
          </section>
        );
      }) : groups.map(({ g, rows }) => (
        <section key={g} className="mb-6" aria-label={GROUP_LABEL[g]}>
          <h2 className="flex items-baseline gap-2 mb-2 text-base font-semibold" style={{ color: g === "overdue" ? C.danger : g === "soon" ? C.warning : C.ink }}>
            {GROUP_LABEL[g]} <span className="num text-sm font-normal text-ink-3">{rows.length}</span>
          </h2>
          <Worklist rows={rows} now={now} lead="Department" onOpen={setOpenId} sel={sel} />
        </section>
      ))}
      <p className="text-xs text-ink-3">Showing {visible.length} of {slices.length} department entries.</p>

      <DelayNoteModal c={delayId ? slices.find((s) => s.id === delayId) || null : null} note={delayId ? notes[delayId] || null : null}
        now={now} onClose={() => setDelayId(null)} onSaved={(m) => toast?.(m)} />

      <CaseDrawer c={selected} siblings={selected ? slices.filter((s) => s.rNumber === selected.rNumber && s.id !== selected.id) : []}
        now={now} onClose={() => setOpenId(null)} onSelect={setOpenId} />
    </div>
  );
}

/** The worklist table. `lead` picks the first column: the department, or the due-time group when already split by department. */
type Selection = {
  picking: boolean; picked: Set<string>; toggle: (id: string) => void;
  hidden: Set<string>; restore: (id: string) => void;
  notes: Record<string, api.DelayNote>; onDelay: (id: string) => void;
};

/** The delay-reason cell at the end of each row. */
function DelayCell({ c, now, sel }: { c: Slice; now: number; sel: Selection }) {
  const n = sel.notes[c.id];
  if (n) return (
    <button onClick={() => sel.onDelay(c.id)} className="w-full text-left rounded-md px-2 py-1.5 hover:bg-raised cursor-pointer"
      title={`${n.reason_category}${n.reason ? `: ${n.reason}` : ""}`}>
      <span className="block text-xs font-medium text-ink truncate">{n.reason_category}</span>
      <span className="flex items-center gap-1.5 mt-0.5">
        <span className="num text-xs text-ink-2">+{delayText(n.delay_minutes)}</span>
        <DelayStatusBadge s={n.status} />
      </span>
    </button>
  );
  if (!needsDelayReason(c, now)) return null;
  return (
    <button onClick={() => sel.onDelay(c.id)}
      className="w-full rounded-md px-2 py-1.5 text-xs font-semibold border cursor-pointer hover:bg-raised"
      style={{ borderColor: C.danger, color: C.danger }}>Add delay reason</button>
  );
}

function Worklist({ rows, now, lead, onOpen, accent, sel }: {
  rows: Slice[]; now: number; lead: "Department" | "Due"; onOpen: (id: string) => void; accent?: string; sel: Selection;
}) {
  return (
          <div className="card overflow-hidden" style={accent ? { borderTop: `3px solid ${accent}` } : undefined}>
            <div className="hidden md:flex border-b" style={{ borderColor: C.line, background: C.raised }}>
              {sel.picking && <span className="w-10 shrink-0" />}
              <div className="flex-1 grid grid-cols-[9rem_minmax(12rem,1.3fr)_minmax(10rem,2fr)_12rem] gap-4 px-4 py-2 text-xs text-ink-3">
                <span>{lead}</span><span>Requisition</span><span>Tests</span><span>TAT</span>
              </div>
              <span className="w-44 shrink-0 px-2 py-2 text-xs text-ink-3">Delay reason</span>
            </div>
            {rows.map((c) => {
              const st = statusText(c, now);
              const g = groupOf(c, now);
              const isCleared = sel.hidden.has(c.id);
              return (
                <div key={c.id} className="flex flex-wrap md:flex-nowrap items-stretch border-b last:border-b-0" style={{ borderColor: C.line,
                  boxShadow: g === "overdue" ? `inset 4px 0 0 ${C.danger}` : undefined, opacity: isCleared ? 0.6 : undefined }}>
                {sel.picking && (
                  <label className="w-10 shrink-0 flex items-center justify-center cursor-pointer hover:bg-raised">
                    <input type="checkbox" className="w-4 h-4" checked={sel.picked.has(c.id)} disabled={isCleared}
                      onChange={() => sel.toggle(c.id)} aria-label={`Select ${c.patientId} ${c.department}`} />
                  </label>
                )}
                <button onClick={() => (sel.picking && !isCleared ? sel.toggle(c.id) : onOpen(c.id))}
                  className="flex-1 min-w-0 text-left grid md:grid-cols-[9rem_minmax(12rem,1.3fr)_minmax(10rem,2fr)_12rem] gap-x-4 gap-y-2 px-4 hover:bg-raised cursor-pointer"
                  style={{ paddingTop: "var(--row-y)", paddingBottom: "var(--row-y)" }}>
                  {lead === "Department"
                    ? <span className="flex items-center gap-2 text-sm text-ink-2"><Cap dept={c.department} /> {c.department}</span>
                    : <span className="text-sm font-medium self-center" style={{ color: g === "overdue" ? C.danger : g === "soon" ? C.warning : g === "done" ? C.success : C.ink2 }}>{GROUP_LABEL[g]}</span>}
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="num font-semibold text-ink">{c.patientId}</span>
                      {c.isAlist && <Badge color={C.alist}>A-List</Badge>}
                      {isCleared && <Badge color={C.ink3}>Cleared</Badge>}
                    </span>
                    <span className="block text-sm text-ink-2 break-words">{c.clientDisplay}</span>
                    <span className="block num text-xs text-ink-3 mt-0.5">
                      {c.dateAdded && <>Added {shortStamp(c.dateAdded)}</>}
                      {c.status === "Completed"
                        ? c.completedAt && <> · Done {shortStamp(c.completedAt)}</>
                        : c.lastSeen && <> · Last seen {shortStamp(c.lastSeen)}</>}
                    </span>
                  </span>
                  <span className="self-center"><TestChips tests={c.tests} showDone={c.status === "Completed"} /></span>
                  <span className="self-center min-w-0">
                    <span className="block text-sm font-semibold mb-1" style={{ color: st.color }}>{st.text}</span>
                    <Fuse c={c} now={now} />
                    <span className="block num text-xs text-ink-3 mt-1">TAT {c.reportDate}</span>
                  </span>
                </button>
                <div className="w-full md:w-44 shrink-0 flex flex-col justify-center gap-1 px-2 py-1.5 max-md:pl-4 max-md:pt-0 max-md:empty:hidden">
                  <DelayCell c={c} now={now} sel={sel} />
                  {isCleared && (
                    <button onClick={() => sel.restore(c.id)} className="text-sm text-accent hover:underline underline-offset-2 cursor-pointer">Restore</button>
                  )}
                </div>
                </div>
              );
            })}
          </div>
  );
}

function CaseDrawer({ c, siblings, now, onClose, onSelect }: {
  c: Slice | null; siblings: Slice[]; now: number; onClose: () => void; onSelect: (id: string) => void;
}) {
  useEffect(() => {
    if (!c) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [c, onClose]);
  const [journey, setJourney] = useState<{ samples: api.SampleRow[]; centres: api.Centre[]; deliveries: api.ReportDelivery[]; releases: api.ReportRelease[] } | null>(null);
  useEffect(() => {
    setJourney(null);
    if (!c) return;
    let live = true;
    Promise.all([api.samplesForRequisition(c.rNumber).catch(() => []), api.loadCentres().catch(() => []), api.deliveriesForRequisition(c.rNumber).catch(() => []), api.releasesForRequisition(c.rNumber).catch(() => [])])
      .then(([samples, centres, deliveries, releases]) => { if (live) setJourney({ samples, centres, deliveries, releases }); });
    return () => { live = false; };
  }, [c?.rNumber]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return null;
  const st = statusText(c, now);
  const tat = tatMs(c);
  const done = c.tests.filter((t) => t.status === "Completed").length;

  return (
    <div className="fixed inset-0 z-50 no-print" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ background: "rgb(10 16 24 / 0.35)" }}>
      <aside role="dialog" aria-modal="true" aria-label={`Requisition ${c.patientId}`}
        className="absolute right-0 top-0 h-full w-full max-w-lg overflow-y-auto border-l p-6" style={{ background: C.surface, borderColor: C.line }}>
        <div className="flex items-start justify-between gap-4 mb-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="num text-2xl font-semibold text-ink">{c.patientId}</h2>
            {c.isAlist && <Badge color={C.alist} solid>A-List</Badge>}
          </div>
          <button onClick={onClose} aria-label="Close" className="text-ink-3 hover:text-ink text-2xl leading-none cursor-pointer px-1">×</button>
        </div>
        <p className="text-ink mb-0.5">{c.clientDisplay}</p>
        {c.clientRaw && c.clientRaw !== c.clientDisplay && <p className="text-xs text-ink-3 mb-3">As printed in MT: {c.clientRaw}</p>}

        <div className="flex items-center gap-2 text-sm text-ink-2 mt-3 mb-5"><Cap dept={c.department} /> {c.department} ({c.pair})</div>

        <div className="rounded-lg p-4 mb-5" style={{ background: tint(st.color, 8), borderLeft: `4px solid ${st.color}` }}>
          <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
            <span className="text-lg font-semibold" style={{ color: st.color }}>{st.text}</span>
            <span className="text-sm text-ink-2">TAT <span className="num text-ink">{c.reportDate}</span></span>
          </div>
          <Fuse c={c} now={now} />
          <p className="text-xs text-ink-3 mt-2">{done} of {c.tests.length} tests finished</p>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm mb-5">
          <div><dt className="text-ink-3 text-xs">First on the list</dt><dd className="num text-ink">{fmtIso(c.dateAdded)}</dd></div>
          <div><dt className="text-ink-3 text-xs">Last seen pending</dt><dd className="num text-ink">{fmtIso(c.lastSeen)}</dd></div>
          <div><dt className="text-ink-3 text-xs">Completed (detected)</dt><dd className="num text-ink">{c.completedAt ? fmtIso(c.completedAt) : "Still outstanding"}</dd></div>
        </dl>

        {siblings.length > 0 && (
          <div className="mb-5">
            <p className="text-xs text-ink-3 mb-1.5">Same requisition, other departments</p>
            <div className="flex flex-wrap gap-2">
              {siblings.map((s) => (
                <Button key={s.id} onClick={() => onSelect(s.id)}>
                  <Cap dept={s.department} size={11} /> {s.department}
                  <span className="text-ink-3">{s.status === "Completed" ? "done" : `${s.tests.filter((t) => t.status !== "Completed").length} pending`}</span>
                </Button>
              ))}
            </div>
          </div>
        )}

        {journey && journey.samples.length > 0 && (
          <div className="mb-5">
            <h3 className="font-semibold text-ink mb-2">Sample journey</h3>
            <ul className="space-y-2">
              {journey.samples.map((s) => {
                const centre = journey.centres.find((x) => x.id === s.centre_id)?.name;
                const transit = s.collected_at && s.received_at ? (new Date(s.received_at).getTime() - new Date(s.collected_at).getTime()) / 60000 : null;
                return (
                  <li key={s.id} className="rounded-md p-3 text-sm" style={{ background: C.raised, border: `1px solid ${C.line}` }}>
                    <div className="flex justify-between gap-3 mb-1">
                      <span className="num font-semibold text-ink">{s.barcode}</span>
                      {s.received_at ? <Badge color={C.success}>At lab</Badge> : <Badge color={C.warning}>In transit</Badge>}
                    </div>
                    {s.source === "courier"
                      ? <p className="text-ink-2">Collected from {centre || "a centre"} by {(s.collected_by || "").split("@")[0]} at <span className="num">{fmtIso(s.collected_at)}</span></p>
                      : <p className="text-ink-2">No courier record (scanned straight in at the lab)</p>}
                    {s.photo_path && !s.photo_deleted_at && (
                      <button className="text-accent underline text-sm cursor-pointer" onClick={async () => {
                        const w = window.open("", "_blank"); // open first so the browser doesn't block it
                        try { const url = await api.samplePhotoUrl(s.photo_path!); if (w) w.location.href = url; } catch { w?.close(); }
                      }}>View pickup photo</button>
                    )}
                    {s.received_at && <p className="text-ink-2">Received at pre-analytical <span className="num">{fmtIso(s.received_at)}</span>{api.receiverName(s) && <> by <span className="font-semibold text-ink">{api.receiverName(s)}</span></>}{transit !== null && ` after ${formatMinutes(transit)} in transit`}</p>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {journey && (journey.deliveries.length > 0 || journey.releases.length > 0) && (
          <div className="mb-5">
            <h3 className="font-semibold text-ink mb-2">Report delivery</h3>
            <ul className="space-y-2">
              {journey.releases.map((r) => (
                <li key={`rel${r.id}`} className="text-sm text-ink-2">
                  Released for <b className="text-ink">{r.destination}</b> by {r.released_by.split("@")[0]} at <span className="num">{fmtIso(r.released_at)}</span>
                  {r.status === "released" && " (waiting for courier)"}{r.status === "cancelled" && ` (withdrawn${r.note ? `: ${r.note}` : ""})`}
                </li>
              ))}
              {journey.deliveries.map((d) => (
                <li key={d.id} className="rounded-md p-3 text-sm" style={{ background: C.raised, border: `1px solid ${C.line}` }}>
                  <div className="flex justify-between gap-3 mb-1">
                    <span className="text-ink">Picked up <span className="num">{fmtIso(d.picked_up_at)}</span></span>
                    <Badge color={d.status === "D" ? C.success : d.status === "pending" ? C.accent : C.warning}>
                      {d.status === "D" ? "Delivered" : d.status === "pending" ? "Out for delivery" : d.status === "ND" ? "Not delivered" : d.status === "CU" ? "Client unavailable" : "Closed"}
                    </Badge>
                  </div>
                  {d.status === "D" && <p className="text-ink-2">Received by {d.receiver_name} at <span className="num">{fmtIso(d.recorded_at)}</span></p>}
                  {d.status !== "D" && d.reason && <p className="text-ink-2">{d.reason} (<span className="num">{fmtIso(d.recorded_at)}</span>)</p>}
                </li>
              ))}
            </ul>
          </div>
        )}

        <h3 className="font-semibold text-ink mb-3">Tests</h3>
        <ol>
          {c.tests.map((t, i) => {
            const v = verdict(t, tat, now);
            const isDone = t.status === "Completed";
            const color = isDone ? (v.kind === "late" ? C.danger : v.kind === "unclear" ? C.warning : C.success) : now > tat ? C.danger : C.accent;
            const label = isDone ? (v.kind === "ontime" ? "on time" : v.kind === "late" ? `${rangeText(v.min, v.max)} late` : "on time?")
              : now > tat ? `${formatMinutes((now - tat) / 60000)} over` : "pending";
            return (
              <li key={t.name} className="flex gap-3">
                <div className="flex flex-col items-center w-4 pt-1">
                  <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ background: isDone ? color : "transparent", border: `2px solid ${color}` }} />
                  {i < c.tests.length - 1 && <span className="w-px flex-1 my-1" style={{ background: C.line }} />}
                </div>
                <div className="pb-4 flex-1 min-w-0">
                  <div className="flex justify-between gap-3">
                    <span className="num font-semibold text-ink">{t.name}</span>
                    <span className="text-sm font-medium" style={{ color }}>{label}</span>
                  </div>
                  <p className="text-xs text-ink-3 num">
                    First seen {fmtIso(t.firstSeen)}.{" "}
                    {isDone ? `Finished between ${fmtTime(t.lastSeen)} and ${fmtIso(t.completedAt)}.` : `Still pending at ${fmtIso(t.lastSeen)}.`}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="text-xs text-ink-3 mt-2">Finish times are known to within one paste: between the last list a test appeared on and the first list it was missing from.</p>
      </aside>
    </div>
  );
}
