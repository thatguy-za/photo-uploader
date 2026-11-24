import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const httpErr = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return `s1$${salt.toString('base64')}$${h.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const [v, s, h] = String(stored).split('$');
  if (v !== 's1' || !s || !h) return false;
  const expected = Buffer.from(h, 'base64');
  const got = await scrypt(pw, Buffer.from(s, 'base64'), expected.length);
  return crypto.timingSafeEqual(got, expected);
}

// Turn a user-supplied relative path into segments + absolute path under root.
// Rejects traversal, hidden (dot) segments, backslashes and NULs.
export function resolveRel(root, rel) {
  const segs = String(rel ?? '').split('/').filter(Boolean);
  for (const s of segs) {
    if (s.startsWith('.') || /[\\\0]/.test(s) || s.length > 200) throw httpErr(400, 'Invalid path');
  }
  return { segs, abs: path.join(root, ...segs) };
}

export function sanitizeName(name) {
  let n = path.basename(String(name || '').replace(/\\/g, '/'));
  n = n.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  if (n.length > 200) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n || 'upload';
}

export function validFolderName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 100 &&
    !name.startsWith('.') && !/[\/\\\0<>:"|?*\x00-\x1f]/.test(name);
}
