/* Shelf Life — a reading tracker for physical books.
   Plain JavaScript, no build step. Data is kept in this browser's localStorage;
   use Export / Import on the home screen to back it up or move it. */
(() => {
  'use strict';

  const KEY = 'shelf-life:v1';
  const COLORS = ['#2E3B36', '#5B2A2A', '#3A4660', '#6B5B3E', '#4D3A4A', '#556060', '#8A7B62', '#2B2B30', '#6E3B2E', '#1F2A38'];
  const GENRES = ['Literary fiction', 'Science fiction', 'Fantasy', 'Mystery', 'Romance', 'Historical fiction', 'Non-fiction', 'Memoir', 'History', 'Nature writing', 'Poetry'];
  const STATUS = { want: 'To read', reading: 'Reading', done: 'Finished' };

  /* ---------- dates ---------- */
  const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const pd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const today = () => ymd(new Date());
  const addDays = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return ymd(d); };
  const diffDays = (a, b) => Math.round((pd(b) - pd(a)) / 864e5);
  const fmtD = s => pd(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const fmtDY = s => pd(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtWD = s => pd(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  /* ---------- helpers ---------- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n0 = n => Number(n || 0).toLocaleString();
  const plural = (n, w, p) => n + ' ' + (n === 1 ? w : (p || w + 's'));
  const $ = (s, r = document) => r.querySelector(s);
  const main = $('#main');

  /* ---------- storage ---------- */
  function blank() { return { v: 1, goal: 24, goalU: 0, books: [], tomb: {} }; }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && Array.isArray(s.books)) return normalize(s);
    } catch (e) { /* fall through */ }
    return blank();
  }
  function normalize(s) {
    const out = { v: 1, goal: Math.max(1, parseInt(s.goal, 10) || 24), goalU: +s.goalU || 0, books: [], tomb: {} };
    if (s.tomb && typeof s.tomb === 'object') for (const k in s.tomb) if (+s.tomb[k] > 0) out.tomb[String(k)] = +s.tomb[k];
    for (const b of s.books) {
      if (!b || typeof b.title !== 'string') continue;
      const pages = Math.max(1, parseInt(b.pages, 10) || 1);
      out.books.push({
        id: String(b.id || uid()), title: b.title.slice(0, 300), author: String(b.author || '').slice(0, 200),
        pages, genre: String(b.genre || '').slice(0, 80),
        status: STATUS[b.status] ? b.status : 'want',
        current: Math.min(pages, Math.max(0, parseInt(b.current, 10) || 0)),
        started: isDate(b.started) ? b.started : null, finished: isDate(b.finished) ? b.finished : null,
        rating: Math.min(5, Math.max(0, parseInt(b.rating, 10) || 0)),
        color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : COLORS[0],
        sessions: (Array.isArray(b.sessions) ? b.sessions : []).filter(x => x && isDate(x.d) && x.p > 0).map(x => ({ d: x.d, p: Math.round(x.p) })),
        notes: (Array.isArray(b.notes) ? b.notes : []).filter(x => x && typeof x.text === 'string').map(x => ({
          id: String(x.id || uid()), text: x.text.slice(0, 5000), page: x.page == null || x.page === '' ? null : parseInt(x.page, 10) || null,
          at: isDate(x.at) ? x.at : today(), u: +x.u || 0
        })),
        added: isDate(b.added) ? b.added : today(), example: !!b.example, u: +b.u || 0
      });
    }
    return out;
  }
  let state = load();

  /* Change tracking for sync: every book and note carries `u` (last changed, ms).
     Deleted ids go into state.tomb so a deletion on one device wins over an older copy elsewhere. */
  const bookKey = b => { const { u, notes, ...rest } = b; return JSON.stringify(rest); };
  const noteKey = n => { const { u, ...rest } = n; return JSON.stringify(rest); };
  let snap = { books: {}, notes: {}, goal: state.goal };
  function stamp(init) {
    const now = Date.now(), next = { books: {}, notes: {}, goal: state.goal };
    for (const b of state.books) {
      const k = bookKey(b); next.books[b.id] = k;
      if (!b.u || (!init && snap.books[b.id] !== k)) b.u = now;
      delete state.tomb[b.id];
      for (const n of b.notes) {
        const nk = noteKey(n); next.notes[n.id] = nk;
        if (!n.u || (!init && snap.notes[n.id] !== nk)) n.u = now;
        delete state.tomb[n.id];
      }
    }
    if (!init) {
      for (const id in snap.books) if (!(id in next.books)) state.tomb[id] = now;
      for (const id in snap.notes) if (!(id in next.notes)) state.tomb[id] = now;
      if (snap.goal !== state.goal) state.goalU = now;
    }
    snap = next;
  }
  stamp(true);
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { toast("Couldn't save. Your browser is blocking storage for this page."); }
  }
  function save() { stamp(false); persist(); scheduleSync(); }

  /* Merge two libraries: newest version of each book wins, notes merge one by one,
     reading sessions from both sides are kept, and deletions win over older copies. */
  function merge(L, R) {
    const tomb = { ...R.tomb };
    for (const k in L.tomb) tomb[k] = Math.max(tomb[k] || 0, L.tomb[k]);
    const goalSide = (L.goalU || 0) >= (R.goalU || 0) ? L : R;
    const rMap = new Map(R.books.map(b => [b.id, b])), lMap = new Map(L.books.map(b => [b.id, b]));
    const ids = [...L.books.map(b => b.id), ...R.books.filter(b => !lMap.has(b.id)).map(b => b.id)];
    const books = [];
    for (const id of ids) {
      const l = lMap.get(id), r = rMap.get(id);
      const base = !r ? l : !l ? r : (l.u || 0) >= (r.u || 0) ? l : r, other = base === l ? r : l;
      if (tomb[id] && tomb[id] >= (base.u || 0)) continue;
      const b = JSON.parse(JSON.stringify(base));
      if (other) {
        const notes = new Map();
        for (const n of [...other.notes, ...b.notes]) { const cur = notes.get(n.id); if (!cur || (n.u || 0) >= (cur.u || 0)) notes.set(n.id, n); }
        b.notes = [...notes.values()].map(n => ({ ...n }));
        const ses = new Map(other.sessions.map(s => [s.d, s.p]));
        b.sessions.forEach(s => ses.set(s.d, s.p));
        b.sessions = [...ses.entries()].map(([d, p]) => ({ d, p })).sort((x, y) => x.d.localeCompare(y.d));
      }
      b.notes = b.notes.filter(n => !(tomb[n.id] && tomb[n.id] >= (n.u || 0)));
      books.push(b);
    }
    const cutoff = Date.now() - 180 * 864e5;
    for (const k in tomb) if (tomb[k] < cutoff) delete tomb[k];
    return { v: 1, goal: goalSide.goal, goalU: goalSide.goalU || 0, books, tomb };
  }

  /* ---------- GitHub Gist sync ---------- */
  const SKEY = 'shelf-life:sync', FILE = 'shelf-life.json', API = 'https://api.github.com';
  let sync = (() => { try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch (e) { return {}; } })();
  const saveSync = () => { try { localStorage.setItem(SKEY, JSON.stringify(sync)); } catch (e) { /* ignore */ } };
  const syncRt = { busy: false, again: false, timer: null, status: sync.token ? 'idle' : 'off', msg: '' };
  async function gh(path, opts = {}) {
    const r = await fetch(API + path, {
      ...opts, cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + sync.token, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }
    });
    if (!r.ok) { const e = new Error('GitHub ' + r.status); e.status = r.status; throw e; }
    return r.status === 204 ? null : r.json();
  }
  async function findOrCreateGist() {
    for (let p = 1; p <= 5; p++) {
      const list = await gh(`/gists?per_page=100&page=${p}`);
      const g = list.find(x => x.files && x.files[FILE]);
      if (g) return g.id;
      if (list.length < 100) break;
    }
    const g = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: 'Shelf Life library (kept in sync by the Shelf Life app)', public: false, files: { [FILE]: { content: JSON.stringify(state) } } }) });
    return g.id;
  }
  function setSync(status, msg = '') {
    syncRt.status = status; syncRt.msg = msg;
    const dot = $('#sync-dot');
    if (dot) { dot.className = 'sync-dot ' + status; dot.title = syncLine(); }
    const line = $('#sync-line'); if (line) line.textContent = syncLine();
  }
  function syncLine() {
    const s = syncRt.status;
    if (s === 'off') return 'Sync is off';
    if (s === 'busy') return 'Syncing…';
    if (s === 'error') return syncRt.msg || "Couldn't sync";
    return sync.last ? 'Synced ' + ago(sync.last) : 'Connected';
  }
  function ago(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function scheduleSync(delay = 1500) {
    if (!sync.token) return;
    clearTimeout(syncRt.timer);
    syncRt.timer = setTimeout(runSync, delay);
  }
  async function runSync() {
    if (!sync.token) return;
    if (syncRt.busy) { syncRt.again = true; return; }
    syncRt.busy = true; setSync('busy');
    try {
      if (!sync.gistId) { sync.gistId = await findOrCreateGist(); saveSync(); }
      const g = await gh('/gists/' + sync.gistId);
      const f = g.files && g.files[FILE];
      let raw = null;
      if (f) raw = f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
      const before = JSON.stringify(state);
      if (raw) {
        let remote = null;
        try { remote = normalize(JSON.parse(raw)); } catch (e) { remote = null; }
        if (remote) { state = merge(state, remote); stamp(true); persist(); }
      }
      const out = JSON.stringify(state);
      if (out !== raw) await gh('/gists/' + sync.gistId, { method: 'PATCH', body: JSON.stringify({ files: { [FILE]: { content: out } } }) });
      sync.last = Date.now(); saveSync(); setSync('idle');
      if (out !== before) softRender();
    } catch (e) {
      if (e.status === 404) { sync.gistId = null; saveSync(); }
      setSync('error', e.status === 401 ? 'GitHub rejected your token. Reconnect sync with a new one.'
        : e.status === 403 ? 'GitHub refused the request. Check your token has the "gist" scope.'
        : e.status === 404 ? 'Your sync gist was not found. It will be recreated on the next sync.'
        : navigator.onLine === false ? "You're offline. Changes will sync when you're back online." : "Couldn't reach GitHub. Will try again shortly.");
      if (e.status !== 401 && e.status !== 403) scheduleSync(30000);
    } finally {
      syncRt.busy = false;
      if (syncRt.again) { syncRt.again = false; scheduleSync(300); }
    }
  }
  /* Re-render after a sync without trampling something the person is typing. */
  function softRender() {
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.id !== 'q') { ui.stale = true; return; }
    if (route().name === 'form') { ui.stale = true; return; }
    render();
  }
  document.addEventListener('focusout', () => { if (ui.stale) setTimeout(() => { const a = document.activeElement; if (ui.stale && !(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) && route().name !== 'form') { ui.stale = false; render(); } }, 150); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(200); });
  window.addEventListener('online', () => scheduleSync(200));
  setInterval(() => { if (document.visibilityState === 'visible') scheduleSync(0); }, 120000);
  setInterval(() => { if (syncRt.status === 'idle') setSync('idle'); }, 30000);
  window.addEventListener('storage', e => { if (e.key === KEY) { state = load(); stamp(true); softRender(); } });
  const byId = id => state.books.find(b => b.id === id);

  /* ---------- reading maths ---------- */
  function pace(b) {
    const t = today();
    const from = b.started && diffDays(b.started, t) < 14 ? b.started : addDays(t, -13);
    const days = Math.max(1, diffDays(from, t) + 1);
    const p = b.sessions.filter(s => s.d >= from).reduce((a, s) => a + s.p, 0);
    return p / days;
  }
  function eta(b) {
    const pc = pace(b), rem = b.pages - b.current;
    if (rem <= 0 || pc <= 0) return null;
    return addDays(today(), Math.ceil(rem / pc));
  }
  function dailyMap(books = state.books) {
    const m = new Map();
    for (const b of books) for (const s of b.sessions) m.set(s.d, (m.get(s.d) || 0) + s.p);
    return m;
  }
  function streak(m) {
    let d = today();
    if (!m.get(d)) d = addDays(d, -1);
    let n = 0;
    while (m.get(d)) { n++; d = addDays(d, -1); }
    return n;
  }
  function longestStreak(dates) {
    const ds = [...dates].sort();
    let best = 0, run = 0, prev = null;
    for (const d of ds) { run = prev && diffDays(prev, d) === 1 ? run + 1 : 1; best = Math.max(best, run); prev = d; }
    return best;
  }
  function logPage(b, n) {
    n = Math.max(0, Math.min(b.pages, Math.round(n)));
    const delta = n - b.current, t = today();
    const s = b.sessions.find(x => x.d === t);
    if (delta > 0) { if (s) s.p += delta; else b.sessions.push({ d: t, p: delta }); }
    else if (delta < 0 && s) { s.p = Math.max(0, s.p + delta); if (!s.p) b.sessions = b.sessions.filter(x => x !== s); }
    b.current = n;
    if (b.status === 'want' && n > 0) { b.status = 'reading'; b.started = b.started || t; }
  }
  function finish(b) {
    logPage(b, b.pages);
    b.status = 'done'; b.finished = today(); b.started = b.started || today();
  }

  /* ---------- ui state ---------- */
  const ui = { filter: 'all', logging: null, editGoal: false, editNote: null, confirmDelete: false, confirmClear: false, pendingImport: null, year: new Date().getFullYear(), draft: {}, q: '', syncErr: '', stale: false };
  let lastRoute = null;

  /* ---------- routing ---------- */
  function route() {
    const h = location.hash.replace(/^#/, '');
    if (h === 'insights') return { name: 'insights' };
    if (h === 'notes') return { name: 'notes' };
    if (h === 'sync') return { name: 'sync' };
    if (h === 'add') return { name: 'form' };
    if (h.startsWith('edit-')) return { name: 'form', id: h.slice(5) };
    if (h.startsWith('book-')) return { name: 'book', id: h.slice(5) };
    return { name: 'home' };
  }
  function render() {
    const r = route(), key = location.hash;
    if (key !== lastRoute) { ui.logging = null; ui.editNote = null; ui.confirmDelete = false; ui.editGoal = false; ui.confirmClear = false; }
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === r.name));
    ui.stale = false;
    if (r.name === 'insights') main.innerHTML = viewInsights();
    else if (r.name === 'notes') main.innerHTML = viewNotes();
    else if (r.name === 'sync') main.innerHTML = viewSync();
    else if (r.name === 'form') main.innerHTML = viewForm(r.id ? byId(r.id) : null);
    else if (r.name === 'book') { const b = byId(r.id); main.innerHTML = b ? viewBook(b) : viewMissing(); }
    else main.innerHTML = viewHome();
    afterRender(r);
    if (key !== lastRoute) { window.scrollTo(0, 0); lastRoute = key; }
    setSync(syncRt.status, syncRt.msg);
    const titles = { home: 'Shelf Life', insights: 'Insights · Shelf Life', notes: 'Notes · Shelf Life', sync: 'Sync · Shelf Life', form: (r.id ? 'Edit book' : 'Add a book') + ' · Shelf Life' };
    document.title = r.name === 'book' && byId(r.id) ? byId(r.id).title + ' · Shelf Life' : titles[r.name] || 'Shelf Life';
  }
  window.addEventListener('hashchange', render);

  /* ---------- shared bits ---------- */
  const cover = (b, cls = '') => `<div class="cover ${cls}" style="--c:${esc(b.color)}" aria-hidden="true"><b>${esc(b.title)}</b>${cls === 'mini' ? '' : `<small>${esc(b.author)}</small>`}</div>`;
  const progress = b => `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${b.pages}" aria-valuenow="${b.current}" aria-label="Progress"><i style="width:${Math.round(b.current / b.pages * 100)}%"></i></div>`;

  /* ---------- home ---------- */
  function viewHome() {
    if (!state.books.length) return viewWelcome();
    const y = new Date().getFullYear();
    const doneYear = state.books.filter(b => b.status === 'done' && b.finished && pd(b.finished).getFullYear() === y).length;
    const start = new Date(y, 0, 1), end = new Date(y + 1, 0, 1);
    const expected = state.goal * ((new Date() - start) / (end - start));
    const diff = Math.round(doneYear - expected);
    const paceLine = doneYear >= state.goal ? 'Goal reached' : diff > 0 ? `${plural(diff, 'book')} ahead of pace` : diff < 0 ? `${plural(-diff, 'book')} behind pace` : 'Right on pace';
    const st = streak(dailyMap());
    const reading = state.books.filter(b => b.status === 'reading').sort((a, b) => (b.started || '').localeCompare(a.started || ''));
    const counts = { all: state.books.length, reading: reading.length, want: 0, done: 0 };
    state.books.forEach(b => { if (b.status !== 'reading') counts[b.status]++; });
    const order = { reading: 0, done: 1, want: 2 };
    const shelf = state.books.filter(b => ui.filter === 'all' || b.status === ui.filter)
      .sort((a, b) => order[a.status] - order[b.status] || (b.finished || b.added).localeCompare(a.finished || a.added));
    const hasExamples = state.books.some(b => b.example);

    return `
      ${hasExamples ? `<div class="banner"><span>These are example books, so you can see how everything works.</span><button class="btn small" data-act="clear-examples">Remove examples</button></div>` : ''}
      <section class="goal" aria-label="Yearly goal">
        <h3>${doneYear} of ${state.goal} books <em>in ${y}</em></h3>
        <div class="bar"><i style="width:${Math.min(100, Math.round(doneYear / state.goal * 100))}%"></i></div>
        <div class="goal-row">
          <span class="mono">${paceLine}${st ? ` · ${plural(st, 'day')} streak` : ''}</span>
          ${ui.editGoal
            ? `<form class="goal-edit" data-form="goal"><label class="sr" for="goal-in">Books this year</label><input id="goal-in" class="num" type="number" min="1" max="999" value="${state.goal}"><button class="btn small primary">Save</button><button type="button" class="link" data-act="goal-cancel">Cancel</button></form>`
            : `<button class="link" data-act="goal-edit">Change goal</button>`}
        </div>
      </section>

      <section aria-label="Reading now">
        <div class="sec-h"><span class="lbl">Reading now</span></div>
        ${reading.length ? `<div>${reading.map(rowReading).join('')}</div>`
          : `<p class="empty-shelf">Nothing on the go. Open a book from your shelf and press <b>Start reading</b>.</p>`}
      </section>

      <section aria-label="Shelf">
        <div class="sec-h"><span class="lbl">Shelf</span>
          <div class="filters" role="group" aria-label="Filter shelf">
            ${['all', 'reading', 'want', 'done'].map(f => `<button data-act="filter" data-v="${f}" class="${ui.filter === f ? 'on' : ''}" aria-pressed="${ui.filter === f}">${f === 'all' ? 'All' : STATUS[f]} ${counts[f]}</button>`).join('')}
          </div>
        </div>
        ${shelf.length ? `<div class="shelf-scroll"><div class="shelf">${shelf.map(spine).join('')}</div></div>`
          : `<p class="empty-shelf">No books here yet.</p>`}
      </section>

      <section class="foot" aria-label="Backup">
        <span class="lbl">Backup</span>
        <button class="link" data-act="export">Export my books</button>
        <label class="link" for="import-file">Import a backup</label>
        <input id="import-file" type="file" accept="application/json,.json" hidden>
        <a class="mono" style="margin-left:auto" href="#sync">${sync.token ? 'Syncing with GitHub' : 'Saved in this browser · Turn on sync'}</a>
      </section>
      ${ui.pendingImport ? `<div class="confirm" role="alertdialog" aria-label="Confirm import">
        <span>Replace your ${plural(state.books.length, 'book')} with the ${plural(ui.pendingImport.books.length, 'book')} in this backup?</span>
        <button class="btn small danger" data-act="import-yes">Replace</button><button class="btn small" data-act="import-no">Cancel</button></div>` : ''}`;
  }
  function rowReading(b) {
    const e = eta(b);
    return `<div class="reading-row">
      <a href="#book-${esc(b.id)}" class="cover mini" style="--c:${esc(b.color)}" aria-label="${esc(b.title)}"><b>${esc(b.title)}</b></a>
      <div><h4><a href="#book-${esc(b.id)}">${esc(b.title)}</a></h4>${b.author ? `<div class="by">${esc(b.author)}</div>` : ''}
        <div class="meta">${progress(b)}<span class="mono">p. ${b.current} / ${b.pages}${e ? ` · done ~${fmtD(e)}` : ''}</span></div></div>
      ${ui.logging === b.id
        ? `<form class="inline-log" data-form="log" data-id="${esc(b.id)}"><label class="sr" for="log-${esc(b.id)}">I'm on page</label><input id="log-${esc(b.id)}" class="num" type="number" min="0" max="${b.pages}" value="${b.current}" inputmode="numeric"><button class="btn small primary">Save</button></form>`
        : `<button class="btn" data-act="log" data-id="${esc(b.id)}">Update page</button>`}
    </div>`;
  }
  function spine(b) {
    const h = Math.min(200, 130 + b.pages * 0.09), w = Math.min(60, Math.round(24 + b.pages / 30));
    const tip = `${b.title} · ${b.pages} pages · ${b.status === 'reading' ? 'p. ' + b.current : STATUS[b.status]}`;
    return `<a href="#book-${esc(b.id)}" class="spine${b.status === 'reading' ? ' now' : ''}" style="--c:${esc(b.color)};height:${h}px;width:${w}px" data-tip="${esc(tip)}" aria-label="${esc(tip)}"><em>${esc(b.title)}</em></a>`;
  }
  function viewWelcome() {
    const stack = [['#9A4030', 120], ['#3A4660', 150], ['#6B5B3E', 100], ['#2E3B36', 170], ['#4D3A4A', 135]];
    return `<section class="welcome">
      <div><h2>Start your shelf</h2>
        <p>Add the books you're reading, have finished, or want to read next. Log your page as you go and jot down anything worth remembering.</p>
        <div class="row"><a class="btn primary" href="#add">Add your first book</a><button class="btn" data-act="examples">Try it with example books</button></div>
      </div>
      <div class="stack" aria-hidden="true">${stack.map(([c, h]) => `<span style="--c:${c};height:${h}px"></span>`).join('')}</div>
    </section>
    <section class="foot" aria-label="Backup"><span class="lbl">Have a backup?</span><label class="link" for="import-file">Import it</label><input id="import-file" type="file" accept="application/json,.json" hidden></section>
    ${ui.pendingImport ? `<div class="confirm"><span>Import ${plural(ui.pendingImport.books.length, 'book')} from this backup?</span><button class="btn small primary" data-act="import-yes">Import</button><button class="btn small" data-act="import-no">Cancel</button></div>` : ''}`;
  }

  /* ---------- book ---------- */
  function viewMissing() {
    return `<a class="back" href="#">← Shelf</a><p class="muted">This book isn't on your shelf any more.</p>`;
  }
  function viewBook(b) {
    const facts = [b.genre, plural(b.pages, 'page'),
      b.status === 'done' && b.finished ? 'Finished ' + fmtDY(b.finished) : b.started ? 'Started ' + fmtDY(b.started) : 'Added ' + fmtDY(b.added)].filter(Boolean).join(' · ');
    let body = '';
    if (b.status === 'reading') {
      const pc = pace(b), e = eta(b), left = b.pages - b.current;
      body = `
        <div class="pagebig"><b>${b.current}</b><span>of ${b.pages} pages</span></div>
        ${progress(b)}
        <div class="stats">
          <div><b>${pc ? Math.round(pc) : '–'}</b><span>pages a day</span></div>
          <div><b>${e ? fmtD(e) : '–'}</b><span>${e ? 'estimated finish' : 'log a page to estimate'}</span></div>
          <div><b>${left}</b><span>pages to go</span></div>
        </div>
        <form class="update" data-form="log" data-id="${esc(b.id)}">
          <label for="pg">I'm on page</label><input id="pg" class="num" type="number" min="0" max="${b.pages}" value="${b.current}" inputmode="numeric">
          <button class="btn primary">Save</button>
          <button type="button" class="btn${left === 0 ? ' accent' : ''}" data-act="finish" data-id="${esc(b.id)}">Mark finished</button>
        </form>`;
    } else if (b.status === 'want') {
      body = `<div class="pagebig"><b>${b.pages}</b><span>pages, not started yet</span></div>
        <div class="update"><button class="btn primary" data-act="start" data-id="${esc(b.id)}">Start reading</button></div>`;
    } else {
      const days = b.started && b.finished ? diffDays(b.started, b.finished) + 1 : null;
      body = `<div class="pagebig"><b>${b.pages}</b><span>pages, finished${b.finished ? ' ' + fmtD(b.finished) : ''}</span></div>
        <div class="stars" role="group" aria-label="Your rating">${[1, 2, 3, 4, 5].map(i => `<button data-act="rate" data-id="${esc(b.id)}" data-v="${i}" class="${i <= b.rating ? 'on' : ''}" aria-label="${plural(i, 'star')}" aria-pressed="${i === b.rating}">★</button>`).join('')}</div>
        ${days ? `<div class="stats"><div><b>${days}</b><span>${days === 1 ? 'day' : 'days'} to read</span></div><div><b>${Math.round(b.pages / days)}</b><span>pages a day</span></div><div><b>${b.notes.length}</b><span>${b.notes.length === 1 ? 'note' : 'notes'}</span></div></div>` : ''}
        <div class="update"><button class="btn" data-act="reread" data-id="${esc(b.id)}">Read again</button></div>`;
    }
    const sorted = [...b.notes].sort((x, y) => y.at.localeCompare(x.at));
    const defPage = b.status === 'reading' ? b.current : '';
    return `
      <a class="back" href="#">← Shelf</a>
      <section class="book-top">
        ${cover(b)}
        <div class="book-id">
          <h3>${esc(b.title)}</h3>
          ${b.author ? `<div class="by">${esc(b.author)}</div>` : ''}
          <div class="mono facts">${esc(facts)}</div>
          ${body}
          <div class="book-actions">
            <a class="link" href="#edit-${esc(b.id)}">Edit details</a>
            <button class="link danger" data-act="del-ask">Delete book</button>
          </div>
          ${ui.confirmDelete ? `<div class="confirm" style="margin-top:14px"><span>Delete this book and its ${plural(b.notes.length, 'note')}?</span>
            <button class="btn small danger" data-act="del-yes" data-id="${esc(b.id)}">Delete</button><button class="btn small" data-act="del-no">Keep it</button></div>` : ''}
        </div>
      </section>
      ${b.sessions.length ? `<section class="sessions" aria-label="Recent reading"><span class="lbl">Last 14 days</span><svg class="c" id="sess" viewBox="0 0 520 110" role="img" aria-label="Pages read per day over the last 14 days"></svg></section>` : ''}
      <section class="notes" aria-label="Notes">
        <span class="lbl" style="margin-bottom:14px">Notes · ${b.notes.length}</span>
        <form class="compose" data-form="note" data-id="${esc(b.id)}">
          <label class="sr" for="note-text">New note</label>
          <textarea id="note-text" placeholder="Found something interesting? Write it down." maxlength="5000">${esc(ui.draft[b.id] || '')}</textarea>
          <div class="compose-row">
            <span class="pagetag"><label for="note-page">Page</label><input id="note-page" type="number" min="1" max="${b.pages}" value="${defPage}" inputmode="numeric"></span>
            <button class="btn primary">Add note</button>
          </div>
        </form>
        ${sorted.length ? sorted.map(nt => viewNote(b, nt)).join('') : `<p class="no-notes">No notes yet. Quotes, ideas, questions, anything you want to remember.</p>`}
      </section>`;
  }
  function viewNote(b, nt) {
    const head = `${nt.page ? 'p. ' + nt.page + ' · ' : ''}${fmtD(nt.at)}`;
    if (ui.editNote === nt.id) {
      return `<form class="note compose" data-form="note-edit" data-id="${esc(b.id)}" data-note="${esc(nt.id)}">
        <label class="sr" for="ne-text">Edit note</label>
        <textarea id="ne-text" maxlength="5000">${esc(nt.text)}</textarea>
        <div class="compose-row"><span class="pagetag"><label for="ne-page">Page</label><input id="ne-page" type="number" min="1" max="${b.pages}" value="${nt.page || ''}"></span>
          <span style="display:flex;gap:8px"><button type="button" class="btn" data-act="note-cancel">Cancel</button><button class="btn primary">Save</button></span></div>
      </form>`;
    }
    return `<article class="note"><div class="note-h"><span class="mono">${head}</span>
      <span class="acts"><button class="link" data-act="note-edit" data-note="${esc(nt.id)}">Edit</button><button class="link danger" data-act="note-del" data-id="${esc(b.id)}" data-note="${esc(nt.id)}">Delete</button></span></div>
      <p>${esc(nt.text)}</p></article>`;
  }

  /* ---------- add / edit form ---------- */
  function viewForm(b) {
    const editing = !!b;
    if (location.hash.startsWith('#edit-') && !b) return viewMissing();
    const v = b || { title: '', author: '', pages: '', genre: '', status: 'want', current: 0, started: today(), finished: today(), rating: 0, color: COLORS[state.books.length % COLORS.length] };
    const genres = [...new Set([...state.books.map(x => x.genre).filter(Boolean), ...GENRES])];
    return `
      <a class="back" href="${editing ? '#book-' + esc(b.id) : '#'}">← ${editing ? 'Back to book' : 'Shelf'}</a>
      <h3 style="font-size:32px;font-weight:300">${editing ? 'Edit details' : 'Add a book'}</h3>
      <form class="form" data-form="book" ${editing ? `data-id="${esc(b.id)}"` : ''} novalidate>
        <div class="fields">
          <div class="field"><label for="f-title">Title</label><input id="f-title" name="title" value="${esc(v.title)}" maxlength="300" autocomplete="off" required><span class="err" id="e-title" hidden></span></div>
          <div class="field"><label for="f-author">Author <i>optional</i></label><input id="f-author" name="author" value="${esc(v.author)}" maxlength="200" autocomplete="off"></div>
          <div class="two">
            <div class="field"><label for="f-pages">Total pages</label><input id="f-pages" name="pages" class="num" type="number" min="1" max="20000" inputmode="numeric" value="${esc(v.pages)}" required><span class="err" id="e-pages" hidden></span></div>
            <div class="field"><label for="f-genre">Genre <i>optional</i></label><input id="f-genre" name="genre" list="genre-list" value="${esc(v.genre)}" maxlength="80" autocomplete="off">
              <datalist id="genre-list">${genres.map(g => `<option value="${esc(g)}">`).join('')}</datalist></div>
          </div>
          <div class="field"><span class="flabel" id="status-l">Status</span>
            <div class="seg" role="radiogroup" aria-labelledby="status-l">
              ${Object.entries(STATUS).map(([k, l]) => `<label><input type="radio" name="status" value="${k}" ${v.status === k ? 'checked' : ''}>${l}</label>`).join('')}
            </div></div>
          <div class="two" data-group="reading" ${v.status === 'reading' ? '' : 'hidden'}>
            <div class="field"><label for="f-current">Current page</label><input id="f-current" name="current" class="num" type="number" min="0" inputmode="numeric" value="${v.current || 0}"><span class="err" id="e-current" hidden></span></div>
            <div class="field"><label for="f-started">Started</label><input id="f-started" name="started" type="date" value="${esc(v.started || today())}" max="${today()}"></div>
          </div>
          <div data-group="done" ${v.status === 'done' ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:22px">
            <div class="two">
              <div class="field"><label for="f-dstart">Started <i>optional</i></label><input id="f-dstart" name="dstart" type="date" value="${esc(v.status === 'done' ? v.started || '' : '')}" max="${today()}"></div>
              <div class="field"><label for="f-finished">Finished</label><input id="f-finished" name="finished" type="date" value="${esc(v.finished || today())}" max="${today()}"><span class="err" id="e-finished" hidden></span></div>
            </div>
            <div class="field"><span class="flabel" id="rate-l">Rating <i>optional</i></span>
              <div class="rate" role="radiogroup" aria-labelledby="rate-l">${[1, 2, 3, 4, 5].map(i => `<label class="${i <= v.rating ? 'on' : ''}" title="${plural(i, 'star')}"><input type="radio" name="rating" value="${i}" ${v.rating === i ? 'checked' : ''} aria-label="${plural(i, 'star')}">★</label>`).join('')}</div></div>
          </div>
          <div class="field"><span class="flabel" id="col-l">Cover colour</span>
            <div class="swatches" role="radiogroup" aria-labelledby="col-l">${COLORS.map((c, i) => `<label style="--c:${c}" title="Colour ${i + 1}"><input type="radio" name="color" value="${c}" ${v.color === c ? 'checked' : ''} aria-label="Colour ${i + 1}"></label>`).join('')}</div></div>
          <div class="form-foot">
            <button class="btn primary">${editing ? 'Save changes' : 'Add to shelf'}</button>
            <a class="btn" href="${editing ? '#book-' + esc(b.id) : '#'}">Cancel</a>
          </div>
        </div>
        <div class="preview" aria-hidden="true">
          <div class="cover" id="pv" style="--c:${esc(v.color)}"><b>${esc(v.title || 'Title')}</b><small>${esc(v.author)}</small></div>
          <span class="mono">Preview</span>
        </div>
      </form>`;
  }
  function submitBook(form) {
    const f = new FormData(form), id = form.dataset.id;
    const title = String(f.get('title') || '').trim(), pages = parseInt(f.get('pages'), 10), status = f.get('status') || 'want';
    const errs = {};
    if (!title) errs.title = 'Add a title.';
    if (!(pages >= 1)) errs.pages = 'Enter the total number of pages.';
    let current = 0, started = null, finished = null;
    if (status === 'reading') {
      current = parseInt(f.get('current'), 10) || 0;
      if (pages >= 1 && current > pages) errs.current = `This book has ${pages} pages.`;
      started = f.get('started') || today();
    }
    if (status === 'done') {
      finished = f.get('finished') || today();
      started = f.get('dstart') || null;
      if (started && started > finished) errs.finished = 'The finish date is before the start date.';
    }
    ['title', 'pages', 'current', 'finished'].forEach(k => { const e = $('#e-' + k, form); if (e) { e.hidden = !errs[k]; e.textContent = errs[k] || ''; } });
    if (Object.keys(errs).length) { const first = $('#f-' + Object.keys(errs)[0], form); first && first.focus(); return; }

    const base = { title, author: String(f.get('author') || '').trim(), pages, genre: String(f.get('genre') || '').trim(), color: f.get('color') || COLORS[0] };
    const rating = parseInt(f.get('rating'), 10) || 0;
    let b = id && byId(id);
    if (b) {
      Object.assign(b, base);
      b.status = status;
      if (status === 'reading') { b.current = Math.min(current, pages); b.started = started; b.finished = null; }
      else if (status === 'done') { b.current = pages; b.started = started; b.finished = finished; b.rating = rating; }
      else { b.current = Math.min(b.current, pages); }
      toast('Saved');
    } else {
      b = { id: uid(), ...base, status, current: status === 'done' ? pages : current, started, finished, rating: status === 'done' ? rating : 0, sessions: [], notes: [], added: today() };
      state.books.push(b);
      toast(`Added ${title}`);
    }
    save();
    location.hash = 'book-' + b.id;
  }

  /* ---------- notes (search across every book) ---------- */
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function hl(text, terms) {
    if (!terms.length) return esc(text);
    const re = new RegExp('(' + terms.map(reEsc).join('|') + ')', 'gi');
    return String(text).split(re).map((p, i) => i % 2 ? '<mark>' + esc(p) + '</mark>' : esc(p)).join('');
  }
  function allNotes() {
    const out = [];
    state.books.forEach(b => b.notes.forEach(n => out.push({ b, n })));
    return out.sort((x, y) => y.n.at.localeCompare(x.n.at) || (y.n.u || 0) - (x.n.u || 0));
  }
  function viewNotes() {
    const all = allNotes(), nBooks = new Set(all.map(x => x.b.id)).size;
    return `
      <div class="yearseg"><h3>Notes</h3><span class="mono">${plural(all.length, 'note')}${all.length ? ' from ' + plural(nBooks, 'book') : ''}</span></div>
      <div class="search">
        <label class="sr" for="q">Search notes</label>
        <input id="q" type="search" placeholder="Search your notes, titles and authors" value="${esc(ui.q)}" autocomplete="off" spellcheck="false">
      </div>
      <section class="notes wide" id="note-results" aria-live="polite">${noteResults()}</section>`;
  }
  function noteResults() {
    const terms = ui.q.trim().toLowerCase().split(/\s+/).filter(Boolean), all = allNotes();
    if (!all.length) return `<p class="no-notes">No notes yet. Open a book and add one while you read.</p>`;
    const hits = all.filter(({ b, n }) => { const hay = (n.text + ' ' + b.title + ' ' + b.author).toLowerCase(); return terms.every(t => hay.includes(t)); });
    if (!hits.length) return `<p class="no-notes">No notes match “${esc(ui.q.trim())}”.</p>`;
    return (terms.length ? `<span class="mono count">${plural(hits.length, 'match', 'matches')}</span>` : '') + hits.map(({ b, n }) => `
      <article class="note">
        <div class="note-h"><a class="nb" href="#book-${esc(b.id)}">${hl(b.title, terms)}${b.author ? ` <span>· ${hl(b.author, terms)}</span>` : ''}</a><span class="mono">${n.page ? 'p. ' + n.page + ' · ' : ''}${fmtD(n.at)}</span></div>
        <p>${hl(n.text, terms)}</p>
      </article>`).join('');
  }

  /* ---------- sync settings ---------- */
  function viewSync() {
    const tokenUrl = 'https://github.com/settings/tokens/new?scopes=gist&description=Shelf%20Life%20sync';
    if (!sync.token) return `
      <div class="yearseg"><h3>Sync across devices</h3></div>
      <div class="prose">
        <p>Keep the same shelf, notes and reading log on your phone and laptop. Your library is saved as a private file (a secret gist) in your own GitHub account. Each device you connect stays in step with it.</p>
        <ol class="steps">
          <li><b>Create a token.</b> <a href="${tokenUrl}" target="_blank" rel="noopener">Open GitHub's token page</a>. The name and the <b>gist</b> permission are already filled in. Choose an expiry (a year is sensible), then press <b>Generate token</b> and copy it.</li>
          <li><b>Paste it below</b> and press Connect. Do the same on each device. You can reuse the token or make one per device.</li>
        </ol>
        <form class="connect" data-form="sync-connect">
          <label class="sr" for="tok">GitHub token</label>
          <input id="tok" type="password" placeholder="ghp_…" autocomplete="off" spellcheck="false" required>
          <button class="btn primary">Connect</button>
        </form>
        ${ui.syncErr ? `<p class="err" role="alert">${esc(ui.syncErr)}</p>` : ''}
        <p class="fine">The token stays in this browser and is only ever sent to GitHub. It can read and write your gists and nothing else. If you already have books on this device, they're combined with what's already synced. Nothing is overwritten.</p>
      </div>`;
    return `
      <div class="yearseg"><h3>Sync across devices</h3></div>
      <div class="prose">
        <div class="sync-card">
          <span class="sync-dot ${syncRt.status}" aria-hidden="true"></span>
          <div><b id="sync-line">${esc(syncLine())}</b>
            <div class="mono">${sync.login ? 'GitHub account ' + esc(sync.login) + ' · ' : ''}${sync.gistId ? `<a href="https://gist.github.com/${esc(sync.gistId)}" target="_blank" rel="noopener">View the sync file</a>` : 'Setting up…'}</div></div>
        </div>
        <p>Changes save to GitHub a moment after you make them. Other devices pick them up when you open the app, or every couple of minutes while it's open.</p>
        <div class="form-foot"><button class="btn primary" data-act="sync-now">Sync now</button><button class="btn" data-act="sync-off">Disconnect this device</button></div>
        <p class="fine">Disconnecting removes the token from this browser only. Your books stay here, and the copy on GitHub stays as it is.</p>
      </div>`;
  }
  async function connectSync(token) {
    sync = { token: token.trim() }; setSync('busy');
    try {
      const me = await gh('/user');
      sync.login = me && me.login; saveSync();
      await runSync();
      if (syncRt.status !== 'error') toast('Sync is on');
    } catch (e) {
      sync = {}; saveSync(); setSync('off');
      ui.syncErr = e.status === 401 ? "GitHub didn't accept that token. Check you copied all of it." : "Couldn't reach GitHub. Check your connection and try again.";
    }
    render();
  }

  /* ---------- insights ---------- */
  function viewInsights() {
    if (!state.books.length) return `<div class="yearseg"><h3>Insights</h3></div><p class="muted">Add a few books and log your pages, and your reading year will show up here.</p><div><a class="btn primary" href="#add">Add a book</a></div>`;
    const years = new Set([new Date().getFullYear()]);
    state.books.forEach(b => { b.finished && years.add(pd(b.finished).getFullYear()); b.sessions.forEach(s => years.add(pd(s.d).getFullYear())); });
    const yList = [...years].sort();
    const Y = ui.year;
    const inP = d => d && (Y === 'all' || pd(d).getFullYear() === Y);
    const stats = period => {
      const inp = d => d && (period === 'all' || pd(d).getFullYear() === period);
      const done = state.books.filter(b => b.status === 'done' && inp(b.finished));
      let pages = 0; const days = new Set();
      state.books.forEach(b => b.sessions.forEach(s => { if (inp(s.d)) { pages += s.p; days.add(s.d); } }));
      done.forEach(b => { if (!b.sessions.length) pages += b.pages; });
      const rated = done.filter(b => b.rating);
      return { done, pages, days, rated, avg: rated.length ? rated.reduce((a, b) => a + b.rating, 0) / rated.length : 0 };
    };
    const S = stats(Y), P = Y !== 'all' && yList.includes(Y - 1) ? stats(Y - 1) : null;
    const cmp = (a, b) => { if (!P) return ''; const d = a - b; return d === 0 ? `same as ${Y - 1}` : `${d > 0 ? '+' : '−'}${n0(Math.abs(d))} vs ${Y - 1}`; };
    const daily = dailyMap();
    const pdays = [...daily.entries()].filter(([d]) => inP(d));
    const big = pdays.reduce((m, e) => e[1] > (m ? m[1] : 0) ? e : m, null);
    const fast = S.done.filter(b => b.started).map(b => [b, diffDays(b.started, b.finished) + 1]).sort((a, b) => a[1] - b[1])[0];
    const longest = [...S.done].sort((a, b) => b.pages - a.pages)[0];
    const noted = state.books.map(b => [b, b.notes.filter(n => inP(n.at)).length]).filter(x => x[1]).sort((a, b) => b[1] - a[1])[0];
    const genres = {};
    S.done.forEach(b => { const g = b.genre || 'No genre'; genres[g] = (genres[g] || 0) + 1; });
    const gl = Object.entries(genres).sort((a, b) => b[1] - a[1]);
    const gTop = gl.slice(0, 6); if (gl.length > 6) gTop.push(['Other', gl.slice(6).reduce((a, x) => a + x[1], 0)]);
    const gMax = Math.max(1, ...gTop.map(x => x[1]));
    const label = Y === 'all' ? 'All your reading' : `Your ${Y} in reading`;
    const avgDay = S.days.size ? Math.round([...S.days].reduce((a, d) => a + daily.get(d), 0) / S.days.size) : 0;

    return `
      <div class="yearseg"><h3>${label}</h3>
        <div class="seg" role="group" aria-label="Period">${yList.slice(-4).map(y => `<button data-act="year" data-v="${y}" class="${Y === y ? 'on' : ''}" aria-pressed="${Y === y}">${y}</button>`).join('')}<button data-act="year" data-v="all" class="${Y === 'all' ? 'on' : ''}" aria-pressed="${Y === 'all'}">All time</button></div></div>
      <section class="kpis" aria-label="Summary">
        <div><b>${S.done.length}</b><span>${S.done.length === 1 ? 'book' : 'books'} finished</span><small>${cmp(S.done.length, P && P.done.length)}</small></div>
        <div><b>${n0(S.pages)}</b><span>pages read</span><small>${cmp(S.pages, P && P.pages)}</small></div>
        <div><b>${S.days.size}</b><span>days spent reading</span><small>${avgDay ? avgDay + ' pages a day' : ''}</small></div>
        <div><b>${S.avg ? S.avg.toFixed(1) : '–'}</b><span>average rating</span><small>${S.rated.length ? plural(S.done.filter(b => b.rating === 5).length, 'five-star book') : ''}</small></div>
      </section>
      <div class="grid2">
        <div class="chart"><h4>Pages per month</h4><div class="sub" id="m-sub"></div><svg class="c" id="months" viewBox="0 0 480 200" role="img" aria-label="Pages read per month"></svg></div>
        <div class="chart"><h4>Reading days</h4><div class="sub">${Y === 'all' ? 'Last 52 weeks' : Y} · longest streak ${plural(longestStreak(pdays.map(x => x[0])), 'day')}</div>
          <div class="heat-scroll"><div class="heat" id="heat"></div></div>
          <div class="legend">Less <i></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> More</div></div>
        <div class="chart"><h4>When you read</h4><div class="sub">Average pages on a reading day</div>
          ${pdays.length ? `<svg class="c" id="week" viewBox="0 0 480 180" role="img" aria-label="Average pages per reading day by weekday"></svg>` : `<p class="none">Log some pages to see this.</p>`}</div>
        <div class="chart"><h4>Genres</h4><div class="sub">Books finished</div>
          ${gTop.length ? `<div class="hbars">${gTop.map(([g, c]) => `<div class="hb" data-tip="${esc(g)} · ${plural(c, 'book')}"><span>${esc(g)}</span><div><div class="t" style="width:${c / gMax * 100}%"></div></div><span class="n">${c}</span></div>`).join('')}</div>` : `<p class="none">Finish a book to see this.</p>`}</div>
        <div class="chart full"><h4>Records</h4>
          <div class="records">
            <div><span>Fastest read</span><span>${fast ? `${esc(fast[0].title)} · ${plural(fast[1], 'day')}` : '–'}</span></div>
            <div><span>Longest book</span><span>${longest ? `${esc(longest.title)} · ${n0(longest.pages)} pages` : '–'}</span></div>
            <div><span>Biggest day</span><span>${big ? `${fmtWD(big[0])} · ${big[1]} pages` : '–'}</span></div>
            <div><span>Most notes</span><span>${noted ? `${esc(noted[0].title)} · ${plural(noted[1], 'note')}` : '–'}</span></div>
          </div></div>
      </div>`;
  }

  /* ---------- charts ---------- */
  const NS = 'http://www.w3.org/2000/svg';
  const el = (n, a, p) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); p && p.appendChild(e); return e; };
  function nice(max) {
    if (max <= 0) return { max: 10, step: 5 };
    const raw = max / 4, p = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map(x => x * p).find(x => x >= raw);
    return { step, max: Math.ceil(max / step) * step };
  }
  const barPath = (x, y, w, base) => { const r = Math.min(4, w / 2, base - y); return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`; };
  function bars(svg, labels, vals, tips, { w = 480, h = 200, every = 1 } = {}) {
    const L = 36, R = 4, T = 10, B = 24, iw = w - L - R, ih = h - T - B, { step, max } = nice(Math.max(...vals));
    for (let v = 0; v <= max; v += step) {
      const y = T + ih - ih * v / max;
      el('line', { x1: L, x2: w - R, y1: y, y2: y, class: v ? 'gl' : 'base' }, svg);
      el('text', { x: L - 8, y: y + 3, 'text-anchor': 'end', class: 'ax' }, svg).textContent = v >= 1000 ? (v / 1000) + 'k' : v;
    }
    const bw = iw / vals.length, gap = Math.max(2, bw * 0.32);
    vals.forEach((v, i) => {
      const g = el('g', { 'data-tip': tips[i] }, svg);
      el('rect', { x: L + i * bw, y: T, width: bw, height: ih, class: 'hit' }, g);
      if (v > 0) { const x = L + i * bw + gap / 2, wd = bw - gap, y = T + ih - ih * v / max; el('path', { d: barPath(x, Math.min(y, T + ih - 1), wd, T + ih), class: 'mk' }, g); }
      if (i % every === 0) el('text', { x: L + i * bw + bw / 2, y: h - 6, 'text-anchor': 'middle', class: 'ax' }, svg).textContent = labels[i];
    });
  }
  function afterRender(r) {
    if (r.name === 'book') {
      const b = byId(r.id), svg = $('#sess');
      if (b && svg) {
        const m = dailyMap([b]), t = today(), w = 520, h = 110, T = 6, B = 20, ih = h - T - B;
        const ds = Array.from({ length: 14 }, (_, i) => addDays(t, i - 13)), vals = ds.map(d => m.get(d) || 0);
        const max = nice(Math.max(...vals)).max, bw = w / 14, gap = bw * 0.38;
        el('line', { x1: 0, x2: w, y1: T + ih, y2: T + ih, class: 'base' }, svg);
        vals.forEach((v, i) => {
          const g = el('g', { 'data-tip': `${fmtWD(ds[i])} · ${v ? v + ' pages' : 'no reading'}` }, svg);
          el('rect', { x: i * bw, y: 0, width: bw, height: h, class: 'hit' }, g);
          if (v) el('path', { d: barPath(i * bw + gap / 2, T + ih - Math.max(2, ih * v / max), bw - gap, T + ih), class: 'mk' }, g);
          if (i % 2 === 1) el('text', { x: i * bw + bw / 2, y: h - 4, 'text-anchor': 'middle', class: 'ax' }, svg).textContent = i === 13 ? 'Today' : fmtD(ds[i]);
        });
      }
    }
    if (r.name === 'form') {
      const form = $('form[data-form="book"]'); if (!form) return;
      const pv = $('#pv');
      form.addEventListener('input', e => {
        if (e.target.name === 'title') pv.querySelector('b').textContent = e.target.value || 'Title';
        if (e.target.name === 'author') pv.querySelector('small').textContent = e.target.value;
      });
      form.addEventListener('change', e => {
        if (e.target.name === 'color') pv.style.setProperty('--c', e.target.value);
        if (e.target.name === 'status') form.querySelectorAll('[data-group]').forEach(g => g.hidden = g.dataset.group !== e.target.value);
        if (e.target.name === 'rating') form.querySelectorAll('.rate label').forEach((l, i) => l.classList.toggle('on', i < +e.target.value));
      });
      if (!form.dataset.id) $('#f-title').focus();
    }
    if (r.name === 'insights' && state.books.length) {
      const Y = ui.year, daily = dailyMap();
      // months
      const ms = Array.from({ length: 12 }, () => 0), mn = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(undefined, { month: 'short' }));
      let mLabels = mn, mTips;
      if (Y === 'all') {
        const now = new Date(), keys = Array.from({ length: 12 }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1); return [d.getFullYear(), d.getMonth()]; });
        const vals = keys.map(() => 0);
        const add = (d, p) => { const x = pd(d), k = keys.findIndex(([y, m]) => y === x.getFullYear() && m === x.getMonth()); if (k >= 0) vals[k] += p; };
        state.books.forEach(b => { b.sessions.forEach(s => add(s.d, s.p)); if (b.status === 'done' && !b.sessions.length && b.finished) add(b.finished, b.pages); });
        mLabels = keys.map(([y, m]) => mn[m]); mTips = keys.map(([y, m], i) => `${mn[m]} ${y} · ${n0(vals[i])} pages`);
        ms.splice(0, 12, ...vals);
        $('#m-sub').textContent = 'Last 12 months';
      } else {
        state.books.forEach(b => {
          b.sessions.forEach(s => { const d = pd(s.d); if (d.getFullYear() === Y) ms[d.getMonth()] += s.p; });
          if (b.status === 'done' && !b.sessions.length && b.finished) { const d = pd(b.finished); if (d.getFullYear() === Y) ms[d.getMonth()] += b.pages; }
        });
        mTips = ms.map((v, i) => `${mn[i]} ${Y} · ${n0(v)} pages`);
        const best = ms.indexOf(Math.max(...ms));
        $('#m-sub').textContent = Math.max(...ms) ? `${new Date(2000, best, 1).toLocaleDateString(undefined, { month: 'long' })} was your biggest month` : 'No pages logged yet';
      }
      bars($('#months'), mLabels, ms, mTips, { every: 1 });
      // heatmap (Monday-first weeks)
      const heat = $('#heat'), t = today();
      let start, end;
      if (Y === 'all') { end = t; start = addDays(t, -363); }
      else { start = `${Y}-01-01`; end = `${Y}-12-31`; }
      const mondayOf = s => addDays(s, -((pd(s).getDay() + 6) % 7));
      let d = mondayOf(start); const last = addDays(mondayOf(end), 6);
      const cells = [];
      while (d <= last) {
        if (d < start || d > end) cells.push('<i class="out"></i>');
        else if (d > t) cells.push('<i class="fut"></i>');
        else {
          const p = daily.get(d) || 0, lvl = !p ? 0 : p < 20 ? 1 : p < 35 ? 2 : p < 50 ? 3 : 4;
          cells.push(`<i class="${lvl ? 'l' + lvl : ''}" data-tip="${esc(fmtWD(d))} · ${p ? p + ' pages' : 'no reading'}"></i>`);
        }
        d = addDays(d, 1);
      }
      heat.innerHTML = cells.join('');
      const hs = heat.parentElement; hs.scrollLeft = hs.scrollWidth;
      // weekdays
      const wk = $('#week');
      if (wk) {
        const sum = Array(7).fill(0), cnt = Array(7).fill(0);
        daily.forEach((p, ds) => { if (Y === 'all' || pd(ds).getFullYear() === Y) { const i = (pd(ds).getDay() + 6) % 7; sum[i] += p; cnt[i]++; } });
        const names = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }));
        const avg = sum.map((s, i) => cnt[i] ? Math.round(s / cnt[i]) : 0);
        bars(wk, names, avg, avg.map((v, i) => `${names[i]} · ${v ? v + ' pages on average' : 'no reading'}`), { h: 180 });
      }
    }
  }

  /* ---------- events ---------- */
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    const act = a.dataset.act, b = a.dataset.id ? byId(a.dataset.id) : null;
    switch (act) {
      case 'filter': ui.filter = a.dataset.v; break;
      case 'log': ui.logging = a.dataset.id; render(); { const i = $('#log-' + CSS.escape(a.dataset.id)); i && (i.focus(), i.select()); } return;
      case 'goal-edit': ui.editGoal = true; render(); $('#goal-in') && $('#goal-in').select(); return;
      case 'goal-cancel': ui.editGoal = false; break;
      case 'start': if (b) { b.status = 'reading'; b.started = today(); b.current = 0; save(); toast('Started. Happy reading.'); } break;
      case 'finish': if (b) { finish(b); save(); toast(`Finished ${b.title}. Give it a rating?`); } break;
      case 'reread': if (b) { b.status = 'reading'; b.current = 0; b.started = today(); b.finished = null; save(); } break;
      case 'rate': if (b) { const v = +a.dataset.v; b.rating = b.rating === v ? 0 : v; save(); } break;
      case 'del-ask': ui.confirmDelete = true; break;
      case 'del-no': ui.confirmDelete = false; break;
      case 'del-yes': if (b) {
        const idx = state.books.indexOf(b); state.books.splice(idx, 1); save();
        toast(`Deleted ${b.title}`, 'Undo', () => { state.books.splice(idx, 0, b); save(); location.hash = 'book-' + b.id; render(); });
        location.hash = ''; return; }
        break;
      case 'note-edit': ui.editNote = a.dataset.note; render(); { const t = $('#ne-text'); t && t.focus(); } return;
      case 'note-cancel': ui.editNote = null; break;
      case 'note-del': if (b) {
        const idx = b.notes.findIndex(n => n.id === a.dataset.note); if (idx < 0) break;
        const [nt] = b.notes.splice(idx, 1); save();
        toast('Note deleted', 'Undo', () => { b.notes.splice(idx, 0, nt); save(); render(); }); }
        break;
      case 'year': ui.year = a.dataset.v === 'all' ? 'all' : +a.dataset.v; break;
      case 'examples': state.books = examples(); save(); break;
      case 'clear-examples': {
        const kept = state.books.filter(x => !x.example), gone = state.books.filter(x => x.example);
        state.books = kept; save(); toast('Examples removed', 'Undo', () => { state.books = [...state.books, ...gone]; save(); render(); }); }
        break;
      case 'export': exportData(); return;
      case 'import-yes': if (ui.pendingImport) { importNow(); } break;
      case 'sync-now': ui.syncErr = ''; runSync(); return;
      case 'sync-off': sync = {}; saveSync(); clearTimeout(syncRt.timer); setSync('off'); toast('Sync turned off on this device'); break;
      case 'import-no': ui.pendingImport = null; break;
      default: return;
    }
    render();
  });
  document.addEventListener('submit', e => {
    const form = e.target, kind = form.dataset.form; if (!kind) return;
    e.preventDefault();
    const b = form.dataset.id ? byId(form.dataset.id) : null;
    if (kind === 'book') return submitBook(form);
    if (kind === 'sync-connect') { const t = $('#tok').value.trim(); if (t) { ui.syncErr = ''; form.querySelector('button').disabled = true; form.querySelector('button').textContent = 'Connecting…'; connectSync(t); } return; }
    if (kind === 'goal') { const v = parseInt($('#goal-in').value, 10); if (v >= 1) { state.goal = Math.min(999, v); save(); } ui.editGoal = false; }
    if (kind === 'log' && b) {
      const input = form.querySelector('input'), v = parseInt(input.value, 10);
      if (!(v >= 0)) { input.focus(); return; }
      const before = b.current; logPage(b, v); save(); ui.logging = null;
      const d = b.current - before;
      if (b.current >= b.pages && b.status === 'reading') toast('Last page! Mark it finished?', 'Finish', () => { finish(b); save(); render(); });
      else if (d > 0) toast(`+${plural(d, 'page')} today`);
    }
    if (kind === 'note' && b) {
      const text = $('#note-text').value.trim(); if (!text) { $('#note-text').focus(); return; }
      const page = parseInt($('#note-page').value, 10) || null;
      b.notes.push({ id: uid(), text, page, at: today() }); delete ui.draft[b.id]; save(); toast('Note added');
    }
    if (kind === 'note-edit' && b) {
      const nt = b.notes.find(n => n.id === form.dataset.note), text = $('#ne-text').value.trim();
      if (nt && text) { nt.text = text; nt.page = parseInt($('#ne-page').value, 10) || null; save(); }
      ui.editNote = null;
    }
    render();
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'note-text') { const f = e.target.closest('form'); if (f) ui.draft[f.dataset.id] = e.target.value; }
    if (e.target.id === 'q') { ui.q = e.target.value; const r = $('#note-results'); if (r) r.innerHTML = noteResults(); }
  });
  document.addEventListener('change', e => {
    if (e.target.id !== 'import-file' || !e.target.files[0]) return;
    const file = e.target.files[0], rd = new FileReader();
    rd.onload = () => {
      try {
        const data = JSON.parse(rd.result);
        if (!data || !Array.isArray(data.books)) throw new Error('shape');
        ui.pendingImport = normalize(data);
        if (!state.books.length) importNow();
      } catch (err) { toast("That file isn't a Shelf Life backup."); }
      render();
    };
    rd.readAsText(file);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ui.logging) { ui.logging = null; render(); } });

  function importNow() {
    const next = ui.pendingImport; ui.pendingImport = null;
    next.tomb = { ...state.tomb, ...next.tomb };
    next.books.forEach(b => { b.u = 0; b.notes.forEach(n => { n.u = 0; }); });
    state = next; save();
    toast(`Imported ${plural(state.books.length, 'book')}`);
  }
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `shelf-life-backup-${today()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Backup downloaded');
  }

  /* ---------- tooltip & toast ---------- */
  const tip = $('#tip');
  const showTip = e => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip; tip.hidden = false;
    tip.style.left = Math.max(8, Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)) + 'px';
    tip.style.top = Math.max(8, e.clientY - 36) + 'px';
  };
  document.addEventListener('pointermove', showTip);
  document.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') showTip(e); });
  document.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });

  const toastEl = $('#toast'); let toastTimer;
  function toast(msg, actLabel, act) {
    clearTimeout(toastTimer);
    toastEl.innerHTML = `<span>${esc(msg)}</span>${actLabel ? `<button type="button">${esc(actLabel)}</button>` : ''}`;
    toastEl.hidden = false;
    if (actLabel) toastEl.querySelector('button').onclick = () => { toastEl.hidden = true; act(); };
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, actLabel ? 6000 : 2600);
  }

  /* ---------- example books ---------- */
  function examples() {
    const t = today();
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gen = (fromAgo, toAgo, total) => {
      const days = [];
      for (let a = fromAgo; a >= toAgo; a--) if (rnd() < 0.72 || a === toAgo || a === fromAgo) days.push(a);
      const w = days.map(() => 0.4 + rnd()), sw = w.reduce((x, y) => x + y, 0);
      let left = total;
      return days.map((a, i) => { let p = i === days.length - 1 ? left : Math.max(1, Math.round(total * w[i] / sw)); p = Math.min(p, left); left -= p; return { d: addDays(t, -a), p }; }).filter(s => s.p > 0);
    };
    const mk = (title, author, pages, genre, color, status, o = {}) => {
      const b = { id: uid() + Math.round(rnd() * 1e6).toString(36), title, author, pages, genre, color, status, current: 0, started: null, finished: null, rating: 0, sessions: [], notes: [], added: addDays(t, -(o.from || 3)), example: true };
      if (status === 'reading') { b.started = addDays(t, -o.from); b.current = o.at; b.sessions = gen(o.from, 0, o.at); }
      if (status === 'done') { b.started = addDays(t, -o.from); b.finished = addDays(t, -o.to); b.current = pages; b.rating = o.r; b.sessions = gen(o.from, o.to, pages); }
      return b;
    };
    const books = [
      mk('Piranesi', 'Susanna Clarke', 272, 'Fantasy', '#2E3B36', 'reading', { from: 7, at: 188 }),
      mk('Project Hail Mary', 'Andy Weir', 476, 'Science fiction', '#5B2A2A', 'reading', { from: 6, at: 132 }),
      mk('Braiding Sweetgrass', 'Robin Wall Kimmerer', 391, 'Nature writing', '#3A4660', 'done', { from: 40, to: 25, r: 5 }),
      mk('Sea of Tranquility', 'Emily St. John Mandel', 255, 'Science fiction', '#2F3A45', 'done', { from: 30, to: 27, r: 3 }),
      mk('A Psalm for the Wild-Built', 'Becky Chambers', 160, 'Science fiction', '#8A7B62', 'done', { from: 23, to: 21, r: 4 }),
      mk('Educated', 'Tara Westover', 334, 'Memoir', '#A08F72', 'done', { from: 60, to: 48, r: 4 }),
      mk('Station Eleven', 'Emily St. John Mandel', 333, 'Literary fiction', '#2B2B30', 'done', { from: 72, to: 58, r: 4 }),
      mk('Klara and the Sun', 'Kazuo Ishiguro', 303, 'Literary fiction', '#556060', 'done', { from: 95, to: 80, r: 4 }),
      mk('The Remains of the Day', 'Kazuo Ishiguro', 258, 'Literary fiction', '#44524A', 'done', { from: 112, to: 97, r: 5 }),
      mk('The Left Hand of Darkness', 'Ursula K. Le Guin', 304, 'Science fiction', '#6B5B3E', 'done', { from: 150, to: 129, r: 4 }),
      mk('Circe', 'Madeline Miller', 393, 'Fantasy', '#6E3B2E', 'done', { from: 200, to: 181, r: 4 }),
      mk('Middlemarch', 'George Eliot', 880, 'Literary fiction', '#4D3A4A', 'want'),
      mk('The Overstory', 'Richard Powers', 502, 'Literary fiction', '#233029', 'want'),
      mk('The Dispossessed', 'Ursula K. Le Guin', 387, 'Science fiction', '#1F2A38', 'want')
    ];
    books[0].notes = [
      { id: uid() + 'a', page: 5, at: addDays(t, -7), text: '"The Beauty of the House is immeasurable; its Kindness infinite." Opening line. Come back to it at the end.' },
      { id: uid() + 'b', page: 112, at: addDays(t, -4), text: '"I am the Beloved Child of the House." Great line. Is it devotion or captivity?' },
      { id: uid() + 'c', page: 164, at: addDays(t, -2), text: 'He keeps a journal with an index, like a scientist. That careful system makes the gaps in his memory feel even stranger.' }
    ];
    books[2].notes = [{ id: uid() + 'd', page: 31, at: addDays(t, -37), text: 'The idea of the "honorable harvest": take only what is given, use it well, give thanks.' }];
    return books;
  }

  render();
  if (sync.token) scheduleSync(0);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works without it */ });
  }
})();
