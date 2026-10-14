const els = id => document.getElementById(id);

/* =========================================================================
   STATE
========================================================================= */
const state = {
  view: 'dashboard',
  currentUser: null,
  deliveryLog: [],
  settings: { prices: { regular: 10, special: 15, books: 15 }, specialWeeks: [] },
  routeKind: 'auto',
  start: null,          // {text, lat, lon}
  end: null,             // {text, lat, lon}
  endSameAsStart: true,
  routePref: 'fastest',
  departureTime: null,
  pendingAddresses: [],  // raw strings queued before geocoding, from textarea/customers
  stops: [],             // active working stops: {id, raw, name, lat, lon, geocodeStatus, candidates, area, windowStart, windowEnd, deliveryStatus, order, legDist, legDur, eta, manual}
  routeGeometry: null,   // [[lat,lon],...] — full loop/trip
  outboundGeometry: null, // [[lat,lon],...] — start through the last stop
  returnGeometry: null,   // [[lat,lon],...] — last stop to the end point
  outboundDistance: null, outboundDuration: null,
  returnDistance: null, returnDuration: null,
  mapMode: 'full', // 'full' | 'outbound' | 'return'
  mapProvider: 'leaflet', // 'leaflet' (default, free) | 'google' (if a key is configured)
  routeIsManual: false,
  liveNav: { active:false, watchId:null, steps:[], currentStepIndex:0, map:null, vehicleMarker:null,
    routeLine:null, targetStop:null, lastPos:null, lastAnnouncedIndex:-1, provider:null },
  customers: [],         // {id, name, addr, area, lat, lon, windowStart, windowEnd}
  savedRoutes: [],        // {id, name, createdAt, snapshot:{...}}
  history: [],
  drivingIndex: 0,
  map: null,
  markersLayer: null,
  routeLine: null,
};

let idCounter = 1;
function newId(){ return 'id' + (idCounter++) + '-' + Date.now().toString(36); }

/* =========================================================================
   API HELPER
========================================================================= */
async function api(path, opts){
  const timeoutMs = opts && opts.timeoutMs;
  const controller = timeoutMs ? new AbortController() : null;
  const timer = timeoutMs ? setTimeout(()=> controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(path, {
      method: (opts && opts.method) || 'GET',
      headers: {'Content-Type':'application/json'},
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      signal: controller ? controller.signal : undefined,
    });
  } catch(e){
    if (e.name === 'AbortError') throw new Error('timeout');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch(e){ /* empty body */ }
  if (!res.ok){
    const err = new Error((data && data.error) || ('שגיאת שרת ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

/* =========================================================================
   PERSISTENT DATA — real server-side storage, scoped to the logged-in user
========================================================================= */
/* ---- OFFLINE: a copy of the user's data is kept on this device, so saved
   routes and today's route open even without internet. Changes made while
   offline are kept on the device and sent to the server when it's back. ---- */
const OFFLINE_KEY = 'derech-offline-v1';
function isNetworkError(e){
  return !e || e instanceof TypeError || e.message === 'timeout' || e.message === 'Failed to fetch' || navigator.onLine === false;
}
function readOfflineCopy(){
  try { return JSON.parse(localStorage.getItem(OFFLINE_KEY) || 'null'); } catch(e){ return null; }
}
function saveOfflineCopy(){
  if (!state.currentUser) return;
  const data = {
    user: state.currentUser, savedAt: Date.now(),
    customers: state.customers, savedRoutes: state.savedRoutes, history: state.history,
    deliveryLog: state.deliveryLog || [], settings: state.settings || null,
    todayRoute: state.stops.length ? snapshotCurrent() : null,
    pending: state.pendingSync || {},
  };
  try { localStorage.setItem(OFFLINE_KEY, JSON.stringify(data)); }
  catch(e){
    // device storage full — drop the drawn road lines (they're re-fetched online)
    try {
      const slim = JSON.parse(JSON.stringify(data));
      (slim.savedRoutes||[]).forEach(r=>{ if (r.snapshot) r.snapshot.routeGeometry = null; });
      if (slim.todayRoute) slim.todayRoute.routeGeometry = null;
      localStorage.setItem(OFFLINE_KEY, JSON.stringify(slim));
    } catch(e2){ /* nothing more we can do */ }
  }
}
function clearOfflineCopy(){ try { localStorage.removeItem(OFFLINE_KEY); } catch(e){} }

function setOfflineMode(on){
  state.offline = !!on;
  let bar = document.getElementById('offlineBar');
  if (on && !bar){
    bar = document.createElement('div');
    bar.id = 'offlineBar';
    bar.style.cssText = 'position:sticky;top:0;z-index:60;background:#e5a13c;color:#1b1406;font-weight:700;font-size:13.5px;text-align:center;padding:8px 12px;';
    bar.textContent = '📴 אין חיבור לאינטרנט — מוצגים המסלולים השמורים במכשיר. סימוני "נמסר" נשמרים ויישלחו כשיחזור החיבור.';
    const app = document.getElementById('app');
    app.insertBefore(bar, app.firstChild);
  } else if (!on && bar){
    bar.remove();
  }
}

async function loadAll(){
  try {
    const [c, sr, h, t, dl, st] = await Promise.all([
      api('/api/data/customers'), api('/api/data/savedRoutes'),
      api('/api/data/history'), api('/api/data/todayRoute'),
      api('/api/data/deliveryLog'), api('/api/data/settings'),
    ]);
    state.customers = c.value || []; state.savedRoutes = sr.value || []; state.history = h.value || [];
    state.deliveryLog = Array.isArray(dl.value) ? dl.value : [];
    state.settings = normalizeSettings(st.value);
    const local = readOfflineCopy();
    // Changes made offline that never reached the server win over the server copy
    if (local && local.pending && Object.keys(local.pending).length && local.user && state.currentUser && local.user.id === state.currentUser.id){
      if (local.pending.savedRoutes) state.savedRoutes = local.savedRoutes || state.savedRoutes;
      if (local.pending.customers) state.customers = local.customers || state.customers;
      if (local.pending.history) state.history = local.history || state.history;
      if (local.pending.deliveryLog) state.deliveryLog = local.deliveryLog || state.deliveryLog;
      if (local.pending.settings) state.settings = normalizeSettings(local.settings);
      if (local.pending.todayRoute && local.todayRoute) applySnapshot(local.todayRoute, false);
      else if (t.value) applySnapshot(t.value, false);
      state.pendingSync = local.pending;
      syncPending();
    } else if (t.value) {
      applySnapshot(t.value, false);
    }
    setOfflineMode(false);
    saveOfflineCopy();
  } catch(e){
    if (!(isNetworkError(e) && loadFromOfflineCopy())){
      state.customers = state.customers || []; state.savedRoutes = state.savedRoutes || []; state.history = state.history || [];
    }
  }
}
function loadFromOfflineCopy(){
  const local = readOfflineCopy();
  if (!local || !local.user) return false;
  // never show another account's data from this device
  if (state.currentUser && local.user.id !== state.currentUser.id) return false;
  state.customers = local.customers || []; state.savedRoutes = local.savedRoutes || []; state.history = local.history || [];
  state.deliveryLog = local.deliveryLog || []; state.settings = normalizeSettings(local.settings);
  if (local.todayRoute) applySnapshot(local.todayRoute, false);
  state.pendingSync = local.pending || {};
  setOfflineMode(true);
  return true;
}

// Each save goes to the device first, then to the server. If the server
// can't be reached, the change is marked and sent again later.
async function persistKey(key, value, failMsg){
  saveOfflineCopy();
  try {
    await api('/api/data/' + key, {method:'PUT', body:{value}});
    if (state.pendingSync && state.pendingSync[key]){ delete state.pendingSync[key]; saveOfflineCopy(); }
  } catch(e){
    if (isNetworkError(e)){
      state.pendingSync = state.pendingSync || {};
      state.pendingSync[key] = true;
      saveOfflineCopy();
      setOfflineMode(true);
    } else if (failMsg) toast(failMsg);
  }
}
async function persistCustomers(){ await persistKey('customers', state.customers, 'שמירת הלקוחות נכשלה'); }
async function persistSavedRoutes(){ await persistKey('savedRoutes', state.savedRoutes, 'שמירת המסלול נכשלה'); }
async function persistHistory(){ await persistKey('history', state.history); }
async function persistTodayRoute(){ await persistKey('todayRoute', state.stops.length ? snapshotCurrent() : null); }

let syncing = false;
async function syncPending(){
  if (syncing || !state.currentUser) return;
  const keys = Object.keys(state.pendingSync || {});
  if (!keys.length) return;
  syncing = true;
  try {
    for (const k of keys){
      const value = k === 'todayRoute' ? (state.stops.length ? snapshotCurrent() : null) : state[k];
      await api('/api/data/' + k, {method:'PUT', body:{value}});
      delete state.pendingSync[k];
    }
    saveOfflineCopy();
    setOfflineMode(false);
    toast('החיבור חזר — השינויים נשמרו בשרת');
  } catch(e){ /* still offline */ }
  syncing = false;
}
window.addEventListener('online', ()=>{ syncPending(); if (!Object.keys(state.pendingSync||{}).length) setOfflineMode(false); });
window.addEventListener('offline', ()=> setOfflineMode(true));

function snapshotCurrent(){
  return {
    start: state.start, end: state.end, endSameAsStart: state.endSameAsStart,
    routePref: state.routePref, departureTime: state.departureTime,
    stops: state.stops, routeGeometry: state.routeGeometry, routeIsManual: state.routeIsManual,
    routeKind: state.routeKind || 'auto', routeName: state.routeName || null,
    routePrice: state.routePrice ?? null,
  };
}
// A saved route is a template: store it without today's delivery statuses.
function templateSnapshot(){
  const snap = snapshotCurrent();
  snap.stops = (snap.stops || []).map(s=> ({...s, deliveryStatus:'ממתין', statusAt:null, eta:null, actionNote:null, chargedPrice:null}));
  return snap;
}
function applySnapshot(snap, redraw){
  state.start = snap.start; state.end = snap.end; state.endSameAsStart = snap.endSameAsStart;
  state.routePref = snap.routePref || 'fastest'; state.departureTime = snap.departureTime || null;
  state.stops = snap.stops || []; state.routeGeometry = snap.routeGeometry || null;
  state.routeIsManual = !!snap.routeIsManual;
  state.routeKind = snap.routeKind || 'auto'; state.routeName = snap.routeName || null;
  state.routePrice = snap.routePrice ?? null;
  if (redraw) renderResult();
}

/* =========================================================================
   UTIL
========================================================================= */
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>el.classList.remove('show'), 2600);
}
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function fmtKm(meters){ return (meters/1000).toFixed(1); }
function fmtDuration(seconds){
  const h = Math.floor(seconds/3600), m = Math.round((seconds%3600)/60);
  if (h > 0) return h + ':' + String(m).padStart(2,'0') + ' שעות';
  return m + ' דק׳';
}
function fmtClock(date){
  return date.getHours().toString().padStart(2,'0') + ':' + date.getMinutes().toString().padStart(2,'0');
}
function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* =========================================================================
   NAVIGATION
========================================================================= */
function switchView(name){
  state.view = name;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
  document.querySelectorAll('#mainNav button').forEach(b=>{
    b.classList.toggle('active', b.dataset.view === name);
  });
  window.scrollTo({top:0, behavior:'instant'});
  if (name === 'result') setTimeout(initOrRefreshMap, 30);
  if (name === 'dashboard') renderDashboard();
  if (name === 'customers') renderCustomers();
  if (name === 'savedRoutes') renderSavedRoutes();
  if (name === 'report') renderReport();
  if (name === 'builder' && !state.pendingAddresses.length){
    state.pendingAddresses.push({id:newId(), text:''});
    renderAddressRows();
  }
}
document.querySelectorAll('[data-view]').forEach(el=>{
  el.addEventListener('click', ()=>{
    if (el.dataset.view === 'builder') clearBuilderForNewRoute();
    switchView(el.dataset.view);
  });
});

// "מסלול חדש" always opens a clean list. The previous list is kept aside
// so it can be brought back with one tap if the button was pressed by mistake.
let previousAddresses = null;
function clearBuilderForNewRoute(){
  const filled = state.pendingAddresses.filter(p=> (p.text||'').trim());
  if (filled.length){
    previousAddresses = { list: filled, city: els('globalCityInput').value };
  }
  state.pendingAddresses = [];
  els('addrTextarea').value = '';
  els('globalCityInput').value = '';
  const pick = els('pickCustomersCard'); if (pick) pick.style.display = 'none';
  renderAddressRows();
  updateRestoreButton();
}
function updateRestoreButton(){
  const b = els('restorePrevAddrsBtn');
  if (!b) return;
  const hasNew = state.pendingAddresses.some(p=> (p.text||'').trim());
  if (previousAddresses && !hasNew){
    b.textContent = `↩ החזר את הרשימה הקודמת (${previousAddresses.list.length} כתובות)`;
    b.style.display = '';
  } else {
    b.style.display = 'none';
  }
}
els('addressRowsContainer').addEventListener('input', updateRestoreButton);
els('restorePrevAddrsBtn').addEventListener('click', ()=>{
  if (!previousAddresses) return;
  state.pendingAddresses = previousAddresses.list;
  if (!els('globalCityInput').value) els('globalCityInput').value = previousAddresses.city || '';
  previousAddresses = null;
  renderAddressRows();
  updateRestoreButton();
  toast('הרשימה הקודמת הוחזרה');
});

/* =========================================================================
   GEOCODING — proxied through our own server (/api/geocode), which calls
   Nominatim server-side. This avoids the browser network restrictions that
   blocked direct calls, and lets the server send a proper identifying
   User-Agent as Nominatim's usage policy expects.
========================================================================= */
async function geocodeOne(query, city){
  try {
    let url = '/api/geocode?q=' + encodeURIComponent(query);
    if (city) url += '&city=' + encodeURIComponent(city);
    return await api(url);
  } catch(e){
    const err = new Error('geocode-failed');
    err.detail = e.message;
    throw err;
  }
}
async function geocodeQueue(items, onProgress, city){
  // items: [{id, query}]. Returns {results, errors} — errors holds a real failure message per id
  // (network/HTTP problems), separate from a legitimate zero-match result.
  const results = {}, errors = {};
  for (let i=0;i<items.length;i++){
    const it = items[i];
    try {
      results[it.id] = await geocodeOne(it.query, city);
    } catch(e){
      results[it.id] = [];
      errors[it.id] = e.detail || e.message || 'שגיאה לא ידועה';
    }
    if (onProgress) onProgress(i+1, items.length);
  }
  return { results, errors };
}

/* =========================================================================
   ADDRESS PARSING
========================================================================= */
function parseAddressLines(text){
  // Each line is an address. Optionally, "כתובת || הערות" adds a note for
  // the courier (floor, apartment, name, phone, special instructions...)
  // that travels with that stop instead of being lost.
  return text.split('\n')
    .map(l=>l.trim())
    .filter(l=>l.length>0)
    .map(l=>l.replace(/^\s*\(?\d{1,3}[\.\)\-]\s*/, '').replace(/^[•\-\*]\s*/, '').trim())
    .filter(l=>l.length>0)
    .map(l=>{
      const parts = l.split('||');
      return { text: parts[0].trim(), notes: parts.length>1 ? parts.slice(1).join('||').trim() : null };
    });
}

/* =========================================================================
   BUILDER VIEW LOGIC
========================================================================= */

els('endSameAsStart').addEventListener('change', (e)=>{
  state.endSameAsStart = e.target.checked;
  els('endInput').disabled = e.target.checked;
  if (e.target.checked) els('endInput').value = '';
});
els('routePref').addEventListener('change', e=> state.routePref = e.target.value);
els('departureTime').addEventListener('change', e=> state.departureTime = e.target.value || null);

/* address autocomplete for the start/end fields — debounced live search */
function attachAddressAutocomplete(inputEl, onSelect){
  const wrap = inputEl.closest('.autocomplete-wrap');
  if (!wrap) return;
  let listEl = null, debounceTimer = null, activeRequestId = 0;

  function closeList(){
    if (listEl){ listEl.remove(); listEl = null; }
  }
  function renderList(suggestions){
    closeList();
    if (!suggestions.length) return;
    listEl = document.createElement('div');
    listEl.className = 'autocomplete-list';
    suggestions.forEach(s=>{
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.textContent = s.display_name;
      item.addEventListener('mousedown', (e)=>{
        e.preventDefault(); // keep focus so the click registers before blur closes the list
        inputEl.value = s.display_name;
        // Mark this as a confirmed selection BEFORE the input event fires, so
        // the listener that syncs state to the field knows not to treat it as
        // free typing (and therefore not to discard the coordinates we
        // already have — no need to search this text again later).
        inputEl.dataset.justSelected = '1';
        if (onSelect) onSelect(s);
        inputEl.dispatchEvent(new Event('input', {bubbles:true}));
        closeList();
      });
      listEl.appendChild(item);
    });
    wrap.appendChild(listEl);
  }

  inputEl.addEventListener('input', ()=>{
    const q = inputEl.value.trim();
    clearTimeout(debounceTimer);
    if (q.length < 3){ closeList(); return; }
    debounceTimer = setTimeout(async ()=>{
      const requestId = ++activeRequestId;
      try {
        const city = els('globalCityInput') ? els('globalCityInput').value.trim() : '';
        const r = await geocodeOne(q, city || null);
        if (requestId !== activeRequestId) return; // a newer keystroke superseded this request
        renderList((r||[]).slice(0,6));
      } catch(e){ /* silently ignore — this is just a convenience suggestion list */ }
    }, 400);
  });
  inputEl.addEventListener('blur', ()=> setTimeout(closeList, 150));
}
// start/end fields: same "selection sticks" behavior as the address rows above
state.startResolved = null; // {text, lat, lon, label} once a suggestion is picked
state.endResolved = null;
function wireResolvableInput(inputEl, stateKey){
  inputEl.addEventListener('input', ()=>{
    if (inputEl.dataset.justSelected){ delete inputEl.dataset.justSelected; return; }
    state[stateKey] = null; // free typing invalidates the previous confirmed match
  });
  attachAddressAutocomplete(inputEl, (s)=>{
    state[stateKey] = { text: s.display_name, lat: parseFloat(s.lat), lon: parseFloat(s.lon), label: s.display_name };
  });
}
wireResolvableInput(els('startInput'), 'startResolved');
wireResolvableInput(els('endInput'), 'endResolved');

function dropEmptyPendingRows(){
  state.pendingAddresses = state.pendingAddresses.filter(p=> (p.text||'').trim().length > 0);
}

els('addFromTextBtn').addEventListener('click', ()=>{
  const lines = parseAddressLines(els('addrTextarea').value);
  if (!lines.length){ toast('לא נמצאו כתובות בטקסט'); return; }
  dropEmptyPendingRows();
  lines.forEach(l=> state.pendingAddresses.push({id:newId(), text:l.text, notes:l.notes}));
  els('addrTextarea').value = '';
  renderAddressRows();
  toast(lines.length + ' כתובות נוספו לרשימה');
});

els('uploadAddrFileBtn').addEventListener('click', ()=> els('addrFileInput').click());
els('addrFileInput').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if (!file) return;
  const btn = els('uploadAddrFileBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> קורא קובץ...';
  try {
    const dataBase64 = await new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = ()=> resolve(reader.result.split(',')[1] || '');
      reader.onerror = ()=> reject(new Error('קריאת הקובץ נכשלה'));
      reader.readAsDataURL(file);
    });
    const r = await api('/api/parse-addresses', {method:'POST', body:{filename:file.name, dataBase64}});
    const addresses = r.addresses || [];
    if (!addresses.length){ toast('לא נמצאו כתובות בקובץ'); }
    else {
      dropEmptyPendingRows();
      // The file names one city for (almost) everyone — put it in the common
      // city field, unless the person already filled that in.
      const cityInput = els('globalCityInput');
      const currentCity = cityInput ? cityInput.value.trim() : '';
      if (r.commonCity && cityInput && !currentCity) cityInput.value = r.commonCity;
      const commonCity = (cityInput && cityInput.value.trim()) || r.commonCity || '';
      let lowConfCount = 0;
      addresses.forEach(a=>{
        // A row in a different city than the common one keeps its city in the text.
        const text = a.city && a.city !== commonCity ? `${a.text}, ${a.city}` : a.text;
        const entry = {id:newId(), text, notes:a.notes||null, qty: a.qty ?? null, qtyLabel: a.qtyLabel || null};
        if (a.lowConfidence){ entry.lowConfidence = true; lowConfCount++; }
        state.pendingAddresses.push(entry);
      });
      renderAddressRows();
      let msg = addresses.length + ' כתובות נוספו מהקובץ';
      if (lowConfCount) msg += ` (⚠ ${lowConfCount} מהן מסומנות לבדיקה — לא זוהו בביטחון מלא)`;
      toast(msg);
      if (r.warning) toast(r.warning);
    }
  } catch(err){
    toast(err.message || 'שגיאה בקריאת הקובץ');
  }
  btn.disabled = false; btn.textContent = originalLabel;
  e.target.value = ''; // allow re-selecting the same file later
});

els('pickCustomersBtn').addEventListener('click', ()=>{
  const card = els('pickCustomersCard');
  card.style.display = card.style.display === 'none' ? 'block' : 'none';
  if (card.style.display === 'block') renderCustomerPickList();
});

function renderAddressRows(focusLastEmpty){
  setTimeout(updateRestoreButton, 0);
  if (!state.pendingAddresses.length){
    state.pendingAddresses.push({id:newId(), text:''});
  }
  const wrap = els('addressRowsContainer');
  wrap.innerHTML = '';
  state.pendingAddresses.forEach(p=>{
    const row = document.createElement('div');
    row.className = 'address-row';
    if (p.lowConfidence) row.classList.add('low-confidence');

    const mainCol = document.createElement('div');
    mainCol.style.flex = '1';
    mainCol.style.minWidth = '0';

    if (p.lowConfidence){
      const warn = document.createElement('div');
      warn.className = 'low-confidence-badge';
      warn.textContent = '⚠ לא זוהתה בביטחון מלא מתוך הקובץ — בדוק מול המקור';
      mainCol.appendChild(warn);
    }

    const acWrap = document.createElement('div');
    acWrap.className = 'autocomplete-wrap';
    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = p.name ? `${p.name} — כתובת` : 'כתובת משלוח';
    input.value = p.text || '';
    input.addEventListener('input', ()=>{
      p.text = input.value;
      p.lowConfidence = false; // editing it means it's been reviewed
      if (input.dataset.justSelected){
        delete input.dataset.justSelected; // confirmed selection — keep the coordinates onSelect just set
      } else {
        // free typing invalidates any previously confirmed match, so it gets re-searched properly
        p.lat = null; p.lon = null; p.resolvedLabel = null; p.geocodeStatus = null; p.candidates = null;
      }
    });
    acWrap.appendChild(input);
    mainCol.appendChild(acWrap);

    const notesInput = document.createElement('input');
    notesInput.type = 'text';
    notesInput.className = 'address-notes-input';
    notesInput.placeholder = 'הערה לשליח (קומה, דירה, שם, טלפון, הוראות מסירה...) — לא חובה';
    notesInput.value = p.notes || '';
    notesInput.addEventListener('input', ()=>{ p.notes = notesInput.value; });
    mainCol.appendChild(notesInput);

    row.appendChild(mainCol);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'icon-btn';
    removeBtn.title = 'הסר';
    removeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
    removeBtn.addEventListener('click', ()=>{
      state.pendingAddresses = state.pendingAddresses.filter(x=>x.id!==p.id);
      renderAddressRows();
    });
    row.appendChild(removeBtn);

    wrap.appendChild(row);
    attachAddressAutocomplete(input, (s)=>{
      // The person picked a suggestion Nominatim already matched — trust it
      // directly instead of searching the same text again at calculation time.
      p.lat = parseFloat(s.lat); p.lon = parseFloat(s.lon);
      p.resolvedLabel = s.display_name; p.geocodeStatus = 'ok'; p.candidates = [];
    });
    if (focusLastEmpty && !p.text) input.focus();
  });
}
els('addEmptyRowBtn').addEventListener('click', ()=>{
  state.pendingAddresses.push({id:newId(), text:''});
  renderAddressRows(true);
});

function areaOptionsHtml(areas){
  return areas.map(a=>`<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
}
function refreshAreaFilters(){
  const areas = [...new Set(state.customers.map(c=>c.area).filter(Boolean))];
  ['areaFilterBuilder','areaFilterCustomers'].forEach(id=>{
    const sel = els(id);
    const cur = sel.value;
    const firstOpt = sel.options[0];
    sel.innerHTML = '';
    sel.appendChild(firstOpt);
    sel.insertAdjacentHTML('beforeend', areaOptionsHtml(areas));
    sel.value = areas.includes(cur) ? cur : '';
  });
}

function renderCustomerPickList(){
  refreshAreaFilters();
  const filterArea = els('areaFilterBuilder').value;
  const list = els('customerPickList');
  const hint = els('noCustomersHintBuilder');
  const filtered = state.customers.filter(c=> !filterArea || c.area === filterArea);
  hint.style.display = state.customers.length ? 'none' : 'block';
  list.innerHTML = '';
  filtered.forEach(c=>{
    const row = document.createElement('div');
    row.className = 'cust-row';
    const alreadyIn = state.pendingAddresses.some(p=>p.customerId === c.id);
    row.innerHTML = `
      <input type="checkbox" ${alreadyIn?'checked':''} id="pick-${c.id}">
      <div class="cust-info">
        <div class="cust-name">${escapeHtml(c.name)}</div>
        <div class="cust-addr">${escapeHtml(c.addr)}</div>
        ${c.area ? `<span class="badge badge-muted cust-area">${escapeHtml(c.area)}</span>`:''}
      </div>`;
    row.querySelector('input').addEventListener('change', (e)=>{
      if (e.target.checked){
        if (!state.pendingAddresses.some(p=>p.customerId===c.id)){
          dropEmptyPendingRows();
          state.pendingAddresses.push({id:newId(), text:c.addr, customerId:c.id, name:c.name, area:c.area,
            windowStart:c.windowStart, windowEnd:c.windowEnd, lat:c.lat, lon:c.lon, geocodeStatus: (c.lat!=null?'ok':undefined)});
        }
      } else {
        state.pendingAddresses = state.pendingAddresses.filter(p=>p.customerId!==c.id);
      }
      renderAddressRows();
    });
    list.appendChild(row);
  });
}
els('areaFilterBuilder').addEventListener('change', renderCustomerPickList);

/* =========================================================================
   CALCULATE ROUTE — main pipeline
========================================================================= */
els('calcRouteBtn').addEventListener('click', startRouteCalculation);

async function startRouteCalculation(){
  state.currentSavedRouteId = null;
  const startText = els('startInput').value.trim();
  if (!startText){ toast('הכנס נקודת התחלה'); return; }
  if (!state.endSameAsStart && !els('endInput').value.trim()){ toast('הכנס נקודת סיום או סמן חזרה להתחלה'); return; }

  // drop empty/placeholder rows before checking — the builder always shows
  // at least one blank row ready for typing, which shouldn't count as an address
  state.pendingAddresses = state.pendingAddresses.filter(p=> (p.text||'').trim().length > 0);
  if (!state.pendingAddresses.length){ toast('הוסף לפחות כתובת משלוח אחת'); return; }

  state.endSameAsStart = els('endSameAsStart').checked;
  const globalCity = els('globalCityInput').value.trim() || null;
  const endText = els('endInput').value.trim();

  // If the person picked start/end from the autocomplete dropdown and hasn't
  // edited it since, trust that match directly instead of searching the same
  // text again (which is exactly what was failing before).
  const startAlreadyResolved = state.startResolved && state.startResolved.text === startText;
  const endAlreadyResolved = !state.endSameAsStart && state.endResolved && state.endResolved.text === endText;

  // Build the geocode queue: start, end(if needed), each pending address without lat/lon yet
  const queue = [];
  if (!startAlreadyResolved) queue.push({id:'__start__', query: startText});
  if (!state.endSameAsStart && !endAlreadyResolved) queue.push({id:'__end__', query: endText});
  state.pendingAddresses.forEach(p=>{
    if (p.lat == null) queue.push({id:p.id, query:p.text});
  });

  // Dedupe identical address text before geocoding — this is both faster
  // (fewer lookups) and correct for delivery lists that legitimately need
  // to visit the exact same address twice (e.g. two packages, same building).
  const normKey = (t)=> (t||'').trim().toLowerCase();
  const uniqueMap = new Map(); // normalized text -> {query, ids:[]}
  queue.forEach(it=>{
    const key = normKey(it.query);
    if (!uniqueMap.has(key)) uniqueMap.set(key, {query: it.query, ids: []});
    uniqueMap.get(key).ids.push(it.id);
  });
  const uniqueEntries = Array.from(uniqueMap.values());
  const uniqueItems = uniqueEntries.map((v,i)=>({id:'u'+i, query:v.query}));

  const btn = els('calcRouteBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true;

  const geo = await geocodeQueue(uniqueItems, (done,total)=>{
    btn.innerHTML = `<span class="spinner"></span> מאמת כתובות (${done}/${total})`;
  }, globalCity);
  btn.disabled = false; btn.textContent = originalLabel;

  // map unique results back onto every original id that shared that text
  const results = {}, geoErrors = {};
  uniqueEntries.forEach((v, i)=>{
    const uid = 'u'+i;
    v.ids.forEach(origId=>{
      results[origId] = geo.results[uid];
      if (geo.errors[uid]) geoErrors[origId] = geo.errors[uid];
    });
  });

  // apply start/end
  if (startAlreadyResolved){
    state.start = { id:'__start__', text:startText, lat:state.startResolved.lat, lon:state.startResolved.lon,
      resolvedLabel:state.startResolved.label, geocodeStatus:'ok', candidates:[] };
  } else {
    applyGeocodeResult('__start__', results['__start__'], startText, 'start', geoErrors['__start__']);
  }
  if (!state.endSameAsStart){
    if (endAlreadyResolved){
      state.end = { id:'__end__', text:endText, lat:state.endResolved.lat, lon:state.endResolved.lon,
        resolvedLabel:state.endResolved.label, geocodeStatus:'ok', candidates:[] };
    } else {
      applyGeocodeResult('__end__', results['__end__'], endText, 'end', geoErrors['__end__']);
    }
  }

  // build working stop list
  state.stops = state.pendingAddresses.map(p=>{
    if (p.lat != null){
      return { id:p.id, raw:p.text, name:p.name||null, area:p.area||null, notes:p.notes||null, qty:p.qty ?? null, qtyLabel:p.qtyLabel||null, lat:p.lat, lon:p.lon,
        geocodeStatus:'ok', candidates:[], windowStart:p.windowStart||null, windowEnd:p.windowEnd||null,
        deliveryStatus:'ממתין' };
    }
    const r = results[p.id] || [];
    const errMsg = geoErrors[p.id];
    const base = { id:p.id, raw:p.text, name:p.name||null, area:p.area||null, notes:p.notes||null, qty:p.qty ?? null, qtyLabel:p.qtyLabel||null, windowStart:p.windowStart||null,
      windowEnd:p.windowEnd||null, deliveryStatus:'ממתין', candidates:r, errorMsg: errMsg||null };
    if (errMsg){
      return {...base, geocodeStatus:'error'};
    } else if (r.length === 1){
      return {...base, lat:parseFloat(r[0].lat), lon:parseFloat(r[0].lon), geocodeStatus:'ok', resolvedLabel:r[0].display_name};
    } else if (r.length > 1){
      return {...base, geocodeStatus:'ambiguous'};
    } else {
      return {...base, geocodeStatus:'notfound'};
    }
  });

  renderGeoReview();
  switchView('georeview');
}

function applyGeocodeResult(tag, result, originalText, which, errMsg){
  const list = result || [];
  let lat, lon, label, status;
  if (errMsg){ status = 'error'; }
  else if (list.length === 1){ lat=parseFloat(list[0].lat); lon=parseFloat(list[0].lon); label=list[0].display_name; status='ok'; }
  else if (list.length > 1){ lat=parseFloat(list[0].lat); lon=parseFloat(list[0].lon); label=list[0].display_name; status='ambiguous'; }
  else { status='notfound'; }
  const point = { id:tag, text:originalText, lat, lon, resolvedLabel:label, geocodeStatus:status, candidates:list, errorMsg: errMsg||null };
  if (which === 'start') state.start = point; else state.end = point;
}

/* ---- geocode review screen ---- */
function renderGeoReview(){
  const container = els('geoRowsContainer');
  container.innerHTML = '';

  const rows = [];
  rows.push({label:'נקודת התחלה', point: state.start, kind:'start'});
  if (!state.endSameAsStart) rows.push({label:'נקודת סיום', point: state.end, kind:'end'});
  state.stops.forEach(s=> rows.push({label:null, point: s, kind:'stop'}));

  let badCount = rows.filter(r=> r.point.geocodeStatus !== 'ok').length;
  els('geoStatusLine').textContent = badCount === 0
    ? `כל ${rows.length} הכתובות אומתו בהצלחה.`
    : `${badCount} כתובות דורשות את תשומת ליבך מתוך ${rows.length}.`;

  rows.forEach(r=>{
    const p = r.point;
    const row = document.createElement('div');
    row.className = 'geo-row';
    const dotClass = p.geocodeStatus === 'ok' ? 'ok' : (p.geocodeStatus === 'ambiguous' ? 'warn' : 'bad');
    let inner = `<div class="geo-status-dot ${dotClass}"></div><div class="geo-main">`;
    inner += `<div class="geo-input-text">${r.label ? escapeHtml(r.label)+': ' : ''}${escapeHtml(p.text || p.raw)}</div>`;
    if (p.geocodeStatus === 'ok'){
      inner += `<div class="geo-resolved">${escapeHtml(p.resolvedLabel || 'מיקום מאומת')}</div>`;
    } else if (p.geocodeStatus === 'ambiguous'){
      inner += `<div class="geo-error">נמצאו כמה מיקומים אפשריים — בחר את הנכון, או תקן את הכתובת אם אף אחת לא מתאימה:</div>`;
      inner += `<div class="geo-suggestions">`;
      (p.candidates||[]).forEach((c,i)=>{
        inner += `<button class="geo-suggestion-btn" data-pid="${p.id}" data-idx="${i}">${escapeHtml(c.display_name)}</button>`;
      });
      inner += `</div>`;
      inner += `<div class="geo-manual-fix">
        <input type="text" placeholder="אף אחת לא נכונה? נסח מחדש כאן" data-retry="${p.id}">
        <button class="btn btn-secondary" data-retrybtn="${p.id}">חפש שוב</button>
      </div>`;
      inner += `<button class="btn btn-ghost" data-pickmap="${p.id}" style="margin-top:6px">או בחר את המיקום המדויק ידנית על המפה</button>`;
    } else if (p.geocodeStatus === 'error'){
      inner += `<div class="geo-error">שגיאה בפנייה לשירות המיקומים (${escapeHtml(p.errorMsg||'')}) — זו לא בעיה בכתובת עצמה. נסה שוב:</div>`;
      inner += `<div class="geo-manual-fix">
        <button class="btn btn-secondary" data-retrybtn="${p.id}" style="flex:1">נסה שוב</button>
      </div>`;
    } else {
      inner += `<div class="geo-error">הכתובת לא נמצאה. נסה לתקן את הטקסט, או בחר את המיקום ידנית על המפה (שימושי כשמספר הבית חסר במאגר המפות).</div>`;
      inner += `<div class="geo-manual-fix">
        <input type="text" placeholder="נסח מחדש את הכתובת" data-retry="${p.id}">
        <button class="btn btn-secondary" data-retrybtn="${p.id}">נסה שוב</button>
      </div>`;
      inner += `<button class="btn btn-ghost" data-pickmap="${p.id}" style="margin-top:6px">בחר מיקום ידנית על המפה</button>`;
    }
    inner += `</div>`;
    row.innerHTML = inner;
    container.appendChild(row);
  });

  container.querySelectorAll('[data-pickmap]').forEach(btn=>{
    btn.addEventListener('click', ()=> openManualPinPicker(btn.dataset.pickmap));
  });
  container.querySelectorAll('.geo-suggestion-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const pid = btn.dataset.pid, idx = parseInt(btn.dataset.idx);
      applyCandidateChoice(pid, idx);
      renderGeoReview();
    });
  });
  container.querySelectorAll('[data-retrybtn]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const pid = btn.dataset.retrybtn;
      const input = container.querySelector(`[data-retry="${pid}"]`);
      const p = findPointById(pid);
      const q = input ? input.value.trim() : (p.text || p.raw);
      if (input && !q){ toast('הכנס נוסח כתובת חדש'); return; }
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        const r = await geocodeOne(q, els('globalCityInput').value.trim() || null);
        applyRetryResult(pid, q, r, null);
      } catch(e){
        applyRetryResult(pid, q, [], e.detail || e.message || 'שגיאה לא ידועה');
      }
      renderGeoReview();
    });
  });
}

function findPointById(id){
  if (id === '__start__') return state.start;
  if (id === '__end__') return state.end;
  return state.stops.find(s=>s.id===id);
}
function applyCandidateChoice(id, idx){
  const p = findPointById(id);
  const c = p.candidates[idx];
  p.lat = parseFloat(c.lat); p.lon = parseFloat(c.lon); p.resolvedLabel = c.display_name; p.geocodeStatus = 'ok';
}
function applyRetryResult(id, newText, result, errMsg){
  const p = findPointById(id);
  if (id==='__start__'||id==='__end__') p.text = newText; else p.raw = newText;
  p.candidates = result || [];
  p.errorMsg = errMsg || null;
  if (errMsg){
    p.geocodeStatus = 'error';
  } else if (result && result.length === 1){
    p.lat = parseFloat(result[0].lat); p.lon = parseFloat(result[0].lon);
    p.resolvedLabel = result[0].display_name; p.geocodeStatus = 'ok';
  } else if (result && result.length > 1){
    p.geocodeStatus = 'ambiguous';
  } else {
    p.geocodeStatus = 'notfound';
  }
}

els('proceedToRouteBtn').addEventListener('click', async ()=>{
  const unresolved = [state.start, ...(state.endSameAsStart?[]:[state.end]), ...state.stops].filter(p=>p.geocodeStatus!=='ok');
  if (unresolved.length){ toast(`יש עוד ${unresolved.length} כתובות לא מאומתות`); return; }
  await computeOptimalRoute();
});

/* =========================================================================
   ROUTE OPTIMIZATION — OSRM table (matrix, via our server proxy) + local
   nearest-neighbor + 2-opt. Avoids brute-force permutations; scales to
   dozens/hundreds of stops.
========================================================================= */
async function fetchDurationMatrix(points){
  // points: array of {lat, lon}. Returns {durations:[[..]], distances:[[..]]}
  // Capped at 25s: with very large address lists the free routing service can
  // sit there "thinking" instead of failing outright — a timeout makes that
  // look the same as a failure so the straight-line fallback still kicks in
  // instead of leaving the person staring at a spinner indefinitely.
  const data = await api('/api/table', {method:'POST', body:{points}, timeoutMs: 25000});
  if (data.code !== 'Ok') throw new Error('table-error:'+data.code);
  return data;
}

function buildCostMatrix(matrix, pref){
  // Turns the raw OSRM table (durations + distances) into the single 2D cost
  // matrix the optimizer should minimize, based on the chosen preference.
  if (pref === 'shortest') return matrix.distances;
  if (pref === 'balanced'){
    const n = matrix.durations.length;
    let maxDur = 0, maxDist = 0;
    for (let i=0;i<n;i++) for (let j=0;j<n;j++){
      if (matrix.durations[i][j] > maxDur) maxDur = matrix.durations[i][j];
      if (matrix.distances[i][j] > maxDist) maxDist = matrix.distances[i][j];
    }
    maxDur = maxDur || 1; maxDist = maxDist || 1;
    const blended = [];
    for (let i=0;i<n;i++){
      blended.push([]);
      for (let j=0;j<n;j++){
        const d = matrix.durations[i][j], s = matrix.distances[i][j];
        blended[i][j] = (d==null || s==null) ? null : (d/maxDur*0.5 + s/maxDist*0.5);
      }
    }
    return blended;
  }
  return matrix.durations; // 'fastest' (also the default)
}

function buildInitialOrder(n, costMatrix, startIdx, endIdx){
  // Nearest-neighbor construction from startIdx, visiting all "stop" indices,
  // finishing at endIdx.
  const stopIndices = [];
  for (let i=0;i<n;i++) if (i!==startIdx && i!==endIdx) stopIndices.push(i);
  const order = [];
  let current = startIdx;
  const remaining = new Set(stopIndices);
  while (remaining.size){
    let best=null, bestCost=Infinity;
    for (const idx of remaining){
      const c = costMatrix[current][idx];
      if (c!=null && c < bestCost){ bestCost=c; best=idx; }
    }
    if (best==null) { best = remaining.values().next().value; }
    order.push(best);
    remaining.delete(best);
    current = best;
  }
  return order; // does not include start/end
}

function pathCost(costMatrix, startIdx, order, endIdx){
  let total = 0;
  let prev = startIdx;
  for (const idx of order){ total += costMatrix[prev][idx]; prev = idx; }
  total += costMatrix[prev][endIdx];
  return total;
}

function twoOptImprove(costMatrix, startIdx, order, endIdx, maxIterations){
  let improved = true;
  let iterations = 0;
  let best = order.slice();
  let bestCost = pathCost(costMatrix, startIdx, best, endIdx);
  while (improved && iterations < maxIterations){
    improved = false;
    for (let i=0;i<best.length-1 && !improved;i++){
      for (let j=i+1;j<best.length;j++){
        const candidate = best.slice(0,i).concat(best.slice(i,j+1).reverse(), best.slice(j+1));
        const cost = pathCost(costMatrix, startIdx, candidate, endIdx);
        iterations++;
        if (cost < bestCost - 0.01){
          best = candidate; bestCost = cost; improved = true; break;
        }
        if (iterations >= maxIterations) break;
      }
    }
  }
  return best;
}

function buildHaversineMatrix(points){
  // Straight-line distance matrix, computed entirely in the browser — no
  // network call, works for any number of points. Used only as a fallback
  // when the real road-network service (OSRM) fails or times out, which
  // tends to happen with very large stop lists. Distance-only (no duration),
  // so the resulting order is an estimate, not as good as the real thing,
  // but far better than showing nothing.
  const n = points.length;
  const distances = Array.from({length:n}, ()=> new Array(n).fill(0));
  for (let i=0;i<n;i++){
    for (let j=0;j<n;j++){
      if (i===j) continue;
      distances[i][j] = haversineMeters(points[i].lat, points[i].lon, points[j].lat, points[j].lon);
    }
  }
  return { code:'Ok', distances, durations: distances }; // no real duration data — treat distance as the cost either way
}

async function computeOptimalRoute(){
  switchView('result');
  state.mapMode = 'full';
  document.querySelectorAll('#mapTabs [data-mapmode]').forEach(b=>b.classList.toggle('active', b.dataset.mapmode==='full'));
  toast('מחשב מסלול אופטימלי...');

  const startPt = {lat: state.start.lat, lon: state.start.lon};
  const endPt = state.endSameAsStart ? startPt : {lat: state.end.lat, lon: state.end.lon};
  const stopPts = state.stops.map(s=>({lat:s.lat, lon:s.lon}));

  // point order in matrix: [start, ...stops, end(if distinct)]
  const points = [startPt, ...stopPts];
  let endIdxInMatrix;
  if (state.endSameAsStart){
    endIdxInMatrix = 0; // return to start
  } else {
    points.push(endPt);
    endIdxInMatrix = points.length - 1;
  }

  let matrix, usedFallbackMatrix = false;
  try {
    matrix = await fetchDurationMatrix(points);
  } catch(e){
    toast('שירות המסלולים לא הגיב — בודק שוב עם פחות עומס...');
    try { matrix = await fetchDurationMatrix(points); }
    catch(e2){
      // Road-based optimization is unavailable (this tends to happen with
      // very large address lists) — fall back to straight-line distance so
      // the person still gets a usable, ordered route instead of nothing.
      matrix = buildHaversineMatrix(points);
      usedFallbackMatrix = true;
    }
  }

  const startIdx = 0;
  const costMatrix = buildCostMatrix(matrix, state.routePref);

  let order = buildInitialOrder(points.length, costMatrix, startIdx, endIdxInMatrix);
  const maxIter = Math.min(4000, order.length*order.length*4 || 100);
  order = twoOptImprove(costMatrix, startIdx, order, endIdxInMatrix, maxIter);

  // order gives matrix indices of stops in visiting order (1-based offsets into state.stops)
  const newStopOrder = order.map(idx => state.stops[idx-1]);
  state.stops = newStopOrder;
  state.routeIsManual = false;

  if (usedFallbackMatrix){
    // Still try to get real road distances/geometry for the final display —
    // this is a single request (not the full matrix), so it's far less
    // likely to hit the same limit that just failed.
    await recomputeRouteGeometry();
    toast('שירות המסלולים המלא היה עמוס, אז הסדר חושב לפי מרחק ישיר במקום לפי כבישים בפועל. אפשר ללחוץ "חשב מחדש" לנסות שוב.');
  } else {
    await recomputeRouteGeometry();
  }
  await persistTodayRoute();
  renderResult();
  toast('המסלול חושב בהצלחה');
}

function stepsToLatLngs(steps){
  const coords = [];
  (steps||[]).forEach(step=>{
    if (step.geometry && step.geometry.coordinates){
      step.geometry.coordinates.forEach(c=> coords.push([c[1], c[0]]));
    }
  });
  return coords;
}

async function recomputeRouteGeometry(){
  const startPt = {lat: state.start.lat, lon: state.start.lon};
  const endPt = state.endSameAsStart ? startPt : {lat: state.end.lat, lon: state.end.lon};
  const orderedPts = [startPt, ...state.stops.map(s=>({lat:s.lat, lon:s.lon})), endPt];
  state.legGeometries = null;
  try {
    const data = await api('/api/directions', {method:'POST', body:{points: orderedPts}, timeoutMs: 20000});
    if (data.code !== 'Ok') throw new Error('route-error');
    const route = data.routes[0];
    state.routeGeometry = route.geometry.coordinates.map(c=>[c[1], c[0]]);
    // per-leg road-following geometry, so each leg of the trip can be drawn
    // in its own color — this is what makes it clear which visit is which
    // when the route happens to pass the same area more than once.
    state.legGeometries = route.legs.map(leg => stepsToLatLngs(leg.steps));
    // distribute per-leg stats across stops
    let cumSeconds = 0;
    const departure = getDepartureDate();
    route.legs.forEach((leg, i)=>{
      cumSeconds += leg.duration;
      if (i < state.stops.length){
        state.stops[i].legDist = leg.distance;
        state.stops[i].legDur = leg.duration;
        state.stops[i].eta = departure ? new Date(departure.getTime() + cumSeconds*1000) : null;
      }
    });
    state.totalDistance = route.distance;
    state.totalDuration = route.duration;
  } catch(e){
    toast('לא הצלחתי לחשב מרחקים מדויקים למסלול הזה');
  }

  // Outbound leg (start → last stop) and return leg (last stop → end),
  // fetched separately so the "הלוך" / "חזור" map tabs have their own
  // accurate road-following geometry rather than a guess split from the
  // combined route.
  state.outboundGeometry = null; state.returnGeometry = null;
  state.outboundLegGeometries = null;
  state.outboundDistance = null; state.outboundDuration = null;
  state.returnDistance = null; state.returnDuration = null;
  if (state.stops.length){
    const lastStop = {lat: state.stops[state.stops.length-1].lat, lon: state.stops[state.stops.length-1].lon};
    const outboundPts = [startPt, ...state.stops.map(s=>({lat:s.lat, lon:s.lon}))];
    try {
      const outData = await api('/api/directions', {method:'POST', body:{points: outboundPts}, timeoutMs: 20000});
      if (outData.code === 'Ok'){
        const r = outData.routes[0];
        state.outboundGeometry = r.geometry.coordinates.map(c=>[c[1], c[0]]);
        state.outboundLegGeometries = r.legs.map(leg => stepsToLatLngs(leg.steps));
        state.outboundDistance = r.distance; state.outboundDuration = r.duration;
      }
    } catch(e){ /* non-critical — full map still works */ }
    try {
      const retData = await api('/api/directions', {method:'POST', body:{points: [lastStop, endPt]}, timeoutMs: 20000});
      if (retData.code === 'Ok'){
        const r = retData.routes[0];
        state.returnGeometry = r.geometry.coordinates.map(c=>[c[1], c[0]]);
        state.returnDistance = r.distance; state.returnDuration = r.duration;
      }
    } catch(e){ /* non-critical */ }
  }
}

function getDepartureDate(){
  if (!state.departureTime) return null;
  const [h,m] = state.departureTime.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

/* =========================================================================
   RESULT VIEW RENDERING
========================================================================= */
function renderResult(){
  if (els('routeKindSelect')) els('routeKindSelect').value = state.routeKind || 'auto';
  if (els('routePriceInput')){
    els('routePriceInput').value = state.routePrice ?? '';
    const sample = state.stops[0];
    const auto = sample && isBooksStop(sample) ? state.settings.prices.books : (inSpecialWeek(ymd()) ? state.settings.prices.special : state.settings.prices.regular);
    els('routePriceInput').placeholder = 'אוטומטי: ₪' + auto;
  }
  els('routeModeBadge').textContent = state.routeIsManual ? 'מסלול שהמשתמש שינה ידנית' : 'מסלול אופטימלי אוטומטי';
  els('sumStops').textContent = state.stops.length;
  let stLine = document.getElementById('sumStatusLine');
  if (!stLine){
    stLine = document.createElement('div');
    stLine.id = 'sumStatusLine';
    stLine.style.cssText = 'margin-top:10px;font-weight:700;font-size:14px;display:flex;gap:14px;flex-wrap:wrap';
    els('sumStops').closest('.summary-figs').after(stLine);
  }
  const sc = statusCounts();
  stLine.innerHTML = `<span style="color:var(--success)">✓ נמסרו: ${sc.done}</span><span style="color:var(--danger)">✗ לא נמסרו: ${sc.failed}</span><span>⏳ נשארו: ${sc.left}</span>`;
  const withQty = state.stops.filter(s=> s.qty != null);
  let qtyLine = document.getElementById('sumQtyLine');
  if (withQty.length){
    if (!qtyLine){
      qtyLine = document.createElement('div');
      qtyLine.id = 'sumQtyLine';
      qtyLine.style.cssText = 'margin-top:10px;font-weight:700;font-size:14px';
      els('sumStops').closest('.summary-figs').after(qtyLine);
    }
    const total = withQty.reduce((a,s)=> a + (+s.qty||0), 0);
    const left = withQty.filter(s=> s.deliveryStatus !== 'נמסר').reduce((a,s)=> a + (+s.qty||0), 0); // includes "not delivered" — still in the car
    const label = (withQty[0].qtyLabel || 'יחידות').replace(/^כמות\s*/, '') || 'יחידות';
    qtyLine.textContent = `${/ספר/.test(label)?'📚':'📦'} סה"כ ${total} ${label} במסלול · נשארו לחלק: ${left}`;
  } else if (qtyLine){ qtyLine.remove(); }
  els('sumDist').textContent = state.totalDistance!=null ? fmtKm(state.totalDistance) : '—';
  els('sumTime').textContent = state.totalDuration!=null ? fmtDuration(state.totalDuration) : '—';
  document.querySelectorAll('#routePrefTabs [data-pref]').forEach(b=>b.classList.toggle('active', b.dataset.pref===(state.routePref||'fastest')));

  // time-window violations
  const violated = state.stops.filter(s=> s.windowStart && s.eta && !inWindow(s));
  if (violated.length){
    els('windowWarning').style.display = 'block';
    els('windowWarning').textContent = `לא ניתן לעמוד בחלון הזמן של ${violated.length} משלוחים: ` +
      violated.map(s=> s.name || s.raw).slice(0,4).join(', ') + (violated.length>4 ? '...' : '');
  } else {
    els('windowWarning').style.display = 'none';
  }

  renderStopList();
  renderNavChunks();
  renderEndpointsCard();
  initOrRefreshMap();
}

function renderNavChunks(){
  const wrap = els('navChunkButtons');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!state.stops.length) return;
  // Main button: from my current location through the next undelivered stops.
  const nxt = googleMapsNextUrl(0);
  if (nxt){
    const main = document.createElement('a');
    main.className = 'btn btn-primary btn-block';
    main.href = nxt.url; main.target = '_blank'; main.rel = 'noopener';
    main.textContent = `🗺️ פתח ב-Google Maps מהמיקום שלי · ${nxt.count} העצירות הבאות (${nxt.first}–${nxt.last})`;
    main.style.marginBottom = '10px';
    wrap.appendChild(main);
  }
  const chunks = buildGoogleMapsChunks();
  if (chunks.length > 1){
    const lbl = document.createElement('div');
    lbl.className = 'hint'; lbl.style.width = '100%'; lbl.style.margin = '6px 0';
    lbl.textContent = 'או לפי חלקים קבועים (כל חלק מתחיל איפה שהקודם נגמר):';
    wrap.appendChild(lbl);
  }
  chunks.forEach((c)=>{
    const a = document.createElement('a');
    a.className = 'btn btn-secondary';
    a.href = c.url; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = c.back ? '↩ חזרה לנקודת הסיום'
      : (c.done ? '✓ ' : '') + `עצירות ${c.from}–${c.to}`;
    if (c.done) a.style.opacity = '0.55';
    wrap.appendChild(a);
  });
}

// ---- Delivery status, marked by hand at every address ----
document.addEventListener('change', (e)=>{
  if (e.target && e.target.id === 'hideDoneToggle') renderStopList();
  if (e.target && e.target.id === 'routePriceInput'){
    const v = e.target.value.trim();
    state.routePrice = v === '' ? null : Math.max(0, parseFloat(v) || 0);
    persistTodayRoute(); syncOpenSavedRoute();
    toast(state.routePrice == null ? 'המחיר חזר לאוטומטי' : `מחיר לכתובת במסלול הזה: ₪${state.routePrice} — חל על הסימונים מעכשיו`);
  }
  if (e.target && e.target.id === 'routeKindSelect'){ state.routeKind = e.target.value; persistTodayRoute(); syncOpenSavedRoute(); toast('סוג המשלוח עודכן — חל על הסימונים מעכשיו'); }
});
function setStopStatus(idx, status){
  const st = state.stops[idx];
  if (!st) return;
  st.deliveryStatus = status;
  st.statusAt = status === 'ממתין' ? null : Date.now();
  logDelivery(st, status);
  persistTodayRoute();
  renderResult();
  if (status === 'נמסר') toast(`✓ עצירה ${idx+1} סומנה כנמסרה`);
  else if (status === 'לא נמסר') toast(`✗ עצירה ${idx+1} סומנה כלא נמסרה`);
}
function statusLine(s){
  const t = s.statusAt ? ' · ' + new Date(s.statusAt).toLocaleTimeString('he-IL', {hour:'2-digit', minute:'2-digit'}) : '';
  if (s.deliveryStatus === 'נמסר') return `<div class="status-line ok">✓ נמסר${t}</div>`;
  if (s.deliveryStatus === 'לא נמסר') return `<div class="status-line bad">✗ לא נמסר${t}</div>`;
  return '';
}
function statusCounts(){
  const done = state.stops.filter(s=> s.deliveryStatus==='נמסר').length;
  const failed = state.stops.filter(s=> s.deliveryStatus==='לא נמסר').length;
  return { done, failed, left: state.stops.length - done - failed };
}

/* =========================================================================
   MONTHLY TRIP REPORT — every address marked "נמסר" is written to a log
   (date, address, type). The report prices each one:
     • books deliveries — always the books rate (default ₪15)
     • regular deliveries — ₪10, or the special-week rate (₪15) on days that
       fall inside a "special week" the person sets for that month.
   Prices are worked out when the report is shown, so changing the special
   week or the rates later updates the report.
========================================================================= */
const DEFAULT_SETTINGS = { prices: { regular: 10, special: 15, books: 15 }, specialWeeks: [] };
function normalizeSettings(v){
  const s = (v && !Array.isArray(v) && typeof v === 'object') ? v : {};
  return {
    prices: { ...DEFAULT_SETTINGS.prices, ...(s.prices || {}) },
    specialWeeks: Array.isArray(s.specialWeeks) ? s.specialWeeks : [],
  };
}
function ymd(d){ d = d || new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
function isBooksStop(stop){
  if (state.routeKind === 'books') return true;
  if (state.routeKind === 'regular') return false;
  return !!(stop.qtyLabel && /ספר/.test(stop.qtyLabel));
}
function inSpecialWeek(dateStr){
  return (state.settings.specialWeeks || []).some(w=> w.from && w.to && dateStr >= w.from && dateStr <= w.to);
}
function entryKind(e){ return e.kind === 'books' ? 'books' : (inSpecialWeek(e.date) ? 'special' : 'regular'); }
// A price typed by hand (for the route, or for one delivery) always wins.
function entryPrice(e){ return (e.price != null && e.price !== '') ? (+e.price || 0) : (+state.settings.prices[entryKind(e)] || 0); }
const KIND_LABEL = { regular: 'רגיל', special: 'שבוע מיוחד', books: 'ספרים' };

function currentRouteName(){
  if (state.routeName) return state.routeName;
  const sr = state.currentSavedRouteId && state.savedRoutes.find(x=> x.id === state.currentSavedRouteId);
  return sr ? sr.name : 'מסלול ' + new Date().toLocaleDateString('he-IL');
}
function logDelivery(stop, status){
  state.deliveryLog = state.deliveryLog || [];
  const date = ymd();
  const key = stop.id + '|' + date;
  const i = state.deliveryLog.findIndex(e=> e.key === key);
  if (status === 'נמסר'){
    if (i === -1){
      state.deliveryLog.push({ id:newId(), key, date, time: new Date().toTimeString().slice(0,5),
        address: stop.raw, route: currentRouteName(), kind: isBooksStop(stop) ? 'books' : 'regular',
        qty: stop.qty ?? null, note: stop.actionNote || null,
        price: stop.chargedPrice != null ? +stop.chargedPrice : ((state.routePrice != null && state.routePrice !== '') ? +state.routePrice : null) });
    }
  } else if (i !== -1){
    state.deliveryLog.splice(i, 1); // un-marked or "not delivered" → no charge
  }
  persistKey('deliveryLog', state.deliveryLog);
}

// Books deliveries are packed by size; the amount tells which: ₪15 שקית,
// ₪25 ארגז, ₪30 שתי שקיות, ₪35 שני ארגזים.
const PACKAGE_BY_PRICE = { 15: 'שקית', 25: 'ארגז', 30: 'שתי שקיות', 35: 'שני ארגזים' };
const PACKAGES = [ { label:'שקית', price:15 }, { label:'ארגז', price:25 }, { label:'שתי שקיות', price:30 }, { label:'שני ארגזים', price:35 } ];
function packageLabel(price){ return PACKAGE_BY_PRICE[+price] || ''; }

function reportSection(title, entries, kindCols){
  const byDay = new Map();
  entries.forEach(e=>{
    if (!byDay.has(e.date)) byDay.set(e.date, { n:0, sum:0, cols:{}, routes:new Set() });
    const d = byDay.get(e.date); const k = kindCols.key(e);
    d.n++; d.sum += entryPrice(e); d.cols[k] = (d.cols[k]||0) + 1; if (e.route) d.routes.add(e.route);
  });
  const tot = { n:0, sum:0, cols:{} };
  byDay.forEach(d=>{ tot.n += d.n; tot.sum += d.sum; Object.entries(d.cols).forEach(([k,v])=> tot.cols[k] = (tot.cols[k]||0) + v); });
  const cols = kindCols.list.filter(c=> tot.cols[c.key]); // only columns that have data
  return { title, entries, byDay, tot, cols };
}
function sectionHtml(sec){
  if (!sec.entries.length) return `<div class="card"><h2>${sec.title}</h2><div class="empty-state"><p>אין משלוחים בחודש הזה.</p></div></div>`;
  return `<div class="card">
    <h2>${sec.title} — ${sec.tot.n} כתובות · ₪${sec.tot.sum.toLocaleString('he-IL')}</h2>
    <div class="stat-grid">${sec.cols.map(c=>`<div class="stat-box"><div class="num">${sec.tot.cols[c.key]}</div><div class="lbl">${c.label}</div></div>`).join('')}
      <div class="stat-box"><div class="num">₪${sec.tot.sum.toLocaleString('he-IL')}</div><div class="lbl">סה"כ</div></div></div>
    <div style="overflow-x:auto;margin-top:12px"><table class="report-table">
      <thead><tr><th>תאריך</th><th>מסלול</th>${sec.cols.map(c=>`<th>${c.label}</th>`).join('')}<th>סכום</th></tr></thead>
      <tbody>${[...sec.byDay.entries()].map(([day,d])=>`<tr><td>${fmtDay(day)}</td><td>${escapeHtml([...d.routes].join(', '))}</td>${sec.cols.map(c=>`<td>${d.cols[c.key]||''}</td>`).join('')}<td><b>₪${d.sum}</b></td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="2">סה"כ</td>${sec.cols.map(c=>`<td>${sec.tot.cols[c.key]}</td>`).join('')}<td><b>₪${sec.tot.sum.toLocaleString('he-IL')}</b></td></tr></tfoot>
    </table></div></div>`;
}
const REGULAR_COLS = { key: (e)=> entryKind(e) === 'special' ? 'special' : 'regular',
  list: [ { key:'regular', label:'רגיל' }, { key:'special', label:'שבוע מיוחד' } ] };
const BOOKS_COLS = { key: (e)=> packageLabel(entryPrice(e)) || ('₪' + entryPrice(e)),
  get list(){ return [ ...PACKAGES.map(p=>({ key:p.label, label:`${p.label} (₪${p.price})` })),
    ...[...new Set((state.lastBooksEntries||[]).map(e=> entryPrice(e)).filter(p=> !PACKAGE_BY_PRICE[p]))].map(p=>({ key:'₪'+p, label:'₪'+p })) ]; } };

function renderReport(){
  const monthEl = els('reportMonth');
  if (!monthEl.value) monthEl.value = ymd().slice(0,7);
  const month = monthEl.value;
  const P = state.settings.prices;
  els('priceRegular').value = P.regular; els('priceSpecial').value = P.special; els('priceBooks').value = P.books;

  const weeks = (state.settings.specialWeeks || []).map((w,i)=>({...w, i})).filter(w=> (w.from||'').slice(0,7) === month || (w.to||'').slice(0,7) === month);
  els('specialWeeksList').innerHTML = weeks.length
    ? weeks.map(w=> `<span class="chip">${fmtDay(w.from)} – ${fmtDay(w.to)} <button data-delweek="${w.i}" title="מחק">×</button></span>`).join('')
    : '<span class="hint" style="margin:0">לא הוגדר שבוע מיוחד בחודש הזה</span>';
  els('specialWeeksList').querySelectorAll('[data-delweek]').forEach(b=> b.addEventListener('click', ()=>{
    state.settings.specialWeeks.splice(+b.dataset.delweek, 1);
    persistKey('settings', state.settings); renderReport();
  }));

  const all = (state.deliveryLog || []).filter(e=> (e.date||'').slice(0,7) === month)
    .sort((a,b)=> (a.date+(a.time||'')).localeCompare(b.date+(b.time||'')));
  const regular = all.filter(e=> e.kind !== 'books');
  const books = all.filter(e=> e.kind === 'books');
  state.lastBooksEntries = books;
  const secR = reportSection('📦 משלוחים רגילים (עלונים)', regular, REGULAR_COLS);
  const secB = reportSection('📚 משלוחי ספרים', books, BOOKS_COLS);
  const grand = secR.tot.sum + secB.tot.sum;

  els('reportTotals').innerHTML = `
    <div class="stat-box"><div class="num">${all.length}</div><div class="lbl">כתובות שנמסרו</div></div>
    <div class="stat-box"><div class="num">₪${secR.tot.sum.toLocaleString('he-IL')}</div><div class="lbl">רגילים (${secR.tot.n})</div></div>
    <div class="stat-box"><div class="num">₪${secB.tot.sum.toLocaleString('he-IL')}</div><div class="lbl">ספרים (${secB.tot.n})</div></div>
    <div class="stat-box"><div class="num">₪${grand.toLocaleString('he-IL')}</div><div class="lbl">סה"כ לחודש</div></div>`;
  const show = els('reportShow') ? els('reportShow').value : 'all';
  els('reportTable').innerHTML = (show !== 'books' ? sectionHtml(secR) : '') + (show !== 'regular' ? sectionHtml(secB) : '');

  const detailEntries = show === 'books' ? books : show === 'regular' ? regular : all;
  els('reportDetails').innerHTML = detailEntries.map(e=> {
    const pk = e.kind === 'books' ? packageLabel(entryPrice(e)) : '';
    return `
    <div class="saved-route-row">
      <div><div class="saved-route-name">${escapeHtml(e.address)}${pk?` <span class="badge badge-accent">${pk}</span>`:''}</div>
        <div class="saved-route-sub">${fmtDay(e.date)} ${e.time||''} · ${escapeHtml(e.route||'')} · ${e.kind==='books'?'ספרים':KIND_LABEL[entryKind(e)]} · <b>₪${entryPrice(e)}</b>${e.price!=null?' (ידני)':''}${e.manual?' · נוסף ידנית':''}</div>
        ${e.note?`<div class="stop-notes">📝 ${escapeHtml(e.note)}</div>`:''}</div>
      <div style="display:flex;gap:6px">
      <button class="icon-btn" data-editlog="${e.id}" title="ערוך סכום / הערה"><span style="font-weight:800;font-size:13px">₪</span></button>
      <button class="icon-btn" data-dellog="${e.id}" title="מחק מהדוח"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    </div>`; }).join('') || '<div class="empty-state"><p>אין משלוחים להצגה.</p></div>';
  els('reportDetails').querySelectorAll('[data-editlog]').forEach(b=> b.addEventListener('click', ()=>{
    const e = state.deliveryLog.find(x=> x.id === b.dataset.editlog); if (!e) return;
    openActionDialog({ title: e.address, isBooks: e.kind === 'books', note: e.note || '', price: e.price,
      autoPrice: entryPrice({ ...e, price: null }),
      onSave: ({note, price, kind})=>{ e.note = note; e.price = price; if (kind) e.kind = kind; persistKey('deliveryLog', state.deliveryLog); renderReport(); } });
  }));
  els('reportDetails').querySelectorAll('[data-dellog]').forEach(b=> b.addEventListener('click', ()=>{
    if (!confirm('למחוק את המשלוח הזה מהדוח?')) return;
    state.deliveryLog = state.deliveryLog.filter(e=> e.id !== b.dataset.dellog);
    persistKey('deliveryLog', state.deliveryLog); renderReport();
  }));
  state.lastReport = { month, secR, secB, grand };
}

// One dialog for "what happened at this address": free note + amount.
// For books deliveries there are one-tap package buttons (שקית ₪15 …).
function openActionDialog({ title, isBooks, note, price, autoPrice, allowKind, onSave }){
  const old = document.getElementById('actionOverlay'); if (old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'actionOverlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:320;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;';
  ov.innerHTML = `
    <div class="card" style="width:100%;max-width:440px">
      <h2>📝 פעולה בכתובת</h2>
      <p class="hint">${escapeHtml(title || '')}</p>
      ${isBooks ? `<label class="field-label">אריזה</label>
        <div class="row" style="gap:6px;margin-bottom:12px">${PACKAGES.map(p=>`<button class="btn btn-secondary pkg-btn" data-p="${p.price}" data-l="${p.label}" style="min-width:0;padding:10px 8px">${p.label}<br><small>₪${p.price}</small></button>`).join('')}</div>` : ''}
      <div class="field">
        <label class="field-label">מה היה שם (חופשי) — למשל כמה פריטים</label>
        <textarea id="actNote" style="min-height:80px" placeholder="לדוגמה: 3 ספרים + 2 חוברות"></textarea>
      </div>
      <div class="field">
        <label class="field-label">סכום שנגבה / לתשלום (₪)</label>
        <input type="number" id="actPrice" min="0" step="0.5" inputmode="decimal" placeholder="אוטומטי: ₪${autoPrice ?? ''}">
      </div>
      ${allowKind ? `<label class="check-row" style="margin-bottom:10px"><input type="checkbox" id="actBooks" ${isBooks?'checked':''}> משלוח ספרים</label>` : ''}
      <div class="row">
        <button class="btn btn-primary" id="actSave">שמור</button>
        <button class="btn btn-secondary" id="actCancel">ביטול</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const noteEl = document.getElementById('actNote'), priceEl = document.getElementById('actPrice');
  noteEl.value = note || ''; priceEl.value = price != null ? price : '';
  ov.querySelectorAll('.pkg-btn').forEach(b=> b.addEventListener('click', ()=>{
    priceEl.value = b.dataset.p;
    ov.querySelectorAll('.pkg-btn').forEach(x=> x.classList.toggle('btn-primary', x === b));
  }));
  const close = ()=> ov.remove();
  document.getElementById('actCancel').addEventListener('click', close);
  ov.addEventListener('click', (e)=>{ if (e.target === ov) close(); });
  document.getElementById('actSave').addEventListener('click', ()=>{
    const v = priceEl.value.trim();
    const kindEl = document.getElementById('actBooks');
    onSave({ note: noteEl.value.trim() || null, price: v === '' ? null : Math.max(0, parseFloat(v) || 0),
      kind: kindEl ? (kindEl.checked ? 'books' : 'regular') : null });
    close();
  });
}

// Action note on a stop of the open route (also updates today's report line)
function openStopAction(idx){
  const st = state.stops[idx]; if (!st) return;
  const books = isBooksStop(st);
  const auto = books ? state.settings.prices.books : (inSpecialWeek(ymd()) ? state.settings.prices.special : state.settings.prices.regular);
  openActionDialog({ title: `${idx+1}. ${st.raw}`, isBooks: books, note: st.actionNote || '', price: st.chargedPrice ?? null,
    autoPrice: (state.routePrice != null && state.routePrice !== '') ? state.routePrice : auto,
    onSave: ({note, price})=>{
      st.actionNote = note; st.chargedPrice = price;
      const e = (state.deliveryLog || []).find(x=> x.key === st.id + '|' + ymd());
      if (e){ e.note = note; if (price != null) e.price = price; persistKey('deliveryLog', state.deliveryLog); }
      persistTodayRoute(); renderResult();
      toast('הפעולה נשמרה' + (e ? ' · עודכנה גם בדוח' : ' · תירשם בדוח כשתסמן "נמסר"'));
    } });
}

function fmtDay(d){ if (!d) return ''; const [y,m,dd] = d.split('-'); return `${dd}/${m}/${y}`; }

(function wireReport(){
  if (!els('view-report')) return;
  els('reportMonth').addEventListener('change', renderReport);
  els('savePricesBtn').addEventListener('click', ()=>{
    state.settings.prices = { regular: +els('priceRegular').value || 0, special: +els('priceSpecial').value || 0, books: +els('priceBooks').value || 0 };
    persistKey('settings', state.settings); renderReport(); toast('המחירים נשמרו');
  });
  els('addWeekBtn').addEventListener('click', ()=>{
    const from = els('weekFrom').value, to = els('weekTo').value || '';
    if (!from){ toast('בחר תאריך התחלה של השבוע'); return; }
    let end = to;
    if (!end){ const d = new Date(from); d.setDate(d.getDate()+6); end = ymd(d); }
    if (end < from){ toast('תאריך הסיום לפני ההתחלה'); return; }
    state.settings.specialWeeks.push({ from, to: end });
    persistKey('settings', state.settings);
    els('weekFrom').value = ''; els('weekTo').value = '';
    renderReport(); toast('השבוע המיוחד נשמר — המשלוחים בו מחושבים לפי ₪' + state.settings.prices.special);
  });
  els('addManualBtn').addEventListener('click', ()=>{
    const date = els('manualDate').value, address = els('manualAddr').value.trim();
    const count = Math.max(1, parseInt(els('manualCount').value, 10) || 1);
    if (!date || !address){ toast('מלא תאריך וכתובת'); return; }
    for (let i = 0; i < count; i++){
      state.deliveryLog.push({ id:newId(), key:'manual|'+newId(), date, time:'', address, route:'הוספה ידנית',
        kind: els('manualKind').value === 'books' ? 'books' : 'regular', manual:true,
        price: els('manualPrice').value.trim() === '' ? null : Math.max(0, parseFloat(els('manualPrice').value) || 0) });
    }
    persistKey('deliveryLog', state.deliveryLog);
    els('manualAddr').value = ''; els('manualCount').value = '1'; els('manualPrice').value = '';
    els('reportMonth').value = date.slice(0,7);
    renderReport(); toast(count > 1 ? `נוספו ${count} משלוחים לדוח` : 'נוסף לדוח');
  });
  const exportSection = (sec, fname)=>{
    const r = state.lastReport;
    if (!r || !sec.entries.length){ toast('אין נתונים לייצוא'); return; }
    const q = (v)=> '"' + String(v ?? '').replace(/"/g,'""') + '"';
    const L = [];
    L.push([sec.title.replace(/^[^\u0590-\u05FF]+/, ''), r.month].map(q).join(','));
    L.push('');
    L.push(['תאריך','מסלול', ...sec.cols.map(c=> c.label), 'סכום ₪'].map(q).join(','));
    sec.byDay.forEach((d,day)=> L.push([fmtDay(day), [...d.routes].join(' / '), ...sec.cols.map(c=> d.cols[c.key]||''), d.sum].map(q).join(',')));
    L.push(['סה"כ','', ...sec.cols.map(c=> sec.tot.cols[c.key]), sec.tot.sum].map(q).join(','));
    L.push('');
    L.push(['תאריך','שעה','כתובת','מסלול','סוג / אריזה','סכום ₪','הערת פעולה'].map(q).join(','));
    sec.entries.forEach(e=> L.push([fmtDay(e.date), e.time||'', e.address, e.route||'',
      e.kind==='books' ? (packageLabel(entryPrice(e)) || 'ספרים') : KIND_LABEL[entryKind(e)], entryPrice(e), e.note||''].map(q).join(',')));
    const blob = new Blob(['\uFEFF' + L.join('\r\n')], {type:'text/csv;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${fname}-${r.month}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  };
  // PDF: a clean printable page for one section, printed from a hidden frame.
  // In the print window choose "Save as PDF" / "שמירה כ-PDF".
  const pdfSection = (secs, fname)=>{
    const r = state.lastReport;
    secs = secs.filter(x=> x && x.entries.length);
    if (!r || !secs.length){ toast('אין נתונים לדוח'); return; }
    const user = (state.currentUser && state.currentUser.name) || '';
    const [yy, mm] = r.month.split('-');
    const body = secs.map(sec=> `
      <h2>${escapeHtml(sec.title.replace(/^[^\u0590-\u05FF]+/, ''))}</h2>
      <div class="sum">${sec.tot.n} כתובות · סה"כ <b>₪${sec.tot.sum.toLocaleString('he-IL')}</b>
        ${sec.cols.map(c=>` · ${escapeHtml(c.label)}: ${sec.tot.cols[c.key]}`).join('')}</div>
      <table><thead><tr><th>תאריך</th><th>מסלול</th>${sec.cols.map(c=>`<th>${escapeHtml(c.label)}</th>`).join('')}<th>סכום</th></tr></thead>
      <tbody>${[...sec.byDay.entries()].map(([day,d])=>`<tr><td>${fmtDay(day)}</td><td>${escapeHtml([...d.routes].join(', '))}</td>${sec.cols.map(c=>`<td>${d.cols[c.key]||''}</td>`).join('')}<td>₪${d.sum}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="2">סה"כ</td>${sec.cols.map(c=>`<td>${sec.tot.cols[c.key]}</td>`).join('')}<td>₪${sec.tot.sum.toLocaleString('he-IL')}</td></tr></tfoot></table>
      <h3>פירוט משלוחים</h3>
      <table class="det"><thead><tr><th>#</th><th>תאריך</th><th>כתובת</th><th>סוג / אריזה</th><th>סכום</th><th>הערת פעולה</th></tr></thead>
      <tbody>${sec.entries.map((e,i)=>`<tr><td>${i+1}</td><td>${fmtDay(e.date)} ${e.time||''}</td><td>${escapeHtml(e.address)}</td><td>${e.kind==='books' ? (packageLabel(entryPrice(e)) || 'ספרים') : KIND_LABEL[entryKind(e)]}</td><td>₪${entryPrice(e)}</td><td>${escapeHtml(e.note||'')}</td></tr>`).join('')}</tbody></table>`).join('<div class="pb"></div>');
    const grand = secs.reduce((a,x)=> a + x.tot.sum, 0);
    const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${fname}-${r.month}</title>
      <style>
        @page{size:A4;margin:14mm}
        body{font-family:Arial,'Heebo',sans-serif;color:#111;font-size:12px;margin:0}
        .head{display:flex;align-items:center;gap:12px;border-bottom:3px solid #3fa89f;padding-bottom:10px;margin-bottom:14px}
        .head img{width:54px;height:54px;border-radius:50%}
        .head h1{margin:0;font-size:20px} .head .sub{color:#555;font-size:12.5px;margin-top:2px}
        h2{font-size:16px;margin:16px 0 4px;color:#1f6f68} h3{font-size:13px;margin:14px 0 6px}
        .sum{margin-bottom:8px;font-size:12.5px}
        table{width:100%;border-collapse:collapse;margin-bottom:6px}
        th,td{border:1px solid #bbb;padding:5px 6px;text-align:right;vertical-align:top}
        th{background:#eef6f5} tfoot td{font-weight:bold;background:#f6f6f6}
        table.det td:nth-child(6){max-width:180px}
        .grand{margin-top:16px;font-size:15px;font-weight:bold;border-top:2px solid #111;padding-top:8px}
        .pb{page-break-after:always}
        .foot{margin-top:18px;color:#777;font-size:10.5px}
      </style></head><body>
      <div class="head"><img src="${location.origin}/icons/logo.png"><div>
        <h1>דוח נסיעות — ${mm}/${yy}</h1>
        <div class="sub">דרך חתם סופר${user ? ' · ' + escapeHtml(user) : ''} · הופק ${new Date().toLocaleDateString('he-IL')}</div></div></div>
      ${body}
      ${secs.length > 1 ? `<div class="grand">סה"כ לחודש: ₪${grand.toLocaleString('he-IL')}</div>` : ''}
      </body></html>`;
    const old = document.getElementById('pdfFrame'); if (old) old.remove();
    const f = document.createElement('iframe');
    f.id = 'pdfFrame';
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px';
    document.body.appendChild(f);
    f.contentDocument.open(); f.contentDocument.write(html); f.contentDocument.close();
    const go = ()=>{ try { f.contentWindow.focus(); f.contentWindow.print(); } catch(e){ toast('לא הצלחתי לפתוח הדפסה — נסה מהמחשב'); } };
    const img = f.contentDocument.querySelector('img');
    if (img && !img.complete){ img.onload = img.onerror = ()=> setTimeout(go, 100); } else setTimeout(go, 150);
    toast('בחלון ההדפסה בחר "שמירה כ-PDF"');
  };
  els('pdfRegularBtn').addEventListener('click', ()=> pdfSection([state.lastReport && state.lastReport.secR], 'דוח-משלוחים-רגילים'));
  els('pdfBooksBtn').addEventListener('click', ()=> pdfSection([state.lastReport && state.lastReport.secB], 'דוח-משלוחי-ספרים'));
  els('pdfAllBtn').addEventListener('click', ()=> pdfSection([state.lastReport && state.lastReport.secR, state.lastReport && state.lastReport.secB], 'דוח-נסיעות'));
  els('exportReportBtn').addEventListener('click', ()=> exportSection(state.lastReport.secR, 'דוח-משלוחים-רגילים'));
  els('exportBooksBtn').addEventListener('click', ()=> exportSection(state.lastReport.secB, 'דוח-משלוחי-ספרים'));
  els('reportShow').addEventListener('change', renderReport);
})();

// "📚 3 ספרים" — the exact amount to hand over at this stop (from the file)
function qtyBadge(s, big){
  if (s.qty == null) return '';
  const label = (s.qtyLabel || 'יחידות').replace(/^כמות\s*/, '') || 'יחידות';
  const icon = /ספר/.test(label) ? '📚' : '📦';
  return big
    ? `<div class="driving-window" style="font-size:22px;font-weight:800;background:var(--accent-soft);color:var(--accent)">${icon} ${s.qty} ${escapeHtml(label)}</div>`
    : `<span class="badge badge-accent" style="margin-inline-start:6px">${icon} ${s.qty} ${escapeHtml(label)}</span>`;
}
function inWindow(s){
  if (!s.windowStart || !s.eta) return true;
  const [sh,sm] = s.windowStart.split(':').map(Number);
  const [eh,em] = (s.windowEnd||'23:59').split(':').map(Number);
  const winStart = new Date(s.eta); winStart.setHours(sh,sm,0,0);
  const winEnd = new Date(s.eta); winEnd.setHours(eh,em,0,0);
  return s.eta >= winStart && s.eta <= winEnd;
}

function renderStopList(){
  const wrap = els('stopList');
  wrap.innerHTML = '';
  if (!state.stops.length){
    wrap.innerHTML = `<div class="empty-state"><p>אין עצירות במסלול.</p></div>`;
    return;
  }
  // count identical addresses so repeat visits (e.g. two packages, same
  // building) get a visible "כפול" badge instead of looking like a mistake
  const addrCounts = new Map();
  state.stops.forEach(s=>{
    const key = (s.raw||'').trim().toLowerCase();
    addrCounts.set(key, (addrCounts.get(key)||0) + 1);
  });

  state.stops.forEach((s, idx)=>{
    const item = document.createElement('div');
    item.className = 'stop-item' + (s.deliveryStatus==='נמסר' ? ' delivered' : s.deliveryStatus==='לא נמסר' ? ' notdelivered' : '');
    if (els('hideDoneToggle') && els('hideDoneToggle').checked && (s.deliveryStatus==='נמסר' || s.deliveryStatus==='לא נמסר')) return;
    item.draggable = true;
    item.dataset.idx = idx;

    let metaBits = [];
    if (s.legDist!=null) metaBits.push(fmtKm(s.legDist)+' ק"מ מהעצירה הקודמת');
    if (s.legDur!=null) metaBits.push(fmtDuration(s.legDur));
    if (s.eta) metaBits.push('הגעה משוערת ' + fmtClock(s.eta));

    const dupCount = addrCounts.get((s.raw||'').trim().toLowerCase()) || 1;
    const dupBadge = dupCount > 1 ? `<span class="badge badge-amber" style="margin-inline-start:6px">כפול · ${dupCount} משלוחים</span>` : '';

    let windowHtml = '';
    if (s.windowStart){
      const bad = s.eta && !inWindow(s);
      windowHtml = `<div class="stop-window ${bad?'violated':''}">חלון זמן: ${s.windowStart}–${s.windowEnd||''} ${bad?'⚠ לא עומד בזמן':''}</div>`;
    }
    const notesHtml = s.notes ? `<div class="stop-notes">📝 ${escapeHtml(s.notes)}</div>` : '';

    item.innerHTML = `
      <span class="grip"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></span>
      <div class="stop-num">${idx+1}</div>
      <div class="stop-body">
        <div class="stop-addr">${escapeHtml(s.name ? s.name+' — '+s.raw : s.raw)}${qtyBadge(s)}${dupBadge}</div>
        <div class="stop-meta">${metaBits.map(m=>`<span>${m}</span>`).join('')}</div>
        ${statusLine(s)}
        ${(s.actionNote || s.chargedPrice != null) ? `<div class="stop-notes" style="border-inline-start:3px solid var(--amber)">📝 ${escapeHtml(s.actionNote||'')}${s.chargedPrice!=null?` · <b>₪${s.chargedPrice}</b>${isBooksStop(s)&&packageLabel(s.chargedPrice)?' ('+packageLabel(s.chargedPrice)+')':''}`:''}</div>` : ''}
        ${windowHtml}
        ${notesHtml}
      </div>
      <div class="stop-actions">
        <button class="mark-btn ok ${s.deliveryStatus==='נמסר'?'on':''}" data-mark-idx="${idx}" data-mark-val="נמסר" title="סמן שנמסר">✓ נמסר</button>
        <button class="mark-btn bad ${s.deliveryStatus==='לא נמסר'?'on':''}" data-mark-idx="${idx}" data-mark-val="לא נמסר" title="סמן שלא נמסר">✗ לא</button>
        <a class="icon-btn" title="נווט ב-Waze (מהמיקום הנוכחי)" href="${wazeLink(s)}" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 11l18-8-8 18-2-8-8-2z"/></svg>
        </a>
        <a class="icon-btn" title="Google Maps — מהכתובת הקודמת" href="${googleMapsFromPrev(idx)}" target="_blank" rel="noopener" style="font-weight:800;font-size:13px">G</a>
        <button class="icon-btn" data-action-idx="${idx}" title="הערת פעולה / סכום">📝</button>
        <button class="icon-btn" data-edit-idx="${idx}" title="ערוך כתובת / הערה">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>
        </button>
        <button class="icon-btn" data-remove-idx="${idx}" title="הסר">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>`;
    wrap.appendChild(item);
  });

  wrap.querySelectorAll('[data-mark-idx]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const idx = parseInt(btn.dataset.markIdx);
      const val = btn.dataset.markVal;
      // tapping the status that's already set clears it (back to "waiting")
      setStopStatus(idx, state.stops[idx].deliveryStatus === val ? 'ממתין' : val);
    });
  });
  wrap.querySelectorAll('[data-action-idx]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{ e.stopPropagation(); openStopAction(parseInt(btn.dataset.actionIdx)); });
  });
  wrap.querySelectorAll('[data-edit-idx]').forEach(btn=>{
    btn.addEventListener('click', ()=> openEditStop(parseInt(btn.dataset.editIdx)));
  });
  wrap.querySelectorAll('[data-remove-idx]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const idx = parseInt(btn.dataset.removeIdx);
      state.stops.splice(idx,1);
      toast('העצירה הוסרה — לוחצים על "חשב מחדש" לעדכון המסלול');
      renderStopList();
      persistTodayRoute();
      syncOpenSavedRoute();
    });
  });

  attachDragAndDrop(wrap);
}

function wazeLink(s){
  // No starting point on purpose: Waze always starts from where the car is now.
  return `https://waze.com/ul?ll=${s.lat},${s.lon}&navigate=yes`;
}
// On Android (phone or car screen) open the installed Waze app directly,
// instead of a browser page. If Waze isn't installed, the web link opens.
const IS_ANDROID = /Android/i.test(navigator.userAgent || '');
function wazeAppUrl(httpsUrl){
  const q = httpsUrl.split('?')[1] || '';
  return `intent://?${q}#Intent;scheme=waze;package=com.waze;S.browser_fallback_url=${encodeURIComponent(httpsUrl)};end`;
}
document.addEventListener('click', (e)=>{
  const a = e.target && e.target.closest && e.target.closest('a[href^="https://waze.com/ul"]');
  if (!a || !IS_ANDROID) return;
  e.preventDefault();
  window.location.href = wazeAppUrl(a.getAttribute('href'));
}, true);
// Starting point for stop #idx = the previous delivery address (or the route's
// start point for the first stop). Waze links can't take a starting point —
// Waze always navigates from where the phone is now — so this is used for the
// Google Maps link, which does support an explicit origin.
function prevPointFor(idx){
  if (idx > 0 && state.stops[idx-1]) return state.stops[idx-1];
  return state.start || null;
}
function googleMapsFromPrev(idx){
  const s = state.stops[idx];
  const o = prevPointFor(idx);
  let url = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving`;
  if (o && o.lat != null) url += `&origin=${o.lat},${o.lon}`;
  return url;
}
function googleMapsSingle(s){
  return `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving`;
}

/* drag & drop reorder */
function attachDragAndDrop(container){
  let dragSrcIdx = null;
  container.querySelectorAll('.stop-item').forEach(item=>{
    item.addEventListener('dragstart', ()=>{
      dragSrcIdx = parseInt(item.dataset.idx);
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', ()=> item.classList.remove('dragging'));
    item.addEventListener('dragover', (e)=>{ e.preventDefault(); item.classList.add('drag-over'); });
    item.addEventListener('dragleave', ()=> item.classList.remove('drag-over'));
    item.addEventListener('drop', async (e)=>{
      e.preventDefault();
      item.classList.remove('drag-over');
      const destIdx = parseInt(item.dataset.idx);
      if (dragSrcIdx===null || dragSrcIdx===destIdx) return;
      const moved = state.stops.splice(dragSrcIdx,1)[0];
      state.stops.splice(destIdx,0,moved);
      state.routeIsManual = true;
      await recomputeRouteGeometry();
      await persistTodayRoute();
      renderResult();
    });
  });
}

els('recalcBtn').addEventListener('click', async ()=>{
  if (!state.stops.length){ toast('אין עצירות לחישוב'); return; }
  toast('מחשב מחדש...');
  await computeOptimalRoute();
});

document.querySelectorAll('#routePrefTabs [data-pref]').forEach(btn=>{
  btn.addEventListener('click', async ()=>{
    if (!state.stops.length){ toast('חשב מסלול קודם'); return; }
    state.routePref = btn.dataset.pref;
    document.querySelectorAll('#routePrefTabs [data-pref]').forEach(b=>b.classList.toggle('active', b===btn));
    toast('מחשב מסלול לפי ההעדפה החדשה...');
    await computeOptimalRoute();
  });
});

/* =========================================================================
   MAP (Leaflet) — one map, three modes: full route / outbound leg / return leg
========================================================================= */
document.querySelectorAll('#mapTabs [data-mapmode]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    state.mapMode = btn.dataset.mapmode;
    document.querySelectorAll('#mapTabs [data-mapmode]').forEach(b=>b.classList.toggle('active', b===btn));
    initOrRefreshMap();
  });
});

function startPinIcon(){
  return L.divIcon({html:`<div class="start-pin"><svg viewBox="0 0 24 24" fill="none" stroke="#3fa89f" stroke-width="2.4"><circle cx="12" cy="12" r="3"/></svg></div>`, className:'', iconSize:[30,30], iconAnchor:[15,15]});
}
function endPinIcon(){
  return L.divIcon({html:`<div class="end-pin"><svg viewBox="0 0 24 24" fill="none" stroke="#e15c46" stroke-width="2.4"><path d="M6 3v18M6 4h11l-3 4 3 4H6"/></svg></div>`, className:'', iconSize:[30,30], iconAnchor:[15,15]});
}
function stopPinIcon(idx, s){
  return L.divIcon({html:`<div class="stop-pin ${s.deliveryStatus==='נמסר'?'delivered':s.deliveryStatus==='לא נמסר'?'failed':''}"><span>${idx+1}</span></div>`, className:'', iconSize:[30,30], iconAnchor:[15,28]});
}

function legColor(i, total){
  // Early legs render teal, later legs shift toward orange — so when a route
  // happens to pass the same street twice, the two passes are visibly
  // different (by when in the trip they happen), not just by pin number.
  if (total <= 1) return '#3fa89f';
  const hueStart = 168, hueEnd = 28;
  const t = i/(total-1);
  const hue = hueStart + (hueEnd-hueStart)*t;
  return `hsl(${hue}, 68%, 56%)`;
}
function drawLegGeometries(legGeoms, fallbackGeometry, fallbackColor){
  const lines = [];
  if (legGeoms && legGeoms.length && legGeoms.some(g=>g && g.length)){
    legGeoms.forEach((coords, i)=>{
      if (coords && coords.length){
        lines.push(L.polyline(coords, {color: legColor(i, legGeoms.length), weight:5, opacity:0.88}).addTo(state.map));
      }
    });
  } else if (fallbackGeometry && fallbackGeometry.length){
    lines.push(L.polyline(fallbackGeometry, {color: fallbackColor, weight:4, opacity:0.85}).addTo(state.map));
  }
  return lines;
}

function initOrRefreshMap(){
  if (state.mapProvider === 'google' && window.google && window.google.maps){
    initOrRefreshMapGoogle();
  } else {
    initOrRefreshMapLeaflet();
  }
}

function initOrRefreshMapLeaflet(){
  if (!els('map')) return;
  if (!state.map){
    state.map = L.map('map', { zoomControl:true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors'
    }).addTo(state.map);
    state.markersLayer = L.layerGroup().addTo(state.map);
  }
  state.markersLayer.clearLayers();
  (state.routeLines||[]).forEach(line=> state.map.removeLayer(line));
  state.routeLines = [];

  const bounds = [];
  const mode = state.mapMode || 'full';
  const legInfo = els('mapLegInfo');

  if (mode === 'outbound'){
    if (state.start){
      L.marker([state.start.lat, state.start.lon], {icon:startPinIcon()}).addTo(state.markersLayer).bindPopup('התחלה: '+ (state.start.resolvedLabel||state.start.text));
      bounds.push([state.start.lat, state.start.lon]);
    }
    state.stops.forEach((s, idx)=>{
      L.marker([s.lat, s.lon], {icon:stopPinIcon(idx, s)}).addTo(state.markersLayer).bindPopup(`${idx+1}. ${escapeHtml(s.name?s.name+' — '+s.raw:s.raw)}`);
      bounds.push([s.lat, s.lon]);
    });
    state.routeLines = drawLegGeometries(state.outboundLegGeometries, state.outboundGeometry, '#3fa89f');
    if (legInfo) legInfo.textContent = state.outboundDistance!=null
      ? `הלוך: ${fmtKm(state.outboundDistance)} ק"מ · ${fmtDuration(state.outboundDuration)} · צבע הקו מציין את סדר הנסיעה` : '';
  } else if (mode === 'return'){
    if (state.stops.length){
      const last = state.stops[state.stops.length-1];
      const lastIcon = L.divIcon({html:`<div class="stop-pin"><span>${state.stops.length}</span></div>`, className:'', iconSize:[30,30], iconAnchor:[15,28]});
      L.marker([last.lat, last.lon], {icon:lastIcon}).addTo(state.markersLayer).bindPopup('עצירה אחרונה: '+escapeHtml(last.name?last.name+' — '+last.raw:last.raw));
      bounds.push([last.lat, last.lon]);
    }
    const endPoint = state.endSameAsStart ? state.start : state.end;
    if (endPoint){
      L.marker([endPoint.lat, endPoint.lon], {icon:endPinIcon()}).addTo(state.markersLayer).bindPopup('סיום: '+(endPoint.resolvedLabel||endPoint.text));
      bounds.push([endPoint.lat, endPoint.lon]);
    }
    if (state.returnGeometry && state.returnGeometry.length){
      state.routeLines = [L.polyline(state.returnGeometry, {color:'#e5a13c', weight:5, opacity:0.88}).addTo(state.map)];
    }
    if (legInfo) legInfo.textContent = state.returnDistance!=null
      ? `חזור: ${fmtKm(state.returnDistance)} ק"מ · ${fmtDuration(state.returnDuration)}` : '';
  } else {
    if (state.start){
      L.marker([state.start.lat, state.start.lon], {icon:startPinIcon()}).addTo(state.markersLayer).bindPopup('התחלה: '+ (state.start.resolvedLabel||state.start.text));
      bounds.push([state.start.lat, state.start.lon]);
    }
    state.stops.forEach((s, idx)=>{
      L.marker([s.lat, s.lon], {icon:stopPinIcon(idx, s)}).addTo(state.markersLayer).bindPopup(`${idx+1}. ${escapeHtml(s.name?s.name+' — '+s.raw:s.raw)}`);
      bounds.push([s.lat, s.lon]);
    });
    if (!state.endSameAsStart && state.end){
      L.marker([state.end.lat, state.end.lon], {icon:endPinIcon()}).addTo(state.markersLayer).bindPopup('סיום: '+(state.end.resolvedLabel||state.end.text));
      bounds.push([state.end.lat, state.end.lon]);
    }
    state.routeLines = drawLegGeometries(state.legGeometries, state.routeGeometry, '#3fa89f');
    if (legInfo) legInfo.textContent = state.totalDistance!=null
      ? `מסלול מלא: ${fmtKm(state.totalDistance)} ק"מ · ${fmtDuration(state.totalDuration)} · צבע הקו = סדר הנסיעה (טורקיז בהתחלה, כתום לקראת הסוף)` : '';
  }

  setTimeout(()=>{
    state.map.invalidateSize();
    if (bounds.length) state.map.fitBounds(bounds, {padding:[36,36]});
  }, 60);
}

/* ---------- Google Maps variant (used only when a key is configured) ---------- */
function gSvgIcon(svgInner, size){
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30" width="${size}" height="${size}">${svgInner}</svg>`;
  return { url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(size,size), anchor: new google.maps.Point(size/2, size/2) };
}
function gStartIcon(){
  return gSvgIcon(`<circle cx="15" cy="15" r="12" fill="#1c222b" stroke="#3fa89f" stroke-width="3"/><circle cx="15" cy="15" r="4" fill="none" stroke="#3fa89f" stroke-width="2.4"/>`, 30);
}
function gEndIcon(){
  return gSvgIcon(`<circle cx="15" cy="15" r="12" fill="#1c222b" stroke="#e15c46" stroke-width="3"/><path d="M10 6v18M10 7h13l-4 5 4 5H10" stroke="#e15c46" stroke-width="2" fill="none"/>`, 30);
}
function gStopIcon(num, delivered){
  const bg = delivered === 'failed' ? '#e15c46' : delivered ? '#4bab72' : '#3fa89f';
  return gSvgIcon(`<circle cx="15" cy="15" r="13" fill="${bg}" stroke="#0d1613" stroke-width="2"/><text x="15" y="19.5" font-size="13" font-weight="800" text-anchor="middle" fill="#0d1613" font-family="Arial">${num}</text>`, 30);
}
function initOrRefreshMapGoogle(){
  if (!els('map')) return;
  if (!state.gmap){
    state.gmap = new google.maps.Map(els('map'), {
      center: {lat:31.5, lng:35.0}, zoom:8,
      streetViewControl:false, mapTypeControl:false, fullscreenControl:false,
    });
  }
  (state.gMarkers||[]).forEach(m=> m.setMap(null));
  (state.gLines||[]).forEach(l=> l.setMap(null));
  state.gMarkers = []; state.gLines = [];

  const bounds = new google.maps.LatLngBounds();
  const mode = state.mapMode || 'full';
  const legInfo = els('mapLegInfo');

  const addMarker = (lat, lon, icon, title)=>{
    const m = new google.maps.Marker({ position:{lat, lng:lon}, map: state.gmap, icon, title });
    state.gMarkers.push(m); bounds.extend({lat, lng:lon});
  };
  const drawLines = (legGeoms, fallback, fallbackColor)=>{
    if (legGeoms && legGeoms.length && legGeoms.some(g=>g && g.length)){
      legGeoms.forEach((coords,i)=>{
        if (coords && coords.length){
          const path = coords.map(c=>({lat:c[0], lng:c[1]}));
          state.gLines.push(new google.maps.Polyline({ path, strokeColor: legColor(i, legGeoms.length), strokeWeight:5, strokeOpacity:0.88, map: state.gmap }));
        }
      });
    } else if (fallback && fallback.length){
      const path = fallback.map(c=>({lat:c[0], lng:c[1]}));
      state.gLines.push(new google.maps.Polyline({ path, strokeColor: fallbackColor, strokeWeight:4, strokeOpacity:0.85, map: state.gmap }));
    }
  };

  if (mode === 'outbound'){
    if (state.start) addMarker(state.start.lat, state.start.lon, gStartIcon(), 'התחלה');
    state.stops.forEach((s, idx)=> addMarker(s.lat, s.lon, gStopIcon(idx+1, s.deliveryStatus==='נמסר' ? true : s.deliveryStatus==='לא נמסר' ? 'failed' : false), String(idx+1)));
    drawLines(state.outboundLegGeometries, state.outboundGeometry, '#3fa89f');
    if (legInfo) legInfo.textContent = state.outboundDistance!=null
      ? `הלוך: ${fmtKm(state.outboundDistance)} ק"מ · ${fmtDuration(state.outboundDuration)} · צבע הקו מציין את סדר הנסיעה` : '';
  } else if (mode === 'return'){
    if (state.stops.length){
      const last = state.stops[state.stops.length-1];
      addMarker(last.lat, last.lon, gStopIcon(state.stops.length, false), 'עצירה אחרונה');
    }
    const endPoint = state.endSameAsStart ? state.start : state.end;
    if (endPoint) addMarker(endPoint.lat, endPoint.lon, gEndIcon(), 'סיום');
    if (state.returnGeometry && state.returnGeometry.length){
      const path = state.returnGeometry.map(c=>({lat:c[0], lng:c[1]}));
      state.gLines.push(new google.maps.Polyline({ path, strokeColor:'#e5a13c', strokeWeight:5, strokeOpacity:0.88, map: state.gmap }));
    }
    if (legInfo) legInfo.textContent = state.returnDistance!=null
      ? `חזור: ${fmtKm(state.returnDistance)} ק"מ · ${fmtDuration(state.returnDuration)}` : '';
  } else {
    if (state.start) addMarker(state.start.lat, state.start.lon, gStartIcon(), 'התחלה');
    state.stops.forEach((s, idx)=> addMarker(s.lat, s.lon, gStopIcon(idx+1, s.deliveryStatus==='נמסר' ? true : s.deliveryStatus==='לא נמסר' ? 'failed' : false), String(idx+1)));
    if (!state.endSameAsStart && state.end) addMarker(state.end.lat, state.end.lon, gEndIcon(), 'סיום');
    drawLines(state.legGeometries, state.routeGeometry, '#3fa89f');
    if (legInfo) legInfo.textContent = state.totalDistance!=null
      ? `מסלול מלא: ${fmtKm(state.totalDistance)} ק"מ · ${fmtDuration(state.totalDuration)} · צבע הקו = סדר הנסיעה (טורקיז בהתחלה, כתום לקראת הסוף)` : '';
  }

  setTimeout(()=>{
    google.maps.event.trigger(state.gmap, 'resize');
    if (!bounds.isEmpty()) state.gmap.fitBounds(bounds, 60);
  }, 60);
}

/* =========================================================================
   ADD AN ADDRESS TO AN EXISTING ROUTE — inserted at the cheapest place
   (smallest detour), never before stops already delivered.
========================================================================= */
let addStopPicked = null; // set when the person picks a suggestion from the list
(function wireAddStop(){
  const input = els('addStopInput');
  if (!input) return;
  attachAddressAutocomplete(input, (s)=>{ addStopPicked = {text: s.display_name, lat: parseFloat(s.lat), lon: parseFloat(s.lon)}; });
  input.addEventListener('input', ()=>{
    if (input.dataset.justSelected){ delete input.dataset.justSelected; return; }
    addStopPicked = null;
  });
  input.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') els('addStopBtn').click(); });
  els('addStopBtn').addEventListener('click', addStopToRoute);
})();

function bestInsertIndex(pt){
  // positions run from after the last delivered stop to the end of the route
  const start = {lat: state.start.lat, lon: state.start.lon};
  const end = state.endSameAsStart ? start : {lat: state.end.lat, lon: state.end.lon};
  let firstFree = 0;
  state.stops.forEach((s, i)=>{ if (s.deliveryStatus === 'נמסר') firstFree = i + 1; });
  const seq = [start, ...state.stops, end]; // stop i is seq[i+1]
  const d = (a, b)=> haversineMeters(a.lat, a.lon, b.lat, b.lon);
  let best = state.stops.length, bestCost = Infinity;
  for (let i = firstFree; i <= state.stops.length; i++){
    const a = seq[i], b = seq[i+1];
    const cost = d(a, pt) + d(pt, b) - d(a, b);
    if (cost < bestCost - 1){ bestCost = cost; best = i; } // ties → the earlier position
  }
  return best; // insert so the new stop becomes state.stops[best]
}

async function addStopToRoute(){
  if (state.offline || navigator.onLine === false){ toast('אין חיבור — הוספת כתובת צריכה אינטרנט (כדי למצוא אותה במפה)'); return; }
  const input = els('addStopInput');
  const text = input.value.trim();
  if (!text){ toast('הכנס כתובת'); return; }
  if (!state.start || state.start.lat == null){ toast('אין מסלול פתוח — חשב או פתח מסלול קודם'); return; }
  const btn = els('addStopBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> מחפש את הכתובת...';
  try {
    let lat, lon, label;
    if (addStopPicked && addStopPicked.text === text){
      ({lat, lon} = addStopPicked); label = addStopPicked.text;
    } else {
      const city = els('globalCityInput') ? els('globalCityInput').value.trim() : '';
      const r = await geocodeOne(text, city || null);
      if (!r || !r.length){ toast('הכתובת לא נמצאה — נסה לכתוב אותה אחרת או לבחור מההצעות'); return; }
      lat = parseFloat(r[0].lat); lon = parseFloat(r[0].lon); label = r[0].display_name;
    }
    const stop = { id:newId(), raw:text, name:null, area:null, notes: els('addStopNotes').value.trim() || null,
      lat, lon, geocodeStatus:'ok', resolvedLabel:label, candidates:[], windowStart:null, windowEnd:null,
      deliveryStatus:'ממתין' };
    const at = bestInsertIndex(stop);
    state.stops.splice(at, 0, stop);
    btn.innerHTML = '<span class="spinner"></span> מעדכן את המסלול...';
    await recomputeRouteGeometry();
    await persistTodayRoute();
    // keep the saved route (if this one came from there) in sync
    const savedMsg = (await syncOpenSavedRoute()) ? ' · המסלול השמור עודכן' : '';
    renderResult();
    input.value = ''; els('addStopNotes').value = ''; addStopPicked = null;
    toast(`נוסף כעצירה ${at+1}: ${label}${savedMsg}`);
  } catch(e){
    toast('לא הצלחתי להוסיף: ' + (e.message || 'שגיאה'));
  } finally {
    btn.disabled = false; btn.textContent = '+ הוסף למסלול';
  }
}

// If the open route came from "מסלולים שמורים", keep that saved copy in sync.
async function syncOpenSavedRoute(){
  if (!state.currentSavedRouteId) return false;
  const sr = state.savedRoutes.find(x=> x.id === state.currentSavedRouteId);
  if (!sr) return false;
  sr.snapshot = templateSnapshot();
  await persistSavedRoutes();
  return true;
}

/* =========================================================================
   CHANGE START / RETURN POINT OF AN EXISTING (OR SAVED) ROUTE
========================================================================= */
const epPicked = { start: null, end: null };
function renderEndpointsCard(){
  if (!els('endpointsCard') || !state.start) return;
  const startTxt = state.start.text || state.start.resolvedLabel || '';
  const endTxt = state.endSameAsStart ? '' : ((state.end && (state.end.text || state.end.resolvedLabel)) || '');
  els('epStartInput').value = startTxt;
  els('epEndInput').value = endTxt;
  els('epReturnToStart').checked = !!state.endSameAsStart;
  els('epEndWrap').style.display = state.endSameAsStart ? 'none' : '';
  els('endpointsSummary').textContent = 'כרגע: יציאה מ"' + startTxt + '" · ' +
    (state.endSameAsStart ? 'חזרה לנקודת ההתחלה' : 'סיום ב"' + endTxt + '"');
  epPicked.start = null; epPicked.end = null;
}
(function wireEndpoints(){
  if (!els('endpointsCard')) return;
  ['start','end'].forEach(which=>{
    const el = els(which === 'start' ? 'epStartInput' : 'epEndInput');
    attachAddressAutocomplete(el, (r)=>{ epPicked[which] = {text:r.display_name, lat:parseFloat(r.lat), lon:parseFloat(r.lon)}; });
    el.addEventListener('input', ()=>{ if (el.dataset.justSelected){ delete el.dataset.justSelected; return; } epPicked[which] = null; });
  });
  els('epReturnToStart').addEventListener('change', ()=>{
    els('epEndWrap').style.display = els('epReturnToStart').checked ? 'none' : '';
  });
  els('epSaveBtn').addEventListener('click', saveEndpoints);
})();

async function resolvePoint(text, picked, id){
  if (picked && picked.text === text) return { id, text, lat: picked.lat, lon: picked.lon, resolvedLabel: picked.text, geocodeStatus:'ok', candidates:[] };
  const city = els('globalCityInput') ? els('globalCityInput').value.trim() : '';
  const r = await geocodeOne(text, city || null);
  if (!r || !r.length) return null;
  return { id, text, lat: parseFloat(r[0].lat), lon: parseFloat(r[0].lon), resolvedLabel: r[0].display_name, geocodeStatus:'ok', candidates:[] };
}

async function saveEndpoints(){
  if (!state.stops.length){ toast('אין מסלול פתוח'); return; }
  if (state.offline || navigator.onLine === false){ toast('אין חיבור — שינוי נקודות צריך אינטרנט'); return; }
  const startText = els('epStartInput').value.trim();
  const returnToStart = els('epReturnToStart').checked;
  const endText = els('epEndInput').value.trim();
  if (!startText){ toast('הכנס נקודת התחלה'); return; }
  if (!returnToStart && !endText){ toast('הכנס נקודת חזור, או סמן "לחזור לנקודת ההתחלה"'); return; }
  const btn = els('epSaveBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> מחפש את הנקודות...';
  try {
    const curStart = state.start.text || state.start.resolvedLabel || '';
    if (startText !== curStart){
      const p = await resolvePoint(startText, epPicked.start, '__start__');
      if (!p){ toast('נקודת ההתחלה לא נמצאה — נסה לבחור מההצעות'); return; }
      state.start = p;
    }
    if (returnToStart){
      state.endSameAsStart = true;
    } else {
      const curEnd = (!state.endSameAsStart && state.end) ? (state.end.text || state.end.resolvedLabel || '') : '';
      if (endText !== curEnd || state.endSameAsStart){
        const p = await resolvePoint(endText, epPicked.end, '__end__');
        if (!p){ toast('נקודת החזור לא נמצאה — נסה לבחור מההצעות'); return; }
        state.end = p;
      }
      state.endSameAsStart = false;
    }
    btn.innerHTML = '<span class="spinner"></span> מעדכן מסלול...';
    if (els('epReorder').checked){
      await computeOptimalRoute(); // also saves today's route
    } else {
      await recomputeRouteGeometry();
      await persistTodayRoute();
      renderResult();
    }
    const synced = await syncOpenSavedRoute();
    toast('הנקודות עודכנו' + (synced ? ' · המסלול השמור עודכן' : ''));
  } catch(e){
    toast('לא הצלחתי לעדכן: ' + (e.message || 'שגיאה'));
  } finally {
    btn.disabled = false; btn.textContent = 'עדכן נקודות';
    renderEndpointsCard();
  }
}

/* =========================================================================
   EDIT A STOP IN AN EXISTING ROUTE — fix the address and/or the courier note.
   A changed address is looked up again and keeps its place in the order.
========================================================================= */
function openEditStop(idx){
  const s = state.stops[idx];
  if (!s) return;
  const old = document.getElementById('editStopOverlay'); if (old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'editStopOverlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;';
  ov.innerHTML = `
    <div class="card" style="width:100%;max-width:440px">
      <h2>עריכת עצירה ${idx+1}</h2>
      <div class="field autocomplete-wrap">
        <label class="field-label">כתובת</label>
        <input type="text" id="editStopAddr" autocomplete="off">
      </div>
      <div class="field">
        <label class="field-label">כמות למסירה (ספרים / יחידות)</label>
        <input type="number" id="editStopQty" min="0" inputmode="numeric" placeholder="לא חובה">
      </div>
      <div class="field">
        <label class="field-label">הערה לשליח</label>
        <textarea id="editStopNotes" style="min-height:80px"></textarea>
      </div>
      <div class="row">
        <button class="btn btn-primary" id="editStopSave">שמור</button>
        <button class="btn btn-secondary" id="editStopCancel">ביטול</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const addrEl = document.getElementById('editStopAddr');
  const notesEl = document.getElementById('editStopNotes');
  addrEl.value = s.raw || '';
  notesEl.value = s.notes || '';
  const qtyEl = document.getElementById('editStopQty');
  qtyEl.value = s.qty != null ? s.qty : '';
  let picked = null;
  attachAddressAutocomplete(addrEl, (r)=>{ picked = {text:r.display_name, lat:parseFloat(r.lat), lon:parseFloat(r.lon)}; });
  addrEl.addEventListener('input', ()=>{ if (addrEl.dataset.justSelected){ delete addrEl.dataset.justSelected; return; } picked = null; });
  const close = ()=> ov.remove();
  document.getElementById('editStopCancel').addEventListener('click', close);
  ov.addEventListener('click', (e)=>{ if (e.target === ov) close(); });
  document.getElementById('editStopSave').addEventListener('click', async ()=>{
    const newText = addrEl.value.trim();
    const newNotes = notesEl.value.trim() || null;
    const qv = qtyEl.value.trim();
    s.qty = qv === '' ? null : Math.max(0, parseInt(qv, 10) || 0);
    if (s.qty != null && !s.qtyLabel) s.qtyLabel = 'ספרים';
    if (!newText){ toast('הכתובת ריקה'); return; }
    const btn = document.getElementById('editStopSave');
    const addrChanged = newText !== (s.raw || '');
    if (addrChanged){
      if (state.offline || navigator.onLine === false){ toast('אין חיבור — שינוי כתובת צריך אינטרנט. אפשר לשנות כרגע רק את ההערה'); return; }
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> מחפש...';
      try {
        let lat, lon, label;
        if (picked && picked.text === newText){ ({lat, lon} = picked); label = picked.text; }
        else {
          const city = els('globalCityInput') ? els('globalCityInput').value.trim() : '';
          const r = await geocodeOne(newText, city || null);
          if (!r || !r.length){ toast('הכתובת החדשה לא נמצאה — נסה לכתוב אחרת או לבחור מההצעות'); btn.disabled=false; btn.textContent='שמור'; return; }
          lat = parseFloat(r[0].lat); lon = parseFloat(r[0].lon); label = r[0].display_name;
        }
        s.raw = newText; s.lat = lat; s.lon = lon; s.resolvedLabel = label; s.geocodeStatus = 'ok';
        s.notes = newNotes;
        btn.innerHTML = '<span class="spinner"></span> מעדכן מסלול...';
        await recomputeRouteGeometry();
      } catch(e){
        toast('לא הצלחתי לעדכן: ' + (e.message || 'שגיאה')); btn.disabled=false; btn.textContent='שמור'; return;
      }
    } else {
      s.notes = newNotes;
    }
    await persistTodayRoute();
    const synced = await syncOpenSavedRoute();
    close();
    renderResult();
    toast((addrChanged ? 'הכתובת עודכנה' : 'ההערה עודכנה') + (synced ? ' · המסלול השמור עודכן' : '') +
      (addrChanged ? ' — אפשר ללחוץ "חשב מחדש" לסדר אופטימלי' : ''));
  });
  setTimeout(()=> addrEl.focus(), 50);
}

/* =========================================================================
   SAVE ROUTE / SAVE CUSTOMER FROM RESULT
========================================================================= */
els('saveRouteBtn').addEventListener('click', async ()=>{
  const name = prompt('תן שם למסלול (למשל: מסלול יום ראשון)');
  if (!name) return;
  const id = newId();
  state.savedRoutes.push({ id, name, createdAt: Date.now(), snapshot: templateSnapshot() });
  state.currentSavedRouteId = id;
  await persistSavedRoutes();
  toast('המסלול נשמר');
});

els('exportExcelBtn').addEventListener('click', async ()=>{
  if (!state.stops.length){ toast('אין מסלול לייצוא'); return; }
  const btn = els('exportExcelBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> מכין קובץ...';
  try {
    const res = await fetch('/api/export-route', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      credentials:'same-origin',
      body: JSON.stringify({ stops: state.stops, totalDistance: state.totalDistance, totalDuration: state.totalDuration }),
    });
    if (!res.ok){ toast('שגיאה בהפקת הקובץ'); btn.disabled=false; btn.textContent=originalLabel; return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'מסלול.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch(e){
    toast('שגיאה בייצוא הקובץ');
  }
  btn.disabled = false; btn.textContent = originalLabel;
});

/* =========================================================================
   NAVIGATION LAUNCH (multi-stop, chunked for URL limits)
========================================================================= */
els('startDrivingBtn').addEventListener('click', ()=>{
  if (!state.stops.length){ toast('אין עצירות במסלול'); return; }
  openDrivingMode();
});

// Google Maps takes at most 9 stops in between + 1 destination per link,
// so a long route is split into consecutive parts of up to 10 stops. Each
// part starts where the previous one ended.
const GMAPS_STOPS_PER_LINK = 10;
function gmapsDirUrl(origin, stops){
  const dest = stops[stops.length-1];
  const via = stops.slice(0, -1).map(p=> p.lat+','+p.lon).join('|');
  let url = `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lon}&travelmode=driving`;
  if (origin) url += `&origin=${origin.lat},${origin.lon}`; // no origin = from where the phone is now
  if (via) url += `&waypoints=${encodeURIComponent(via)}`;
  return url;
}
function buildGoogleMapsChunks(){
  const chunks = [];
  const pts = state.stops;
  let origin = state.start;
  for (let i = 0; i < pts.length; i += GMAPS_STOPS_PER_LINK){
    const slice = pts.slice(i, i + GMAPS_STOPS_PER_LINK);
    const done = slice.every(p=> p.deliveryStatus === 'נמסר');
    chunks.push({url: gmapsDirUrl(origin, slice), from: i+1, to: i + slice.length, done});
    origin = slice[slice.length-1];
  }
  const back = state.endSameAsStart ? state.start : state.end;
  if (back && back.lat != null && pts.length){
    chunks.push({url: gmapsDirUrl(origin, [back]), back: true});
  }
  return chunks;
}
// From where the driver is right now, through the next undelivered stops.
function nextStopsForGoogle(fromIdx){
  const out = [];
  for (let i = Math.max(0, fromIdx||0); i < state.stops.length && out.length < GMAPS_STOPS_PER_LINK; i++){
    if (state.stops[i].deliveryStatus !== 'נמסר') out.push({s: state.stops[i], idx: i});
  }
  return out;
}
function googleMapsNextUrl(fromIdx){
  const next = nextStopsForGoogle(fromIdx);
  if (!next.length) return null;
  return { url: gmapsDirUrl(null, next.map(n=> n.s)), first: next[0].idx+1, last: next[next.length-1].idx+1, count: next.length };
}

/* =========================================================================
   DRIVING MODE — minimal single-stop screen
========================================================================= */
function openDrivingMode(){
  state.drivingIndex = state.stops.findIndex(s=> s.deliveryStatus !== 'נמסר' && s.deliveryStatus !== 'לא נמסר');
  if (state.drivingIndex === -1) state.drivingIndex = state.stops.length; // all done
  renderDrivingScreen();
}
function renderDrivingScreen(){
  let overlay = document.getElementById('drivingOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.className = 'driving-screen';
  overlay.id = 'drivingOverlay';

  const total = state.stops.length;
  const done = state.stops.filter(s=>s.deliveryStatus==='נמסר').length;

  if (state.drivingIndex >= total){
    overlay.innerHTML = `
      <div class="driving-top"><div class="driving-progress">${done}/${total} נמסרו</div>
        <button class="icon-btn" id="exitDriving"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="driving-done">
        <div class="driving-addr">${statusCounts().failed ? 'עברת על כל הכתובות' : 'כל העצירות הושלמו 🎉'}</div>
        <p class="hint">✓ נמסרו ${done} מתוך ${total} · ${fmtKm(state.totalDistance||0)} ק"מ</p>
        ${statusCounts().failed ? `<div class="card" style="text-align:right;margin-top:14px">
          <h2 style="color:var(--danger)">✗ לא נמסרו (${statusCounts().failed})</h2>
          ${state.stops.map((x,i)=> x.deliveryStatus==='לא נמסר' ? `<div class="saved-route-row"><div><div class="saved-route-name">${i+1}. ${escapeHtml(x.raw)}</div>${x.notes?`<div class="saved-route-sub">${escapeHtml(x.notes)}</div>`:''}</div><a class="btn btn-secondary" href="${wazeLink(x)}" target="_blank" rel="noopener">נווט</a></div>` : '').join('')}
          <p class="hint" style="margin-top:10px">כשמוסרים אחת מהן — מסמנים "נמסר" ברשימת העצירות.</p>
        </div>` : ''}
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#exitDriving').addEventListener('click', ()=>{ stopLiveNav(); overlay.remove(); });
    return;
  }

  const s = state.stops[state.drivingIndex];
  overlay.innerHTML = `
    <div class="driving-top">
      <div class="driving-progress">עצירה ${state.drivingIndex+1} מתוך ${total} · ✓ ${done} נמסרו · ✗ ${statusCounts().failed} לא · ⏳ ${statusCounts().left} נשארו</div>
      <button class="icon-btn" id="exitDriving"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="driving-body">
      <div class="driving-stopnum">${state.drivingIndex+1}</div>
      <div class="driving-addr">${escapeHtml(s.name ? s.name+' — '+s.raw : s.raw)}</div>
      ${qtyBadge(s, true)}
      ${s.legDist!=null ? `<div class="driving-meta">${fmtKm(s.legDist)} ק"מ מהעצירה הקודמת · ${fmtDuration(s.legDur)}</div>`:''}
      ${s.windowStart ? `<div class="driving-window">חלון זמן: ${s.windowStart}–${s.windowEnd||''}</div>`:''}
      ${s.notes ? `<div class="stop-notes" style="max-width:420px;text-align:right">📝 ${escapeHtml(s.notes)}</div>`:''}
    </div>
    <div class="driving-actions">
      <button class="btn btn-primary btn-block btn-lg" id="startLiveNavBtn">נווט (עם הכוונה קולית)</button>
      <a class="btn btn-secondary btn-block" href="${wazeLink(s)}" target="_blank" rel="noopener">פתח ב-Waze (מהמיקום הנוכחי)</a>
      ${(()=>{ const n = googleMapsNextUrl(state.drivingIndex); return n && n.count > 1
        ? `<a class="btn btn-secondary btn-block" href="${n.url}" target="_blank" rel="noopener">Google Maps · ${n.count} העצירות הבאות ברצף</a>` : ''; })()}
      <a class="btn btn-secondary btn-block" href="${googleMapsFromPrev(state.drivingIndex)}" target="_blank" rel="noopener">Google Maps לעצירה הזו (מהכתובת הקודמת)</a>
      <div class="row" style="gap:10px">
        <button class="btn btn-lg" id="markDeliveredBtn" style="background:var(--success);color:#0d1613;flex:2">✓ נמסר</button>
        <button class="btn btn-lg btn-danger" id="markFailedBtn" style="flex:1">✗ לא נמסר</button>
      </div>
      <button class="btn btn-secondary btn-block" id="drvActionBtn">📝 הערת פעולה / סכום${s.actionNote||s.chargedPrice!=null?' ✓':''}</button>
      <button class="btn btn-ghost btn-block" id="skipStopBtn">דלג בינתיים (בלי לסמן)</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#exitDriving').addEventListener('click', ()=>{ stopLiveNav(); overlay.remove(); });
  overlay.querySelector('#startLiveNavBtn').addEventListener('click', ()=> startLiveNav(s));
  overlay.querySelector('#markDeliveredBtn').addEventListener('click', ()=>{
    setStopStatus(state.drivingIndex, 'נמסר');
    advanceDriving();
  });
  overlay.querySelector('#markFailedBtn').addEventListener('click', ()=>{
    setStopStatus(state.drivingIndex, 'לא נמסר');
    advanceDriving();
  });
  overlay.querySelector('#skipStopBtn').addEventListener('click', advanceDriving);
  overlay.querySelector('#drvActionBtn').addEventListener('click', ()=>{
    const idx = state.drivingIndex;
    openStopAction(idx);
    // refresh the driving screen after saving so the ✓ shows
    const obs = setInterval(()=>{ if (!document.getElementById('actionOverlay')){ clearInterval(obs); if (document.getElementById('drivingOverlay')) renderDrivingScreen(); } }, 300);
  });
}
function advanceDriving(){
  let next = state.drivingIndex + 1;
  while (next < state.stops.length && (state.stops[next].deliveryStatus === 'נמסר' || state.stops[next].deliveryStatus === 'לא נמסר')) next++;
  state.drivingIndex = next;
  renderDrivingScreen();
  renderResult();
}

/* =========================================================================
   LIVE TURN-BY-TURN NAVIGATION — GPS position, moving vehicle marker, and
   spoken directions, using the phone's own GPS and the browser's built-in
   text-to-speech. Waze/Google remain available as a fallback button.
========================================================================= */
function haversineMeters(lat1, lon1, lat2, lon2){
  const R = 6371000;
  const toRad = d => d*Math.PI/180;
  const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function bearingDegrees(lat1, lon1, lat2, lon2){
  const toRad = d => d*Math.PI/180, toDeg = r => r*180/Math.PI;
  const y = Math.sin(toRad(lon2-lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) - Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(toRad(lon2-lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function maneuverRotation(modifier){
  const map = {'left':-90,'slight left':-45,'sharp left':-135,'right':90,'slight right':45,'sharp right':135,'straight':0,'uturn':180};
  return map[modifier] ?? 0;
}
function maneuverText(step){
  if (!step) return '';
  const type = step.maneuver.type, modifier = step.maneuver.modifier;
  const name = step.name || '';
  const streetPart = name ? ' אל ' + name : '';
  const dir = {
    left:'שמאלה', right:'ימינה', straight:'ישר',
    'slight left':'שמאלה בעדינות', 'slight right':'ימינה בעדינות',
    'sharp left':'שמאלה בחדות', 'sharp right':'ימינה בחדות', uturn:'פרסה'
  };
  switch(type){
    case 'depart': return 'התחל בנסיעה' + streetPart;
    case 'arrive': return 'הגעת ליעד';
    case 'roundabout': case 'rotary':
      return `בכיכר, צא ביציאה ${step.maneuver.exit||''}` + streetPart;
    case 'turn': return `פנה ${dir[modifier]||'ישר'}` + streetPart;
    case 'continue': return `המשך ${dir[modifier]||'ישר'}` + streetPart;
    case 'merge': return 'התמזג לכביש' + streetPart;
    case 'on ramp': return 'עלה לכביש' + streetPart;
    case 'off ramp': return 'רד מהכביש' + streetPart;
    case 'fork': return `בפיצול, המשך ${dir[modifier]||''}` + streetPart;
    case 'end of road': return `בסוף הכביש, פנה ${dir[modifier]||''}` + streetPart;
    case 'new name': return 'המשך בדרך' + streetPart;
    default: return 'המשך בנסיעה' + streetPart;
  }
}
// The browser's voice list often loads asynchronously — on first call it can
// be empty even though Hebrew voices exist, so we wait for it once and cache
// whichever Hebrew voice (if any) is actually installed on this device.
let _hebrewVoicePromise = null;
function findHebrewVoice(){
  if (_hebrewVoicePromise) return _hebrewVoicePromise;
  _hebrewVoicePromise = new Promise((resolve)=>{
    const pick = ()=> {
      const voices = window.speechSynthesis.getVoices() || [];
      const he = voices.find(v=> v.lang && v.lang.toLowerCase().startsWith('he'));
      resolve(he || null);
    };
    const existing = window.speechSynthesis.getVoices();
    if (existing && existing.length){ pick(); return; }
    window.speechSynthesis.onvoiceschanged = pick;
    setTimeout(pick, 1200); // safety net for browsers that never fire the event
  });
  return _hebrewVoicePromise;
}
async function speak(text){
  if (!('speechSynthesis' in window) || !text) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'he-IL';
    const voice = await findHebrewVoice();
    if (voice) u.voice = voice;
    else console.warn('No Hebrew voice found on this device — using the browser default, which may mispronounce Hebrew.');
    u.rate = 1.0;
    window.speechSynthesis.speak(u);
  } catch(e){ /* speech not available — silently ignore */ }
}

async function startLiveNav(stop){
  if (!('geolocation' in navigator)){ toast('הדפדפן הזה לא תומך באיתור מיקום'); return; }
  state.liveNav.pendingStop = stop;
  renderLiveNavShell(stop);
  // If permission was already refused, asking again does nothing on most
  // phones — explain how to turn it back on instead of failing silently.
  try {
    if (navigator.permissions && navigator.permissions.query){
      const st = await navigator.permissions.query({name:'geolocation'});
      if (st.state === 'denied'){ showLiveNavPermissionError({code:1}); return; }
      if (st.state === 'prompt'){ showLocationAsk(stop); return; }
    }
  } catch(e){ /* permissions API not available — just ask directly */ }
  requestPositionForNav(stop);
}

// Explicit "allow location" screen: the system prompt then appears right
// after the person taps, which phones and the Android app wrapper handle best.
function showLocationAsk(stop){
  const el = document.getElementById('liveNavPermission');
  if (!el) return;
  el.innerHTML = `<div style="max-width:340px">
    <div style="font-size:40px;margin-bottom:8px">📍</div>
    <p style="font-weight:700;font-size:17px;margin:0 0 6px">צריך את המיקום שלך לניווט</p>
    <p class="hint">בלחיצה על הכפתור הטלפון ישאל אם לאשר גישה למיקום — בחרו "אפשר" (או "בזמן השימוש באפליקציה").</p>
    <button class="btn btn-primary btn-block btn-lg" id="allowLocationBtn">אפשר מיקום והתחל ניווט</button>
    <button class="btn btn-ghost btn-block" id="cancelLocationBtn">ביטול</button>
  </div>`;
  document.getElementById('allowLocationBtn').addEventListener('click', ()=>{
    el.innerHTML = `<div><div class="spinner" style="width:26px;height:26px;margin:0 auto 14px"></div><p class="hint">מאתר את המיקום שלך...</p></div>`;
    requestPositionForNav(stop);
  });
  document.getElementById('cancelLocationBtn').addEventListener('click', stopLiveNav);
}

function requestPositionForNav(stop){
  navigator.geolocation.getCurrentPosition(
    (pos)=> beginLiveNavWithPosition(stop, pos),
    (err)=>{
      // Precise GPS often times out indoors / right after starting — fall
      // back to a quicker, less precise fix before giving up.
      if (err && err.code !== 1){
        navigator.geolocation.getCurrentPosition(
          (pos)=> beginLiveNavWithPosition(stop, pos),
          (err2)=> showLiveNavPermissionError(err2),
          {enableHighAccuracy:false, timeout:20000, maximumAge:60000}
        );
      } else {
        showLiveNavPermissionError(err);
      }
    },
    {enableHighAccuracy:true, timeout:12000, maximumAge:10000}
  );
}

function renderLiveNavShell(stop){
  let overlay = document.getElementById('liveNavOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.className = 'livenav-screen';
  overlay.id = 'liveNavOverlay';
  overlay.innerHTML = `
    <div class="livenav-exit"><button id="exitLiveNav">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button></div>
    <div class="livenav-map" id="liveNavMapWrap">
      <div class="livenav-permission" id="liveNavPermission">
        <div>
          <div class="spinner" style="width:26px;height:26px;margin:0 auto 14px"></div>
          <p class="hint">מבקש הרשאת מיקום כדי להתחיל ניווט...</p>
        </div>
      </div>
      <div id="liveNavMap" style="width:100%;height:100%"></div>
    </div>
    <div class="livenav-bottom">
      <div class="lv-target"><b>יעד:</b> ${escapeHtml(stop.name ? stop.name+' — '+stop.raw : stop.raw)}</div>
      <button class="btn" id="lnDeliveredBtn" style="background:var(--success);color:#0d1613">✓ נמסר</button>
      <button class="btn btn-danger" id="lnFailedBtn">✗ לא</button>
      <button class="btn btn-secondary" id="stopLiveNavBtn">עצור</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#exitLiveNav').addEventListener('click', stopLiveNav);
  overlay.querySelector('#stopLiveNavBtn').addEventListener('click', stopLiveNav);
  const markFromNav = (val)=>{
    const idx = state.stops.indexOf(stop);
    stopLiveNav();
    if (idx === -1) return;
    setStopStatus(idx, val);
    if (document.getElementById('drivingOverlay')){ state.drivingIndex = idx; advanceDriving(); }
  };
  overlay.querySelector('#lnDeliveredBtn').addEventListener('click', ()=> markFromNav('נמסר'));
  overlay.querySelector('#lnFailedBtn').addEventListener('click', ()=> markFromNav('לא נמסר'));
}

function showLiveNavPermissionError(err){
  const el = document.getElementById('liveNavPermission');
  if (!el) return;
  const denied = err && err.code === 1;
  const s = (state.liveNav && state.liveNav.pendingStop) || null;
  const msg = denied
    ? `הגישה למיקום חסומה כרגע.<br><br><b>איך מאשרים:</b><br>
       • <b>באפליקציה:</b> הגדרות הטלפון ← אפליקציות ← דרך חתם סופר ← הרשאות ← מיקום ← "אפשר בזמן השימוש". אם אין שם — אותו דבר עבור <b>Chrome</b>.<br>
       • <b>בדפדפן:</b> לחצו על סמל המנעול/ההגדרות ליד הכתובת ← הרשאות ← מיקום ← אפשר.<br>
       • ודאו גם ש<b>המיקום (GPS) של הטלפון דלוק</b>.<br><br>אחר כך חזרו ולחצו שוב על "נווט".`
    : `לא הצלחנו לקבל מיקום (${escapeHtml((err && err.message) || 'אין אות GPS')}).<br>ודאו שה-GPS דלוק ונסו שוב, רצוי ליד חלון או בחוץ.<br><br><b>במסך מולטימדיה ברכב:</b> ודאו שמותקן ומעודכן <b>Google Chrome</b> ושיש לו הרשאת מיקום (הגדרות ← אפליקציות ← Chrome ← הרשאות ← מיקום), ושהמסך מקבל GPS (למשל ש-Waze מראה את הרכב זז).`;
  el.style.display = '';
  el.innerHTML = `<div style="max-width:380px;text-align:right">
    <p class="hint" style="line-height:1.7">${msg}</p>
    <p class="hint" style="font-size:11.5px;opacity:.7">קוד שגיאה: ${err && err.code != null ? err.code : '—'} · ${('geolocation' in navigator) ? 'יש תמיכה במיקום' : 'אין תמיכה במיקום במכשיר הזה'}</p>
    ${s ? `<a class="btn btn-secondary btn-block" href="${wazeLink(s)}" target="_blank" rel="noopener" style="margin-bottom:8px">נווט ב-Waze במקום</a>` : ''}
    <button class="btn btn-secondary btn-block" id="closeLiveNavErr">סגור</button>
  </div>`;
  document.getElementById('closeLiveNavErr').addEventListener('click', stopLiveNav);
}

async function beginLiveNavWithPosition(stop, pos){
  const lat = pos.coords.latitude, lon = pos.coords.longitude;
  let data;
  try {
    data = await api('/api/directions', {method:'POST', body:{points:[{lat,lon},{lat:stop.lat, lon:stop.lon}]}});
  } catch(e){
    toast(state.offline || navigator.onLine === false ? 'אין חיבור — הניווט הקולי צריך אינטרנט. אפשר לנווט עם Waze (עובד גם עם חיבור חלש)' : 'לא הצלחתי לחשב מסלול ניווט');
    stopLiveNav();
    return;
  }
  if (data.code !== 'Ok' || !data.routes || !data.routes[0]){
    toast('לא נמצא מסלול ליעד הזה');
    stopLiveNav();
    return;
  }
  const route = data.routes[0];
  const steps = (route.legs[0] && route.legs[0].steps) || [];

  const permEl = document.getElementById('liveNavPermission');
  if (permEl) permEl.style.display = 'none';

  state.liveNav.active = true;
  state.liveNav.steps = steps;
  state.liveNav.currentStepIndex = 0;
  state.liveNav.lastAnnouncedIndex = -1;
  state.liveNav.targetStop = stop;
  state.liveNav.lastPos = {lat, lon};

  const geom = route.geometry.coordinates.map(c=>[c[1], c[0]]);

  if (state.mapProvider === 'google' && window.google && window.google.maps){
    const gmap = new google.maps.Map(document.getElementById('liveNavMap'), {
      center: {lat, lng:lon}, zoom:16, disableDefaultUI:true,
    });
    const path = geom.map(c=>({lat:c[0], lng:c[1]}));
    new google.maps.Polyline({ path, strokeColor:'#3fa89f', strokeWeight:5, strokeOpacity:0.9, map: gmap });
    const gBounds = new google.maps.LatLngBounds();
    path.forEach(p=> gBounds.extend(p));
    gmap.fitBounds(gBounds, 40);
    const vehicleMarker = new google.maps.Marker({
      position:{lat, lng:lon}, map: gmap,
      icon: { path:'M 0,-8 8,8 0,4 -8,8 z', fillColor:'#3fa89f', fillOpacity:1, strokeColor:'#0d1613', strokeWeight:1, scale:1.3, rotation:0 },
    });
    new google.maps.Marker({ position:{lat:stop.lat, lng:stop.lon}, map: gmap, title:'יעד' });
    state.liveNav.map = gmap;
    state.liveNav.vehicleMarker = vehicleMarker;
    state.liveNav.provider = 'google';
  } else {
    const lvMap = L.map('liveNavMap', {zoomControl:false, attributionControl:false});
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19}).addTo(lvMap);
    const line = L.polyline(geom, {color:'#3fa89f', weight:5, opacity:0.9}).addTo(lvMap);
    lvMap.fitBounds(line.getBounds(), {padding:[40,40]});
    const vehicleIcon = L.divIcon({
      html:`<div class="vehicle-marker" id="vehicleMarkerInner"><svg viewBox="0 0 24 24" fill="#3fa89f" stroke="#0d1613" stroke-width="1"><path d="M12 2 L20 20 L12 15 L4 20 Z"/></svg></div>`,
      className:'', iconSize:[26,26], iconAnchor:[13,13]
    });
    const vehicleMarker = L.marker([lat, lon], {icon:vehicleIcon}).addTo(lvMap);
    L.marker([stop.lat, stop.lon]).addTo(lvMap).bindPopup('יעד');
    state.liveNav.map = lvMap;
    state.liveNav.routeLine = line;
    state.liveNav.vehicleMarker = vehicleMarker;
    state.liveNav.provider = 'leaflet';
  }

  renderLiveNavBanner();
  speak(maneuverText(steps[0]));

  state.liveNav.watchId = navigator.geolocation.watchPosition(
    onLiveNavPosition,
    ()=>{ /* transient GPS errors — ignore and keep the last known position */ },
    {enableHighAccuracy:true, maximumAge:1000, timeout:20000}
  );
}

function renderLiveNavBanner(){
  const wrap = document.getElementById('liveNavMapWrap');
  if (!wrap) return;
  let banner = document.getElementById('liveNavBanner');
  const steps = state.liveNav.steps;
  const idx = state.liveNav.currentStepIndex;
  const step = steps[idx];
  if (!banner){
    banner = document.createElement('div');
    banner.className = 'livenav-banner';
    banner.id = 'liveNavBanner';
    wrap.appendChild(banner);
  }
  if (!step){ banner.style.display='none'; return; }
  const rot = maneuverRotation(step.maneuver.modifier);
  banner.innerHTML = `
    <div class="maneuver-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${rot}deg)"><path d="M12 19V5M12 5l-6 6M12 5l6 6"/></svg></div>
    <div class="maneuver-text">
      <div class="maneuver-dist" id="lvManeuverDist">—</div>
      <div class="maneuver-instr">${escapeHtml(maneuverText(step))}</div>
    </div>`;
}

function onLiveNavPosition(pos){
  if (!state.liveNav.active) return;
  const lat = pos.coords.latitude, lon = pos.coords.longitude;

  let heading = pos.coords.heading;
  if (heading == null && state.liveNav.lastPos){
    heading = bearingDegrees(state.liveNav.lastPos.lat, state.liveNav.lastPos.lon, lat, lon);
  }
  state.liveNav.lastPos = {lat, lon};

  if (state.liveNav.vehicleMarker){
    if (state.liveNav.provider === 'google'){
      state.liveNav.vehicleMarker.setPosition({lat, lng:lon});
      if (heading != null){
        const icon = state.liveNav.vehicleMarker.getIcon();
        icon.rotation = heading;
        state.liveNav.vehicleMarker.setIcon(icon);
      }
      if (state.liveNav.map) state.liveNav.map.panTo({lat, lng:lon});
    } else {
      state.liveNav.vehicleMarker.setLatLng([lat, lon]);
      const el = document.getElementById('vehicleMarkerInner');
      if (el && heading != null) el.style.transform = `rotate(${heading}deg)`;
      if (state.liveNav.map) state.liveNav.map.panTo([lat, lon], {animate:true});
    }
  }

  const steps = state.liveNav.steps;
  const idx = state.liveNav.currentStepIndex;
  if (idx >= steps.length) return;
  const step = steps[idx];
  const [mLon, mLat] = step.maneuver.location;
  const dist = haversineMeters(lat, lon, mLat, mLon);

  const distEl = document.getElementById('lvManeuverDist');
  if (distEl) distEl.textContent = dist >= 1000 ? (dist/1000).toFixed(1)+' ק"מ' : Math.round(dist)+' מ׳';

  if (dist < 150 && state.liveNav.lastAnnouncedIndex < idx){
    speak(maneuverText(step));
    state.liveNav.lastAnnouncedIndex = idx;
  }

  if (dist < 25){
    if (step.maneuver.type === 'arrive'){
      speak('הגעת ליעד');
      toast('הגעת ליעד');
      stopLiveNav();
      return;
    }
    state.liveNav.currentStepIndex = idx + 1;
    renderLiveNavBanner();
    const nextStep = steps[state.liveNav.currentStepIndex];
    if (nextStep){ speak(maneuverText(nextStep)); state.liveNav.lastAnnouncedIndex = state.liveNav.currentStepIndex; }
  }
}

function stopLiveNav(){
  if (state.liveNav.watchId != null){
    navigator.geolocation.clearWatch(state.liveNav.watchId);
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (state.liveNav.map && state.liveNav.provider === 'leaflet'){ state.liveNav.map.remove(); }
  // Google Maps instances have no explicit destroy — removing the overlay's
  // DOM node below is enough to release them.
  state.liveNav = { active:false, watchId:null, steps:[], currentStepIndex:0, map:null, vehicleMarker:null,
    routeLine:null, targetStop:null, lastPos:null, lastAnnouncedIndex:-1, provider:null };
  const overlay = document.getElementById('liveNavOverlay');
  if (overlay) overlay.remove();
}

/* =========================================================================
   CUSTOMERS VIEW
========================================================================= */
els('saveCustomerBtn').addEventListener('click', async ()=>{
  const name = els('newCustName').value.trim();
  const addr = els('newCustAddr').value.trim();
  const area = els('newCustArea').value.trim();
  const ws = els('newCustWinStart').value || null;
  const we = els('newCustWinEnd').value || null;
  if (!name || !addr){ toast('הכנס שם וכתובת'); return; }

  const btn = els('saveCustomerBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> שומר...';
  let lat=null, lon=null;
  try {
    const r = await geocodeOne(addr);
    if (r && r.length){ lat = parseFloat(r[0].lat); lon = parseFloat(r[0].lon); }
  } catch(e){ /* keep null, still save address text */ }
  btn.disabled = false; btn.textContent = 'שמור כתובת';

  state.customers.push({ id:newId(), name, addr, area: area||null, lat, lon, windowStart:ws, windowEnd:we });
  await persistCustomers();
  els('newCustName').value=''; els('newCustAddr').value=''; els('newCustArea').value='';
  els('newCustWinStart').value=''; els('newCustWinEnd').value='';
  renderCustomers();
  toast(lat!=null ? 'הלקוח נשמר ואומת' : 'הלקוח נשמר, אך הכתובת תאומת שוב בעת בניית מסלול');
});

function renderCustomers(){
  refreshAreaFilters();
  const filterArea = els('areaFilterCustomers').value;
  const list = els('customersList');
  const filtered = state.customers.filter(c=> !filterArea || c.area === filterArea);
  els('customersEmpty').style.display = state.customers.length ? 'none' : 'block';
  list.innerHTML = '';
  filtered.forEach(c=>{
    const row = document.createElement('div');
    row.className = 'cust-row';
    row.innerHTML = `
      <div class="cust-info">
        <div class="cust-name">${escapeHtml(c.name)}</div>
        <div class="cust-addr">${escapeHtml(c.addr)}</div>
        <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
          ${c.area ? `<span class="badge badge-muted">${escapeHtml(c.area)}</span>` : ''}
          ${c.windowStart ? `<span class="badge badge-accent">${c.windowStart}–${c.windowEnd||''}</span>` : ''}
        </div>
      </div>
      <button class="icon-btn" data-delcust="${c.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-delcust]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      if (!confirm('למחוק את הלקוח הזה?')) return;
      state.customers = state.customers.filter(c=>c.id!==btn.dataset.delcust);
      await persistCustomers();
      renderCustomers();
    });
  });
}
els('areaFilterCustomers').addEventListener('change', renderCustomers);

/* =========================================================================
   SAVED ROUTES VIEW
========================================================================= */
function renderSavedRoutes(){
  const list = els('savedRoutesList');
  els('savedRoutesEmpty').style.display = state.savedRoutes.length ? 'none' : 'block';
  list.innerHTML = '';
  state.savedRoutes.slice().reverse().forEach(r=>{
    const row = document.createElement('div');
    row.className = 'saved-route-row';
    const stopsCount = r.snapshot.stops ? r.snapshot.stops.length : 0;
    row.innerHTML = `
      <div>
        <div class="saved-route-name">${escapeHtml(r.name)}</div>
        <div class="saved-route-sub">${stopsCount} עצירות · נשמר ${new Date(r.createdAt).toLocaleDateString('he-IL')}</div>
      </div>
      <div class="row" style="min-width:auto;gap:6px">
        <button class="btn btn-secondary" data-openroute="${r.id}">פתח</button>
        <button class="icon-btn" data-delroute="${r.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-openroute]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const r = state.savedRoutes.find(x=>x.id===btn.dataset.openroute);
      applySnapshot(r.snapshot, false);
      state.currentSavedRouteId = r.id;
      state.mapMode = 'full';
      document.querySelectorAll('#mapTabs [data-mapmode]').forEach(b=>b.classList.toggle('active', b.dataset.mapmode==='full'));
      if (!state.offline && navigator.onLine !== false) await recomputeRouteGeometry();
      renderResult();
      switchView('result');
      toast('המסלול נטען');
    });
  });
  list.querySelectorAll('[data-delroute]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      if (!confirm('למחוק את המסלול השמור הזה?')) return;
      state.savedRoutes = state.savedRoutes.filter(r=>r.id!==btn.dataset.delroute);
      await persistSavedRoutes();
      renderSavedRoutes();
    });
  });
}

/* =========================================================================
   DASHBOARD
========================================================================= */
function renderDashboard(){
  const hasRoute = state.stops.length > 0;
  els('todayEmptyHint').style.display = hasRoute ? 'none' : 'block';
  els('todayStats').style.display = hasRoute ? 'block' : 'none';
  if (hasRoute){
    const done = state.stops.filter(s=>s.deliveryStatus==='נמסר').length;
    els('dStatTotal').textContent = state.stops.length;
    els('dStatDone').textContent = done;
    els('dStatLeft').textContent = state.stops.length - done;
    els('dStatDist').textContent = state.totalDistance!=null ? fmtKm(state.totalDistance) : '—';
    els('dStatTime').textContent = state.totalDuration!=null ? fmtDuration(state.totalDuration) : '—';
  }
  els('historyCount').textContent = state.history.length ? `${state.history.length} מסלולים שהושלמו` : 'אין עדיין היסטוריה';
}
els('dContinueBtn').addEventListener('click', ()=>{ switchView('result'); });
els('dDrivingBtn').addEventListener('click', ()=>{ openDrivingMode(); });
els('dHistoryBtn').addEventListener('click', ()=>{
  const card = els('historyCard');
  card.style.display = card.style.display==='none' ? 'block':'none';
  if (card.style.display==='block') renderHistory();
});
function renderHistory(){
  const list = els('historyList');
  if (!state.history.length){ list.innerHTML = '<div class="empty-state"><p>אין עדיין היסטוריה.</p></div>'; return; }
  list.innerHTML = state.history.slice().reverse().map(h=>`
    <div class="saved-route-row">
      <div>
        <div class="saved-route-name">${new Date(h.completedAt).toLocaleDateString('he-IL')}</div>
        <div class="saved-route-sub">${h.stopsCount} משלוחים · ${fmtKm(h.distance)} ק"מ</div>
      </div>
    </div>`).join('');
}

/* =========================================================================
   AUTH — register / login / logout / forgot & reset password
========================================================================= */
function showApp(user){
  state.currentUser = user;
  document.getElementById('authGate').style.display = 'none';
  document.getElementById('app').style.display = '';
  const nameEl = document.getElementById('currentUserName');
  if (nameEl) nameEl.textContent = user.name;
}
function showAuthGate(){
  document.getElementById('authGate').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function authError(msg){
  const el = document.getElementById('authErrorMsg');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}
function authInfo(msg){
  const el = document.getElementById('authInfoMsg');
  if (!el) return;
  el.innerHTML = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

function switchAuthMode(mode){
  ['login','register','forgot','reset'].forEach(m=>{
    document.getElementById('authForm-'+m).style.display = (m===mode) ? 'block' : 'none';
  });
  authError(''); authInfo('');
}

document.querySelectorAll('[data-authmode]').forEach(el=>{
  el.addEventListener('click', (e)=>{ e.preventDefault(); switchAuthMode(el.dataset.authmode); });
});

document.getElementById('loginForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  authError('');
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  try {
    const r = await api('/api/login', {method:'POST', body:{email, password}});
    await afterAuthSuccess(r.user);
  } catch(err){ authError(err.message); }
});

document.getElementById('registerForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  authError('');
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  try {
    const r = await api('/api/register', {method:'POST', body:{name, email, password}});
    await afterAuthSuccess(r.user);
  } catch(err){ authError(err.message); }
});

document.getElementById('forgotForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  authError(''); authInfo('');
  const email = document.getElementById('forgotEmail').value.trim();
  try {
    const r = await api('/api/forgot-password', {method:'POST', body:{email}});
    if (r.resetLink){
      authInfo(`בסביבה הזו אין עדיין שירות מייל מוגדר, אז הנה קישור האיפוס ישירות: <a href="${r.resetLink}">${r.resetLink}</a>`);
    } else {
      authInfo('אם קיים חשבון עם האימייל הזה, נשלח אליו קישור לאיפוס סיסמה.');
    }
  } catch(err){ authError(err.message); }
});

document.getElementById('resetForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  authError('');
  const token = document.getElementById('resetToken').value;
  const password = document.getElementById('resetPassword').value;
  try {
    await api('/api/reset-password', {method:'POST', body:{token, password}});
    const me = await api('/api/me');
    await afterAuthSuccess(me.user);
  } catch(err){ authError(err.message); }
});

document.getElementById('logoutBtn').addEventListener('click', async ()=>{
  try { await api('/api/logout', {method:'POST'}); } catch(e){}
  clearOfflineCopy();
  state.currentUser = null;
  showAuthGate();
  switchAuthMode('login');
});

function loadGoogleMapsScript(key){
  if (window.google && window.google.maps) return Promise.resolve();
  if (window.__gmapsLoadingPromise) return window.__gmapsLoadingPromise;
  window.__gmapsLoadingPromise = new Promise((resolve, reject)=>{
    window.__gmapsReadyCallback = ()=> resolve();
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__gmapsReadyCallback`;
    script.async = true;
    script.onerror = ()=> reject(new Error('טעינת Google Maps נכשלה'));
    document.head.appendChild(script);
  });
  return window.__gmapsLoadingPromise;
}

async function afterAuthSuccess(user, offline){
  showApp(user);
  if (offline) loadFromOfflineCopy(); else await loadAll();
  try {
    if (state.offline) throw new Error('offline');
    const cfg = await api('/api/config');
    if (cfg.googleMapsKey){
      await loadGoogleMapsScript(cfg.googleMapsKey);
      state.mapProvider = 'google';
    } else {
      state.mapProvider = 'leaflet';
    }
  } catch(e){
    state.mapProvider = 'leaflet'; // Google failed to load (bad key, network, etc) — fall back quietly
  }
  renderDashboard();
  switchView('dashboard');
}

/* =========================================================================
   INIT
========================================================================= */
(async function init(){
  // A password-reset link looks like /?resetToken=XXXX — detect it first.
  const params = new URLSearchParams(window.location.search);
  const resetToken = params.get('resetToken');

  try {
    const me = await api('/api/me');
    if (resetToken){
      // already logged in but opened a reset link anyway — just log them in normally
      history.replaceState({}, '', window.location.pathname);
    }
    await afterAuthSuccess(me.user);
    return;
  } catch(e){
    // No internet: open with the copy saved on this device (if there is one)
    const local = readOfflineCopy();
    if (isNetworkError(e) && local && local.user){
      await afterAuthSuccess(local.user, true);
      return;
    }
  }

  showAuthGate();
  if (resetToken){
    document.getElementById('resetToken').value = resetToken;
    switchAuthMode('reset');
  } else {
    switchAuthMode('login');
  }
})();
