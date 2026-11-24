import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(appdataDir) {
  fs.mkdirSync(appdataDir, { recursive: true });
  const db = new DatabaseSync(path.join(appdataDir, 'photo-uploader.db'));
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      token_hash TEXT UNIQUE,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS perms (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('read','upload')),
      PRIMARY KEY (user_id, folder)
    );
    DELETE FROM sessions WHERE expires < ${Date.now()};
  `);
  return db;
}
