// db.js — storage for the app, with two interchangeable backends:
//
//  1. Postgres (when the DATABASE_URL environment variable is set) — used when
//     the app runs in the cloud (e.g. Render). Free cloud servers wipe their
//     disk on every restart/redeploy, so a local file there would lose every
//     account and route. The whole database is kept as one JSON document in a
//     single Postgres row (free tier at neon.tech is more than enough).
//  2. A JSON file on disk (when DATABASE_URL is not set) — for running on your
//     own computer. Stored OUTSIDE the app folder so updating the app never
//     touches it. Override the folder with DB_DIR.
//
// Either way, data is held in memory and every change is saved immediately,
// so the rest of the server keeps using simple synchronous functions.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DATA_DIR = process.env.DB_DIR || path.join(os.homedir(), '.derech-chatam-sofer-data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const USE_PG = !!process.env.DATABASE_URL;

let cache = null;
let pool = null;
let pgWriteChain = Promise.resolve();

function emptyDb() {
  return {
    cookieSecret: crypto.randomBytes(32).toString('hex'),
    users: {},          // id -> {id, email, passwordHash, name, createdAt}
    usersByEmail: {},   // email -> id
    resetTokens: {},    // token -> {userId, expiresAt}
    customers: {},      // userId -> [ {id,name,addr,area,lat,lon,windowStart,windowEnd} ]
    savedRoutes: {},    // userId -> [ {id,name,createdAt,snapshot} ]
    history: {},        // userId -> [ {...} ]
    todayRoute: {},     // userId -> snapshot | null
  };
}

function loadFromFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const fresh = emptyDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    // corrupted file safety net — keep a backup, never crash the whole app
    try { fs.copyFileSync(DB_FILE, DB_FILE + '.corrupt-' + Date.now()); } catch (_) {}
    const fresh = emptyDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

// Must be awaited once before the server starts listening.
async function init() {
  if (!USE_PG) {
    cache = loadFromFile();
    console.log('מסד נתונים: קובץ מקומי ב-' + DB_FILE);
    return;
  }
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  pool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 3,
  });
  await pool.query('CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())');
  const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
  if (r.rows.length) {
    cache = r.rows[0].data;
  } else {
    cache = emptyDb();
    await pool.query('INSERT INTO app_state (id, data) VALUES (1, $1)', [JSON.stringify(cache)]);
  }
  console.log('מסד נתונים: Postgres (נשמר לצמיתות)');
}

function readDb() {
  if (!cache) throw new Error('db.init() was not called');
  return cache;
}

function writeDb(db) {
  cache = db;
  if (!USE_PG) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    return;
  }
  // Serialize writes so an older snapshot can never overwrite a newer one.
  const snapshot = JSON.stringify(db);
  pgWriteChain = pgWriteChain
    .then(() => pool.query('UPDATE app_state SET data = $1, updated_at = now() WHERE id = 1', [snapshot]))
    .catch((e) => console.error('שגיאה בשמירה למסד הנתונים:', e.message));
}

// Lets the server wait for pending saves before shutting down.
function flush() {
  return pgWriteChain;
}

// ---------- cookie secret (persisted so sessions survive restarts) ----------
function getCookieSecret() {
  return readDb().cookieSecret;
}

// ---------- users ----------
function createUser({ email, passwordHash, name }) {
  const db = readDb();
  email = email.toLowerCase().trim();
  if (db.usersByEmail[email]) return null;
  const id = crypto.randomUUID();
  const user = { id, email, passwordHash, name, createdAt: Date.now() };
  db.users[id] = user;
  db.usersByEmail[email] = id;
  db.customers[id] = [];
  db.savedRoutes[id] = [];
  db.history[id] = [];
  db.todayRoute[id] = null;
  writeDb(db);
  return user;
}
function findUserByEmail(email) {
  const db = readDb();
  const id = db.usersByEmail[(email || '').toLowerCase().trim()];
  return id ? db.users[id] : null;
}
function findUserById(id) {
  return readDb().users[id] || null;
}
function updatePassword(userId, passwordHash) {
  const db = readDb();
  if (!db.users[userId]) return false;
  db.users[userId].passwordHash = passwordHash;
  writeDb(db);
  return true;
}

// ---------- password reset tokens ----------
function createResetToken(userId) {
  const db = readDb();
  const token = crypto.randomBytes(24).toString('hex');
  db.resetTokens[token] = { userId, expiresAt: Date.now() + 60 * 60 * 1000 };
  writeDb(db);
  return token;
}
function consumeResetToken(token) {
  const db = readDb();
  const entry = db.resetTokens[token];
  if (!entry) return null;
  delete db.resetTokens[token];
  writeDb(db);
  if (entry.expiresAt < Date.now()) return null;
  return entry.userId;
}

// ---------- per-user data collections ----------
function getCollection(name, userId) {
  const db = readDb();
  if (!db[name]) db[name] = {};
  return db[name][userId] ?? (name === 'todayRoute' ? null : []);
}
function setCollection(name, userId, value) {
  const db = readDb();
  if (!db[name]) db[name] = {};
  db[name][userId] = value;
  writeDb(db);
}

module.exports = {
  init, flush,
  getCookieSecret,
  createUser, findUserByEmail, findUserById, updatePassword,
  createResetToken, consumeResetToken,
  getCollection, setCollection,
};
