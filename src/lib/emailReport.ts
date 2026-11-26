// Reads the Meditech "Doctor's Patient Search" report, either a digital file
// (PDF with text, or plain text) or a scanned printout (OCR). Only rows under
// the EMAIL account are kept, and only Req #, Acc # and the two dates:
// patient names are never stored.
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { imageRect, readScreen, toGray } from "./screenReader";

/** A screen-read Req # whose closest alternative digit is at least this far away needs no checking. */
const SCREEN_SURE = 8;
const DATE_RE = /\d{2}\/\d{2}\/\d{2}-\d{2}/;

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

/** The account tracked by this section (letters only, so OCR noise like "~-" doesn't matter). */
export const EMAIL_ACCOUNT_LABEL = "MDS-LANCET LABORATORIES-EMAIL";
const EMAIL_ACCOUNT_KEY = "MDSLANCETLABORATORIESEMAIL";

export interface ReportRow {
  r_number: string;
  acc_number: string;
  collection: string;      // as printed, e.g. 12/11/26-0726
  entered: string;
  page: number;
  confidence: number | null; // OCR confidence of the numbers (0-100), null for digital files
  needsCheck: boolean;
  accSuspect?: boolean;     // Acc # may be misread (shown for reference only; never used for matching)
  group: string;            // key of the account group it was listed under
  why: string[];           // reasons a person should check this row
  crop?: string;           // image of the line from the scan, for checking only (not stored)
}
export interface ReportGroup { key: string; label: string; isEmail: boolean; firstPage: number; lastPage: number; rows: number }
export interface ParsedReport {
  source: "digital" | "scan" | "text";
  screen?: boolean;                 // read from Meditech screen captures
  pictures?: boolean;               // uploaded as picture files (one per page)
  groups: ReportGroup[];            // each account heading (or unheaded block) in the order found
  partialSkipped?: number;          // half-visible lines at the edge of screen captures (not read)
  overlapMerged?: number;           // rows that appeared on two overlapping captures (counted once)
  runDate: string | null;
  pages: number;
  accounts: Record<string, number>; // rows found per account (for information)
  rows: ReportRow[];                // every account; the upload screen picks which groups to keep
  unreadable: { page: number; text: string; crop?: string; group: string }[]; // lines that couldn't be read
}

type Box = { x0: number; y0: number; x1: number; y1: number };
type Line = { text: string; page: number; conf?: number; words?: { text: string; conf: number; bbox?: Box }[]; bbox?: Box;
  screen?: boolean; screenMargin?: number };

const letters = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "");

/* ---------------- digital PDF: text with positions ---------------- */
async function pdfTextLines(doc: pdfjs.PDFDocumentProxy): Promise<Line[]> {
  const out: Line[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of tc.items as any[]) {
      if (!("str" in it) || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 2) * 2; // group items on the same baseline
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y)!.push({ x: it.transform[4], s: it.str });
    }
    [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, items]) =>
      out.push({ page: p, text: items.sort((a, b) => a.x - b.x).map((i) => i.s).join(" ") }));
  }
  return out;
}

/* ---------------- scanned PDF: OCR each page ---------------- */
type PageSource = { count: number; label: string; get: (p: number) => Promise<{ canvas: HTMLCanvasElement; rect: { x: number; y: number; w: number; h: number } }> };

/** Pages of a PDF, rendered at about 300 dpi. */
function pdfPages(doc: pdfjs.PDFDocumentProxy): PageSource {
  return { count: doc.numPages, label: "page", get: async (p) => {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 300 / 72 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
    const rect = (await imageRect(page, vp, pdfjs)) || { x: 0, y: 0, w: canvas.width, h: canvas.height };
    return { canvas, rect };
  } };
}

/** Picture files (PNG, JPG): one page each, enlarged so small screenshots read as well as a 300 dpi page. */
function imagePages(files: File[]): PageSource {
  return { count: files.length, label: "picture", get: async (p) => {
    const bmp = await createImageBitmap(files[p - 1]!);
    const scale = Math.max(1, Math.min(4, 3200 / bmp.width));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high"; ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    return { canvas, rect: { x: 0, y: 0, w: canvas.width, h: canvas.height } };
  } };
}

async function ocrLines(src: PageSource, onProgress: (msg: string, pct: number) => void) {
  const { createWorker } = await import("tesseract.js");
  const base = `${window.location.origin}/ocr`;
  const worker = await createWorker("eng", 1, {
    workerPath: `${base}/worker.min.js`, corePath: base, langPath: base, gzip: true,
  });
  await worker.setParameters({ preserve_interword_spaces: "1", tessedit_pageseg_mode: "6" as any });
  const lines: Line[] = [];
  const pageCanvases: HTMLCanvasElement[] = [];
  let screenPages = 0, partial = 0;
  try {
    for (let p = 1; p <= src.count; p++) {
      onProgress(`Reading ${src.label} ${p} of ${src.count}…`, Math.round(((p - 1) / src.count) * 100));
      const { canvas, rect } = await src.get(p);
      pageCanvases[p] = canvas;
      // Meditech screen captures: read the number columns with the screen-font reader
      const sp = readScreen(toGray(canvas, rect), rect);
      if (sp.isScreen) { screenPages++; partial += sp.partial; }
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      const pageLines: Line[] = [];
      for (const block of (data as any).blocks || []) for (const para of block.paragraphs || []) for (const ln of para.lines || []) {
        const l: Line = { page: p, text: ln.text.trim(), conf: ln.confidence, bbox: ln.bbox,
          words: (ln.words || []).map((w: any) => ({ text: w.text, conf: w.confidence, bbox: w.bbox })) };
        // On screen pages keep only headings from general OCR; the rows come from the screen reader
        if (sp.isScreen && (DATE_RE.test(l.text) || /\d{6}/.test(l.text))) continue;
        pageLines.push(l);
      }
      if (sp.isScreen) for (const r of sp.rows) {
        const conf = r.margin >= SCREEN_SURE ? 99 : 50;
        const bbox = { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
        pageLines.push({ page: p, screen: true, screenMargin: r.margin, bbox, conf,
          text: `${r.r_number} ${r.acc_number} ${r.collection} ${r.entered}`,
          words: [{ text: r.r_number, conf, bbox: { ...bbox, x1: r.x0 + (r.x1 - r.x0) * 0.15 } }] });
      }
      pageLines.sort((a, b) => (a.bbox?.y0 ?? 0) - (b.bbox?.y0 ?? 0));
      lines.push(...pageLines);
    }
  } finally { await worker.terminate(); }
  onProgress("Checking the results…", 100);
  return { lines, pageCanvases, screenPages, partial };
}

/** Image of one report line for checking. Starts at the Req # column, so patient names are not shown. */
function cropLine(canvas: HTMLCanvasElement | undefined, b: Line["bbox"], fromX?: number): string | undefined {
  if (!canvas || !b) return undefined;
  const pad = 14, x = Math.max(0, (fromX ?? b.x0) - pad), y = Math.max(0, b.y0 - pad);
  const w = Math.min(canvas.width - x, b.x1 - x + pad), h = Math.min(canvas.height - y, b.y1 - b.y0 + pad * 2);
  const c = document.createElement("canvas");
  const scale = Math.min(1, 900 / w);
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.getContext("2d")!.drawImage(canvas, x, y, w, h, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8);
}

/* ---------------- parsing ---------------- */
// Left edge of the Req # (or first long number) on a scanned line, to crop out the name
function reqX(ln: Line, tok: string): number | undefined {
  const w = ln.words?.find((x) => tok && x.text === tok) || ln.words?.find((x) => /\d{6}/.test(x.text));
  return w?.bbox?.x0;
}
// Fix characters OCR commonly confuses inside numbers
const digitsOnly = (t: string) => t.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1").replace(/[Ss](?=\d)/g, "5").replace(/[^0-9]/g, "");
/** Below this OCR confidence (0-100) a Req # is shown to staff for checking. */
export const REQ_CONFIDENCE = 80;
const DATE = /\d{2}\/\d{2}\/\d{2}-[\dN]{1,4}/g;

export function parseLines(lines: Line[], source: ParsedReport["source"], canvases: HTMLCanvasElement[] = [], screen = false): ParsedReport {
  const report: ParsedReport = { source, screen, runDate: null, pages: 0, accounts: {}, groups: [], rows: [], unreadable: [] };
  let group: ReportGroup | null = null;
  const newGroup = (label: string, page: number) => {
    // The printed report repeats the account heading on every page: same account, same group
    const cur = group as ReportGroup | null;
    if (cur && label && letters(cur.label) === letters(label)) return;
    group = { key: String(report.groups.length + 1), label: label || "No account heading", isEmail: letters(label).includes(EMAIL_ACCOUNT_KEY), firstPage: page, lastPage: page, rows: 0 };
    report.groups.push(group);
  };
  const byReq = new Map<string, number>(); // r_number -> index in report.rows

  for (const ln of lines) {
    report.pages = Math.max(report.pages, ln.page);
    const text = ln.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const run = text.match(/RUN DATE:\s*(\d{2}\/\d{2}\/\d{2})/i);
    if (run && !report.runDate) report.runDate = run[1]!;
    const doc = text.match(/Doctor\s*:\s*(.+)$/i);
    if (doc) { newGroup(doc[1]!.trim(), ln.page); continue; }
    // Screen captures: a column-heading line after rows starts a new (unheaded) list
    if (report.screen && /Req\s*#/i.test(text) && /Acc/i.test(text) && /Date/i.test(text)) { if (group && (group as ReportGroup).rows > 0) newGroup("", ln.page); continue; }

    const dates = text.match(DATE) || [];
    const tokens = text.split(" ");
    // Req #: a 9-digit token (allowing common OCR swaps). Acc #: two letters + 6 digits.
    let reqTok = tokens.find((t) => /^\d{9}$/.test(t));
    let fixedReq = false;
    if (!reqTok) {
      const cand = tokens.find((t) => t.length >= 9 && t.length <= 10 && /\d{6}/.test(t) && digitsOnly(t).length === 9);
      if (cand) { reqTok = cand; fixedReq = true; }
    }
    // Acc # is always "GS" + 6 digits. The "GS" is often misread on scans ("(S", "G8", "(3"),
    // so take the token after the Req # and keep its last 6 digits.
    let accTok: string | undefined;
    if (reqTok) {
      const next = tokens[tokens.indexOf(reqTok) + 1];
      if (next && digitsOnly(next).length >= 4 && digitsOnly(next).length <= 8) accTok = next;
    } else {
      accTok = tokens.find((t) => /^[A-Z(]{1,2}\d{6,7}$/i.test(t.replace(/[^A-Za-z0-9(]/g, "")));
    }
    const looksLikeRow = dates.length >= 1 && (reqTok || accTok);
    if (!looksLikeRow) continue;

    if (!group) newGroup("", ln.page);
    const g = group as unknown as ReportGroup;
    g.lastPage = ln.page;
    report.accounts[g.label] = (report.accounts[g.label] || 0) + 1;

    if (!reqTok || !accTok) {
      report.unreadable.push({ page: ln.page, group: g.key, text: text.replace(/^[^0-9]*?(?=\d{6})/, "… "),
        crop: cropLine(canvases[ln.page], ln.bbox, reqX(ln, reqTok || accTok || "")) });
      continue;
    }
    const r_number = digitsOnly(reqTok);
    const acc_number = "GS" + digitsOnly(accTok).slice(-6);
    const why: string[] = [];
    let confidence: number | null = null;
    if (ln.words) {
      // Judge the Req # (the number used for matching) on its own confidence
      const w = ln.words.find((x) => x.text.replace(/[^0-9A-Za-z]/g, "") === reqTok!.replace(/[^0-9A-Za-z]/g, ""))
        || ln.words.find((x) => digitsOnly(x.text) === r_number);
      confidence = w ? Math.round(w.conf) : null;
      if (confidence === null || confidence < REQ_CONFIDENCE) why.push("Req # not clearly printed");
    }
    if (fixedReq) why.push("Req # needed correcting");
    if (digitsOnly(accTok).length < 6) why.push("Acc # unclear");
    if (dates.length < 2) why.push("a date is missing");

    const prev = byReq.get(r_number);
    if (prev !== undefined) {
      const p = report.rows[prev]!;
      if (report.screen && p.page !== ln.page) {
        // Overlapping screen captures show some rows twice: keep the clearer copy
        report.overlapMerged = (report.overlapMerged || 0) + 1;
        if ((confidence ?? 0) > (p.confidence ?? 0) && !why.length) { p.confidence = confidence; p.needsCheck = false; p.why = []; p.crop = undefined; }
        continue;
      }
      why.push("appears twice in this report");
    }
    byReq.set(r_number, report.rows.length);
    g.rows++;

    report.rows.push({
      r_number, acc_number, collection: dates[0] || "", entered: dates[1] || "", page: ln.page, group: g.key,
      confidence, needsCheck: why.length > 0, why,
      crop: why.length && source === "scan" ? cropLine(canvases[ln.page], ln.bbox, reqX(ln, reqTok)) : undefined,
    });
  }
  // Acc #s in one report share their leading digits; one that doesn't is probably misread
  const prefix = (a: string) => a.slice(2, 4);
  const counts: Record<string, number> = {};
  report.rows.forEach((r) => { counts[prefix(r.acc_number)] = (counts[prefix(r.acc_number)] || 0) + 1; });
  const common = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  report.rows.forEach((r) => { r.accSuspect = r.acc_number.length !== 8 || (report.rows.length >= 10 && prefix(r.acc_number) !== common); });
  return report;
}

/** Reads an uploaded file: digital PDF, scanned PDF or a text file. */
const isImage = (f: File) => f.type.startsWith("image/") || /\.(png|jpe?g|bmp|gif|webp)$/i.test(f.name);

/** Reads one or more picture files (screen captures or photos), in name order, as one report. */
export async function readImages(files: File[], onProgress: (msg: string, pct: number) => void): Promise<ParsedReport> {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const { lines, pageCanvases, screenPages, partial } = await ocrLines(imagePages(sorted), onProgress);
  const report = parseLines(lines, "scan", pageCanvases, screenPages > 0);
  report.pictures = true;
  if (screenPages) report.partialSkipped = partial;
  return report;
}

export async function readReport(fileOrFiles: File | File[], onProgress: (msg: string, pct: number) => void): Promise<ParsedReport> {
  const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  if (files.every(isImage)) return readImages(files, onProgress);
  if (files.length > 1) throw new Error("Choose one PDF or text file, or several pictures (PNG/JPG), not a mix");
  const file = files[0]!;
  if (/\.txt$/i.test(file.name) || file.type.startsWith("text/")) {
    const text = await file.text();
    let page = 1;
    const lines: Line[] = text.split(/\r?\n/).map((t) => { if (/\f|PAGE \d+/.test(t)) page++; return { text: t, page }; });
    return parseLines(lines, "text");
  }
  onProgress("Opening the PDF…", 0);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const textLines = await pdfTextLines(doc);
  const chars = textLines.reduce((n, l) => n + l.text.length, 0);
  if (chars > 200 * doc.numPages * 0.25) return parseLines(textLines, "digital"); // has real text
  const { lines, pageCanvases, screenPages, partial } = await ocrLines(pdfPages(doc), onProgress);
  const report = parseLines(lines, "scan", pageCanvases, screenPages > 0);
  if (screenPages) report.partialSkipped = partial;
  if (!report.runDate) {
    // Screen captures have no RUN DATE line: use a date in the PDF's title, if any
    const title = String(((await doc.getMetadata().catch(() => null))?.info as any)?.Title || "");
    report.runDate = title.match(/\d{2}\/\d{2}\/\d{2}/)?.[0] || null;
  }
  return report;
}

