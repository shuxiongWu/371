import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { GameError } from './hand.js';

export const STARTING_CHIPS = 10000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export function openDatabase(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      chips INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const actual = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function createUser(db, username, password) {
  const now = Date.now();
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, chips, created_at) VALUES (?, ?, ?, ?)',
  ).run(username, hashPassword(password), STARTING_CHIPS, now);
  return getUserById(db, Number(result.lastInsertRowid));
}

export function getUserByName(db, username) {
  return db.prepare(
    'SELECT id, username, password_hash, chips, created_at FROM users WHERE username = ?',
  ).get(username) ?? null;
}

export function getUserById(db, id) {
  const row = db.prepare(
    'SELECT id, username, chips FROM users WHERE id = ?',
  ).get(id);
  return row ? { id: row.id, username: row.username, chips: row.chips } : null;
}

export function createSession(db, userId) {
  const token = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now());
  return token;
}

export function userForToken(db, token) {
  if (!token) return null;
  const session = db.prepare('SELECT user_id, created_at FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (Date.now() - session.created_at > SESSION_MS) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return getUserById(db, session.user_id);
}

export function deleteSession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function addChips(db, userId, delta) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT chips FROM users WHERE id = ?').get(userId);
    if (!row) throw new Error('用户不存在');
    const next = row.chips + delta;
    if (next < 0) throw new GameError('筹码不足');
    db.prepare('UPDATE users SET chips = ? WHERE id = ?').run(next, userId);
    db.exec('COMMIT');
    return next;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw error;
  }
}

export function accountsFrom(db) {
  return {
    getChips(userId) {
      return getUserById(db, userId)?.chips ?? 0;
    },
    addChips(userId, delta) {
      return addChips(db, userId, delta);
    },
    getUser(userId) {
      return getUserById(db, userId);
    },
  };
}
