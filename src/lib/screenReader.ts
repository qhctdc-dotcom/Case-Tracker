// Reads Meditech *screen* captures (e.g. "Patient Entry List" screenshots pasted
// into a PDF). The terminal font has a slashed zero that general OCR misreads
// as 8, so the number columns are read here by matching each character cell
// against templates of that font. Patient names are never read.
import { SCREEN_TEMPLATES } from "./screenTemplates";

export type Gray = { w: number; h: number; d: Float32Array }; // darkness 0..255
export interface ScreenRow {
  y0: number; y1: number;              // in the page canvas
  x0: number; x1: number;              // Req # cell span, in the page canvas
  r_number: string; acc_number: string; collection: string; entered: string;
  dist: number; margin: number;        // worst template distance, smallest margin (bigger = surer)
  feats?: Float32Array[];              // for building templates (debug)
  cells?: number;                      // index of the Req # cell (debug)
}
export interface ScreenPage { rows: ScreenRow[]; partial: number; headerYs: number[]; isScreen: boolean }

const INK = 110;
const GW = 10, GH = 16, GW2 = 12, GH2 = 20;

/** Region of the canvas covered by the page's picture (from the PDF drawing commands). */
export async function imageRect(page: any, viewport: any, pdfjs: any): Promise<{ x: number; y: number; w: number; h: number } | null> {
  try {
    const ops = await page.getOperatorList();
    const OPS = pdfjs.OPS;
    let ctm = [1, 0, 0, 1, 0, 0]; const stack: number[][] = [];
    const mul = (m: number[], n: number[]) => [m[0]! * n[0]! + m[2]! * n[1]!, m[1]! * n[0]! + m[3]! * n[1]!, m[0]! * n[2]! + m[2]! * n[3]!,
      m[1]! * n[2]! + m[3]! * n[3]!, m[0]! * n[4]! + m[2]! * n[5]! + m[4]!, m[1]! * n[4]! + m[3]! * n[5]! + m[5]!];
    let best: { x: number; y: number; w: number; h: number } | null = null;
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i]; const args = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(ctm, args);
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        const m = mul(viewport.transform, ctm);
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [m[0]! * u! + m[2]! * v! + m[4]!, m[1]! * u! + m[3]! * v! + m[5]!]);
        const xs = pts.map((p) => p[0]!), ys = pts.map((p) => p[1]!);
        const r = { x: Math.max(0, Math.floor(Math.min(...xs))), y: Math.max(0, Math.floor(Math.min(...ys))),
          w: Math.ceil(Math.max(...xs) - Math.min(...xs)), h: Math.ceil(Math.max(...ys) - Math.min(...ys)) };
        if (!best || r.w * r.h > best.w * best.h) best = r;
      }
    }
    return best;
  } catch { return null; }
}

export function toGray(canvas: HTMLCanvasElement, r: { x: number; y: number; w: number; h: number }): Gray {
  const w = Math.min(r.w, canvas.width - r.x), h = Math.min(r.h, canvas.height - r.y);
  const px = canvas.getContext("2d")!.getImageData(r.x, r.y, w, h).data;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = 255 - (0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!);
  return { w, h, d };
}

/** Removes screen borders: long vertical and horizontal lines. */
function clean(g: Gray) {
  const { w, h, d } = g;
  const col = new Float32Array(w), row = new Float32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[y * w + x]! > INK) { col[x]!++; row[y]!++; }
  for (let x = 0; x < w; x++) if (col[x]! / h > 0.8) for (let y = 0; y < h; y++) d[y * w + x] = 0;
  for (let y = 0; y < h; y++) if (row[y]! / w > 0.6) for (let x = 0; x < w; x++) d[y * w + x] = 0;
}

function textRows(g: Gray): [number, number][] {
  const out: [number, number][] = [];
  let y = 0;
  const on = (yy: number) => { for (let x = 0; x < g.w; x++) if (g.d[yy * g.w + x]! > INK) return true; return false; };
  while (y < g.h) {
    if (on(y)) { const s = y; while (y < g.h && on(y)) y++; out.push([s, y]); } else y++;
  }
  return out;
}

function pitchOf(g: Gray, rows: [number, number][], rowH: number) {
  const prof = new Float64Array(g.w);
  for (const [a, b] of rows) for (let y = a; y < b; y++) for (let x = 0; x < g.w; x++) if (g.d[y * g.w + x]! > INK) prof[x]!++;
  let best = 0, bestP = rowH * 0.64;
  for (let p = rowH * 0.45; p <= rowH * 0.9; p += rowH * 0.0003) {
    let re = 0, im = 0;
    for (let x = 0; x < g.w; x++) { const v = prof[x]!; if (!v) continue; const t = (2 * Math.PI * x) / p; re += v * Math.cos(t); im += v * Math.sin(t); }
    const s = re * re + im * im;
    if (s > best) { best = s; bestP = p; }
  }
  return bestP;
}

function rowPhase(g: Gray, a: number, b: number, P: number) {
  let re = 0, im = 0;
  for (let x = 0; x < g.w; x++) {
    let v = 0; for (let y = a; y < b; y++) if (g.d[y * g.w + x]! > INK) v++;
    if (!v) continue; const t = (2 * Math.PI * x) / P; re += v * Math.cos(t); im += v * Math.sin(t);
  }
  return (((Math.atan2(im, re) / (2 * Math.PI)) * P) % P + P) % P;
}

function cellsOf(g: Gray, a: number, b: number, P: number): [number, number][] {
  let x0 = rowPhase(g, a, b, P) - P / 2;
  while (x0 - P >= 0) x0 -= P;
  const n = Math.floor((g.w - x0) / P), out: [number, number][] = [];
  for (let k = 0; k < n; k++) out.push([x0 + k * P, x0 + (k + 1) * P]);
  return out;
}

/** Ink amount of a cell (scale independent). */
function cellInk(g: Gray, a: number, b: number, xs: number, xe: number) {
  let s = 0;
  for (let i = 0; i < GH; i++) for (let j = 0; j < GW; j++) {
    const y0 = Math.floor(a + ((b - a) * i) / GH), y1 = Math.max(y0 + 1, Math.ceil(a + ((b - a) * (i + 1)) / GH));
    const x0 = Math.max(0, Math.floor(xs + ((xe - xs) * j) / GW)), x1 = Math.min(g.w, Math.max(x0 + 1, Math.ceil(xs + ((xe - xs) * (j + 1)) / GW)));
    let t = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { t += g.d[y * g.w + x]!; n++; }
    s += n ? t / n / 255 : 0;
  }
  return s;
}

/** The glyph in a cell, cropped to its own ink and scaled to 12x20, plus its relative width. */
function glyph(g: Gray, a: number, b: number, xs: number, xe: number): Float32Array {
  const out = new Float32Array(GW2 * GH2 + 1);
  const x0 = Math.max(0, Math.round(xs) - 2), x1 = Math.min(g.w, Math.round(xe) + 2);
  const cols: number[] = [];
  for (let x = x0; x < x1; x++) { let on = false; for (let y = a; y < b && !on; y++) if (g.d[y * g.w + x]! > INK) on = true; if (on) cols.push(x - x0); }
  if (!cols.length) return out;
  const groups: number[][] = [[cols[0]!]];
  for (let i = 1; i < cols.length; i++) { if (cols[i]! - cols[i - 1]! > 1) groups.push([]); groups[groups.length - 1]!.push(cols[i]!); }
  const inside = groups.filter((h) => h[0]! >= 1 && h[h.length - 1]! <= x1 - x0 - 2);
  let sel: number[];
  if (inside.length) sel = inside.flat();
  else { const cx = (xs + xe) / 2 - x0; sel = groups.reduce((p, q) => Math.abs((q[0]! + q[q.length - 1]!) / 2 - cx) < Math.abs((p[0]! + p[p.length - 1]!) / 2 - cx) ? q : p); }
  const gx0 = x0 + sel[0]!, gx1 = x0 + sel[sel.length - 1]! + 1, H = b - a, W = gx1 - gx0;
  for (let i = 0; i < GH2; i++) for (let j = 0; j < GW2; j++) {
    const ys = Math.floor((H * i) / GH2), ye = Math.max(ys + 1, Math.ceil((H * (i + 1)) / GH2));
    const xsj = Math.floor((W * j) / GW2), xej = Math.max(xsj + 1, Math.ceil((W * (j + 1)) / GW2));
    let t = 0, n = 0;
    for (let y = ys; y < ye; y++) for (let x = xsj; x < xej; x++) { t += g.d[(a + y) * g.w + gx0 + x]!; n++; }
    out[i * GW2 + j] = n ? t / n / 255 : 0;
  }
  out[GW2 * GH2] = (8 * W) / (xe - xs);
  return out;
}

const T: Record<string, Float32Array> = Object.fromEntries(Object.entries(SCREEN_TEMPLATES).map(([k, v]) => [k, Float32Array.from(v)]));
const DIG = "0123456789".split("");
function cls(f: Float32Array, allowed: string[]): [string, number, number] {
  const ds = allowed.filter((c) => T[c]).map((c) => { let s = 0; const t = T[c]!; for (let i = 0; i < f.length; i++) s += Math.abs(f[i]! - t[i]!); return [s, c] as [number, string]; }).sort((p, q) => p[0] - q[0]);
  if (!ds.length) return ["?", 999, 0];
  return [ds[0]![1], ds[0]![0], ds.length > 1 ? ds[1]![0] - ds[0]![0] : 99];
}
const REQ = Array(9).fill(DIG), ACC = [["G"], ["S"], ...Array(6).fill(DIG)];
const DATE = [DIG, DIG, ["/"], DIG, DIG, ["/"], DIG, DIG, ["-"], DIG, DIG, DIG, DIG];
function readCells(G: Float32Array[], start: number, pattern: string[][]) {
  let s = "", worst = 0, margin = 99;
  pattern.forEach((allowed, j) => { const [c, d, m] = cls(G[start + j]!, allowed); s += c; worst = Math.max(worst, d); margin = Math.min(margin, m); });
  return { s, worst, margin };
}

/** Max template distance for a real row (headings and names score far higher). */
export const MAX_DIST = 45;

/** Reads the number columns of a screen-capture page. offset = where the region sits in the page canvas. */
export function readScreen(g: Gray, offset: { x: number; y: number }, debug = false): ScreenPage {
  clean(g);
  const all = textRows(g);
  const hs = all.map(([a, b]) => b - a).sort((p, q) => p - q);
  const med = hs.length ? hs[Math.floor(hs.length / 2)]! : 0;
  const page: ScreenPage = { rows: [], partial: 0, headerYs: [], isScreen: false };
  if (!med) return page;
  const full = all.filter(([a, b]) => b - a >= 0.8 * med);
  const P = pitchOf(g, full, med);
  for (const [a, b] of all) {
    if (b - a < 0.8 * med) { if (b - a >= 2) page.partial++; continue; }
    const cells = cellsOf(g, a, b, P);
    const ink = cells.map(([xs, xe]) => cellInk(g, a, b, xs, xe));
    const on = (i: number) => (ink[i] ?? 0) > 0.6;
    const starts: number[] = [];
    for (let i = 0; i + 61 <= cells.length; i++) {
      let ok = true;
      for (let k = 0; k < 9 && ok; k++) ok = on(i + k);
      for (let k = 0; k < 8 && ok; k++) ok = on(i + 10 + k);
      if (ok) starts.push(i);
    }
    if (!starts.length) continue;
    const G = cells.map(([xs, xe]) => glyph(g, a, b, xs, xe));
    let bestI = starts[0]!, bestS = Infinity;
    for (const i of starts) { const s = readCells(G, i, REQ).worst + readCells(G, i + 10, ACC).worst; if (s < bestS) { bestS = s; bestI = i; } }
    const i = bestI;
    const req = readCells(G, i, REQ), acc = readCells(G, i + 10, ACC), c1 = readCells(G, i + 32, DATE), c2 = readCells(G, i + 48, DATE);
    const dist = Math.max(req.worst, acc.worst, c1.worst, c2.worst);
    if (!debug && dist > MAX_DIST) continue;
    page.rows.push({
      y0: a + offset.y, y1: b + offset.y, x0: cells[i]![0] + offset.x, x1: cells[Math.min(cells.length - 1, i + 60)]![1] + offset.x,
      r_number: req.s, acc_number: acc.s, collection: c1.s, entered: c2.s,
      dist, margin: Math.min(req.margin, acc.margin), ...(debug ? { feats: G, cells: i } : {}),
    });
  }
  page.isScreen = page.rows.length >= 3;
  return page;
}
