// Job Site Schedule API (Cloudflare Pages Functions)
//
// Bindings (set in Cloudflare Pages > Settings > Bindings):
//   DB     -> D1 database
//   FILES  -> R2 bucket
// Environment variable (Settings > Variables and Secrets, type "Secret"):
//   TEAM_PASSCODE -> the team passcode for editing
//
// Data model: every record is a JSON document in one of three collections
// (projects, tasks, logs). Devices that unlock with the passcode can change
// anything. Locked devices may only add to a few sections of an existing job.

const COLLECTIONS = new Set(["projects", "tasks", "logs"]);
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_FILE = 25 * 1024 * 1024; // 25 MB per attachment
const MAX_DOC = 900 * 1024;        // keep each record well under D1 limits

// Fields a locked device may change on an existing job.
const LOCKED_KEYS = new Set([
  "materialsList", "materials",
  "obsTour", "tourDate", "tourTime", "tourWho", "tourCount", "tourNotes",
  "obsRequity", "reqDate", "reqTime", "reqWho", "reqCount", "reqNotes",
  "archQ", "archQs", "archText", "archA", "archAnsweredAt",
  "media", "mediaWhat", "mediaLink",
  "noteLog", "attachments",
  "updatedBy", "updatedAt"
]);
// Lists a locked device may only grow, never shorten.
const GROW_ONLY = ["materialsList", "archQs"];
// Lists a locked device may only append to; earlier entries must stay exactly as they were.
const APPEND_ONLY = ["noteLog", "attachments"];
// Sections a locked device may turn on but not off.
const NO_UNCHECK = ["obsTour", "obsRequity", "media", "archQ"];

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (col, id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS docs_updated ON docs (updated_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS editors (token TEXT PRIMARY KEY, name TEXT, created_at INTEGER NOT NULL)")
  ]);
  schemaReady = true;
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
const fail = (status, code, message) => json({ error: { code, message } }, status);

async function editorFor(request, db) {
  const h = request.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token || token.length > 200) return null;
  const row = await db.prepare("SELECT name FROM editors WHERE token = ?").bind(token).first();
  return row ? { token, name: row.name || "" } : null;
}

function sameJSON(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// Returns an error message if a locked device is not allowed to make this change, else "".
function lockedProblem(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (!sameJSON(before[k], after[k]) && !LOCKED_KEYS.has(k)) return `Unlock editing to change "${k}".`;
  }
  for (const k of GROW_ONLY) {
    const a = Array.isArray(before[k]) ? before[k].length : 0, b = Array.isArray(after[k]) ? after[k].length : 0;
    if (b < a) return "Lines can't be removed while editing is locked.";
  }
  for (const k of APPEND_ONLY) {
    const a = Array.isArray(before[k]) ? before[k] : [], b = Array.isArray(after[k]) ? after[k] : [];
    if (b.length < a.length || !sameJSON(b.slice(0, a.length), a)) return "Earlier notes and attachments can't be changed while editing is locked.";
  }
  for (const k of NO_UNCHECK) if (before[k] === true && after[k] !== true) return "Sections can't be turned off while editing is locked.";
  return "";
}

async function handleSync(url, db) {
  const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
  const now = Date.now();
  const rows = await db.prepare("SELECT col, id, data, deleted, updated_at FROM docs WHERE updated_at > ? ORDER BY updated_at").bind(since).all();
  const docs = (rows.results || []).map(r => ({ col: r.col, id: r.id, deleted: !!r.deleted, data: r.deleted ? null : JSON.parse(r.data) }));
  return json({ now, docs });
}

async function handleWrite(request, db) {
  let body;
  try { body = await request.json(); } catch (e) { return fail(400, "bad-request", "The request wasn't readable."); }
  const ops = Array.isArray(body && body.ops) ? body.ops : null;
  if (!ops || !ops.length || ops.length > 500) return fail(400, "bad-request", "No changes were sent.");
  const editor = await editorFor(request, db);
  const now = Date.now();
  const stmts = [];
  const current = new Map(); // col/id -> data after earlier ops in this batch
  const load = async (col, id) => {
    const key = col + "/" + id;
    if (current.has(key)) return current.get(key);
    const row = await db.prepare("SELECT data, deleted FROM docs WHERE col = ? AND id = ?").bind(col, id).first();
    const v = row && !row.deleted ? JSON.parse(row.data) : null;
    current.set(key, v);
    return v;
  };
  for (const op of ops) {
    const { op: kind, col, id } = op || {};
    if (!COLLECTIONS.has(col) || !ID_RE.test(id || "") || !["set", "update", "delete"].includes(kind)) return fail(400, "bad-request", "A change pointed at an unknown record.");
    const before = await load(col, id);
    let after = null;
    if (kind === "delete") after = null;
    else {
      if (!op.data || typeof op.data !== "object" || Array.isArray(op.data)) return fail(400, "bad-request", "A change had no data.");
      if (kind === "update" && !before) return fail(404, "not-found", "That record no longer exists.");
      after = kind === "set" ? op.data : { ...before, ...op.data };
    }
    if (!editor) {
      if (col !== "tasks" || kind !== "update" || !before) return fail(403, "permission-denied", "Unlock editing to make this change.");
      const why = lockedProblem(before, after);
      if (why) return fail(403, "permission-denied", why);
    }
    current.set(col + "/" + id, after);
    if (after) {
      const text = JSON.stringify(after);
      if (text.length > MAX_DOC) return fail(413, "too-large", "This record is too large to save.");
      stmts.push(db.prepare("INSERT INTO docs (col, id, data, updated_at, deleted) VALUES (?, ?, ?, ?, 0) ON CONFLICT (col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = 0").bind(col, id, text, now));
    } else {
      stmts.push(db.prepare("UPDATE docs SET deleted = 1, data = '{}', updated_at = ? WHERE col = ? AND id = ?").bind(now, col, id));
    }
  }
  await db.batch(stmts);
  return json({ now });
}

async function handleUnlock(request, env, db) {
  let body;
  try { body = await request.json(); } catch (e) { return fail(400, "bad-request", "The request wasn't readable."); }
  const code = String((body && body.code) || "").trim();
  const name = String((body && body.name) || "").trim().slice(0, 79);
  if (!name) return fail(400, "bad-request", "Enter your name.");
  const expected = String(env.TEAM_PASSCODE || "");
  if (!expected) return fail(500, "not-configured", "The team passcode hasn't been set up yet.");
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(code)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  const ok = new Uint8Array(a).every((x, i) => x === new Uint8Array(b)[i]);
  if (!ok) { await new Promise(r => setTimeout(r, 600)); return fail(403, "permission-denied", "That passcode didn't work."); }
  const token = crypto.randomUUID() + "-" + crypto.randomUUID();
  await db.prepare("INSERT INTO editors (token, name, created_at) VALUES (?, ?, ?)").bind(token, name, Date.now()).run();
  return json({ token, name });
}

const SAFE_INLINE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "application/pdf", "text/plain", "video/mp4", "video/quicktime", "video/webm", "audio/mpeg", "audio/mp4"]);
function safeName(n) { return String(n || "file").replace(/[\r\n"\\]/g, "").slice(0, 150) || "file"; }

async function handleUpload(request, url, env, db) {
  if (!env.FILES) return fail(500, "not-configured", "File storage isn't connected yet.");
  const task = url.searchParams.get("task") || "";
  const name = safeName(url.searchParams.get("name"));
  if (!ID_RE.test(task)) return fail(400, "bad-request", "Pick a job before uploading.");
  const exists = await db.prepare("SELECT 1 FROM docs WHERE col = 'tasks' AND id = ? AND deleted = 0").bind(task).first();
  if (!exists) return fail(404, "not-found", "That job no longer exists.");
  const len = Number(request.headers.get("content-length") || 0);
  if (!len) return fail(400, "bad-request", "The file was empty.");
  if (len > MAX_FILE) return fail(413, "too-large", "Files must be 25 MB or smaller.");
  const type = (request.headers.get("content-type") || "application/octet-stream").slice(0, 120);
  const key = `t/${task}/${crypto.randomUUID()}`;
  await env.FILES.put(key, request.body, { httpMetadata: { contentType: type }, customMetadata: { name } });
  return json({ key, name, size: len, type });
}

async function handleFile(request, key, env, db) {
  if (!env.FILES) return fail(500, "not-configured", "File storage isn't connected yet.");
  if (!/^t\/[A-Za-z0-9_-]{1,100}\/[0-9a-f-]{36}$/.test(key)) return fail(404, "not-found", "File not found.");
  if (request.method === "DELETE") {
    const editor = await editorFor(request, db);
    if (!editor) return fail(403, "permission-denied", "Unlock editing to delete files.");
    await env.FILES.delete(key);
    return json({ ok: true });
  }
  const obj = await env.FILES.get(key);
  if (!obj) return fail(404, "not-found", "File not found.");
  const name = (obj.customMetadata && obj.customMetadata.name) || "file";
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // Only show safe types in the browser; anything else (web pages, SVG, scripts) downloads instead.
  const type = String(headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
  const inline = SAFE_INLINE.has(type);
  if (!inline) headers.set("content-type", "application/octet-stream");
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "private, max-age=86400");
  headers.set("content-disposition", `${inline ? "inline" : "attachment"}; filename="${safeName(name).replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  headers.set("x-content-type-options", "nosniff");
  // Browsers' PDF viewers refuse to open under a sandbox policy, so PDFs skip it; they can't run page scripts anyway.
  if (type !== "application/pdf") headers.set("content-security-policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
  return new Response(obj.body, { headers });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const db = env.DB;
  if (!db) return fail(500, "not-configured", "The database isn't connected yet.");
  try {
    await ensureSchema(db);
    if (path === "sync" && request.method === "GET") return await handleSync(url, db);
    if (path === "write" && request.method === "POST") return await handleWrite(request, db);
    if (path === "me" && request.method === "GET") {
      const ed = await editorFor(request, db);
      return json({ editor: !!ed, name: ed ? ed.name : "" });
    }
    if (path === "unlock" && request.method === "POST") return await handleUnlock(request, env, db);
    if (path === "lock" && request.method === "POST") {
      const ed = await editorFor(request, db);
      if (ed) await db.prepare("DELETE FROM editors WHERE token = ?").bind(ed.token).run();
      return json({ ok: true });
    }
    if (path === "files" && request.method === "POST") return await handleUpload(request, url, env, db);
    if (path.startsWith("files/") && (request.method === "GET" || request.method === "DELETE")) return await handleFile(request, path.slice(6), env, db);
    return fail(404, "not-found", "Unknown address.");
  } catch (e) {
    return fail(500, "server-error", "Something went wrong on the server. Try again.");
  }
}
