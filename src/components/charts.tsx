import { useEffect, useRef, useState, type ReactNode } from "react";
import { C } from "./ui";

/* Small, dependency-free charts for the Analytics tab.
   One series colour (--viz-1), hairline grid, thin marks, values at bar tips,
   a hover/focus tooltip on every mark and a table view for every chart. */

type Tip = { x: number; y: number; value: string; label: string } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div className="absolute z-20 pointer-events-none card px-2.5 py-1.5 text-sm shadow-lg whitespace-nowrap"
      style={{ left: tip.x, top: tip.y, transform: "translate(-50%, calc(-100% - 10px))" }}>
      <div className="font-semibold text-ink num">{tip.value}</div>
      <div className="text-xs text-ink-2">{tip.label}</div>
    </div>
  );
}

function useTip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip>(null);
  const at = (el: Element, value: string, label: string) => {
    const box = ref.current?.getBoundingClientRect(); const r = el.getBoundingClientRect();
    if (box) setTip({ x: r.left - box.left + r.width / 2, y: r.top - box.top, value, label });
  };
  return { ref, tip, at, clear: () => setTip(null) };
}

/** A card that holds one chart, with a Chart / Table switch. */
export function ChartCard({ title, sub, children, table, className = "" }: {
  title: string; sub?: ReactNode; children: ReactNode; table: { head: string[]; rows: (string | number)[][] }; className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={`card p-4 ${className}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-ink">{title}</h3>
          {sub && <p className="text-xs text-ink-3 mt-0.5">{sub}</p>}
        </div>
        <button className="text-xs text-accent underline underline-offset-2 cursor-pointer whitespace-nowrap" onClick={() => setAsTable(!asTable)}
          aria-pressed={asTable}>{asTable ? "Show chart" : "Show table"}</button>
      </div>
      {asTable ? (
        <div className="overflow-auto max-h-80">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-ink-3 border-b" style={{ borderColor: C.line }}>
              {table.head.map((h, i) => <th key={h} className={`py-1.5 pr-3 font-medium ${i ? "text-right" : ""}`}>{h}</th>)}
            </tr></thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i} className="border-b last:border-b-0" style={{ borderColor: C.line }}>
                  {r.map((c, j) => <td key={j} className={`py-1.5 pr-3 ${j ? "text-right num" : "text-ink"}`}>{c}</td>)}
                </tr>
              ))}
              {!table.rows.length && <tr><td className="py-3 text-ink-3" colSpan={table.head.length}>No data for this period.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : children}
    </section>
  );
}

export const Empty = () => <p className="text-sm text-ink-3 py-6 text-center">No data for this period.</p>;

/** Ranked horizontal bars. Values print at the bar tips; the tooltip adds detail. */
export function BarList({ rows, format = (v) => v.toLocaleString(), limit = 10, unit = "" }: {
  rows: { label: string; value: number; detail?: string }[]; format?: (v: number) => string; limit?: number; unit?: string;
}) {
  const { ref, tip, at, clear } = useTip();
  if (!rows.length) return <Empty />;
  const shown = rows.length > limit ? rows.slice(0, limit - 1) : rows;
  const rest = rows.length > limit ? rows.slice(limit - 1) : [];
  const list = rest.length ? [...shown, { label: `Other (${rest.length})`, value: rest.reduce((n, r) => n + r.value, 0), detail: "Everything else combined" }] : shown;
  const max = Math.max(...list.map((r) => r.value), 1);
  return (
    <div ref={ref} className="relative" onPointerLeave={clear}>
      <ul className="space-y-2">
        {list.map((r) => (
          <li key={r.label} tabIndex={0} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-3 items-center outline-none group cursor-default"
            onPointerEnter={(e) => at(e.currentTarget.querySelector("[data-bar]")!, `${format(r.value)}${unit}`, r.detail || r.label)}
            onFocus={(e) => at(e.currentTarget.querySelector("[data-bar]")!, `${format(r.value)}${unit}`, r.detail || r.label)} onBlur={clear}>
            <span className="text-sm text-ink-2 truncate" title={r.label}>{r.label}</span>
            <span className="flex items-center gap-2 min-w-0">
              <span data-bar className="h-3 rounded-r transition-[filter] group-hover:brightness-110 group-focus:brightness-110"
                style={{ width: `${Math.max(1, (r.value / max) * 82)}%`, background: "var(--viz-1)" }} />
              <span className="text-sm text-ink num whitespace-nowrap">{format(r.value)}{unit}</span>
            </span>
          </li>
        ))}
      </ul>
      <Tooltip tip={tip} />
    </div>
  );
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) || 10) * p;
};

/** Vertical columns over time or hour of day. */
export function Columns({ points, height = 180, format = (v) => v.toLocaleString(), labelEvery }: {
  points: { label: string; value: number; tip: string }[]; height?: number; format?: (v: number) => string; labelEvery?: number;
}) {
  const { ref, tip, at, clear } = useTip();
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    setWidth(Math.max(240, Math.round(el.clientWidth)));
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el); return () => ro.disconnect();
  }, [ref, points.length]);
  if (!points.length || points.every((p) => !p.value)) return <Empty />;
  const W = width, padL = 36, padB = 22, padT = 8, H = height;
  const top = niceMax(Math.max(...points.map((p) => p.value)));
  const band = (W - padL) / points.length;
  const bw = Math.min(24, Math.max(2, band - 2));
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / top);
  const every = labelEvery || Math.ceil(points.length / 12);
  const ticks = [0, top / 2, top];
  return (
    <div ref={ref} className="relative" onPointerLeave={clear}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" role="img" aria-label="Column chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--line-strong)" : "var(--line)"} strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--ink-3)" className="num">{format(t)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = padL + i * band + (band - bw) / 2;
          const h = Math.max(0, y(0) - y(p.value));
          const r = Math.min(4, bw / 2, h);
          return (
            <g key={i} tabIndex={0} className="outline-none group"
              onPointerEnter={(e) => at(e.currentTarget.querySelector("[data-col]")!, format(p.value), p.tip)}
              onFocus={(e) => at(e.currentTarget.querySelector("[data-col]")!, format(p.value), p.tip)} onBlur={clear}>
              <rect x={padL + i * band} y={padT} width={band} height={H - padT - padB} fill="transparent" />
              {h > 0 && (
                <path data-col className="group-hover:brightness-110 group-focus:brightness-110" fill="var(--viz-1)"
                  d={`M${x},${y(0)} V${y(p.value) + r} Q${x},${y(p.value)} ${x + r},${y(p.value)} H${x + bw - r} Q${x + bw},${y(p.value)} ${x + bw},${y(p.value) + r} V${y(0)} Z`} />
              )}
              {h === 0 && <rect data-col x={x} y={y(0) - 1} width={bw} height={1} fill="transparent" />}
              {i % every === 0 && <text x={padL + i * band + band / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--ink-3)">{p.label}</text>}
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** One whole split into parts (e.g. delivery outcomes). Status colours always come with their label. */
export function SegBar({ parts }: { parts: { label: string; value: number; color: string; ink?: string }[] }) {
  const { ref, tip, at, clear } = useTip();
  const total = parts.reduce((n, p) => n + p.value, 0);
  if (!total) return <Empty />;
  const live = parts.filter((p) => p.value > 0);
  return (
    <div ref={ref} className="relative" onPointerLeave={clear}>
      <div className="flex gap-[2px] h-7" role="img" aria-label={live.map((p) => `${p.label} ${p.value}`).join(", ")}>
        {live.map((p) => {
          const pct = (100 * p.value) / total;
          return (
            <div key={p.label} tabIndex={0} className="rounded flex items-center px-1.5 text-xs font-semibold overflow-hidden outline-none hover:brightness-110 focus:brightness-110"
              style={{ width: `${pct}%`, background: p.color, color: p.ink || "#fff" }}
              onPointerEnter={(e) => at(e.currentTarget, `${p.value.toLocaleString()} (${Math.round(pct)}%)`, p.label)}
              onFocus={(e) => at(e.currentTarget, `${p.value.toLocaleString()} (${Math.round(pct)}%)`, p.label)} onBlur={clear}>
              {pct >= 9 ? `${Math.round(pct)}%` : ""}
            </div>
          );
        })}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5 text-sm">
        {live.map((p) => (
          <li key={p.label} className="flex items-center gap-1.5 text-ink-2">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: p.color }} aria-hidden="true" />{p.label} <span className="num text-ink">{p.value.toLocaleString()}</span>
          </li>
        ))}
      </ul>
      <Tooltip tip={tip} />
    </div>
  );
}
