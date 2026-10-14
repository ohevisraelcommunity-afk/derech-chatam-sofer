// pdfTable.js — reads a delivery-list table out of a PDF using the exact
// position of every word on the page (from Poppler's `pdftotext -tsv`).
//
// Why positions and not plain text: Hebrew tables exported from Excel come out
// of plain-text extraction in scrambled order, and cells that wrap onto two
// lines (e.g. "קומה 3 / דירה 5") get mixed into the neighbouring rows. Here we
//   1. find the header row and work out where each column starts and ends,
//   2. use the row numbers in the "route" column as anchors for the rows,
//   3. drop every word into its (row, column) cell by its coordinates,
// so each cell is rebuilt correctly no matter how it wrapped.
//
// Returns null when the PDF doesn't look like a table with known headers —
// the caller then falls back to simpler extraction.

const HEBREW = /[֐-׿]/;
const BIDI_CTRL = /[‎‏‪-‮⁦-⁩]/g;

// Header labels → field. Matched against the header text of each column.
const HEADER_RULES = [
  { field: 'route',  re: /^(מסלול|מס['׳]?|#|מספר סידורי)$/ },
  { field: 'street', re: /(עמודה\s*1|^רחוב$|^כתובת$)/ },
  { field: 'house',  re: /(עמודה\s*2|^מספר$|^מס['׳]? בית$|^בית$)/ },
  { field: 'unit',   re: /(עמודה\s*3|קומה|דירה)/ },
  { field: 'qty',    re: /^(כמות|ספרים|חבילות|יח['׳]?|יחידות|עלונים)/ },
  { field: 'order',  re: /^(הזמנה|מס['׳]? הזמנה|מספר הזמנה)$/ },
  { field: 'ignore', re: /^[✓✔☐□]$/ },
  { field: 'first',  re: /^שם:?$/ },
  { field: 'last',   re: /משפחה/ },
  { field: 'phone',  re: /טלפון|נייד/ },
  { field: 'city',   re: /^עיר:?$/ },
  { field: 'notes',  re: /הערות/ },
];

// Map header labels to fields. When two columns claim the same field, a
// real name ("רחוב") beats a generic one ("עמודה1"); the loser is kept as an
// extra column whose text is added to the courier notes.
function assignFields(labels) {
  const fields = labels.map((raw) => {
    const label = String(raw == null ? '' : raw).replace(/[:]/g, '').replace(/\s+/g, ' ').trim();
    const rule = HEADER_RULES.find((r) => r.re.test(label));
    return { label, field: rule ? rule.field : null, generic: /עמודה\s*\d/.test(label) };
  });
  const taken = {};
  fields.forEach((f, i) => {
    if (!f.field) return;
    const j = taken[f.field];
    if (j === undefined) { taken[f.field] = i; return; }
    // conflict: keep the non-generic one
    if (fields[j].generic && !f.generic) { fields[j].field = 'extra'; taken[f.field] = i; }
    else f.field = 'extra';
  });
  fields.forEach((f) => { if (!f.field && f.label) f.field = 'extra'; });
  return fields;
}

// pdftotext -tsv gives Hebrew words in visual (reversed) letter order.
function logicalWord(w) {
  w = w.replace(BIDI_CTRL, '');
  if (!HEBREW.test(w)) return w;
  return Array.from(w).reverse().join('')
    // brackets flip when reversed
    .replace(/[()]/g, (c) => (c === '(' ? ')' : '('));
}

function parseTsv(tsv) {
  const words = [];
  const lines = tsv.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const text = logicalWord(c[11] || '').trim();
    if (!text || /^https?:/i.test(text) || /^www\./i.test(text)) continue; // page footers
    const x0 = parseFloat(c[6]), y0 = parseFloat(c[7]);
    const w = parseFloat(c[8]), h = parseFloat(c[9]);
    words.push({
      page: +c[1], block: +c[2], par: +c[3], line: +c[4],
      x0, y0, x1: x0 + w, y1: y0 + h, xc: x0 + w / 2, yc: y0 + h / 2, text,
    });
  }
  return words;
}

// Join the words of one cell: lines top→bottom, words right→left (RTL).
// Punctuation tokens stick to the word before them.
function cellText(ws) {
  if (!ws.length) return '';
  const sorted = ws.slice().sort((a, b) => a.yc - b.yc);
  const rows = [];
  for (const w of sorted) {
    const r = rows.find((r) => Math.abs(r.yc - w.yc) < Math.max(4, (w.y1 - w.y0) * 0.45));
    if (r) { r.ws.push(w); } else rows.push({ yc: w.yc, ws: [w] });
  }
  return rows
    .map((r) => {
      let out = '';
      r.ws.sort((a, b) => b.x1 - a.x1).forEach((w) => {
        if (/^[.,;:'׳"״)]+$/.test(w.text) && out) out += w.text;
        else out += (out ? ' ' : '') + w.text;
      });
      return out;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}

// Group words into lines by block+line id (one text line inside one cell).
function groupLines(words) {
  const m = new Map();
  for (const w of words) {
    const k = w.page + ':' + w.block + ':' + w.par + ':' + w.line;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(w);
  }
  return [...m.values()];
}

// Header = the text line that matches the most header labels.
function findHeader(words) {
  const lines = groupLines(words);
  // Merge lines at nearly the same height into one header candidate.
  const bands = [];
  for (const ln of lines) {
    const yc = ln.reduce((s, w) => s + w.yc, 0) / ln.length;
    let b = bands.find((b) => Math.abs(b.yc - yc) < 6);
    if (!b) { b = { yc, lines: [] }; bands.push(b); }
    b.lines.push(ln);
  }
  let best = null;
  for (const b of bands) {
    // each "cell" in the header band = words of one block
    const cells = new Map();
    b.lines.flat().forEach((w) => {
      const k = w.block;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(w);
    });
    const cols = [];
    for (const ws of cells.values()) {
      cols.push({
        label: cellText(ws),
        x0: Math.min(...ws.map((w) => w.x0)), x1: Math.max(...ws.map((w) => w.x1)),
        y1: Math.max(...ws.map((w) => w.y1)),
      });
    }
    assignFields(cols.map((c) => c.label)).forEach((f, i) => { cols[i].field = f.field; cols[i].label = f.label; });
    const known = cols.filter((c) => c.field && c.field !== 'extra');
    const fields = new Set(known.map((c) => c.field));
    if (fields.has('street') && fields.size >= 3 && (!best || known.length > best.known)) {
      best = { cols: cols.sort((a, b) => b.x1 - a.x1), known: known.length, yBottom: Math.max(...cols.map((c) => c.y1)) };
    }
  }
  return best;
}

// Column edges: between each two neighbouring header labels, pick the x with
// the fewest data words crossing it (the empty gutter between the columns).
function columnEdges(headerCols, dataWords, shift) {
  const cols = headerCols; // right → left
  const edges = [];
  for (let i = 0; i < cols.length - 1; i++) {
    const right = cols[i], left = cols[i + 1];
    let lo = left.x1 + shift - 6, hi = right.x0 + shift + 6;
    if (hi < lo) [lo, hi] = [hi, lo];
    // coverage at each x; then take the WIDEST run of minimal coverage
    const xs = [], cov = [];
    for (let x = lo; x <= hi; x += 0.5) {
      xs.push(x);
      cov.push(dataWords.reduce((s, w) => s + (w.x0 < x && w.x1 > x ? 1 : 0), 0));
    }
    const min = Math.min(...cov);
    let bestX = (lo + hi) / 2, bestW = -1, start = null;
    for (let k = 0; k <= xs.length; k++) {
      if (k < xs.length && cov[k] === min) { if (start === null) start = k; continue; }
      if (start !== null) {
        const w = xs[k - 1] - xs[start];
        if (w > bestW) { bestW = w; bestX = (xs[start] + xs[k - 1]) / 2; }
        start = null;
      }
    }
    edges.push(bestX);
  }
  return edges; // edges[i] separates cols[i] (right) from cols[i+1] (left)
}

function colIndexForWord(w, edges) {
  for (let i = 0; i < edges.length; i++) if (w.xc > edges[i]) return i;
  return edges.length;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

function parseDeliveryTable(tsv) {
  const words = parseTsv(tsv);
  if (!words.length) return null;
  const pages = [...new Set(words.map((w) => w.page))].sort((a, b) => a - b);

  let groupCity = null;    // city from a section title, if the file has one
  let header = null;       // last header seen (reused on pages without one)
  let headerRouteX = null; // x of the route column header, to detect page shifts
  const rows = [];

  for (const p of pages) {
    const pw = words.filter((w) => w.page === p);
    const h = findHeader(pw);
    let shift = 0;
    let data = pw;
    if (h) {
      header = h;
      data = pw.filter((w) => w.yc > h.yBottom + 1);
      // a section title like "ביתר עילית (28)" above the table names the city
      if (!groupCity) {
        for (const ln of groupLines(pw.filter((w) => w.yc < h.yBottom - 4))) {
          const t = cellText(ln);
          const m = t.match(/^([א-ת][א-ת"'׳״\s-]{1,30}?)\s*[()]\d+[()]$/);
          if (m) { groupCity = m[1].trim(); break; }
        }
      }
    } else if (!header) {
      continue; // no header yet — can't interpret this page
    }
    const cols = header.cols;
    const routeIdx = cols.findIndex((c) => c.field === 'route');
    if (routeIdx === -1) return null;

    // Route-number anchors: plain integers right of the first column gutter.
    const routeCol = cols[routeIdx];
    const nearRoute = data.filter((w) => /^\d{1,4}$/.test(w.text) && w.x0 > cols[routeIdx + 1].x1 - 2 + 0);
    // On pages without their own header, the whole table may sit a few points
    // to the side — estimate the shift from where the row numbers are.
    if (!h && nearRoute.length) {
      const medianX = nearRoute.map((w) => w.xc).sort((a, b) => a - b)[Math.floor(nearRoute.length / 2)];
      shift = medianX - (routeCol.x0 + routeCol.x1) / 2;
      if (Math.abs(shift) > 40) shift = 0;
    }
    const edges = columnEdges(cols, data, shift);
    const anchors = data
      .filter((w) => /^\d{1,4}$/.test(w.text) && colIndexForWord(w, edges) === routeIdx)
      .sort((a, b) => a.yc - b.yc);
    if (!anchors.length) continue;

    // Assign each text line (one line inside one cell) to the nearest row
    // anchor by its vertical centre. Cells that wrap onto 2–3 lines are
    // vertically centred in their row, so each of their lines is still
    // closer to its own row number than to the neighbours'.
    const pageRows = anchors.map((a) => ({ num: +a.text, yc: a.yc, cells: cols.map(() => []) }));
    const gaps = anchors.slice(1).map((a, i) => a.yc - anchors[i].yc).sort((a, b) => a - b);
    const typicalGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 30;
    const bottomLimit = anchors[anchors.length - 1].yc + Math.max(20, typicalGap * 1.2);
    for (const ln of groupLines(data)) {
      for (const w of ln) {
        if (anchors.includes(w)) continue;
        if (w.yc > bottomLimit) continue; // footer below the table
        let best = 0, bd = Infinity;
        pageRows.forEach((r, i) => { const d = Math.abs(r.yc - w.yc); if (d < bd) { bd = d; best = i; } });
        pageRows[best].cells[colIndexForWord(w, edges)].push(w);
      }
    }
    pageRows.forEach((r) => rows.push({ num: r.num, cells: r.cells.map(cellText), cols }));
  }
  if (!rows.length) return null;

  const res = entriesFromRows(rows.map((r) => ({
    num: r.num,
    qtyLabel: (r.cols.find((c) => c.field === 'qty') || {}).label,
    get: (field) => r.cols.map((c, i) => (c.field === field ? r.cells[i] : '')).filter(Boolean).join(' '),
  })));
  if (!res.commonCity && groupCity) {
    res.commonCity = groupCity;
    // drop the city from addresses that repeat it ("... 10 ביתר עילית")
    res.entries.forEach((e) => { e.text = e.text.replace(new RegExp('[,\\s]*' + groupCity + '\\s*$'), '').trim(); });
  }
  return res;
}

// Shared by PDF and Excel/CSV: rows → delivery entries {text, notes, city…}
function entriesFromRows(rows) {
  const entries = [];
  let lowConfidenceCount = 0;
  const str = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
  for (const r of rows) {
    let street = str(r.get('street'));
    let house = str(r.get('house'));
    if (!street && !house) continue;
    street = street.replace(/([א-ת])(\d)/g, '$1 $2').replace(/(\d)([א-ת]{2,})/g, '$1 $2').trim();
    // "בן איש חי 56" + number 56 → don't repeat the number
    if (house && new RegExp('(^|\\s)' + house.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$').test(street)) house = '';
    const text = (street + (house ? ' ' + house : '')).replace(/\s+/g, ' ').trim();

    const notes = [];
    const unit = str(r.get('unit'));
    if (unit) notes.push(/^-?\d+(\.\d+)?$/.test(unit) ? 'קומה/דירה: ' + unit : unit);

    // Content repair: in some PDFs neighbouring columns touch, so a phone can
    // land in the quantity column or an order number in the name column.
    // Sort the pieces out by what they look like.
    const fixLeading0 = (t) => t.replace(/(^|\s)([57]\d{8})(?=\s|$)/g, '$10$2').replace(/(^|\s)([2-489]\d{7})(?=\s|$)/g, '$10$2');
    const PHONE_RE = /0\d[\d-]{6,10}\d/g;
    let phoneTxt = fixLeading0(str(r.get('phone')));
    let cityTxt = str(r.get('city'));
    let qtyTxt = str(r.get('qty'));
    let extraTxt = str(r.get('extra'));
    let orderTxt = str(r.get('order'));
    let first = str(r.get('first')), last = str(r.get('last'));
    const phones = [];
    const takePhones = (t) => fixLeading0(t).replace(PHONE_RE, (m) => { if (!phones.includes(m)) phones.push(m); return ' '; }).replace(/\s+/g, ' ').trim();
    phoneTxt = takePhones(phoneTxt); cityTxt = takePhones(cityTxt); qtyTxt = takePhones(qtyTxt);
    if (!phones.length) extraTxt = takePhones(extraTxt);
    // order numbers (5–7 digits) stuck to the name
    const takeOrder = (t) => t.replace(/(^|\s)(\d{5,7})(?=\s|$)/g, (m, sp, n) => { if (!orderTxt) orderTxt = n; return ' '; }).replace(/\s*—\s*/g, ' ').trim();
    first = takeOrder(first); last = takeOrder(last);
    // quantity = a small whole number
    const qm = qtyTxt.match(/\d{1,4}/g);
    const qty = qm ? parseInt(qm[qm.length - 1], 10) : null;
    const qtyRest = qm ? qtyTxt.replace(qm[qm.length - 1], '').trim() : qtyTxt;

    const name = first && last && first === last ? first : [first, last].filter(Boolean).join(' ');
    if (name) notes.push(name);
    const cityText = [phoneTxt, cityTxt].filter(Boolean).join(' ').replace(/[;,.:]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (phones.length) notes.push('טל: ' + phones.join(', '));
    const qtyLabel = (r.qtyLabel || 'כמות').replace(/[:]/g, '').trim();
    // quantity is shown separately (badge + totals), not inside the notes
    if (qtyRest) notes.push(qtyRest);
    if (orderTxt) notes.push('הזמנה ' + orderTxt);
    const extra = str(r.get('notes'));
    if (extra) notes.push(extra);
    if (extraTxt) notes.push(extraTxt);

    const lowConfidence = !HEBREW.test(street) || !/\d/.test(house || street);
    if (lowConfidence) lowConfidenceCount++;
    entries.push({ text, notes: notes.join(' · ') || null, lowConfidence, city: cityText || null, rowNum: r.num,
      qty, qtyLabel, orders: orderTxt ? [orderTxt] : [] });
  }

  // Same address more than once (e.g. two orders for one family) → one stop
  // with the quantities added up, so the courier sees the exact total.
  const merged = [];
  const byKey = new Map();
  const keyOf = (e) => (e.text + '|' + (e.city || '')).replace(/["'׳״\s,.-]/g, '');
  for (const e of entries) {
    const k = keyOf(e);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, e); merged.push(e); continue; }
    if (e.qty != null) prev.qty = (prev.qty || 0) + e.qty;
    prev.orders = prev.orders.concat(e.orders);
    prev.notes = [prev.notes, e.notes].filter(Boolean).join(' | ');
    prev.mergedCount = (prev.mergedCount || 1) + 1;
    if (e.lowConfidence) prev.lowConfidence = true;
  }
  merged.forEach((e) => {
    if (e.mergedCount > 1 && e.qty != null) e.notes = `סה"כ ${e.qtyLabel || 'כמות'}: ${e.qty} (${e.mergedCount} משלוחים לאותה כתובת) | ` + e.notes;
  });
  entries.length = 0; entries.push(...merged);
  lowConfidenceCount = entries.filter((e) => e.lowConfidence).length;

  // City: if most rows share one city, report it once (the app puts it in the
  // "common city" field) and keep only genuinely different cities per row.
  const counts = {};
  entries.forEach((e) => { if (e.city) counts[e.city] = (counts[e.city] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  let commonCity = null;
  if (top && top[1] >= entries.length * 0.6) commonCity = top[0];
  entries.forEach((e) => {
    // same city written slightly differently ("ביתר" vs "ביתר עילית") → treat as the common one
    if (e.city && commonCity && (levenshtein(e.city, commonCity) <= 1 || commonCity.startsWith(e.city + ' ') || e.city.startsWith(commonCity + ' '))) e.city = null;
  });
  return { entries, lowConfidenceCount, commonCity };
}

// Excel / CSV: rows = array of arrays of cell values. Finds the header row
// (within the first 15 rows) and reads every row below it.
function parseSpreadsheetRows(rows) {
  let hdr = -1, fields = null;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const f = assignFields(rows[i] || []);
    const known = new Set(f.filter((x) => x.field && x.field !== 'extra').map((x) => x.field));
    if (known.has('street') && known.size >= 2) { hdr = i; fields = f; break; }
  }
  if (hdr === -1) return null;
  const data = rows.slice(hdr + 1).filter((r) => (r || []).some((c) => String(c == null ? '' : c).trim()));
  const res = entriesFromRows(data.map((r, k) => ({
    num: k + 1,
    qtyLabel: (fields.find((f) => f.field === 'qty') || {}).label,
    get: (field) => fields.map((f, i) => (f.field === field ? r[i] : null))
      .filter((v) => v != null && String(v).trim() !== '').join(' '),
  })));
  return res.entries.length ? res : null;
}

module.exports = { parseDeliveryTable, parseSpreadsheetRows, parseTsv, logicalWord };
