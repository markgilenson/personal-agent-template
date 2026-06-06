const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'mark-agent.db');

// Ensure the directory exists (Railway volume may not be mounted yet)
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    role      TEXT NOT NULL,
    content   TEXT NOT NULL,
    ts        INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS memory (
    key       TEXT PRIMARY KEY,
    value     TEXT NOT NULL,
    updated   INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS pending_actions (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created     INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    jid        TEXT NOT NULL,
    sender     TEXT,
    text       TEXT NOT NULL,
    is_group   INTEGER NOT NULL DEFAULT 0,
    group_name TEXT,
    ts         INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_wa_ts  ON whatsapp_messages(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_wa_jid ON whatsapp_messages(jid);

  CREATE TABLE IF NOT EXISTS doc_cache (
    key      TEXT PRIMARY KEY,
    name     TEXT,
    content  TEXT NOT NULL,
    ts       INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// ── Conversation history ───────────────────────────────────────────────────────

/** Return the last N messages as Anthropic-format {role, content} objects. */
function getHistory(limit = 40) {
  return db
    .prepare('SELECT role, content FROM messages ORDER BY id DESC LIMIT ?')
    .all(limit)
    .reverse()
    .map(r => ({ role: r.role, content: r.content }));
}

function addMessage(role, content) {
  // Permanent archive — never deleted. The agent reads a recent window via
  // getHistory() and reaches anything older through searchMessages().
  db.prepare('INSERT INTO messages (role, content) VALUES (?, ?)').run(role, content);
}

function getMessageCount() {
  return db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
}

/**
 * Search the full conversation archive. Splits the query into terms and
 * requires all of them to appear (case-insensitive substring match), so
 * "ruti contract" finds messages mentioning both. Returns most-recent-first.
 */
function searchMessages(query, limit = 20) {
  const terms = String(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const where = terms.map(() => 'content LIKE ?').join(' AND ');
  const params = terms.map(t => `%${t}%`);
  return db
    .prepare(`SELECT role, content, ts FROM messages WHERE ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit)
    .map(r => ({ role: r.role, content: r.content, ts: r.ts }));
}

// ── Key-value memory ───────────────────────────────────────────────────────────

function remember(key, value) {
  db.prepare('INSERT OR REPLACE INTO memory (key, value, updated) VALUES (?, ?, unixepoch())').run(key, String(value));
}

function recall(key) {
  const row = db.prepare('SELECT value FROM memory WHERE key = ?').get(key);
  return row ? row.value : null;
}

function recallAll() {
  return db.prepare('SELECT key, value FROM memory ORDER BY key').all();
}

function forget(key) {
  db.prepare('DELETE FROM memory WHERE key = ?').run(key);
}

function forgetByPrefix(prefix) {
  db.prepare("DELETE FROM memory WHERE key LIKE ?").run(`${prefix}%`);
}

// ── Pending approval actions ───────────────────────────────────────────────────

function storePending(id, type, payload) {
  db.prepare('INSERT OR REPLACE INTO pending_actions (id, type, payload) VALUES (?, ?, ?)').run(id, type, JSON.stringify(payload));
}

function getPending(id) {
  const row = db.prepare('SELECT type, payload FROM pending_actions WHERE id = ?').get(id);
  if (!row) return null;
  return { type: row.type, payload: JSON.parse(row.payload) };
}

function popPending(id) {
  const row = db.prepare('SELECT type, payload FROM pending_actions WHERE id = ?').get(id);
  if (!row) return null;
  db.prepare('DELETE FROM pending_actions WHERE id = ?').run(id);
  return { type: row.type, payload: JSON.parse(row.payload) };
}

// ── WhatsApp messages ─────────────────────────────────────────────────────────

function storeWhatsAppMessage(jid, sender, text, isGroup = 0, groupName = null) {
  db.prepare(
    'INSERT INTO whatsapp_messages (jid, sender, text, is_group, group_name) VALUES (?, ?, ?, ?, ?)'
  ).run(jid, sender || null, text, isGroup, groupName || null);
}

function getWhatsAppMessages({ jid, limit = 50 } = {}) {
  const fmtDate = ts => new Date(ts * 1000).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  const rows = jid
    ? db.prepare('SELECT * FROM whatsapp_messages WHERE jid = ? ORDER BY ts DESC LIMIT ?').all(jid, limit)
    : db.prepare('SELECT * FROM whatsapp_messages ORDER BY ts DESC LIMIT ?').all(limit);
  return rows.map(r => ({
    from: r.sender || r.jid.replace('@s.whatsapp.net', '').replace('@g.us', ''),
    group: r.group_name || null,
    text: r.text,
    date: fmtDate(r.ts),
  }));
}

function searchWhatsAppMessages(query, limit = 30) {
  const terms = String(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const where = terms.map(() => 'text LIKE ?').join(' AND ');
  const params = terms.map(t => `%${t}%`);
  const fmtDate = ts => new Date(ts * 1000).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  return db
    .prepare(`SELECT * FROM whatsapp_messages WHERE ${where} ORDER BY ts DESC LIMIT ?`)
    .all(...params, limit)
    .map(r => ({
      from: r.sender || r.jid.replace('@s.whatsapp.net', '').replace('@g.us', ''),
      group: r.group_name || null,
      text: r.text,
      date: fmtDate(r.ts),
    }));
}

// ── Working memory: documents read this session ───────────────────────────────
// When the agent reads a Drive file or email thread, we cache it so follow-up
// questions reuse it instead of re-searching and re-reading.

function cacheDoc(key, name, content) {
  db.prepare('INSERT OR REPLACE INTO doc_cache (key, name, content, ts) VALUES (?, ?, ?, unixepoch())')
    .run(key, name || null, String(content).slice(0, 8000));
  // Keep only the 12 most recent cached docs
  db.prepare('DELETE FROM doc_cache WHERE key NOT IN (SELECT key FROM doc_cache ORDER BY ts DESC LIMIT 12)').run();
}

function getRecentDocs({ maxAgeMin = 30, limit = 3 } = {}) {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeMin * 60;
  return db.prepare('SELECT key, name, content, ts FROM doc_cache WHERE ts >= ? ORDER BY ts DESC LIMIT ?')
    .all(cutoff, limit);
}

module.exports = { getHistory, addMessage, searchMessages, remember, recall, recallAll, forget, forgetByPrefix, storePending, getPending, popPending, getMessageCount, storeWhatsAppMessage, getWhatsAppMessages, searchWhatsAppMessages, cacheDoc, getRecentDocs };
