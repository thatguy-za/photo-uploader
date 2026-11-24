import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fstatic from '@fastify/static';
import sharp from 'sharp';
import exifReader from 'exif-reader';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import {
  httpErr, sha256, randomToken, hashPassword, verifyPassword,
  resolveRel, sanitizeName, validFolderName,
} from './util.js';

const DATA = path.resolve(process.env.DATA_DIR || '/data');
const APPDATA = path.resolve(process.env.APPDATA_DIR || '/appdata'); // database + thumbnail cache
const THUMBS = path.join(APPDATA, 'thumbs');
const run = promisify(execFile);
const PORT = Number(process.env.PORT || 8080);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_FILE = 50 * 1024 ** 3; // 50 GB per file, effectively unlimited

const db = openDb(APPDATA);
await fs.mkdir(DATA, { recursive: true });
await fs.mkdir(THUMBS, { recursive: true });
sharp.cache(false);
sharp.concurrency(1);

const app = Fastify({ trustProxy: true, bodyLimit: 1024 * 1024, logger: { level: 'warn' } });
await app.register(cookie);
await app.register(multipart, { limits: { fileSize: MAX_FILE, files: 1000, fields: 20 } });
// Any other content type (image/heic, application/octet-stream, ...) is handed to the route as a raw stream.
app.addContentTypeParser('*', (req, payload, done) => done(null, payload));

// ---------- auth helpers ----------
function getUser(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    return db.prepare('SELECT * FROM users WHERE token_hash = ?').get(sha256(h.slice(7).trim())) ?? null;
  }
  const sid = req.cookies.sid;
  if (!sid) return null;
  return db.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires > ?'
  ).get(sha256(sid), Date.now()) ?? null;
}
function requireUser(req) {
  const u = getUser(req);
  if (!u) throw httpErr(401, 'Not signed in');
  return u;
}
function requireAdmin(req) {
  const u = requireUser(req);
  if (!u.is_admin) throw httpErr(403, 'Admin only');
  return u;
}
// 'upload' | 'read' | null  (upload implies read)
function access(user, folder) {
  if (user.is_admin) return 'upload';
  return db.prepare('SELECT level FROM perms WHERE user_id = ? AND folder = ?').get(user.id, folder)?.level ?? null;
}
const str = (v, max = 200) => (typeof v === 'string' && v.length <= max ? v : '');

async function subdirs(abs) {
  try {
    const ents = await fs.readdir(abs, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

// ---------- login throttle ----------
const fails = new Map();
function throttled(key) {
  const f = fails.get(key);
  return f && f.until > Date.now() && f.n >= 10;
}
function noteFail(key) {
  const f = fails.get(key);
  const n = f && f.until > Date.now() ? f.n + 1 : 1;
  fails.set(key, { n, until: Date.now() + 15 * 60 * 1000 });
}

// ---------- session / account ----------
app.get('/healthz', async () => ({ ok: true }));

// First run: with no users yet, the first person to register becomes the admin (owner).
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

function startSession(reply, userId) {
  const sid = randomToken();
  db.prepare('INSERT INTO sessions (id, user_id, expires) VALUES (?, ?, ?)').run(sha256(sid), userId, Date.now() + SESSION_MS);
  reply.setCookie('sid', sid, { httpOnly: true, sameSite: 'strict', secure: 'auto', path: '/', maxAge: SESSION_MS / 1000 });
}

app.get('/api/setup-status', async () => ({ needsSetup: userCount() === 0 }));

app.post('/api/setup', async (req, reply) => {
  const username = str(req.body?.username, 50).trim();
  const password = str(req.body?.password, 500);
  if (!/^[\w.@-]{2,50}$/.test(username)) throw httpErr(400, 'Username: 2-50 letters, digits, . _ - @');
  if (password.length < 8) throw httpErr(400, 'Password must be at least 8 characters');
  // Single atomic statement: only succeeds while the users table is empty, so two racing
  // visitors can't both become admin.
  const res = db.prepare('INSERT INTO users (username, pass, is_admin, created) SELECT ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM users)')
    .run(username, await hashPassword(password), Date.now());
  if (!res.changes) throw httpErr(409, 'Setup is already complete');
  startSession(reply, Number(res.lastInsertRowid));
  return { ok: true };
});

app.post('/api/login', async (req, reply) => {
  const username = str(req.body?.username, 100);
  const password = str(req.body?.password, 500);
  const key = `${req.ip}|${username.toLowerCase()}`;
  if (throttled(key)) throw httpErr(429, 'Too many attempts, try again later');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !(await verifyPassword(password, user.pass))) {
    noteFail(key);
    throw httpErr(401, 'Wrong username or password');
  }
  fails.delete(key);
  startSession(reply, user.id);
  return { ok: true };
});

app.post('/api/logout', async (req, reply) => {
  if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(req.cookies.sid));
  reply.clearCookie('sid', { path: '/' });
  return { ok: true };
});

app.get('/api/me', async (req) => {
  const u = requireUser(req);
  return { username: u.username, isAdmin: !!u.is_admin, hasToken: !!u.token_hash };
});

app.post('/api/password', async (req) => {
  const u = requireUser(req);
  const cur = str(req.body?.current, 500), next = str(req.body?.next, 500);
  if (next.length < 8) throw httpErr(400, 'New password must be at least 8 characters');
  if (!(await verifyPassword(cur, u.pass))) throw httpErr(403, 'Current password is wrong');
  db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPassword(next), u.id);
  return { ok: true };
});

// Per-user API token (for the iOS Shortcut / scripts). Shown once, stored hashed.
app.post('/api/token', async (req) => {
  const u = requireUser(req);
  const token = 'pu_' + randomToken(24);
  db.prepare('UPDATE users SET token_hash = ? WHERE id = ?').run(sha256(token), u.id);
  return { token };
});
app.delete('/api/token', async (req) => {
  const u = requireUser(req);
  db.prepare('UPDATE users SET token_hash = NULL WHERE id = ?').run(u.id);
  return { ok: true };
});

// ---------- folders / browsing ----------
async function accessibleFolders(user) {
  const names = await subdirs(DATA);
  return names.map((name) => ({ name, level: access(user, name) })).filter((f) => f.level);
}

app.get('/api/folders', async (req) => {
  const u = requireUser(req);
  const folders = await accessibleFolders(u);
  return Promise.all(folders.map(async (f) => ({ ...f, dirs: await subdirs(path.join(DATA, f.name)) })));
});

// Flat list of writable targets ("Family", "Family/Holiday"): handy for Shortcuts' "Choose from List".
app.get('/api/targets', async (req) => {
  const u = requireUser(req);
  const out = [];
  for (const f of await accessibleFolders(u)) {
    if (f.level !== 'upload') continue;
    out.push(f.name);
    for (const d of await subdirs(path.join(DATA, f.name))) out.push(`${f.name}/${d}`);
  }
  return out;
});

app.get('/api/list', async (req) => {
  const u = requireUser(req);
  const p = resolveRel(DATA, req.query.path);
  if (!p.segs.length) {
    const dirs = (await accessibleFolders(u)).map((f) => f.name);
    return { path: '', dirs, info: await dirInfos(dirs, ''), files: [] };
  }
  if (!access(u, p.segs[0])) throw httpErr(403, 'No access to that folder');
  let ents;
  try { ents = await fs.readdir(p.abs, { withFileTypes: true }); } catch { throw httpErr(404, 'Not found'); }
  const dirs = ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b));
  const files = [];
  for (const e of ents) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    const st = await fs.stat(path.join(p.abs, e.name));
    files.push({ name: e.name, size: st.size, mtime: st.mtimeMs, k: kindOf(e.name) });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return { path: p.segs.join('/'), dirs, info: await dirInfos(dirs, p.segs.join('/')), files: files.slice(0, 5000) };
});

// Authenticated, permission-checked file serving (range requests, caching headers via @fastify/static).
await app.register(async (f) => {
  f.addHook('onRequest', async (req) => {
    const u = requireUser(req);
    let rel;
    try { rel = decodeURIComponent(req.url.split('?')[0].replace(/^\/files\/?/, '')); } catch { throw httpErr(400, 'Bad path'); }
    const p = resolveRel(DATA, rel);
    if (!p.segs.length || !access(u, p.segs[0])) throw httpErr(403, 'No access');
  });
  f.register(fstatic, {
    root: DATA, prefix: '/files/', dotfiles: 'deny', index: false, list: false,
    decorateReply: false, cacheControl: false,
  });
});

// Cache policy: user files are private + cacheable; API and app shell are revalidated.
app.addHook('onSend', async (req, reply) => {
  if (req.url.split('?')[0].endsWith('.shortcut')) reply.header('content-type', 'application/vnd.apple.shortcut');
  if (!reply.hasHeader('cache-control')) {
    reply.header('cache-control', req.url.startsWith('/files/') && reply.statusCode < 300 ? 'private, max-age=3600' : 'no-cache');
  }
});

// ---------- media helpers ----------
const IMG = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);
const HEIC = new Set(['.heic', '.heif']);
const VID = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.3gp']);
// i = image, h = heic (pre-existing files only; uploads are converted), v = video, o = other
const kindOf = (name) => {
  const e = path.extname(name).toLowerCase();
  return IMG.has(e) ? 'i' : HEIC.has(e) ? 'h' : VID.has(e) ? 'v' : 'o';
};

function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, res, rej } = queue.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
}
const heavy = limiter(2); // caps concurrent image work so a Raspberry Pi isn't swamped

const exists = (f) => fs.access(f).then(() => true, () => false);

// heif-convert (libheif-tools) -> JPEG at `dest`. Applies rotation and keeps EXIF.
async function heifToJpeg(src, dest) {
  await run('heif-convert', ['-q', '92', src, dest], { timeout: 120000 });
  if (await exists(dest)) return;
  // Multi-image HEIC files are written as name-1.jpg, name-2.jpg ...
  const alt = dest.replace(/\.jpg$/, '-1.jpg');
  if (await exists(alt)) { await fs.rename(alt, dest); return; }
  throw new Error('heif-convert produced no output');
}

async function reserveName(dir, name) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${ext}`;
    try { (await fs.open(path.join(dir, candidate), 'wx', 0o666)).close(); return candidate; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw httpErr(500, 'Could not find a free filename');
}

// Replace an uploaded HEIC with a JPEG next to it. Throws if conversion fails (caller keeps the HEIC).
async function convertHeic(dir, name) {
  const src = path.join(dir, name);
  const tmp = path.join(dir, `.${randomToken(6)}.jpg`);
  try {
    await heavy(() => heifToJpeg(src, tmp));
    const jpgName = await reserveName(dir, name.replace(/\.[^.]+$/, '') + '.jpg');
    await fs.rename(tmp, path.join(dir, jpgName));
    await fs.unlink(src);
    return { name: jpgName, size: (await fs.stat(path.join(dir, jpgName))).size, converted: true };
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

// Give the file its "date taken": EXIF if present, else the phone's lastModified, else leave as upload time.
async function stampDate(file, clientMs) {
  let when = null;
  try {
    if (/\.jpe?g$/i.test(file)) {
      const { exif } = await sharp(file).metadata();
      if (exif) {
        const x = exifReader(exif);
        const d = x?.Photo?.DateTimeOriginal ?? x?.Image?.DateTime;
        if (d instanceof Date && !isNaN(d) && d.getFullYear() > 1990) when = d;
      }
    }
  } catch { /* unreadable EXIF: fall through */ }
  if (!when && clientMs > 0 && clientMs <= Date.now() + 86400000) when = new Date(clientMs);
  if (when) await fs.utimes(file, when, when).catch(() => {});
}

async function makeThumb(src, kind, size, dest) {
  const tmpJpg = kind === 'h' ? `${dest}.src.jpg` : null;
  const tmpOut = `${dest}.${randomToken(4)}.tmp`;
  try {
    if (tmpJpg) await heifToJpeg(src, tmpJpg);
    const square = size <= 400;
    await sharp(tmpJpg || src, { failOn: 'none', limitInputPixels: 400e6 })
      .rotate()
      .resize(size, size, { fit: square ? 'cover' : 'inside', withoutEnlargement: !square })
      .webp({ quality: square ? 72 : 82 })
      .toFile(tmpOut);
    await fs.rename(tmpOut, dest);
  } finally {
    if (tmpJpg) await fs.unlink(tmpJpg).catch(() => {});
    await fs.unlink(tmpOut).catch(() => {});
  }
}

// Cached thumbnails live in APPDATA/thumbs, keyed by path+mtime+size so edits invalidate them.
app.get('/api/thumb', async (req, reply) => {
  const u = requireUser(req);
  const p = resolveRel(DATA, req.query.path);
  if (p.segs.length < 2 || !access(u, p.segs[0])) throw httpErr(403, 'No access');
  const st = await fs.stat(p.abs).catch(() => null);
  if (!st?.isFile()) throw httpErr(404, 'Not found');
  const kind = kindOf(p.segs.at(-1));
  if (kind !== 'i' && kind !== 'h') throw httpErr(415, 'No thumbnail for this file type');
  const size = req.query.size === 'l' ? 1600 : 360;
  const key = sha256(`${p.segs.join('/')}|${st.mtimeMs}|${st.size}|${size}`).slice(0, 40);
  const dir = path.join(THUMBS, key.slice(0, 2));
  const file = path.join(dir, `${key}.webp`);
  if (!(await exists(file))) {
    await fs.mkdir(dir, { recursive: true });
    await heavy(async () => { if (!(await exists(file))) await makeThumb(p.abs, kind, size, file); })
      .catch((e) => { req.log.warn(e); throw httpErr(422, 'Could not read this image'); });
  }
  reply.header('cache-control', 'private, max-age=31536000, immutable');
  reply.type('image/webp');
  return reply.send(createReadStream(file));
});

// Everything under a folder (or under every folder the user can see), flat, newest first.
async function walk(abs, rel, out, depth = 0) {
  let ents;
  try { ents = await fs.readdir(abs, { withFileTypes: true }); } catch { return; }
  await Promise.all(ents.map(async (e) => {
    if (e.name.startsWith('.')) return;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (depth < 6) await walk(path.join(abs, e.name), r, out, depth + 1); return; }
    if (!e.isFile()) return;
    const st = await fs.stat(path.join(abs, e.name)).catch(() => null);
    if (st) out.push({ p: r, t: Math.round(st.mtimeMs), s: st.size, k: kindOf(e.name) });
  }));
}

// Album cover = newest image anywhere inside the folder; count = photos + videos. Cached briefly.
const infoCache = new Map();
async function dirInfo(rel) {
  const hit = infoCache.get(rel);
  if (hit && hit.exp > Date.now()) return hit.v;
  const items = [];
  await walk(path.join(DATA, rel), rel, items);
  const v = {
    cover: items.filter((x) => x.k === 'i' || x.k === 'h').sort((a, b) => b.t - a.t)[0]?.p ?? null,
    count: items.filter((x) => x.k !== 'o').length,
  };
  infoCache.set(rel, { v, exp: Date.now() + 60000 });
  return v;
}
async function dirInfos(names, parent) {
  const out = {};
  await Promise.all(names.map(async (n) => { out[n] = await dirInfo(parent ? `${parent}/${n}` : n); }));
  return out;
}

app.get('/api/timeline', async (req) => {
  const u = requireUser(req);
  const p = resolveRel(DATA, req.query.path);
  const items = [];
  if (!p.segs.length) {
    for (const f of await accessibleFolders(u)) await walk(path.join(DATA, f.name), f.name, items);
  } else {
    if (!access(u, p.segs[0])) throw httpErr(403, 'No access to that folder');
    await walk(p.abs, p.segs.join('/'), items);
  }
  items.sort((a, b) => b.t - a.t);
  return { items: items.slice(0, 100000) };
});

// ---------- upload ----------
async function writeUnique(dir, name, stream) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${ext}`;
    let fh;
    try { fh = await fs.open(path.join(dir, candidate), 'wx', 0o666); }
    catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    try {
      await pipeline(stream, fh.createWriteStream());
    } catch (e) {
      await fs.unlink(path.join(dir, candidate)).catch(() => {});
      throw e;
    }
    const st = await fs.stat(path.join(dir, candidate));
    return { name: candidate, size: st.size };
  }
  throw httpErr(500, 'Could not find a free filename');
}

app.post('/api/upload', async (req) => {
  const u = requireUser(req);
  const p = resolveRel(DATA, req.query.folder);
  if (p.segs.length < 1) throw httpErr(400, 'Choose a folder to upload to');
  if (p.segs.length > 3) throw httpErr(400, 'Folder is nested too deeply');
  if (access(u, p.segs[0]) !== 'upload') throw httpErr(403, 'You do not have upload permission for that folder');
  // The top-level folder must already exist (only the admin / the mount creates those).
  const top = await fs.stat(path.join(DATA, p.segs[0])).catch(() => null);
  if (!top?.isDirectory()) throw httpErr(404, 'Folder not found');
  await fs.mkdir(p.abs, { recursive: true });
  const saved = [];
  const clientMs = Number(req.query.mtime) || 0;
  const store = async (stream, filename) => {
    let out = await writeUnique(p.abs, sanitizeName(filename), stream);
    if (kindOf(out.name) === 'h') {
      try { out = await convertHeic(p.abs, out.name); }
      catch (e) { req.log.warn(e); out.warning = 'HEIC could not be converted; original kept'; }
    }
    await stampDate(path.join(p.abs, out.name), clientMs);
    saved.push(out);
  };
  if (req.isMultipart()) {
    // One or many files in a single request, any field name.
    for await (const part of req.files()) await store(part.file, part.filename);
  } else {
    // Raw body = one file; name via ?name= or X-Filename. Easiest for iOS Shortcuts ("Request Body: File").
    const name = str(req.query.name, 255) || str(req.headers['x-filename'], 255);
    if (!name) throw httpErr(400, 'Add ?name=<filename> when sending a raw file body');
    await store(req.body, name);
  }
  if (!saved.length) throw httpErr(400, 'No files received');
  infoCache.clear(); // album covers/counts may have changed
  return { saved };
});

// ---------- admin ----------
function userRows() {
  const users = db.prepare('SELECT id, username, is_admin, token_hash IS NOT NULL AS has_token FROM users ORDER BY is_admin DESC, username').all();
  const perms = db.prepare('SELECT user_id, folder, level FROM perms').all();
  return users.map((u) => ({
    id: u.id, username: u.username, isAdmin: !!u.is_admin, hasToken: !!u.has_token,
    perms: Object.fromEntries(perms.filter((p) => p.user_id === u.id).map((p) => [p.folder, p.level])),
  }));
}
function targetUser(id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!u) throw httpErr(404, 'No such user');
  return u;
}

app.get('/api/admin/users', async (req) => { requireAdmin(req); return userRows(); });

app.post('/api/admin/users', async (req) => {
  requireAdmin(req);
  const username = str(req.body?.username, 50).trim();
  const password = str(req.body?.password, 500);
  if (!/^[\w.@-]{2,50}$/.test(username)) throw httpErr(400, 'Username: 2-50 letters, digits, . _ - @');
  if (password.length < 8) throw httpErr(400, 'Password must be at least 8 characters');
  const type = req.body?.type === 'admin' ? 'admin' : 'standard';
  try {
    db.prepare('INSERT INTO users (username, pass, is_admin, created) VALUES (?, ?, ?, ?)')
      .run(username, await hashPassword(password), type === 'admin' ? 1 : 0, Date.now());
  } catch { throw httpErr(409, 'That username already exists'); }
  return { ok: true };
});

// The first user is the owner: it can never be demoted or deleted, so there is always an admin.
const firstUserId = () => db.prepare('SELECT MIN(id) AS id FROM users').get().id;

// Reset a password and/or change the user type (admin | standard).
app.patch('/api/admin/users/:id', async (req) => {
  const actor = requireAdmin(req);
  const u = targetUser(req.params.id);
  const { password, type } = req.body ?? {};
  const hasPw = typeof password === 'string', hasType = type !== undefined;
  if (!hasPw && !hasType) throw httpErr(400, 'Nothing to change');
  if (hasPw) {
    if (password.length < 8 || password.length > 500) throw httpErr(400, 'Password must be at least 8 characters');
    db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPassword(password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  }
  if (hasType) {
    if (type !== 'admin' && type !== 'standard') throw httpErr(400, 'Type must be admin or standard');
    if (u.id === firstUserId() || u.id === actor.id) throw httpErr(400, "You can't change the type of the owner or of yourself");
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(type === 'admin' ? 1 : 0, u.id);
  }
  return { ok: true };
});

app.delete('/api/admin/users/:id', async (req) => {
  const actor = requireAdmin(req);
  const u = targetUser(req.params.id);
  if (u.id === firstUserId()) throw httpErr(400, 'The first admin (owner) cannot be deleted');
  if (u.id === actor.id) throw httpErr(400, "You can't delete yourself");
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id); // cascades to sessions + perms
  return { ok: true };
});

app.put('/api/admin/users/:id/perms', async (req) => {
  requireAdmin(req);
  const u = targetUser(req.params.id);
  if (u.is_admin) throw httpErr(400, 'The admin already has full access');
  const perms = req.body?.perms && typeof req.body.perms === 'object' ? req.body.perms : {};
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM perms WHERE user_id = ?').run(u.id);
    const ins = db.prepare('INSERT INTO perms (user_id, folder, level) VALUES (?, ?, ?)');
    for (const [folder, level] of Object.entries(perms)) {
      if (!validFolderName(folder) || !['read', 'upload'].includes(level)) continue;
      ins.run(u.id, folder, level);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true };
});

app.get('/api/admin/folders', async (req) => { requireAdmin(req); return subdirs(DATA); });

app.post('/api/admin/folders', async (req) => {
  requireAdmin(req);
  const name = str(req.body?.name, 100).trim();
  if (!validFolderName(name)) throw httpErr(400, 'Invalid folder name');
  await fs.mkdir(path.join(DATA, name), { recursive: true });
  return { ok: true };
});

// ---------- static PWA ----------
await app.register(fstatic, { root: PUBLIC, cacheControl: false, index: false });
app.get('/', (req, reply) => reply.sendFile('index.html'));

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/files/')) return reply.code(404).send({ message: 'Not found' });
  return reply.sendFile('index.html');
});

app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode && err.statusCode < 600 ? err.statusCode : 500;
  if (status >= 500) req.log.error(err);
  reply.code(status).send({ message: status >= 500 ? 'Server error' : err.message });
});

await app.listen({ host: '0.0.0.0', port: PORT });
console.log(`Photo Uploader listening on :${PORT}  data=${DATA} appdata=${APPDATA}`);
