// SQLite storage for local chats, messages, models, and small settings.
// All SQL values use bound parameters; schema statements are static.
// Writes are coalesced briefly and the database is flushed on shutdown.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import initSqlJs from 'sql.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || './data/chats.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const SQL = await initSqlJs({
  locateFile: (file) => path.join(moduleDir, 'node_modules', 'sql.js', 'dist', file),
});
const database = fs.existsSync(dbPath)
  ? new SQL.Database(fs.readFileSync(dbPath))
  : new SQL.Database();

database.run('PRAGMA foreign_keys = ON');
database.run(`
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    model TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_contexts (
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    through_message_id INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS models (
    name TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE INDEX IF NOT EXISTS messages_chat_id_id ON messages(chat_id, id);
`);

const seedModel = database.prepare('INSERT OR IGNORE INTO models(name, created_at) VALUES (?, ?)');
for (const name of ['qwen3-coder-next-sd-dev', 'qwen3-coder-next-awq']) {
  seedModel.run([name, Date.now()]);
}
seedModel.free();

let persistTimer;
let persistQueue = Promise.resolve();

function queryAll(sql, parameters = []) {
  const statement = database.prepare(sql);
  statement.bind(parameters);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function queryOne(sql, parameters = []) {
  return queryAll(sql, parameters)[0] || null;
}

function persist() {
  const bytes = Buffer.from(database.export());
  const temporaryPath = `${dbPath}.tmp`;
  persistQueue = persistQueue.then(async () => {
    await fs.promises.writeFile(temporaryPath, bytes);
    await fs.promises.rename(temporaryPath, dbPath);
  });
  persistQueue.catch((error) => console.error(`Could not persist chat database: ${error.message}`));
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 300);
  persistTimer.unref?.();
}

export function flushDatabaseSync() {
  clearTimeout(persistTimer);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(`${dbPath}.tmp`, Buffer.from(database.export()));
  fs.renameSync(`${dbPath}.tmp`, dbPath);
}

export function getDatabasePath() {
  return dbPath;
}

// ---- Chats and messages ----
export function listChats() {
  return queryAll('SELECT id, title, model, created_at, updated_at FROM chats ORDER BY updated_at DESC');
}

export function createChat(model = null) {
  const now = Date.now();
  const chat = { id: randomUUID(), title: 'New chat', model, created_at: now, updated_at: now };
  database.run('INSERT INTO chats(id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [chat.id, chat.title, chat.model, chat.created_at, chat.updated_at]);
  schedulePersist();
  return chat;
}

export function renameChat(id, title) {
  database.run('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?', [title, Date.now(), id]);
  schedulePersist();
  return queryOne('SELECT id, title, model, created_at, updated_at FROM chats WHERE id = ?', [id]);
}

export function deleteChat(id) {
  database.run('DELETE FROM chats WHERE id = ?', [id]);
  schedulePersist();
}

export function touchChat(id, model) {
  database.run('UPDATE chats SET model = ?, updated_at = ? WHERE id = ?', [model, Date.now(), id]);
  schedulePersist();
}

export function getMessages(chatId) {
  return queryAll(`SELECT id, chat_id, role, content, model, prompt_tokens, completion_tokens, created_at
    FROM messages WHERE chat_id = ? ORDER BY id`, [chatId]);
}

export function getChatContext(chatId) {
  return queryOne(`SELECT summary, through_message_id, updated_at
    FROM chat_contexts WHERE chat_id = ?`, [chatId]);
}

export function saveChatContext(chatId, summary, throughMessageId) {
  const updatedAt = Date.now();
  database.run(`INSERT INTO chat_contexts(chat_id, summary, through_message_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET summary = excluded.summary,
      through_message_id = excluded.through_message_id, updated_at = excluded.updated_at`,
  [chatId, summary, throughMessageId, updatedAt]);
  schedulePersist();
  return { summary, through_message_id: throughMessageId, updated_at: updatedAt };
}

export function addMessage(chatId, role, content, model, promptTokens = null, completionTokens = null) {
  const createdAt = Date.now();
  database.run(`INSERT INTO messages(chat_id, role, content, model, prompt_tokens, completion_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [chatId, role, content, model, promptTokens, completionTokens, createdAt]);
  schedulePersist();
  return queryOne(`SELECT id, chat_id, role, content, model, prompt_tokens, completion_tokens, created_at
    FROM messages WHERE id = last_insert_rowid()`);
}

// ---- Saved models and settings ----
export function listModels() {
  return queryAll('SELECT name FROM models ORDER BY name').map((row) => row.name);
}

export function saveModel(name) {
  database.run('INSERT OR IGNORE INTO models(name, created_at) VALUES (?, ?)', [name, Date.now()]);
  schedulePersist();
  return name;
}

export function getSetting(key) {
  return queryOne('SELECT value FROM settings WHERE key = ?', [key])?.value ?? null;
}

export function setSetting(key, value) {
  database.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]);
  schedulePersist();
}