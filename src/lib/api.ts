import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AlistKeyword, DeptKeyword, ParseResult, ReqRow, TestRow } from "./tracker";

// Connection settings. Render can override these with environment variables
// VITE_SUPABASE_URL / VITE_SUPABASE_KEY; otherwise the values below are used.
// The publishable key is safe in the browser: every table has Row Level
// Security and all writes are checked server-side.
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL || "https://bpymvpuuhrdhreghdofq.supabase.co";
export const SUPABASE_KEY: string = import.meta.env.VITE_SUPABASE_KEY || "sb_publishable_icdvdRX4J6rm3dQacvE4Nw_iJkraGQ_";
export const STAFF_FUNCTION = "manage-staff";

export const configOk = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(SUPABASE_URL);
export const sb: SupabaseClient | null = configOk ? createClient(SUPABASE_URL.replace(/\/$/, ""), SUPABASE_KEY) : null;

export type Role = "staff" | "admin" | "courier" | "display";
export interface Me { email: string; display_name: string | null; role: Role; active: boolean }
export interface PasteRow { id: number; at: string; mode: "full" | "partial"; by_email: string; locked: boolean; undone_at: string | null }
export interface Settings { graceStd: number; graceAlist: number; archiveDays: number }
export interface Unmatched { name: string; count: number; attachedTo: string | null }
export interface StaffRow { email: string; display_name: string | null; role: Role; active: boolean; last_sign_in_at: string | null; has_login: boolean }

export interface Snapshot {
  reqs: ReqRow[];
  tests: TestRow[];
  alist: AlistKeyword[];
  dept: DeptKeyword[];
  ignored: string[];
  unmatched: Record<string, Unmatched>;
  settings: Settings;
  pastes: PasteRow[]; // not undone, newest first
  loadedAt: Date;
}

function client(): SupabaseClient {
  if (!sb) throw new Error("Not connected to Supabase");
  return sb;
}

async function call<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

// PostgREST returns at most 1000 rows per request, so read in pages.
async function fetchAll<T>(table: string, columns: string, orderCol: string): Promise<T[]> {
  const out: T[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await client().from(table).select(columns).order(orderCol, { ascending: true }).range(from, from + size - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if (!data || data.length < size) break;
  }
  return out;
}

export async function loadSnapshot(): Promise<Snapshot> {
  const [reqs, tests, alist, dept, ign, unm, st, pastes] = await Promise.all([
    fetchAll<ReqRow>("requisitions", "r_number,patient_id,client_raw,report_date,report_at", "r_number"),
    fetchAll<TestRow>("requisition_tests", "id,r_number,name,seq,status,first_seen,last_seen,completed_at", "id"),
    fetchAll<{ keyword: string; display_name: string }>("alist_keywords", "keyword,display_name,sort", "sort"),
    fetchAll<{ keyword: string; department: DeptKeyword["department"] }>("dept_keywords", "keyword,department,sort", "sort"),
    fetchAll<{ name_norm: string }>("ignored_tokens", "name_norm", "name_norm"),
    fetchAll<{ name_norm: string; name: string; count: number; attached_to: string | null }>("unmatched_tokens", "name_norm,name,count,attached_to", "name_norm"),
    call(client().from("app_settings").select("*").eq("id", 1).maybeSingle(), "settings"),
    call(client().from("pastes").select("id,at,mode,by_email,locked,undone_at").order("id", { ascending: false }).limit(1000), "pastes"),
  ]);
  const unmatched: Record<string, Unmatched> = {};
  unm.forEach((u) => { unmatched[u.name_norm] = { name: u.name, count: u.count, attachedTo: u.attached_to }; });
  const s = st as { grace_std: number; grace_alist: number; archive_days: number } | null;
  return {
    reqs, tests,
    alist: alist.map((r) => ({ keyword: r.keyword, displayName: r.display_name })),
    dept: dept.map((r) => ({ keyword: r.keyword, department: r.department })),
    ignored: ign.map((r) => r.name_norm),
    unmatched,
    settings: s ? { graceStd: s.grace_std, graceAlist: s.grace_alist, archiveDays: s.archive_days } : { graceStd: 0, graceAlist: 0, archiveDays: 30 },
    pastes: ((pastes as PasteRow[]) || []).filter((p) => !p.undone_at),
    loadedAt: new Date(),
  };
}

export function subscribeLive(onChange: () => void, onStatus: (live: boolean) => void) {
  const ch = client()
    .channel("tracker-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "requisition_tests" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "requisitions" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "pastes" }, onChange)
    .subscribe((status) => onStatus(status === "SUBSCRIBED"));
  return () => { client().removeChannel(ch); };
}

/* ---------- writes (all checked server-side) ---------- */
export async function applyPaste(mode: "full" | "partial", parsed: ParseResult) {
  const byR: Record<string, { r_number: string; patient_id: string; client_raw: string; report_date: string; report_at: string; tests: string[] }> = {};
  const order: string[] = [];
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toUpperCase();
  parsed.slices.forEach((s) => {
    let g = byR[s.rNumber];
    if (!g) {
      g = byR[s.rNumber] = { r_number: s.rNumber, patient_id: s.patientId, client_raw: s.clientRaw, report_date: s.reportDate, report_at: s.reportDateTime, tests: [] };
      order.push(s.rNumber);
    }
    if (new Date(s.reportDateTime) < new Date(g.report_at)) { g.report_at = s.reportDateTime; g.report_date = s.reportDate; }
    s.pendingNames.forEach((n) => { if (!g.tests.some((x) => norm(x) === norm(n))) g.tests.push(n); });
  });
  const unmatched = Object.values(parsed.unmatched).map((u) => ({ name: u.name, count: u.count, attached_to: u.attachedTo }));
  return call(client().rpc("apply_paste", { p_mode: mode, p_items: order.map((r) => byR[r]), p_unmatched: unmatched }), "Saving paste");
}

export const undoLastPaste = () => call(client().rpc("undo_last_paste"), "Undo");
export const clearAllCases = () => call(client().rpc("clear_all_cases"), "Clear all");
export const addTokenToDept = (name: string, department: string) => call(client().rpc("add_token_to_dept", { p_name: name, p_department: department }), "Adding keyword");
export const ignoreToken = (name: string) => call(client().rpc("ignore_token", { p_name: name }), "Ignoring name");
export const saveSettings = (s: Settings) =>
  call(client().rpc("save_settings", { p_grace_std: s.graceStd, p_grace_alist: s.graceAlist, p_archive_days: s.archiveDays }), "Saving settings");
export const replaceAlist = (rows: AlistKeyword[]) =>
  call(client().rpc("replace_keywords", { p_kind: "alist", p_rows: rows.map((r) => ({ keyword: r.keyword, display_name: r.displayName || "" })) }), "Saving A-List");
export const replaceDept = (rows: DeptKeyword[]) =>
  call(client().rpc("replace_keywords", { p_kind: "dept", p_rows: rows.map((r) => ({ keyword: r.keyword, department: r.department })) }), "Saving departments");
export const archiveCompleted = (days: number) =>
  call(client().rpc("archive_completed", { p_days: days }), "Archive") as Promise<{ count: number; requisitions: unknown[] }>;
export const importRequisitions = (reqs: unknown[]) =>
  call(client().rpc("import_requisitions", { p_reqs: reqs }), "Import") as Promise<{ requisitions: number; tests: number }>;

/* ---------- staff Edge Function ---------- */
export async function staffFn<T = any>(payload: Record<string, unknown>): Promise<T> {
  const { data, error } = await client().functions.invoke(STAFF_FUNCTION, { body: payload });
  if (error) {
    let msg = error.message || "Request failed";
    try { const j = await (error as any).context.json(); if (j?.error) msg = j.error; } catch { /* keep generic message */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data as T;
}

/* ---------- auth ---------- */
export async function currentStaff(): Promise<Me | { error: string } | null> {
  const { data: { user } } = await client().auth.getUser();
  if (!user) return null;
  const email = (user.email || "").toLowerCase();
  const { data, error } = await client().from("staff").select("email,display_name,role,active").eq("email", email).maybeSingle();
  if (error) return { error: "Could not check your access: " + error.message };
  if (!data || !data.active) return { error: "This login is not on the staff list, or has been deactivated. Ask an admin." };
  return data as Me;
}

export const signIn = (email: string, password: string) => client().auth.signInWithPassword({ email, password });
export const signOut = () => client().auth.signOut();
export const changePassword = (password: string) => client().auth.updateUser({ password });
export const getSession = () => client().auth.getSession();

/* ---------- sample transport (courier -> pre-analytical) ---------- */
export interface Centre { id: number; name: string; active: boolean }
export interface CourierRun { id: number; courier_email: string; centre_id: number; started_at: string; handed_over_at: string | null;
  route_id?: number | null; is_emergency?: boolean; emergency_reason?: string | null }
export interface SampleRow {
  id: number; barcode: string; barcode_raw: string | null; r_number: string | null; run_id: number | null; centre_id: number | null;
  collected_by: string | null; collected_at: string | null; photo_path: string | null; photo_deleted_at: string | null;
  received_by: string | null; received_by_name?: string | null; received_at: string | null; source: "courier" | "reception";
}
/** Who received a sample: their name at the time of the scan, else the start of their email. */
export const receiverName = (s: { received_by?: string | null; received_by_name?: string | null }) =>
  s.received_by_name || (s.received_by || "").split("@")[0] || "";
export interface TransportSettings { photoRetentionDays: number; transitAlertMinutes: number }
export interface ReceiveResult {
  result: "received" | "already_received" | "not_logged_by_courier";
  sample_id: number; barcode: string; r_number: string | null; centre?: string | null; collected_by?: string | null;
  collected_at?: string | null; received_at: string; received_by?: string; transit_minutes?: number;
}
const SAMPLE_COLS_BASE = "id,barcode,barcode_raw,r_number,run_id,centre_id,collected_by,collected_at,photo_path,photo_deleted_at,received_by,received_at,source";
// received_by_name comes from 12_sample_receipt_audit.sql. Until that has been run,
// read without it so the Samples screen keeps working.
let hasReceiverName = true;
const sampleCols = () => hasReceiverName ? `${SAMPLE_COLS_BASE},received_by_name` : SAMPLE_COLS_BASE;
async function readSamples(build: (cols: string) => PromiseLike<{ data: any; error: { message: string } | null }>, what: string): Promise<SampleRow[]> {
  try { return await call(build(sampleCols()), what); }
  catch (e: any) {
    if (!hasReceiverName || !/received_by_name/.test(e.message)) throw e;
    hasReceiverName = false;
    return await call(build(sampleCols()), what);
  }
}

export interface SampleAuditRow {
  id: number; at: string; actor: string; actor_name: string | null; action: string;
  sample_id: number | null; barcode: string; r_number: string | null; details: Record<string, any> | null;
}
const auditError = (error: { message: string; code?: string }) => new Error(/sample_audit/.test(error.message) || error.code === "42P01"
  ? "History isn't set up yet: run supabase/12_sample_receipt_audit.sql in Supabase"
  : `Loading history: ${error.message}`);

/** Permanent receipt history for one barcode, oldest first. */
export async function loadSampleHistory(barcode: string): Promise<SampleAuditRow[]> {
  const { data, error } = await client().from("sample_audit").select("*").eq("barcode", barcode).order("at").order("id").limit(500);
  if (error) throw auditError(error);
  return data as SampleAuditRow[];
}

/** All receipt history events since local midnight `days - 1` days ago, newest first (at most 10 000). */
export async function loadSampleAudit(days: number): Promise<{ rows: SampleAuditRow[]; truncated: boolean }> {
  const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days - 1));
  const rows: SampleAuditRow[] = [];
  const size = 1000, max = 10000;
  for (let from = 0; from < max; from += size) {
    const { data, error } = await client().from("sample_audit").select("*").gte("at", since.toISOString())
      .order("at", { ascending: false }).order("id", { ascending: false }).range(from, from + size - 1);
    if (error) throw auditError(error);
    rows.push(...(data as SampleAuditRow[]));
    if (!data || data.length < size) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export const loadCentres = () =>
  call(client().from("centres").select("id,name,active").order("name"), "Centres") as Promise<Centre[]>;

export async function loadTransportSettings(): Promise<TransportSettings> {
  const s = await call(client().from("app_settings").select("photo_retention_days,transit_alert_minutes").eq("id", 1).maybeSingle(), "Settings") as any;
  return { photoRetentionDays: s?.photo_retention_days ?? 14, transitAlertMinutes: s?.transit_alert_minutes ?? 180 };
}

/** Everything still in transit, plus anything collected or received in the last `hours`. */
export async function loadTransport(hours = 36) {
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  const [samples, runs, centres, settings] = await Promise.all([
    readSamples((cols) => client().from("samples").select(cols)
      .or(`received_at.is.null,collected_at.gte.${since},received_at.gte.${since}`).order("id", { ascending: false }).limit(3000), "Samples"),
    call(client().from("courier_runs").select("*").or(`handed_over_at.is.null,started_at.gte.${since}`).order("id", { ascending: false }).limit(500), "Runs"),
    loadCentres(),
    loadTransportSettings(),
  ]);
  return { samples: samples as SampleRow[], runs: runs as CourierRun[], centres, settings };
}

export const samplesForRequisition = (r: string) =>
  readSamples((cols) => client().from("samples").select(cols).eq("r_number", r).order("id"), "Samples");

export async function myOpenRun(email: string) {
  const runs = await call(client().from("courier_runs").select("*").eq("courier_email", email).order("id", { ascending: false }).limit(15), "Runs") as CourierRun[];
  const ids = runs.map((r) => r.id);
  const samples = ids.length
    ? await readSamples((cols) => client().from("samples").select(cols).in("run_id", ids).order("id", { ascending: false }), "Samples")
    : [];
  return { runs, samples };
}

export const startRun = (centreId: number, routeId: number | null = null, emergency = false, reason = "") =>
  call(client().rpc("courier_start_run", { p_centre_id: centreId, p_route_id: routeId, p_emergency: emergency, p_reason: reason || null }), "Starting collection") as Promise<number>;
export const logSamples = (runId: number, barcodes: string[], photoPath: string | null) =>
  call(client().rpc("courier_log_samples", { p_run_id: runId, p_barcodes: barcodes, p_photo_path: photoPath }), "Logging samples") as
    Promise<{ barcode: string; r_number: string | null; result: "logged" | "already_in_this_run" | "already_in_transit"; sample_id: number }[]>;
export const removeSample = (id: number) => call(client().rpc("courier_remove_sample", { p_sample_id: id }), "Removing sample");
export const handOver = (runId: number) => call(client().rpc("courier_hand_over", { p_run_id: runId }), "Handing over");
export const receiveSample = (barcode: string) => call(client().rpc("receive_sample", { p_barcode: barcode }), "Receiving") as Promise<ReceiveResult>;
export const undoReceive = (id: number) => call(client().rpc("undo_receive", { p_sample_id: id }), "Undo receipt");
export const saveCentre = (id: number | null, name: string, active: boolean) =>
  call(client().rpc("save_centre", { p_id: id, p_name: name, p_active: active }), "Saving centre");
export const saveTransportSettings = (s: TransportSettings) =>
  call(client().rpc("save_transport_settings", { p_photo_retention_days: s.photoRetentionDays, p_transit_alert_minutes: s.transitAlertMinutes }), "Saving settings");

/** Photos go in date folders (UTC) so old ones can be deleted a whole day at a time. */
export async function uploadSamplePhoto(blob: Blob): Promise<string> {
  const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const path = `${new Date().toISOString().slice(0, 10)}/${id}.jpg`;
  const { error } = await client().storage.from("sample-photos").upload(path, blob, { contentType: "image/jpeg", upsert: false });
  if (error) throw new Error(`Uploading photo: ${error.message}`);
  return path;
}
export async function samplePhotoUrl(path: string): Promise<string> {
  const { data, error } = await client().storage.from("sample-photos").createSignedUrl(path, 600);
  if (error) throw new Error(`Opening photo: ${error.message}`);
  return data.signedUrl;
}

// Each subscriber needs its own channel: Supabase returns the existing channel for a
// name already in use, and adding listeners to it after subscribe() throws, which
// blanked the page when Receive samples and History were both listening.
let transportSubs = 0;
export function subscribeTransport(onChange: () => void) {
  const ch = client().channel(`transport-live-${++transportSubs}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "samples" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "courier_runs" }, onChange)
    .subscribe();
  return () => { client().removeChannel(ch); };
}

/** Delete expired courier photos. Runs at most every 6 hours per computer. */
export function maybePurgePhotos() {
  try {
    const last = Number(localStorage.getItem("pat-photo-purge") || 0);
    if (Date.now() - last < 6 * 3600e3) return;
    localStorage.setItem("pat-photo-purge", String(Date.now()));
  } catch { /* ignore */ }
  staffFn({ action: "purge_photos" }).catch(() => { /* try again next time */ });
}

/* ---------- report delivery (GHA-POSTF001) ---------- */
export type DeliveryStatus = "pending" | "D" | "ND" | "CU" | "C";
export interface DeliverySheet {
  id: number; courier_email: string; courier_name: string | null; courier_signature: string | null;
  location: string; department: string | null; started_at: string; closed_at: string | null;
  reviewed_by: string | null; reviewed_at: string | null; review_note: string | null;
}
export interface ReportDelivery {
  id: number; sheet_id: number; r_number: string; barcode_raw: string | null; client_name: string | null;
  picked_up_at: string; status: DeliveryStatus; receiver_name: string | null; receiver_signature: string | null;
  recorded_at: string | null; reason: string | null;
}

export async function loadDeliveries(days = 45, courierEmail?: string) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  let q = client().from("delivery_sheets").select("*").or(`closed_at.is.null,started_at.gte.${since}`).order("id", { ascending: false }).limit(500);
  if (courierEmail) q = q.eq("courier_email", courierEmail);
  const sheets = await call(q, "Delivery sheets") as DeliverySheet[];
  const ids = sheets.map((s) => s.id);
  const rows = ids.length ? await call(client().from("report_deliveries").select("*").in("sheet_id", ids).order("id"), "Deliveries") as ReportDelivery[] : [];
  return { sheets, rows };
}
export const deliveriesForRequisition = (r: string) =>
  call(client().from("report_deliveries").select("*").eq("r_number", r).order("id"), "Deliveries") as Promise<ReportDelivery[]>;
export const startDeliverySheet = (location: string, department: string, signature: string) =>
  call(client().rpc("delivery_start_sheet", { p_location: location, p_department: department, p_courier_signature: signature }), "Starting sheet") as Promise<number>;
export const addReports = (sheetId: number, codes: string[]) =>
  call(client().rpc("delivery_add_reports", { p_sheet_id: sheetId, p_codes: codes }), "Adding reports") as
    Promise<{ code: string; r_number?: string; result: "added" | "already_on_this_sheet" | "already_out_for_delivery" | "no_r_number" | "not_released";
      client_name?: string | null; destination?: string; other_destination?: boolean }[]>;
export const setDeliveryClient = (id: number, name: string) => call(client().rpc("delivery_set_client", { p_id: id, p_client_name: name }), "Saving client");
export const recordDelivery = (id: number, status: Exclude<DeliveryStatus, "pending">, receiverName: string, signature: string, reason: string) =>
  call(client().rpc("delivery_record", { p_id: id, p_status: status, p_receiver_name: receiverName, p_receiver_signature: signature, p_reason: reason }), "Recording delivery");
export const removeDelivery = (id: number) => call(client().rpc("delivery_remove", { p_id: id }), "Removing report");
export const closeDeliverySheet = (id: number) => call(client().rpc("delivery_close_sheet", { p_sheet_id: id }), "Closing sheet");
export const reviewDeliverySheet = (id: number, note: string) => call(client().rpc("delivery_review", { p_sheet_id: id, p_note: note }), "Reviewing sheet");
export function subscribeDeliveries(onChange: () => void) {
  const ch = client().channel("deliveries-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "delivery_sheets" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "report_deliveries" }, onChange)
    .subscribe();
  return () => { client().removeChannel(ch); };
}

/* ---------- pickup photo review ---------- */
export interface PickupPhoto { path: string; url: string | null; takenAt: string; courier: string | null; centreId: number | null; runId: number | null; samples: SampleRow[] }

/** Courier photos still within the retention period, newest first, with short-lived links. */
export async function loadPickupPhotos(days: number) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const [samples, runs, centres] = await Promise.all([
    readSamples((cols) => client().from("samples").select(cols).not("photo_path", "is", null).is("photo_deleted_at", null)
      .gte("collected_at", since).order("collected_at", { ascending: false }).limit(3000), "Photos"),
    call(client().from("courier_runs").select("*").gte("started_at", new Date(Date.now() - (days + 1) * 86400e3).toISOString()).order("id", { ascending: false }).limit(1000), "Runs") as Promise<CourierRun[]>,
    loadCentres(),
  ]);
  const byPath = new Map<string, PickupPhoto>();
  for (const s of samples) {
    const p = s.photo_path!;
    const e = byPath.get(p);
    if (e) { e.samples.push(s); continue; }
    byPath.set(p, { path: p, url: null, takenAt: s.collected_at || "", courier: s.collected_by, centreId: s.centre_id, runId: s.run_id, samples: [s] });
  }
  const photos = [...byPath.values()];
  // Signed links in batches (valid 30 minutes; reload for fresh ones)
  for (let i = 0; i < photos.length; i += 100) {
    const batch = photos.slice(i, i + 100);
    const { data, error } = await client().storage.from("sample-photos").createSignedUrls(batch.map((p) => p.path), 1800);
    if (error) throw new Error(`Opening photos: ${error.message}`);
    (data || []).forEach((d, j) => { if (batch[j]) batch[j]!.url = d.signedUrl || null; });
  }
  return { photos, runs, centres };
}

/* ---------- report release (post-analytical -> courier) ---------- */
export type ReleaseStatus = "released" | "picked_up" | "delivered" | "returned" | "cancelled";
export interface ReportRelease {
  id: number; r_number: string; client_name: string | null; destination: string; released_by: string; released_at: string;
  status: ReleaseStatus; delivery_id: number | null; closed_by: string | null; closed_at: string | null; note: string | null;
}
export interface ReleaseResult {
  code: string; r_number?: string; result: "released" | "already_released" | "already_with_courier" | "no_r_number";
  client_name?: string | null; pending_tests?: number; known_to_tracker?: boolean; destination?: string;
}
/** Lab view: everything live, plus anything returned or closed in the last `days`. */
export async function loadReleases(days = 14) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  return call(client().from("report_releases").select("*")
    .or(`status.in.(released,picked_up,returned),released_at.gte.${since}`).order("id", { ascending: false }).limit(2000), "Released reports") as Promise<ReportRelease[]>;
}
/** Courier view: reports waiting for pick-up. */
export const loadWaitingReleases = () =>
  call(client().from("report_releases").select("*").eq("status", "released").order("released_at"), "Released reports") as Promise<ReportRelease[]>;
export const releaseReports = (codes: string[], destination: string) =>
  call(client().rpc("release_reports", { p_codes: codes, p_destination: destination }), "Releasing") as Promise<ReleaseResult[]>;
export const cancelRelease = (id: number, note: string) => call(client().rpc("cancel_release", { p_id: id, p_note: note }), "Withdrawing");
let releaseSubs = 0;
export function subscribeReleases(onChange: () => void) {
  const ch = client().channel(`releases-live-${++releaseSubs}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "report_releases" }, onChange).subscribe();
  return () => { client().removeChannel(ch); };
}
/* ---------- reports due back to the centre the samples came from ---------- */
export interface DueBackItem {
  r_number: string; centre_id: number | null; barcodes: string[]; received_at: string; collected_at: string | null;
  client_name: string | null; known_to_tracker: boolean; pending_tests: number; total_tests: number; withdrawn: boolean;
}
const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
async function pagedIn<T>(table: string, cols: string, rs: string[], what: string): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunks(rs, 150)) {
    for (let from = 0; ; from += 1000) {
      const data = await call(client().from(table).select(cols).in("r_number", part).order("id").range(from, from + 999), what) as T[];
      out.push(...data);
      if (data.length < 1000) break;
    }
  }
  return out;
}
/**
 * R#s received in the lab since local midnight `days - 1` days ago whose report hasn't been sent back yet.
 * A report counts as sent once it is released, with a courier, delivered, returned, or closed after a return.
 * A release withdrawn before pick-up puts it back on this list.
 */
export async function loadDueBack(days = 7): Promise<DueBackItem[]> {
  const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days - 1));
  type S = { id: number; r_number: string; barcode: string; centre_id: number | null; received_at: string; collected_at: string | null };
  const samples: S[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const data = await call(client().from("samples").select("id,r_number,barcode,centre_id,received_at,collected_at")
      .gte("received_at", since.toISOString()).not("r_number", "is", null).order("id").range(from, from + 999), "Samples") as S[];
    samples.push(...data);
    if (data.length < 1000) break;
  }
  const byR = new Map<string, DueBackItem>();
  for (const s of samples) {
    const it = byR.get(s.r_number);
    if (!it) {
      byR.set(s.r_number, { r_number: s.r_number, centre_id: s.centre_id, barcodes: [s.barcode], received_at: s.received_at, collected_at: s.collected_at,
        client_name: null, known_to_tracker: false, pending_tests: 0, total_tests: 0, withdrawn: false });
    } else {
      if (!it.barcodes.includes(s.barcode)) it.barcodes.push(s.barcode);
      if (it.centre_id == null) it.centre_id = s.centre_id;
      if (s.received_at > it.received_at) it.received_at = s.received_at;
    }
  }
  const rs = [...byR.keys()];
  if (!rs.length) return [];
  const [rels, reqs, tests] = await Promise.all([
    pagedIn<{ r_number: string; status: ReleaseStatus; delivery_id: number | null }>("report_releases", "id,r_number,status,delivery_id", rs, "Released reports"),
    (async () => {
      const out: { r_number: string; client_raw: string }[] = [];
      for (const part of chunks(rs, 150)) out.push(...await call(client().from("requisitions").select("r_number,client_raw").in("r_number", part), "Requisitions") as any[]);
      return out;
    })(),
    pagedIn<{ r_number: string; status: string }>("requisition_tests", "id,r_number,status", rs, "Tests"),
  ]);
  for (const rel of rels) {
    const it = byR.get(rel.r_number); if (!it) continue;
    if (rel.status === "cancelled" && rel.delivery_id == null) it.withdrawn = true;
    else byR.delete(rel.r_number);
  }
  for (const q of reqs) { const it = byR.get(q.r_number); if (it) { it.known_to_tracker = true; it.client_name = q.client_raw || null; } }
  for (const t of tests) { const it = byR.get(t.r_number); if (it) { it.total_tests++; if (t.status === "Pending") it.pending_tests++; } }
  return [...byR.values()];
}

export const releasesForRequisition = (r: string) =>
  call(client().from("report_releases").select("*").eq("r_number", r).order("id"), "Released reports") as Promise<ReportRelease[]>;

/* ---------- courier routes ---------- */
export interface CourierRoute { id: number; name: string; active: boolean; sites: number[]; couriers: string[] }

/** Lab staff see every route; couriers only the routes assigned to them. */
export async function loadRoutes(): Promise<CourierRoute[]> {
  const [routes, sites, assigns] = await Promise.all([
    call(client().from("courier_routes").select("id,name,active").order("name"), "Routes") as Promise<{ id: number; name: string; active: boolean }[]>,
    call(client().from("route_sites").select("route_id,centre_id,position").order("position"), "Route sites") as Promise<{ route_id: number; centre_id: number; position: number }[]>,
    call(client().from("route_assignments").select("route_id,courier_email"), "Route assignments") as Promise<{ route_id: number; courier_email: string }[]>,
  ]);
  return routes.map((r) => ({
    ...r,
    sites: sites.filter((x) => x.route_id === r.id).sort((a, b) => a.position - b.position).map((x) => x.centre_id),
    couriers: assigns.filter((x) => x.route_id === r.id).map((x) => x.courier_email),
  }));
}
export const saveRoute = (r: { id: number | null; name: string; active: boolean; sites: number[]; couriers: string[] }) =>
  call(client().rpc("save_route", { p_id: r.id, p_name: r.name, p_active: r.active, p_centre_ids: r.sites, p_couriers: r.couriers }), "Saving route") as Promise<number>;

/* ---------- email tracking ---------- */
export interface EmailItem {
  id: number; r_number: string; acc_number: string | null; collection: string | null; entered: string | null;
  status: "open" | "worked" | "removed" | "cleared"; duplicate_flag: boolean; times_flagged: number;
  first_batch_id: number | null; last_batch_id: number | null; worked_by: string | null; worked_at: string | null;
  flagged_at: string | null; removed_by: string | null; removed_at: string | null; cleared_at: string | null;
}
export interface EmailBatch {
  id: number; file_name: string | null; source: string | null; run_date: string | null; mode: "full" | "partial";
  uploaded_by: string; uploaded_at: string; row_count: number; stats: Record<string, number> | null; undone_at: string | null;
}
export async function loadEmailTracking() {
  const since = new Date(Date.now() - 30 * 86400e3).toISOString();
  const [items, batches] = await Promise.all([
    fetchAll<EmailItem>("email_items", "*", "id").then((all) => all.filter((i) => i.status !== "cleared" || (i.cleared_at || "") >= since)),
    call(client().from("email_batches").select("*").order("id", { ascending: false }).limit(1000), "Uploads") as Promise<EmailBatch[]>,
  ]);
  return { items, batches };
}
export const emailApplyUpload = (fileName: string, source: string, runDate: string | null, mode: "full" | "partial",
  rows: { r_number: string; acc_number: string; collection: string; entered: string }[]) =>
  call(client().rpc("email_apply_upload", { p_file_name: fileName, p_source: source, p_run_date: runDate, p_mode: mode, p_rows: rows }), "Saving upload") as Promise<Record<string, number>>;
export const emailUndoUpload = () => call(client().rpc("email_undo_upload"), "Undo upload");
export const emailMarkWorked = (ids: number[]) => call(client().rpc("email_mark_worked", { p_ids: ids }), "Marking worked") as Promise<number>;
export const emailUndoWorked = (id: number) => call(client().rpc("email_undo_worked", { p_id: id }), "Undo");
export const emailMarkRemoved = (ids: number[]) => call(client().rpc("email_mark_removed", { p_ids: ids }), "Marking removed") as Promise<number>;
export const emailUndoRemoved = (id: number) => call(client().rpc("email_undo_removed", { p_id: id }), "Undo");
export function subscribeEmail(onChange: () => void) {
  const ch = client().channel("email-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "email_items" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "email_batches" }, onChange).subscribe();
  return () => { client().removeChannel(ch); };
}

export interface EmailAuditRow { id: number; at: string; actor: string; action: string; r_number: string | null; batch_id: number | null; details: Record<string, any> | null }
/** Audit trail (admins only), newest first, between two dates (inclusive). */
export async function loadEmailAudit(fromIso: string, toIso: string) {
  const out: EmailAuditRow[] = [];
  for (let from = 0; ; from += 1000) {
    const page = (await call(client().from("email_audit").select("*").gte("at", fromIso).lt("at", toIso)
      .order("id", { ascending: false }).range(from, from + 999), "Audit trail")) as EmailAuditRow[];
    out.push(...page);
    if (page.length < 1000 || out.length >= 20000) break;
  }
  return out;
}

/* ---------- analytics (admin) ---------- */
export interface AnalyticsData {
  samples: SampleRow[]; runs: CourierRun[]; centres: Centre[]; audit: SampleAuditRow[]; auditMissing: boolean;
  releases: ReportRelease[]; deliveries: ReportDelivery[]; sheets: DeliverySheet[];
  names: Record<string, string>; transitAlertMinutes: number; truncated: boolean;
}
const MAX_ROWS = 30000;
async function pages<T>(build: (from: number, to: number) => PromiseLike<{ data: any; error: { message: string } | null }>, what: string) {
  const out: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += 1000) {
    const data = await call(build(from, from + 999), what) as T[];
    out.push(...data);
    if (data.length < 1000) return { rows: out, truncated: false };
  }
  return { rows: out, truncated: true };
}
/** Everything collected, received, released or delivered between `fromIso` and `toIso`. */
export async function loadAnalytics(fromIso: string, toIso: string): Promise<AnalyticsData> {
  const inRange = (col: string) => `and(${col}.gte.${fromIso},${col}.lt.${toIso})`;
  const runsSince = new Date(new Date(fromIso).getTime() - 2 * 86400e3).toISOString();
  const [samples, runs, centres, settings, rel, del] = await Promise.all([
    pages<SampleRow>((a, b) => client().from("samples").select(sampleCols()).or(`${inRange("collected_at")},${inRange("received_at")}`).order("id").range(a, b), "Samples")
      .catch(async (e) => { if (!/received_by_name/.test(e.message)) throw e; hasReceiverName = false;
        return pages<SampleRow>((a, b) => client().from("samples").select(sampleCols()).or(`${inRange("collected_at")},${inRange("received_at")}`).order("id").range(a, b), "Samples"); }),
    pages<CourierRun>((a, b) => client().from("courier_runs").select("*").gte("started_at", runsSince).lt("started_at", toIso).order("id").range(a, b), "Runs"),
    loadCentres(),
    loadTransportSettings(),
    pages<ReportRelease>((a, b) => client().from("report_releases").select("*").gte("released_at", fromIso).lt("released_at", toIso).order("id").range(a, b), "Released reports"),
    pages<ReportDelivery>((a, b) => client().from("report_deliveries").select("id,sheet_id,r_number,client_name,picked_up_at,status,receiver_name,recorded_at,reason")
      .gte("picked_up_at", fromIso).lt("picked_up_at", toIso).order("id").range(a, b), "Deliveries"),
  ]);
  let audit: SampleAuditRow[] = [], auditMissing = false;
  try {
    const r = await pages<SampleAuditRow>((a, b) => client().from("sample_audit").select("*").gte("at", fromIso).lt("at", toIso).order("id").range(a, b), "History");
    audit = r.rows;
  } catch { auditMissing = true; }
  const sheetIds = [...new Set(del.rows.map((d) => d.sheet_id))];
  const sheets: DeliverySheet[] = [];
  for (const part of chunks(sheetIds, 150)) sheets.push(...await call(client().from("delivery_sheets").select("id,courier_email,courier_name,location,department,started_at,closed_at,reviewed_by,reviewed_at").in("id", part), "Sheets") as DeliverySheet[]);
  const names: Record<string, string> = {};
  try {
    const staff = await call(client().from("staff").select("email,display_name"), "Staff") as { email: string; display_name: string | null }[];
    staff.forEach((s) => { if (s.display_name) names[s.email] = s.display_name; });
  } catch { /* names fall back to the email */ }
  audit.forEach((r) => { if (r.actor_name && !names[r.actor]) names[r.actor] = r.actor_name; });
  return { samples: samples.rows, runs: runs.rows, centres, audit, auditMissing, releases: rel.rows, deliveries: del.rows, sheets, names,
    transitAlertMinutes: settings.transitAlertMinutes, truncated: samples.truncated || rel.truncated || del.truncated };
}

/* ---------- delay reasons and follow-up (13_delay_notes.sql) ---------- */
export type DelayStatus = "open" | "following_up" | "resolved";
export interface DelayNote {
  id: number; r_number: string; department: string; patient_id: string | null; client: string | null; is_alist: boolean;
  tests: string | null; tat_at: string | null; reason_category: string; reason: string; delay_minutes: number; expected_at: string | null;
  status: DelayStatus; recorded_by: string; recorded_by_name: string | null; recorded_at: string;
  updated_by: string | null; updated_by_name: string | null; updated_at: string;
  follow_up_note: string | null; followed_up_by: string | null; followed_up_by_name: string | null; followed_up_at: string | null;
  resolved_at: string | null; history: { at: string; by: string; action: string; category?: string; reason?: string; delay_minutes?: number; note?: string }[];
}
export const DELAY_REASONS = [
  "Repeat / re-run of test", "Instrument breakdown or maintenance", "Reagent or consumable out of stock", "QC failure",
  "Sample problem (haemolysed, clotted, insufficient)", "Sample received late", "Awaiting confirmatory or reflex test",
  "Culture still incubating", "Sent to referral lab", "Awaiting pathologist / senior review", "LIS or IT problem",
  "Staff shortage or high workload", "Power outage", "Other",
];
const delayErr = (e: Error) => /delay_notes|save_delay_note|follow_up_delay|schema cache/i.test(e.message)
  ? new Error("Delay notes aren't set up yet. Ask an admin to run supabase/13_delay_notes.sql in the Supabase SQL Editor.") : e;

/** Delay notes recorded since `fromIso` (all of them when omitted), newest first. */
export async function loadDelayNotes(fromIso?: string): Promise<DelayNote[]> {
  try {
    const r = await pages<DelayNote>((a, b) => {
      let q = client().from("delay_notes").select("*");
      if (fromIso) q = q.gte("recorded_at", fromIso);
      return q.order("recorded_at", { ascending: false }).range(a, b);
    }, "Delay notes");
    return r.rows;
  } catch (e: any) { throw delayErr(e); }
}
export async function saveDelayNote(p: {
  rNumber: string; department: string; patientId: string; client: string; isAlist: boolean; tests: string; tatAt: string | null;
  category: string; reason: string; delayMinutes: number;
}): Promise<number> {
  try {
    return await call(client().rpc("save_delay_note", {
      p_r_number: p.rNumber, p_department: p.department, p_patient_id: p.patientId, p_client: p.client, p_is_alist: p.isAlist,
      p_tests: p.tests, p_tat_at: p.tatAt, p_category: p.category, p_reason: p.reason, p_delay_minutes: p.delayMinutes,
    }), "Saving delay reason") as number;
  } catch (e: any) { throw delayErr(e); }
}
export async function followUpDelay(id: number, status: DelayStatus, note: string) {
  try { await call(client().rpc("follow_up_delay", { p_id: id, p_status: status, p_note: note }), "Saving follow-up"); }
  catch (e: any) { throw delayErr(e); }
}
export async function deleteDelayNote(id: number) {
  try { await call(client().rpc("delete_delay_note", { p_id: id }), "Removing delay note"); }
  catch (e: any) { throw delayErr(e); }
}
let delaySubs = 0;
export function subscribeDelayNotes(onChange: () => void) {
  const ch = client().channel(`delays-live-${++delaySubs}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "delay_notes" }, onChange).subscribe();
  return () => { client().removeChannel(ch); };
}
