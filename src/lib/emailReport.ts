// Reads the Meditech "Doctor's Patient Search" report, either a digital file
// (PDF with text, or plain text) or a scanned printout (OCR). Only rows under
// the EMAIL account are kept, and only Req #, Acc # and the two dates:
// patient names are never stored.
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

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
  why: string[];           // reasons a person should check this row
  crop?: string;           // image of the line from the scan, for checking only (not stored)
}
export interface ParsedReport {
  source: "digital" | "scan" | "text";
  runDate: string | null;
  pages: number;
  accounts: Record<string, number>; // rows found per account (for information)
  rows: ReportRow[];                // EMAIL account only
  unreadable: { page: number; text: string; crop?: string }[]; // EMAIL-account lines that couldn't be read
}

type Box = { x0: number; y0: number; x1: number; y1: number };
type Line = { text: string; page: number; conf?: number; words?: { text: string; conf: number; bbox?: Box }[]; bbox?: Box };

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
async function ocrLines(doc: pdfjs.PDFDocumentProxy, onProgress: (msg: string, pct: number) => void) {
  const { createWorker } = await import("tesseract.js");
  const base = `${window.location.origin}/ocr`;
  const worker = await createWorker("eng", 1, {
    workerPath: `${base}/worker.min.js`, corePath: base, langPath: base, gzip: true,
  });
  await worker.setParameters({ preserve_interword_spaces: "1", tessedit_pageseg_mode: "6" as any });
  const lines: Line[] = [];
  const pageCanvases: HTMLCanvasElement[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      onProgress(`Reading page ${p} of ${doc.numPages}…`, Math.round(((p - 1) / doc.numPages) * 100));
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 300 / 72 }); // about 300 dpi
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
      pageCanvases[p] = canvas;
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      for (const block of (data as any).blocks || []) for (const para of block.paragraphs || []) for (const ln of para.lines || []) {
        lines.push({ page: p, text: ln.text.trim(), conf: ln.confidence, bbox: ln.bbox,
          words: (ln.words || []).map((w: any) => ({ text: w.text, conf: w.confidence, bbox: w.bbox })) });
      }
    }
  } finally { await worker.terminate(); }
  onProgress("Checking the results…", 100);
  return { lines, pageCanvases };
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

export function parseLines(lines: Line[], source: ParsedReport["source"], canvases: HTMLCanvasElement[] = []): ParsedReport {
  const report: ParsedReport = { source, runDate: null, pages: 0, accounts: {}, rows: [], unreadable: [] };
  let account = "";
  let isEmail = false;
  const seen = new Set<string>();

  for (const ln of lines) {
    report.pages = Math.max(report.pages, ln.page);
    const text = ln.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const run = text.match(/RUN DATE:\s*(\d{2}\/\d{2}\/\d{2})/i);
    if (run && !report.runDate) report.runDate = run[1]!;
    const doc = text.match(/Doctor\s*:\s*(.+)$/i);
    if (doc) { account = doc[1]!.trim(); isEmail = letters(account).includes(EMAIL_ACCOUNT_KEY); continue; }

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

    const accName = account || "(unknown account)";
    report.accounts[accName] = (report.accounts[accName] || 0) + 1;
    if (!isEmail) continue;

    if (!reqTok || !accTok) {
      report.unreadable.push({ page: ln.page, text: text.replace(/^[^0-9]*?(?=\d{6})/, "… "),
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
    if (seen.has(r_number)) why.push("appears twice in this report");
    seen.add(r_number);

    report.rows.push({
      r_number, acc_number, collection: dates[0] || "", entered: dates[1] || "", page: ln.page,
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
export async function readReport(file: File, onProgress: (msg: string, pct: number) => void): Promise<ParsedReport> {
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
  const { lines, pageCanvases } = await ocrLines(doc, onProgress);
  return parseLines(lines, "scan", pageCanvases);
}
