/* ============================================
   SQLite Database Layer
   Persistent storage for DOCX conversions
   ============================================ */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'pdf2doc.db');
const STORAGE_DIR = path.join(__dirname, 'storage');

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// --- Init Database ---
const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS conversions (
    id TEXT PRIMARY KEY,
    originalName TEXT NOT NULL,
    rawDocxPath TEXT NOT NULL,
    fileSize INTEGER DEFAULT 0,
    createdAt TEXT DEFAULT (datetime('now')),
    lastProcessedAt TEXT,
    lastMargins TEXT,
    lastGeminiModel TEXT
  )
`);

// --- CRUD Operations ---

function saveConversion(id, originalName, rawDocxBuffer) {
  const filePath = path.join(STORAGE_DIR, `${id}.docx`);
  fs.writeFileSync(filePath, rawDocxBuffer);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO conversions (id, originalName, rawDocxPath, fileSize, createdAt)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  stmt.run(id, originalName, filePath, rawDocxBuffer.length);

  return filePath;
}

function getConversion(id) {
  return db.prepare('SELECT * FROM conversions WHERE id = ?').get(id);
}

function listConversions(limit = 20) {
  return db.prepare('SELECT id, originalName, fileSize, createdAt, lastProcessedAt, lastMargins, lastGeminiModel FROM conversions ORDER BY createdAt DESC LIMIT ?').all(limit);
}

function updateProcessedInfo(id, margins, geminiModel) {
  db.prepare(`
    UPDATE conversions SET lastProcessedAt = datetime('now'), lastMargins = ?, lastGeminiModel = ?
    WHERE id = ?
  `).run(margins ? JSON.stringify(margins) : null, geminiModel || null, id);
}

function deleteConversion(id) {
  const conv = getConversion(id);
  if (conv && conv.rawDocxPath && fs.existsSync(conv.rawDocxPath)) {
    fs.unlinkSync(conv.rawDocxPath);
  }
  db.prepare('DELETE FROM conversions WHERE id = ?').run(id);
}

function getRawDocxBuffer(id) {
  const conv = getConversion(id);
  if (!conv || !conv.rawDocxPath || !fs.existsSync(conv.rawDocxPath)) {
    return null;
  }
  return fs.readFileSync(conv.rawDocxPath);
}

// --- Cleanup old conversions (> 7 days) ---
function cleanupOldConversions() {
  const old = db.prepare("SELECT id, rawDocxPath FROM conversions WHERE createdAt < datetime('now', '-7 days')").all();
  for (const conv of old) {
    if (conv.rawDocxPath && fs.existsSync(conv.rawDocxPath)) {
      try { fs.unlinkSync(conv.rawDocxPath); } catch {}
    }
  }
  db.prepare("DELETE FROM conversions WHERE createdAt < datetime('now', '-7 days')").run();
  return old.length;
}

module.exports = {
  saveConversion,
  getConversion,
  listConversions,
  updateProcessedInfo,
  deleteConversion,
  getRawDocxBuffer,
  cleanupOldConversions,
  STORAGE_DIR,
};
