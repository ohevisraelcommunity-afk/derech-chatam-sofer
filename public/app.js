
/* =========================================================================
   STATE
========================================================================= */
const state = {
  view: 'dashboard',
  currentUser: null,
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
async function loadAll(){
  try { const r = await api('/api/data/customers'); state.customers = r.value || []; }
  catch(e){ state.customers = []; }
  try { const r = await api('/api/data/savedRoutes'); state.savedRoutes = r.value || []; }
  catch(e){ state.savedRoutes = []; }
  try { const r = await api('/api/data/history'); state.history = r.value || []; }
  catch(e){ state.history = []; }
  try {
    const r = await api('/api/data/todayRoute');
    if (r.value) applySnapshot(r.value, false);
  } catch(e){ /* no today route yet */ }
}
async function persistCustomers(){
  try { await api('/api/data/customers', {method:'PUT', body:{value: state.customers}}); }
  catch(e){ toast('שמירת הלקוחות נכשלה'); }
}
async function persistSavedRoutes(){
  try { await api('/api/data/savedRoutes', {method:'PUT', body:{value: state.savedRoutes}}); }
  catch(e){ toast('שמירת המסלול נכשלה'); }
}
async function persistHistory(){
  try { await api('/api/data/history', {method:'PUT', body:{value: state.history}}); }
  catch(e){ /* non-critical */ }
}
async function persistTodayRoute(){
  const value = state.stops.length ? snapshotCurrent() : null;
  try { await api('/api/data/todayRoute', {method:'PUT', body:{value}}); }
  catch(e){ /* non-critical */ }
}

function snapshotCurrent(){
  return {
    start: state.start, end: state.end, endSameAsStart: state.endSameAsStart,
    routePref: state.routePref, departureTime: state.departureTime,
    stops: state.stops, routeGeometry: state.routeGeometry, routeIsManual: state.routeIsManual,
  };
}
function applySnapshot(snap, redraw){
  state.start = snap.start; state.end = snap.end; state.endSameAsStart = snap.endSameAsStart;
  state.routePref = snap.routePref || 'fastest'; state.departureTime = snap.departureTime || null;
  state.stops = snap.stops || []; state.routeGeometry = snap.routeGeometry || null;
  state.routeIsManual = !!snap.routeIsManual;
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
  if (name === 'builder' && !state.pendingAddresses.length){
    state.pendingAddresses.push({id:newId(), text:''});
    renderAddressRows();
  }
}
document.querySelectorAll('[data-view]').forEach(el=>{
  el.addEventListener('click', ()=>switchView(el.dataset.view));
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
const els = id => document.getElementById(id);

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
      let lowConfCount = 0;
      addresses.forEach(a=>{
        const entry = {id:newId(), text:a.text, notes:a.notes||null};
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
      return { id:p.id, raw:p.text, name:p.name||null, area:p.area||null, notes:p.notes||null, lat:p.lat, lon:p.lon,
        geocodeStatus:'ok', candidates:[], windowStart:p.windowStart||null, windowEnd:p.windowEnd||null,
        deliveryStatus:'ממתין' };
    }
    const r = results[p.id] || [];
    const errMsg = geoErrors[p.id];
    const base = { id:p.id, raw:p.text, name:p.name||null, area:p.area||null, notes:p.notes||null, windowStart:p.windowStart||null,
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
  els('routeModeBadge').textContent = state.routeIsManual ? 'מסלול שהמשתמש שינה ידנית' : 'מסלול אופטימלי אוטומטי';
  els('sumStops').textContent = state.stops.length;
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
  initOrRefreshMap();
}

function renderNavChunks(){
  const wrap = els('navChunkButtons');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!state.stops.length) return;
  const chunks = buildGoogleMapsChunks();
  chunks.forEach((c, i)=>{
    const a = document.createElement('a');
    a.className = 'btn btn-secondary';
    a.href = c.url; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = chunks.length > 1 ? `פתח ב-Google Maps · עצירות ${c.from}-${c.to}` : 'פתח ב-Google Maps (מסלול מלא)';
    wrap.appendChild(a);
  });
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
    item.className = 'stop-item' + (s.deliveryStatus==='נמסר' ? ' delivered':'');
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
        <div class="stop-addr">${escapeHtml(s.name ? s.name+' — '+s.raw : s.raw)}${dupBadge}</div>
        <div class="stop-meta">${metaBits.map(m=>`<span>${m}</span>`).join('')}</div>
        ${windowHtml}
        ${notesHtml}
      </div>
      <div class="stop-actions">
        <select class="status-select" data-status-idx="${idx}">
          <option value="ממתין" ${s.deliveryStatus==='ממתין'?'selected':''}>ממתין</option>
          <option value="בדרך" ${s.deliveryStatus==='בדרך'?'selected':''}>בדרך</option>
          <option value="נמסר" ${s.deliveryStatus==='נמסר'?'selected':''}>נמסר</option>
          <option value="לא נמסר" ${s.deliveryStatus==='לא נמסר'?'selected':''}>לא נמסר</option>
        </select>
        <a class="icon-btn" title="נווט" href="${wazeLink(s)}" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 11l18-8-8 18-2-8-8-2z"/></svg>
        </a>
        <button class="icon-btn" data-remove-idx="${idx}" title="הסר">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>`;
    wrap.appendChild(item);
  });

  wrap.querySelectorAll('[data-status-idx]').forEach(sel=>{
    sel.addEventListener('change', (e)=>{
      const idx = parseInt(sel.dataset.statusIdx);
      state.stops[idx].deliveryStatus = e.target.value;
      persistTodayRoute();
      renderStopList();
    });
  });
  wrap.querySelectorAll('[data-remove-idx]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const idx = parseInt(btn.dataset.removeIdx);
      state.stops.splice(idx,1);
      toast('העצירה הוסרה — לוחצים על "חשב מחדש" לעדכון המסלול');
      renderStopList();
      persistTodayRoute();
    });
  });

  attachDragAndDrop(wrap);
}

function wazeLink(s){
  return `https://waze.com/ul?ll=${s.lat},${s.lon}&navigate=yes`;
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
  return L.divIcon({html:`<div class="stop-pin ${s.deliveryStatus==='נמסר'?'delivered':''}"><span>${idx+1}</span></div>`, className:'', iconSize:[30,30], iconAnchor:[15,28]});
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
  const bg = delivered ? '#4bab72' : '#3fa89f';
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
    state.stops.forEach((s, idx)=> addMarker(s.lat, s.lon, gStopIcon(idx+1, s.deliveryStatus==='נמסר'), String(idx+1)));
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
    state.stops.forEach((s, idx)=> addMarker(s.lat, s.lon, gStopIcon(idx+1, s.deliveryStatus==='נמסר'), String(idx+1)));
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
   SAVE ROUTE / SAVE CUSTOMER FROM RESULT
========================================================================= */
els('saveRouteBtn').addEventListener('click', async ()=>{
  const name = prompt('תן שם למסלול (למשל: מסלול יום ראשון)');
  if (!name) return;
  state.savedRoutes.push({ id:newId(), name, createdAt: Date.now(), snapshot: snapshotCurrent() });
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

function buildGoogleMapsChunks(){
  // Google Maps Directions URL supports origin+destination+ up to ~8 intermediate waypoints reliably.
  const CHUNK = 8;
  const chunks = [];
  const pts = state.stops;
  let i = 0;
  let originPoint = state.start;
  while (i < pts.length){
    const slice = pts.slice(i, i+CHUNK);
    const isLast = (i+CHUNK) >= pts.length;
    const destination = isLast ? (state.endSameAsStart ? state.start : state.end) : slice[slice.length-1];
    const waypointSlice = isLast ? slice : slice.slice(0, -1);
    const waypoints = waypointSlice.map(p=> p.lat+','+p.lon).join('|');
    let url = `https://www.google.com/maps/dir/?api=1&origin=${originPoint.lat},${originPoint.lon}&destination=${destination.lat},${destination.lon}&travelmode=driving`;
    if (waypoints) url += `&waypoints=${encodeURIComponent(waypoints)}`;
    chunks.push({url, from:i+1, to:Math.min(i+CHUNK, pts.length)});
    originPoint = destination;
    i += CHUNK;
  }
  return chunks;
}

/* =========================================================================
   DRIVING MODE — minimal single-stop screen
========================================================================= */
function openDrivingMode(){
  state.drivingIndex = state.stops.findIndex(s=> s.deliveryStatus !== 'נמסר');
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
        <div class="driving-addr">כל העצירות הושלמו 🎉</div>
        <p class="hint">סיכום היום: ${fmtKm(state.totalDistance||0)} ק"מ, ${total} משלוחים.</p>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#exitDriving').addEventListener('click', ()=>{ stopLiveNav(); overlay.remove(); });
    return;
  }

  const s = state.stops[state.drivingIndex];
  overlay.innerHTML = `
    <div class="driving-top">
      <div class="driving-progress">עצירה ${state.drivingIndex+1} מתוך ${total} · ${done} נמסרו</div>
      <button class="icon-btn" id="exitDriving"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="driving-body">
      <div class="driving-stopnum">${state.drivingIndex+1}</div>
      <div class="driving-addr">${escapeHtml(s.name ? s.name+' — '+s.raw : s.raw)}</div>
      ${s.legDist!=null ? `<div class="driving-meta">${fmtKm(s.legDist)} ק"מ מהעצירה הקודמת · ${fmtDuration(s.legDur)}</div>`:''}
      ${s.windowStart ? `<div class="driving-window">חלון זמן: ${s.windowStart}–${s.windowEnd||''}</div>`:''}
      ${s.notes ? `<div class="stop-notes" style="max-width:420px;text-align:right">📝 ${escapeHtml(s.notes)}</div>`:''}
    </div>
    <div class="driving-actions">
      <button class="btn btn-primary btn-block btn-lg" id="startLiveNavBtn">נווט (עם הכוונה קולית)</button>
      <a class="btn btn-secondary btn-block" href="${wazeLink(s)}" target="_blank" rel="noopener">פתח ב-Waze במקום</a>
      <button class="btn btn-secondary btn-block" id="markDeliveredBtn">סמן כנמסר ← עצירה הבאה</button>
      <button class="btn btn-ghost btn-block" id="skipStopBtn">דלג לעצירה הבאה</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#exitDriving').addEventListener('click', ()=>{ stopLiveNav(); overlay.remove(); });
  overlay.querySelector('#startLiveNavBtn').addEventListener('click', ()=> startLiveNav(s));
  overlay.querySelector('#markDeliveredBtn').addEventListener('click', ()=>{
    s.deliveryStatus = 'נמסר';
    persistTodayRoute();
    advanceDriving();
  });
  overlay.querySelector('#skipStopBtn').addEventListener('click', advanceDriving);
}
function advanceDriving(){
  let next = state.drivingIndex + 1;
  while (next < state.stops.length && state.stops[next].deliveryStatus === 'נמסר') next++;
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
  renderLiveNavShell(stop);
  navigator.geolocation.getCurrentPosition(
    (pos)=> beginLiveNavWithPosition(stop, pos),
    (err)=> showLiveNavPermissionError(err),
    {enableHighAccuracy:true, timeout:15000}
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
      <button class="btn btn-secondary" id="stopLiveNavBtn">עצור ניווט</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#exitLiveNav').addEventListener('click', stopLiveNav);
  overlay.querySelector('#stopLiveNavBtn').addEventListener('click', stopLiveNav);
}

function showLiveNavPermissionError(err){
  const el = document.getElementById('liveNavPermission');
  if (!el) return;
  el.innerHTML = `<div>
    <p class="hint">לא הצלחנו לקבל את המיקום שלך (${escapeHtml((err && err.message) || 'הרשאה נדחתה')}).<br>אפשר לאשר גישה למיקום בהגדרות הדפדפן ולנסות שוב, או להשתמש ב-Waze במקום.</p>
    <button class="btn btn-secondary" id="closeLiveNavErr">סגור</button>
  </div>`;
  document.getElementById('closeLiveNavErr').addEventListener('click', stopLiveNav);
}

async function beginLiveNavWithPosition(stop, pos){
  const lat = pos.coords.latitude, lon = pos.coords.longitude;
  let data;
  try {
    data = await api('/api/directions', {method:'POST', body:{points:[{lat,lon},{lat:stop.lat, lon:stop.lon}]}});
  } catch(e){
    toast('לא הצלחתי לחשב מסלול ניווט');
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
      state.mapMode = 'full';
      document.querySelectorAll('#mapTabs [data-mapmode]').forEach(b=>b.classList.toggle('active', b.dataset.mapmode==='full'));
      await recomputeRouteGeometry();
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

async function afterAuthSuccess(user){
  showApp(user);
  await loadAll();
  try {
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
  } catch(e){ /* not logged in */ }

  showAuthGate();
  if (resetToken){
    document.getElementById('resetToken').value = resetToken;
    switchAuthMode('reset');
  } else {
    switchAuthMode('login');
  }
})();
