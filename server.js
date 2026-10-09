// server.js — the whole backend in one file, kept simple on purpose.
//
// What this server does:
//  1. Serves the frontend (the /public folder).
//  2. Real accounts: register / login / logout / forgot-password / reset-password,
//     with hashed passwords and a signed session cookie.
//  3. Real per-user data storage (customers, saved routes, history, today's route)
//     backed by db.js (a JSON file on disk — see db.js for why).
//  4. Proxies geocoding and routing calls to OpenStreetMap (Nominatim) and OSRM
//     from the SERVER instead of the browser. This is the fix for the
//     "Failed to fetch" problem: browsers running inside a sandboxed preview
//     can't call those services directly, but a normal Node server can,
//     with no such restriction.

// --- tiny built-in .env loader (so a plain "node server.js" picks up .env
//     locally, with no extra dependency) — hosting platforms that set their
//     own environment variables (Replit, Render, etc.) work fine without it.
const fs = require('fs');
const path0 = require('path');
const envPath = path0.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const rawBuf = fs.readFileSync(envPath);
  // Windows Notepad silently saves as UTF-16 when a file contains non-ASCII
  // text (which ours does, via the Hebrew comments) — reading that as UTF-8
  // would turn every line into garbage and silently drop every setting, so
  // detect the byte-order-mark and decode accordingly.
  let envText;
  if (rawBuf[0] === 0xff && rawBuf[1] === 0xfe) {
    envText = rawBuf.slice(2).toString('utf16le');
  } else if (rawBuf[0] === 0xfe && rawBuf[1] === 0xff) {
    envText = (rawBuf.length % 2 === 0 ? Buffer.from(rawBuf).swap16() : rawBuf).slice(2).toString('utf16le'); // UTF-16 BE -> LE, then decode
  } else {
    envText = rawBuf.toString('utf8').replace(/^\uFEFF/, ''); // strip UTF-8 BOM if present
  }
  envText.split('\n').forEach((line) => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').trim();
  });
}

const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' })); // raised to allow uploaded address files (PDF/Excel/Word) as base64
// Behind a cloud host's proxy (Render etc.) — needed so password-reset links
// come out as https:// and secure cookies work.
app.set('trust proxy', 1);

// Health check for the hosting platform (no login needed).
app.get('/healthz', (req, res) => res.send('ok'));

// Created lazily: the cookie secret lives in the database, which is only
// loaded once db.init() finishes (see start() at the bottom).
let sessionMiddleware = null;
app.use((req, res, next) => {
  if (!sessionMiddleware) {
    sessionMiddleware = cookieSession({
      name: 'session',
      secret: process.env.COOKIE_SECRET || db.getCookieSecret(),
      maxAge: 365 * 24 * 60 * 60 * 1000, // a year — register once, stay signed in
      sameSite: 'lax',
    });
  }
  sessionMiddleware(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  next();
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name };
}

/* =========================================================================
   AUTH
========================================================================= */
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'נא למלא שם, אימייל וסיסמה' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'הסיסמה צריכה להכיל לפחות 6 תווים' });
  }
  const existing = db.findUserByEmail(email);
  if (existing) {
    return res.status(409).json({ error: 'כבר קיים משתמש עם האימייל הזה' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = db.createUser({ email, passwordHash, name });
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.findUserByEmail(email || '');
  if (!user) return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
  const ok = await bcrypt.compare(password || '', user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'unauthenticated' });
  const user = db.findUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  res.json({ user: publicUser(user) });
});

app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  const user = db.findUserByEmail(email || '');
  // Always respond the same way whether or not the account exists,
  // so the form can't be used to discover which emails are registered.
  if (!user) return res.json({ ok: true });

  const token = db.createResetToken(user.id);
  const resetLink = `${req.protocol}://${req.get('host')}/?resetToken=${token}`;

  if (process.env.RESEND_API_KEY) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'onboarding@resend.dev',
          to: user.email,
          subject: 'איפוס סיסמה - אפליקציית מסלול',
          html: `<p>לחצו כאן לאיפוס הסיסמה שלכם:</p><p><a href="${resetLink}">${resetLink}</a></p><p>הקישור בתוקף לשעה אחת.</p>`,
        }),
      });
      return res.json({ ok: true, emailed: true });
    } catch (e) {
      // fall through to returning the link directly
    }
  }
  // No email provider configured (or sending failed) — return the link directly
  // so the feature still works end-to-end without needing an email account.
  res.json({ ok: true, emailed: false, resetLink });
});

app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || String(password).length < 6) {
    return res.status(400).json({ error: 'קישור לא תקין או סיסמה קצרה מדי' });
  }
  const userId = db.consumeResetToken(token);
  if (!userId) return res.status(400).json({ error: 'הקישור לאיפוס פג תוקף או שכבר נעשה בו שימוש' });
  const passwordHash = await bcrypt.hash(password, 10);
  db.updatePassword(userId, passwordHash);
  req.session.userId = userId;
  res.json({ ok: true });
});

/* =========================================================================
   PER-USER DATA (real persistent storage)
========================================================================= */
const COLLECTIONS = ['customers', 'savedRoutes', 'history'];
COLLECTIONS.forEach((name) => {
  app.get(`/api/data/${name}`, requireAuth, (req, res) => {
    res.json({ value: db.getCollection(name, req.session.userId) });
  });
  app.put(`/api/data/${name}`, requireAuth, (req, res) => {
    db.setCollection(name, req.session.userId, req.body.value ?? []);
    res.json({ ok: true });
  });
});
app.get('/api/data/todayRoute', requireAuth, (req, res) => {
  res.json({ value: db.getCollection('todayRoute', req.session.userId) });
});
app.put('/api/data/todayRoute', requireAuth, (req, res) => {
  db.setCollection('todayRoute', req.session.userId, req.body.value ?? null);
  res.json({ ok: true });
});

/* =========================================================================
   GEOCODING PROXY (Nominatim / OpenStreetMap) — called server-side,
   so the request carries a proper identifying User-Agent as their usage
   policy requires, and isn't subject to browser CORS restrictions.
========================================================================= */
let lastGeocodeCall = 0;
async function politeDelay() {
  const minGap = 1000; // Nominatim policy: max ~1 request/second
  const wait = Math.max(0, lastGeocodeCall + minGap - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocodeCall = Date.now();
}

// Israeli street names in the map data are almost always stored WITHOUT the
// word "רחוב" (street) in front — e.g. "הרצל 10" rather than "רחוב הרצל 10".
// Including that word often makes the search fail entirely. We strip it (and
// its common abbreviations) before searching, and keep the original text
// only as a fallback if the cleaned version finds nothing.
function stripStreetWord(q) {
  return q
    .replace(/(^|\s)רחוב(\s|$)/g, '$1$2')
    .replace(/(^|\s)רח['׳](\s|$)/g, '$1$2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function nominatimFetch(url) {
  await politeDelay();
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'DeliveryRouteApp/1.0 (self-hosted by an individual driver)',
      Accept: 'application/json',
    },
  });
  if (!r.ok) throw new Error('geocode service error ' + r.status);
  const data = await r.json();
  return (data || []).map((d) => ({ lat: d.lat, lon: d.lon, display_name: d.display_name }));
}
async function nominatimSearch(q) {
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=il&accept-language=he&q=' +
    encodeURIComponent(q);
  return nominatimFetch(url);
}
// Structured search (separate street/city fields) is more accurate than free
// text when we know the city, since it removes the ambiguity of a bare
// street name matching several towns.
async function nominatimStructuredSearch(street, city) {
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&accept-language=he&country=Israel' +
    '&street=' + encodeURIComponent(street) +
    '&city=' + encodeURIComponent(city);
  return nominatimFetch(url);
}

// Some Israeli cities are known by more than one name in real use (an
// official rename, or a name that's still in common/religious use), and the
// free map data doesn't always link them together — a search for one name
// can miss addresses filed under the other. When the given city fails, we
// automatically retry with any known alias.
const CITY_ALIASES = {
  'מודיעין עילית': ['קרית ספר', 'קריית ספר'],
  'קרית ספר': ['מודיעין עילית'],
  'קריית ספר': ['מודיעין עילית'],
};

// Second, independent map data source (also free, no key) — tried only when
// Nominatim comes back completely empty. Different underlying index, so it
// sometimes finds addresses Nominatim's instance misses, and vice versa.
async function photonSearch(q) {
  const url = 'https://photon.komoot.io/api/?lang=he&limit=5&lat=31.5&lon=35.0&zoom=12&q=' + encodeURIComponent(q);
  const r = await fetch(url);
  if (!r.ok) throw new Error('photon service error ' + r.status);
  const data = await r.json();
  const features = (data && data.features) || [];
  return features
    .filter((f) => f.geometry && f.geometry.coordinates)
    .map((f) => {
      const p = f.properties || {};
      const parts = [
        p.name,
        p.housenumber && p.street ? `${p.street} ${p.housenumber}` : p.street || p.housenumber,
        p.city, p.state, p.country,
      ].filter(Boolean);
      const seen = new Set();
      const label = parts.filter((x) => { const k = x.trim(); if (seen.has(k)) return false; seen.add(k); return true; }).join(', ');
      return { lat: String(f.geometry.coordinates[1]), lon: String(f.geometry.coordinates[0]), display_name: label || q };
    });
}

// Optional third source — only used if the person has set GOOGLE_MAPS_API_KEY
// (see .env.example). Google's own data tends to have the best Israeli
// coverage, but it requires a paid/billed API key, so it's opt-in only.
async function googleGeocodeSearch(q) {
  if (!process.env.GOOGLE_MAPS_API_KEY) return [];
  const url =
    'https://maps.googleapis.com/maps/api/geocode/json?region=il&language=he&key=' +
    process.env.GOOGLE_MAPS_API_KEY + '&address=' + encodeURIComponent(q + ', ישראל');
  const r = await fetch(url);
  if (!r.ok) return [];
  const data = await r.json();
  if (data.status !== 'OK') return [];
  return (data.results || []).map((res) => ({
    lat: String(res.geometry.location.lat),
    lon: String(res.geometry.location.lng),
    display_name: res.formatted_address,
  }));
}

// OpenCage Geocoding — free, no credit card required (free account at
// opencagedata.com), 2,500 requests/day. Aggregates OpenStreetMap plus a few
// other open sources, so it occasionally finds addresses plain Nominatim
// misses. Tried before HERE/Google since it needs no billing info at all.
async function openCageSearch(q) {
  if (!process.env.OPENCAGE_API_KEY) return [];
  const url =
    'https://api.opencagedata.com/geocode/v1/json?language=he&countrycode=il&limit=5&key=' +
    process.env.OPENCAGE_API_KEY + '&q=' + encodeURIComponent(q);
  const r = await fetch(url);
  if (!r.ok) return [];
  const data = await r.json();
  return (data.results || []).map((res) => ({
    lat: String(res.geometry.lat),
    lon: String(res.geometry.lng),
    display_name: res.formatted,
  }));
}

// HERE Geocoding — optional, free tier available but now requires a credit
// card on file (HERE retired their no-card plan in August 2025). Tends to be
// more accurate than OpenStreetMap outside the US, Israel included, if you
// don't mind adding a card you likely won't be charged on.
async function hereGeocodeSearch(q) {
  if (!process.env.HERE_API_KEY) return [];
  const url =
    'https://geocode.search.hereapi.com/v1/geocode?in=countryCode:ISR&lang=he&limit=5&apiKey=' +
    process.env.HERE_API_KEY + '&q=' + encodeURIComponent(q);
  const r = await fetch(url);
  if (!r.ok) return [];
  const data = await r.json();
  return (data.items || []).map((item) => ({
    lat: String(item.position.lat),
    lon: String(item.position.lng),
    display_name: item.address ? item.address.label : item.title,
  }));
}

async function geocodeWithFallbacks(q, city) {
  const cleaned = stripStreetWord(q);
  let results;
  if (city) {
    results = await nominatimStructuredSearch(cleaned || q, city);
    if (!results.length) results = await nominatimSearch((cleaned || q) + ', ' + city);
    if (!results.length && CITY_ALIASES[city]) {
      for (const alias of CITY_ALIASES[city]) {
        results = await nominatimStructuredSearch(cleaned || q, alias);
        if (!results.length) results = await nominatimSearch((cleaned || q) + ', ' + alias);
        if (results.length) break;
      }
    }
  } else {
    results = await nominatimSearch(cleaned || q);
    if (!results.length && cleaned !== q) results = await nominatimSearch(q);
  }
  const query = city ? `${cleaned || q}, ${city}` : (cleaned || q);
  if (!results.length) {
    try { results = await photonSearch(query); }
    catch (e) { /* Photon failed too — fall through to the other fallbacks */ }
  }
  if (!results.length && process.env.OPENCAGE_API_KEY) {
    try { results = await openCageSearch(query); }
    catch (e) { /* fall through */ }
  }
  if (!results.length && process.env.HERE_API_KEY) {
    try { results = await hereGeocodeSearch(query); }
    catch (e) { /* fall through to Google if configured */ }
  }
  if (!results.length && process.env.GOOGLE_MAPS_API_KEY) {
    try { results = await googleGeocodeSearch(query); }
    catch (e) { /* give up — caller will show "not found" */ }
  }
  return results || [];
}

app.get('/api/geocode', requireAuth, async (req, res) => {
  const q = req.query.q;
  const city = req.query.city;
  if (!q) return res.status(400).json({ error: 'missing q' });
  try {
    const results = await geocodeWithFallbacks(q, city);
    res.json(results);
  } catch (e) {
    res.status(502).json({ error: 'geocode failed: ' + e.message });
  }
});

/* =========================================================================
   ADDRESS FILE IMPORT — PDF, Word, Excel/CSV, or plain text, each with a
   list of addresses. We extract raw text/rows server-side (no browser
   limitations here) and reduce it to one address per line, the same way a
   pasted list is handled.
========================================================================= */
function linesToCleanAddresses(lines) {
  return lines
    .map((l) => String(l || '').trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\s*\(?\d{1,3}[.)\-]\s*/, '').replace(/^[•\-*]\s*/, '').trim())
    .filter((l) => l.length > 1);
}
function rowsFromCsvText(text) {
  return text
    .split(/\r?\n/)
    .filter((r) => r.trim().length)
    .map((r) => r.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
}
// Pick the most likely "address" column: prefer a header that says so,
// otherwise fall back to the first column.
function pickAddressColumn(rows) {
  if (!rows.length) return [];
  const header = (rows[0] || []).map((h) => String(h || '').toLowerCase());
  let colIdx = header.findIndex((h) => /כתובת|address|street|רחוב/.test(h));
  let dataRows = rows;
  if (colIdx === -1) {
    colIdx = 0; // no recognizable header — assume the first column is the address
  } else {
    dataRows = rows.slice(1);
  }
  return dataRows.map((r) => String((r || [])[colIdx] || '').trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// PDF delivery-list parsing. Hebrew PDFs are notoriously unreliable to
// extract text from directly — the raw text stream frequently comes out in
// scrambled (wrong reading) order, especially in tables that mix Hebrew and
// numbers (addresses, phone numbers). Naive extraction is not safe to trust
// for real addresses/phone numbers.
//
// Strategy: try the "poppler" pdftotext tool (-layout mode), which uses a
// proper text-layout + bidi-resolution engine and is dramatically more
// reliable for Hebrew tables. It's commonly pre-installed on Linux hosts; if
// it isn't found on this machine, we fall back to a plain-text extraction
// (pdf-parse) that only gives a flat address list, with no notes column
// separation, and we say so in the response.
async function tryPdftotextLayout(buf) {
  const { spawn } = require('child_process');
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const tmpFile = path.join(os.tmpdir(), 'route-app-pdf-' + require('crypto').randomUUID() + '.pdf');
  fs.writeFileSync(tmpFile, buf);
  try {
    const text = await new Promise((resolve, reject) => {
      const env = { ...process.env };
      if (process.env.PATH_EXTRA) {
        // lets a person on Windows point at a manually-installed Poppler
        // "bin" folder without having to edit their system PATH
        env.PATH = process.env.PATH_EXTRA + require('path').delimiter + (env.PATH || '');
      }
      const proc = spawn('pdftotext', ['-layout', tmpFile, '-'], { env });
      let out = '', err = '';
      proc.stdout.on('data', (d) => (out += d));
      proc.stderr.on('data', (d) => (err += d));
      proc.on('error', reject); // binary not found (ENOENT) etc.
      proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || 'pdftotext exited ' + code))));
    });
    return text;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore cleanup failure */ }
  }
}

const PDF_PHONE_RE = /0\d[\d-]{6,12}\d/;
const PDF_HOUSENUM_RE = /^-?\d{1,4}([א-ת])?(\/\d+)?$/; // e.g. 12, -1, 2א, 4/7

function stripBidiControlChars(text) {
  return text.replace(/[\u200e\u200f\u202a-\u202e]/g, '');
}

// Groups the layout-mode text into delivery-list rows using the row-number
// column as an anchor (it reliably appears as the last token — rightmost
// physical column — of each row's main line), then, for each row, reads its
// columns in logical order using the wide gaps -layout mode preserves
// between columns. This recovers correct word order even though the overall
// line is stored in physical left-to-right column order.
function parsePdfDeliveryList_fromLayoutText(rawText) {
  const text = stripBidiControlChars(rawText);
  const lines = text.split('\n').filter((l) => l.trim().length > 0);

  const rowBlocks = [];
  let current = [];
  let expected = 1;
  for (const rawLine of lines) {
    current.push(rawLine);
    const tokens = rawLine.trim().split(/\s+/);
    const last = tokens[tokens.length - 1];
    if (/^\d{1,3}$/.test(last) && parseInt(last, 10) === expected) {
      rowBlocks.push({ lines: current, anchorIdx: current.length - 1 });
      current = [];
      expected++;
    }
  }
  // The header can span several physical lines and its exact wording varies
  // between templates ("עמודה1/2/3" vs "רחוב"/"מספר"/"קומה.דירה", etc), but
  // it always sits before row 1's anchor line. Strip any line in that first
  // block that looks like a header label rather than actual row data, so
  // row 1's real content survives instead of being lost or contaminated.
  const HEADER_MARKERS = /מסלול|עמודה\s*\d|טלפון נייד|ליצירת קשר|משפחה\s*:|עיר\s*:|הערות לשליח|^\s*כמות\s*$|^\s*רחוב מספר\s*$|^\s*שם\s*$|^\s*\.?דירה\s*$/;
  if (rowBlocks.length) {
    const first = rowBlocks[0];
    const anchorLine = first.lines[first.anchorIdx];
    const kept = first.lines.filter((l) => l === anchorLine || !HEADER_MARKERS.test(l));
    first.anchorIdx = kept.indexOf(anchorLine);
    first.lines = kept;
  }

  function splitColumns(rawLine) {
    return rawLine.split(/\s{2,}/).map((s) => s.trim()).filter((s) => s.length > 0);
  }
  function rowToFields(row) {
    const ordered = [row.lines[row.anchorIdx], ...row.lines.filter((_, i) => i !== row.anchorIdx)];
    let all = [];
    for (const l of ordered) {
      const cols = splitColumns(l);
      cols.reverse();
      all.push(...cols);
    }
    return all;
  }

  const entries = [];
  let lowConfidenceCount = 0;
  // skip index 0: it's the header merged with row "1"'s content in a way
  // that's unreliable to salvage — but real lists almost always have >1 row,
  // so we still try it, just don't crash if the array is short.
  rowBlocks.forEach((row) => {
    const fields = rowToFields(row);
    fields.shift(); // row number — already used for grouping, not needed further
    let phone = null;
    for (let i = 0; i < fields.length; i++) {
      const m = fields[i].match(PDF_PHONE_RE);
      if (m) {
        phone = m[0];
        const rest = fields[i].replace(m[0], '').trim();
        fields[i] = rest; // leftover text (often the city) stays in place as a field
        if (!rest) fields.splice(i, 1);
        break;
      }
    }
    let streetAndNumber = fields.shift() || '';
    const lastTok = streetAndNumber.split(/\s+/).slice(-1)[0] || '';
    const hasNum = /\d/.test(lastTok);
    if (!hasNum && fields.length && PDF_HOUSENUM_RE.test(fields[0])) {
      streetAndNumber = streetAndNumber + ' ' + fields.shift();
    }
    streetAndNumber = streetAndNumber.replace(/([א-ת])(\d)/, '$1 $2'); // "יחזקאל7" -> "יחזקאל 7"
    const lowConfidence = !/\d/.test(streetAndNumber) || !/[א-ת]/.test(streetAndNumber);
    if (lowConfidence) lowConfidenceCount++;
    const noteParts = [];
    if (phone) noteParts.push('טל: ' + phone);
    noteParts.push(...fields);
    entries.push({
      text: streetAndNumber.trim(),
      notes: noteParts.join(', ') || null,
      lowConfidence,
    });
  });

  return { entries, lowConfidenceCount };
}

async function parsePdfDeliveryList(buf) {
  let layoutText = null;
  let popplerError = null;
  try {
    layoutText = await tryPdftotextLayout(buf);
  } catch (e) {
    layoutText = null; // poppler not available on this machine — fall back below
    popplerError = e && e.message;
  }

  if (layoutText) {
    const { entries, lowConfidenceCount } = parsePdfDeliveryList_fromLayoutText(layoutText);
    let warning = null;
    if (lowConfidenceCount > 0) {
      warning = `${lowConfidenceCount} שורות לא זוהו בביטחון מלא וסומנו — כדאי להשוות אותן למסמך המקורי לפני שסומכים עליהן.`;
    }
    if (entries.length) return { entries, warning };
    // fell through to below if somehow nothing was recovered
  }

  // Fallback: no poppler available (or it produced nothing usable) — do a
  // plain flat extraction. This still works fine for simple, non-tabular
  // PDFs, but cannot reliably separate notes from addresses for a dense
  // Hebrew table like a delivery list.
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buf);
  const entries = linesToCleanAddresses(data.text.split(/\r?\n/)).map((t) => ({ text: t, notes: null }));
  const diag = process.env.PATH_EXTRA
    ? `(PATH_EXTRA מוגדר ל-"${process.env.PATH_EXTRA}" אבל pdftotext עדיין לא נמצא שם — ${popplerError || 'סיבה לא ידועה'})`
    : '(PATH_EXTRA לא מוגדר כלל — ראו README להתקנת Poppler)';
  const warning =
    'לא הצלחתי להשתמש בכלי הפענוח המדויק (poppler) על השרת הזה, אז הכתובות חולצו בצורה פשוטה יותר ' +
    'וללא הפרדת הערות — כדאי לבדוק את התוצאה מול הקובץ המקורי. ' + diag;
  return { entries, warning };
}

app.post('/api/parse-addresses', requireAuth, async (req, res) => {
  const { filename, dataBase64 } = req.body || {};
  if (!filename || !dataBase64) return res.status(400).json({ error: 'לא התקבל קובץ' });
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const buf = Buffer.from(dataBase64, 'base64');
  try {
    let entries = []; // [{text, notes}]
    let warning = null;

    if (ext === 'txt') {
      entries = linesToCleanAddresses(buf.toString('utf8').split(/\r?\n/)).map((t) => ({ text: t, notes: null }));
    } else if (ext === 'csv') {
      entries = linesToCleanAddresses(pickAddressColumn(rowsFromCsvText(buf.toString('utf8')))).map((t) => ({ text: t, notes: null }));
    } else if (ext === 'pdf') {
      const parsed = await parsePdfDeliveryList(buf);
      entries = parsed.entries;
      warning = parsed.warning;
    } else if (ext === 'docx') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer: buf });
      entries = linesToCleanAddresses(result.value.split(/\r?\n/)).map((t) => ({ text: t, notes: null }));
    } else if (ext === 'xlsx' || ext === 'xls') {
      const XLSX = require('xlsx');
      const wb = XLSX.read(buf, { type: 'buffer' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      entries = linesToCleanAddresses(pickAddressColumn(rows.map((r) => r.map((c) => String(c))))).map((t) => ({ text: t, notes: null }));
    } else {
      return res.status(400).json({ error: `סוג קובץ לא נתמך: .${ext}. נתמכים: TXT, CSV, PDF, DOCX, XLSX, XLS` });
    }
    res.json({ addresses: entries, warning });
  } catch (e) {
    res.status(500).json({ error: 'שגיאה בקריאת הקובץ: ' + e.message });
  }
});

/* =========================================================================
   ROUTING PROXY (OSRM) — table (distance/duration matrix) and route (final path)
========================================================================= */
const OSRM_BASE = 'https://router.project-osrm.org';

app.post('/api/table', requireAuth, async (req, res) => {
  const points = req.body.points || [];
  if (points.length < 2) return res.status(400).json({ error: 'need at least 2 points' });
  try {
    const coordStr = points.map((p) => p.lon + ',' + p.lat).join(';');
    const url = `${OSRM_BASE}/table/v1/driving/${coordStr}?annotations=distance,duration`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'routing table failed: ' + e.message });
  }
});

app.post('/api/directions', requireAuth, async (req, res) => {
  const points = req.body.points || [];
  if (points.length < 2) return res.status(400).json({ error: 'need at least 2 points' });
  try {
    const coordStr = points.map((p) => p.lon + ',' + p.lat).join(';');
    const url = `${OSRM_BASE}/route/v1/driving/${coordStr}?overview=full&geometries=geojson&steps=true`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'directions failed: ' + e.message });
  }
});

/* =========================================================================
   EXCEL EXPORT — turns the finished route into a downloadable .xlsx
========================================================================= */
app.post('/api/export-route', requireAuth, (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { stops, totalDistance, totalDuration } = req.body || {};
    const rows = [['#', 'כתובת', 'מרחק מהעצירה הקודמת (ק"מ)', "זמן נסיעה מהעצירה הקודמת (דק')", 'הגעה משוערת', 'סטטוס', 'הערות לשליח']];
    (stops || []).forEach((s, i) => {
      rows.push([
        i + 1,
        s.name ? `${s.name} — ${s.raw}` : s.raw,
        s.legDist != null ? +(s.legDist / 1000).toFixed(1) : '',
        s.legDur != null ? Math.round(s.legDur / 60) : '',
        s.eta ? new Date(s.eta).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '',
        s.deliveryStatus || '',
        s.notes || '',
      ]);
    });
    rows.push([]);
    rows.push(['סה"כ מרחק (ק"מ)', totalDistance != null ? +(totalDistance / 1000).toFixed(1) : '']);
    rows.push(["סה\"כ זמן נסיעה (דק')", totalDuration != null ? Math.round(totalDuration / 60) : '']);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 4 }, { wch: 34 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 36 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'מסלול');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="route.xlsx"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'שגיאה בהפקת הקובץ: ' + e.message });
  }
});

// Tells the frontend whether to load Google Maps (only if the person set a
// key) or fall back to the free OpenStreetMap/Leaflet map — never expose
// server internals beyond this one flag.
app.get('/api/config', requireAuth, (req, res) => {
  res.json({ googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || null });
});

async function start() {
  await db.init();
  const server = app.listen(PORT, () => {
    console.log(`מוכן! האפליקציה רצה על http://localhost:${PORT}`);
  });
  // On shutdown (e.g. a cloud redeploy) wait for pending saves first.
  const shutdown = async () => {
    server.close();
    try { await db.flush(); } catch (e) {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
start().catch((e) => {
  console.error('לא הצלחתי להפעיל את השרת:', e);
  process.exit(1);
});
