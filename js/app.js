// Bookmark Studio — web app (UI, navigation, library, search, bookmarks)
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];
const COVER_TONES = ['#5e7892', '#8c5c52', '#608068', '#967846', '#70628c', '#467680', '#9c6070', '#586078'];

const S = {
  settings: Store.loadSettings(),
  library: [],       // book metadata (persisted)
  open: [],          // Book instances
  cur: null,         // active Book or null (shelf)
  blobs: new Map(),  // id -> Blob for files not persisted (quota)
  passwords: new Map(),
  anim: null,
};

class Book {
  constructor(meta, doc) {
    this.meta = meta;
    this.doc = doc;
    this.page = clamp(meta.lastPage || 0, 0, doc.n - 1);
    this.zoom = 1;
    this.history = [];
    this.search = { query: '', hits: [], cur: -1, scanning: false, token: 0, done: 0, matchCase: false };
    this.thumbs = new Map();
  }
  get rot() { return ((this.meta.rotation || 0) % 4) * 90; }
}

const dom = {
  viewer: $('#viewer'), pages: $('#pages'), shelf: $('#shelf'), sidebar: $('#sidebar'),
  searchInput: $('#searchInput'), toast: $('#toast'), tooltip: $('#tooltip'), menu: $('#menu'),
  modalWrap: $('#modalWrap'), modal: $('#modal'), slider: $('#slider'), fileInput: $('#fileInput'),
};

// ============================================================================================
// small UI helpers

let toastTimer = 0;
function toast(text) {
  dom.toast.textContent = text;
  dom.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('on'), 2000);
}

function showLoading(on, text = '불러오는 중…') {
  $('#loading').classList.toggle('on', on);
  $('#loadingText').textContent = text;
}

function relTime(ts) {
  if (!ts) return '읽은 적 없음';
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return '방금 전';
  if (d < 3600) return `${Math.floor(d / 60)}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}일 전`;
  if (d < 86400 * 365) return `${Math.floor(d / 86400 / 30)}개월 전`;
  return `${Math.floor(d / 86400 / 365)}년 전`;
}

function progressOf(m) { return m.pages ? Math.min(1, ((m.lastPage || 0) + 1) / m.pages) : 0; }

function toneFor(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return COVER_TONES[(h >>> 0) % COVER_TONES.length];
}

function coverHtml(m) {
  if (m.cover) return `<div class="cover"><img src="${m.cover}" alt="" draggable="false"></div>`;
  return `<div class="cover gen" style="background:${toneFor(m.title || m.name)}"><span>${esc(m.title)}</span><small>PDF</small></div>`;
}

const saveTimers = new Map();
function saveMeta(meta, now = false) {
  clearTimeout(saveTimers.get(meta.id));
  const run = () => { const { volatile, ...rest } = meta; Store.putBook(rest); };
  if (now) run();
  else saveTimers.set(meta.id, setTimeout(run, 500));
}

function saveSettings() { Store.saveSettings(S.settings); }

// ---- modal dialogs

function modal({ title, text = '', input = null, ok = '확인', cancel = '취소', html = '', wide = false }) {
  return new Promise((resolve) => {
    dom.modal.className = 'modal' + (wide ? ' wide' : '');
    dom.modal.innerHTML = `<h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}${html}` +
      (input ? `<input type="${input.type || 'text'}" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" autocomplete="off">` : '') +
      `<div class="actions">${cancel ? `<button class="btn secondary" data-a="cancel">${esc(cancel)}</button>` : ''}<button class="btn primary" data-a="ok">${esc(ok)}</button></div>`;
    dom.modalWrap.classList.add('on');
    const field = $('input', dom.modal);
    const done = (v) => {
      dom.modalWrap.classList.remove('on');
      dom.modalWrap.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && (field ? document.activeElement === field : true)) { e.preventDefault(); e.stopPropagation(); done(field ? field.value : true); }
    };
    document.addEventListener('keydown', onKey, true);
    dom.modalWrap.onclick = (e) => {
      if (e.target === dom.modalWrap) return done(null);
      const a = e.target.closest('[data-a]');
      if (a) done(a.dataset.a === 'ok' ? (field ? field.value : true) : null);
    };
    setTimeout(() => (field ? (field.focus(), field.select()) : $('[data-a="ok"]', dom.modal).focus()), 30);
  });
}

// ---- tooltip

let tipTimer = 0;
let tipTarget = null;
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (t === tipTarget) return;
  tipTarget = t;
  clearTimeout(tipTimer);
  dom.tooltip.classList.remove('on');
  if (!t || matchMedia('(hover: none)').matches) return;
  tipTimer = setTimeout(() => {
    if (!t.isConnected || !t.dataset.tip) return;
    dom.tooltip.textContent = t.dataset.tip;
    const r = t.getBoundingClientRect();
    const tw = dom.tooltip.offsetWidth, th = dom.tooltip.offsetHeight;
    let x = clamp(r.left + r.width / 2 - tw / 2, 6, innerWidth - tw - 6);
    let y = r.bottom + 8;
    if (y + th > innerHeight - 4) y = r.top - th - 8;
    dom.tooltip.style.left = `${x}px`;
    dom.tooltip.style.top = `${y}px`;
    dom.tooltip.classList.add('on');
  }, 550);
});
document.addEventListener('mousedown', () => { clearTimeout(tipTimer); dom.tooltip.classList.remove('on'); }, true);

// ---- popup menu

function openMenu(anchor, items, at) {
  dom.menu.innerHTML = '';
  for (const it of items) {
    if (it === '-') { dom.menu.insertAdjacentHTML('beforeend', '<div class="sep"></div>'); continue; }
    if (it.label && !it.run && !it.chips) { dom.menu.insertAdjacentHTML('beforeend', `<div class="lbl">${esc(it.label)}</div>`); continue; }
    if (it.chips) {
      const row = document.createElement('div');
      row.className = 'chips';
      if (it.label) dom.menu.insertAdjacentHTML('beforeend', `<div class="lbl">${esc(it.label)}</div>`);
      for (const c of it.chips) {
        const b = document.createElement('button');
        b.className = 'chip' + (c.on ? ' on' : '');
        b.textContent = c.text;
        b.onclick = () => { c.run(); openMenu(anchor, typeof items.rebuild === 'function' ? items.rebuild() : items, at); };
        row.appendChild(b);
      }
      dom.menu.appendChild(row);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'mi' + (it.toggle !== undefined ? ' tog' : '') + (it.danger ? ' danger' : '');
    b.disabled = !!it.disabled;
    b.innerHTML = it.toggle !== undefined
      ? `<span>${esc(it.text)}</span><span class="switch${it.toggle ? ' on' : ''}"></span>`
      : `${it.icon ? icon(it.icon) : ''}<span>${esc(it.text)}</span>${it.kbd ? `<span class="kbd">${esc(it.kbd)}</span>` : ''}`;
    b.onclick = () => {
      if (it.toggle !== undefined) { it.run(); openMenu(anchor, typeof items.rebuild === 'function' ? items.rebuild() : items, at); return; }
      closeMenu();
      it.run();
    };
    dom.menu.appendChild(b);
  }
  dom.menu.classList.add('on');
  const mw = dom.menu.offsetWidth, mh = dom.menu.offsetHeight;
  let x, y;
  if (at) { x = at.x; y = at.y; } else {
    const r = anchor.getBoundingClientRect();
    x = r.right - mw; y = r.bottom + 6;
  }
  dom.menu.style.left = `${clamp(x, 8, innerWidth - mw - 8)}px`;
  dom.menu.style.top = `${clamp(y, 8, innerHeight - mh - 8)}px`;
}
function closeMenu() { dom.menu.classList.remove('on'); }
document.addEventListener('pointerdown', (e) => {
  if (dom.menu.classList.contains('on') && !dom.menu.contains(e.target) && !e.target.closest('#btnMore')) closeMenu();
});

// ============================================================================================
// settings & theme

function resolvedFilter() {
  const f = S.settings.filter;
  if (f !== 'auto') return f;
  return { light: 'original', sepia: 'sepia', dark: 'night' }[S.settings.theme] || 'original';
}

function effectiveView() {
  const v = S.settings.view;
  if (v === 'spread' && dom.viewer.clientWidth && dom.viewer.clientWidth < 720) return 'single';
  return v;
}

function applySettings() {
  const st = S.settings;
  document.body.dataset.theme = st.theme;
  document.body.dataset.pfilter = resolvedFilter();
  document.body.dataset.view = effectiveView();
  document.body.classList.toggle('sidebar-open', !!st.sidebar);
  $('#btnSidebar').classList.toggle('on', !!st.sidebar);
  const themeIcon = { light: 'sun', sepia: 'coffee', dark: 'moon' }[st.theme];
  const tb = $('#btnTheme');
  tb.dataset.icon = themeIcon;
  tb.dataset.tip = `테마: ${{ light: '라이트', sepia: '세피아', dark: '다크' }[st.theme]} (T)`;
  hydrateIcons(tb.parentElement);
  $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === st.view));
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === st.sideTab));
  $$('.panel').forEach((p) => p.classList.toggle('on', p.id === `panel-${st.sideTab}`));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).getPropertyValue('--chrome').trim() || '#fbfaf8';
}

function setSetting(key, value) {
  S.settings[key] = value;
  saveSettings();
  const prevView = document.body.dataset.view;
  applySettings();
  if (key === 'view' || key === 'coverAlone' || (key === 'sidebar' && S.cur) || document.body.dataset.view !== prevView) {
    if (S.cur) { S.cur.zoom = 1; renderReader(); }
  }
  if (key === 'sideTab' || key === 'sidebar') renderSidebar();
}

function cycleTheme() {
  const order = ['light', 'sepia', 'dark'];
  setSetting('theme', order[(order.indexOf(S.settings.theme) + 1) % 3]);
}

// ============================================================================================
// library: import, open, close, remove

async function loadPdf(blob, meta) {
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = pdfjsLib.getDocument({ data, isEvalSupported: false });
  let cancelled = false;
  task.onPassword = async (update, reason) => {
    const known = S.passwords.get(meta.id);
    if (known && reason === pdfjsLib.PasswordResponses.NEED_PASSWORD) return update(known);
    showLoading(false);
    const pw = await modal({
      title: '암호로 보호된 문서',
      text: reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? '암호가 올바르지 않습니다. 다시 입력하세요.' : `“${meta.name}” 문서를 열려면 암호를 입력하세요.`,
      input: { type: 'password', placeholder: '암호' }, ok: '열기',
    });
    if (pw === null) { cancelled = true; task.destroy(); return; }
    S.passwords.set(meta.id, pw);
    update(pw);
  };
  try {
    return await task.promise;
  } catch (e) {
    if (cancelled) return null;
    throw e;
  }
}

async function getBlob(id) {
  return S.blobs.get(id) || (await Store.getFile(id));
}

async function importFile(file) {
  const id = await Store.fileId(file);
  let meta = S.library.find((m) => m.id === id);
  const isNew = !meta;
  if (!meta) {
    meta = { id, name: file.name, title: file.name.replace(/\.pdf$/i, ''), size: file.size, pages: 0, lastPage: 0, rotation: 0, added: Date.now(), lastOpened: 0, marks: [] };
  }
  S.blobs.set(id, file);
  if (!(await Store.putFile(id, file))) meta.volatile = true;
  if (isNew || !meta.cover) {
    try {
      const pdf = await loadPdf(file, meta);
      if (!pdf) return null;
      const doc = new BookDoc(meta, pdf);
      await doc.init();
      meta.pages = doc.n;
      meta.title = doc.title() || meta.title;
      const c = await doc.thumbnail(0, 240);
      meta.cover = c.toDataURL('image/jpeg', 0.82);
      doc.destroy();
    } catch (e) {
      console.warn(e);
      toast(`열 수 없는 PDF입니다: ${file.name}`);
      return null;
    }
  }
  if (isNew) S.library.push(meta);
  saveMeta(meta, true);
  return meta;
}

async function addFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!files.length) { toast('PDF 파일만 열 수 있습니다'); return; }
  showLoading(true, files.length > 1 ? `${files.length}권을 서재에 추가하는 중…` : '불러오는 중…');
  let last = null;
  let count = 0;
  for (const f of files) {
    const m = await importFile(f);
    if (m) { last = m; count++; }
  }
  showLoading(false);
  if (!last) { renderShelf(); return; }
  if (count > 1) {
    toast(`${count}권의 책을 서재에 추가했습니다`);
    if (!S.cur) { renderShelf(); renderSidebar(); return; }
  }
  await openBook(last.id);
}

async function openBook(id) {
  const existing = S.open.find((b) => b.meta.id === id);
  if (existing) return activate(existing);
  const meta = S.library.find((m) => m.id === id);
  if (!meta) return;
  const blob = await getBlob(id);
  if (!blob) {
    toast('저장된 파일이 없습니다. PDF를 다시 열어 주세요');
    return;
  }
  showLoading(true);
  try {
    const pdf = await loadPdf(blob, meta);
    if (!pdf) return;
    const doc = new BookDoc(meta, pdf);
    await doc.init();
    meta.pages = doc.n;
    if (!meta.title || meta.title === meta.name.replace(/\.pdf$/i, '')) meta.title = doc.title() || meta.title;
    const b = new Book(meta, doc);
    S.open.push(b);
    activate(b, true);
    doc.loadOutline().then(() => { if (S.cur === b) { renderSidebar(); updateChrome(); } });
    doc.measureAll(() => { if (S.cur === b) renderReader({ keep: true }); });
  } catch (e) {
    console.error(e);
    toast(`열 수 없는 PDF입니다: ${meta.name}`);
  } finally {
    showLoading(false);
  }
}

function activate(b, fresh = false) {
  finishAnim();
  S.cur = b;
  b.meta.lastOpened = Date.now();
  saveMeta(b.meta);
  document.body.classList.remove('is-home');
  document.title = `${b.meta.title} — Bookmark Studio`;
  dom.searchInput.value = b.search.query;
  document.body.classList.toggle('searching', !!b.search.query);
  applySettings();
  renderReader();
  renderSidebar();
  if (fresh && b.page > 0) toast(`p. ${b.page + 1}부터 이어 읽습니다`);
  dom.viewer.focus({ preventScroll: true });
}

function closeBook(b = S.cur) {
  if (!b) return;
  finishAnim();
  const i = S.open.indexOf(b);
  S.open.splice(i, 1);
  b.search.token++;
  b.doc.destroy();
  if (S.cur === b) {
    const next = S.open[Math.min(i, S.open.length - 1)];
    if (next) activate(next);
    else goHome();
  } else {
    renderSidebar();
  }
}

function goHome() {
  finishAnim();
  S.cur = null;
  document.body.classList.add('is-home');
  document.body.classList.remove('searching');
  document.title = 'Bookmark Studio';
  dom.pages.replaceChildren();
  if (S.settings.sideTab !== 'library') { S.settings.sideTab = 'library'; saveSettings(); applySettings(); }
  renderShelf();
  renderSidebar();
  updateChrome();
}

async function removeFromLibrary(meta) {
  const ok = await modal({ title: '서재에서 빼기', text: `“${meta.title}”을(를) 서재에서 뺄까요? 책갈피와 읽은 위치도 함께 삭제됩니다.`, ok: '빼기' });
  if (!ok) return;
  const open = S.open.find((b) => b.meta.id === meta.id);
  if (open) closeBook(open);
  S.library = S.library.filter((m) => m !== meta);
  S.blobs.delete(meta.id);
  await Store.removeBook(meta.id);
  renderShelf();
  renderSidebar();
  toast('서재에서 뺐습니다');
}

async function downloadBook(meta) {
  const blob = await getBlob(meta.id);
  if (!blob) return toast('저장된 파일이 없습니다');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = meta.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ============================================================================================
// shelf (home)

function sortedLibrary() {
  return [...S.library].sort((a, b) => (b.lastOpened || b.added) - (a.lastOpened || a.added));
}

function renderShelf() {
  if (S.cur) return;
  const list = sortedLibrary();
  $('#brandSub').textContent = S.open.length ? `열린 책 ${S.open.length}권` : '';
  if (!list.length) {
    dom.shelf.innerHTML = `<div class="shelf-empty">
      <div class="big">${icon('library')}</div>
      <h1>서재가 비어 있습니다</h1>
      <p>PDF 파일을 이 창으로 끌어다 놓거나 아래 버튼을 눌러 책을 추가하세요.</p>
      <button class="primary-btn" data-act="open">${icon('plus')}PDF 열기</button>
      <div class="hint">Ctrl+O · 여러 파일 동시 선택 가능 · 파일은 이 브라우저에만 저장됩니다 · ? 단축키</div>
    </div>`;
    return;
  }
  const hero = list[0].lastOpened ? list[0] : null;
  const readCount = list.filter((m) => m.lastOpened).length;
  let html = `<div class="shelf-inner"><div class="shelf-head"><div><h1>서재</h1><p>책 ${list.length}권 · 읽은 책 ${readCount}권</p></div>
    <button class="primary-btn" data-act="open">${icon('plus')}PDF 열기</button></div>`;
  if (hero) {
    const pct = Math.round(progressOf(hero) * 100);
    html += `<div class="hero" data-id="${hero.id}" tabindex="0">
      <div class="cover-wrap">${coverHtml(hero)}</div>
      <div class="info"><div class="k">이어 읽기</div><h2>${esc(hero.title)}</h2>
      <div class="m">p. ${hero.lastPage + 1} / ${hero.pages} · ${pct}% 읽음 · ${relTime(hero.lastOpened)}${hero.marks.length ? ` · 책갈피 ${hero.marks.length}개` : ''}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <button class="primary-btn" data-id="${hero.id}">계속 읽기 →</button></div></div>`;
  }
  html += '<h3>모든 책</h3><div class="grid">';
  for (const m of list) {
    const pct = Math.round(progressOf(m) * 100);
    const meta = m.lastOpened ? `${pct}% · ${relTime(m.lastOpened)}` : `새 책 · ${m.pages}쪽`;
    html += `<div class="card" data-id="${m.id}" tabindex="0" title="${esc(m.name)}">
      <div class="cover-wrap">${coverHtml(m)}</div>
      <button class="card-menu" data-menu="${m.id}" aria-label="더보기">${icon('more')}</button>
      <div class="bar"><i style="width:${m.lastOpened ? pct : 0}%"></i></div>
      <div class="t">${esc(m.title)}</div><div class="m${m.volatile ? ' warn' : ''}">${m.volatile ? '이번 세션에만 열림' : meta}</div></div>`;
  }
  html += '</div></div>';
  dom.shelf.innerHTML = html;
}

dom.shelf.addEventListener('click', (e) => {
  if (e.target.closest('[data-act="open"]')) return dom.fileInput.click();
  const menuBtn = e.target.closest('[data-menu]');
  if (menuBtn) {
    e.stopPropagation();
    const meta = S.library.find((m) => m.id === menuBtn.dataset.menu);
    if (meta) bookMenu(meta, menuBtn);
    return;
  }
  const card = e.target.closest('[data-id]');
  if (card) openBook(card.dataset.id);
});
dom.shelf.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset.id) openBook(e.target.dataset.id);
});
dom.shelf.addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  const meta = S.library.find((m) => m.id === card.dataset.id);
  if (meta) bookMenu(meta, null, { x: e.clientX, y: e.clientY });
});

function bookMenu(meta, anchor, at) {
  openMenu(anchor, [
    { text: '열기', icon: 'book', run: () => openBook(meta.id) },
    { text: 'PDF 다운로드', icon: 'download', run: () => downloadBook(meta) },
    '-',
    { text: '서재에서 빼기', icon: 'trash', danger: true, run: () => removeFromLibrary(meta) },
  ], at);
}

// ============================================================================================
// reader layout & rendering

function spreadStart(b, p) {
  p = clamp(p, 0, b.doc.n - 1);
  if (S.settings.coverAlone) return p === 0 ? 0 : p - ((p - 1) % 2);
  return p - (p % 2);
}

function spreadPages(b, start) {
  if (S.settings.coverAlone && start === 0) return [0];
  return start + 1 < b.doc.n ? [start, start + 1] : [start];
}

function visiblePages(b) {
  const v = effectiveView();
  if (v === 'spread') return spreadPages(b, spreadStart(b, b.page));
  return [b.page];
}

function margin() { return dom.viewer.clientWidth < 600 ? 14 : effectiveView() === 'spread' ? 34 : 26; }

function layoutSizes(b, list) {
  const vw = dom.viewer.clientWidth, vh = dom.viewer.clientHeight, m = margin();
  const dims = list.map((p) => b.doc.size(p, b.rot));
  const A = dims.reduce((s, d) => s + d.w / d.h, 0);
  const fitA = effectiveView() === 'spread' && list.length === 1 ? A * 2 : A;
  const H = Math.max(40, Math.min(vh - 2 * m, (vw - 2 * m) / fitA)) * b.zoom;
  return dims.map((d) => ({ w: Math.round((d.w / d.h) * H), h: Math.round(H) }));
}

function buildSpread(b, list, sizes, els) {
  const spread = document.createElement('div');
  spread.className = 'spread' + (list.length === 2 ? ' two' : '');
  els.forEach((el, i) => {
    el.classList.toggle('pl', list.length === 2 && i === 0);
    el.classList.toggle('pr', list.length === 2 && i === 1);
    spread.appendChild(el);
  });
  if (effectiveView() === 'spread') {
    // stacked page edges: thickness shows how far into the book you are
    const n = b.doc.n;
    const read = Math.round((5 * list[0]) / Math.max(1, n - 1));
    const lw = list[0] === 0 && list.length === 1 ? 0 : read, rw = 5 - read;
    const edge = (side, w) => {
      if (!w) return;
      const d = document.createElement('div');
      d.className = `edges ${side}`;
      d.style.width = `${w * 2 + 6}px`;
      d.style.background = `repeating-linear-gradient(90deg, var(--paper) 0 1.5px, color-mix(in srgb, var(--paper) 78%, #000) 1.5px 2px)`;
      d.style.borderRadius = side === 'l' ? '3px 0 0 3px' : '0 3px 3px 0';
      spread.appendChild(d);
    };
    edge('l', lw);
    edge('r', rw);
  }
  return spread;
}

function renderReader(opts = {}) {
  const b = S.cur;
  if (!b) return;
  finishAnim();
  document.body.dataset.view = effectiveView();
  if (effectiveView() === 'scroll') renderScroll(opts);
  else renderPaged(opts);
  updateChrome();
}

function renderPaged(opts = {}) {
  const b = S.cur;
  disconnectScroll();
  const keep = opts.keep ? viewportCenter() : null;
  const list = visiblePages(b);
  const sizes = layoutSizes(b, list);
  const els = list.map((p, i) => b.doc.pageEl(p, sizes[i].w, sizes[i].h, b.rot));
  dom.pages.style.padding = `${margin()}px`;
  dom.pages.replaceChildren(buildSpread(b, list, sizes, els));
  els.forEach((el) => el.ready.then(() => paintHighlights(el, b.search.hits, b.search.hits[b.search.cur])));
  if (keep) restoreCenter(keep);
  else if (opts.edge) {
    dom.viewer.scrollLeft = (dom.viewer.scrollWidth - dom.viewer.clientWidth) / 2;
    dom.viewer.scrollTop = opts.edge > 0 ? 0 : dom.viewer.scrollHeight;
  } else {
    dom.viewer.scrollLeft = (dom.viewer.scrollWidth - dom.viewer.clientWidth) / 2;
    dom.viewer.scrollTop = 0;
  }
  updatePanCursor();
  schedulePrefetch();
}

function viewportCenter() {
  const v = dom.viewer;
  return { x: (v.scrollLeft + v.clientWidth / 2) / Math.max(1, v.scrollWidth), y: (v.scrollTop + v.clientHeight / 2) / Math.max(1, v.scrollHeight) };
}
function restoreCenter(c, anchor) {
  const v = dom.viewer;
  v.scrollLeft = c.x * v.scrollWidth - (anchor ? anchor.x : v.clientWidth / 2);
  v.scrollTop = c.y * v.scrollHeight - (anchor ? anchor.y : v.clientHeight / 2);
}

function updatePanCursor() {
  const v = dom.viewer;
  const pannable = effectiveView() !== 'scroll' && (v.scrollWidth > v.clientWidth + 2 || v.scrollHeight > v.clientHeight + 2);
  v.classList.toggle('grab', pannable);
}

let prefetchTimer = 0;
function schedulePrefetch() {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    const b = S.cur;
    if (!b || effectiveView() === 'scroll') return;
    const targets = [];
    if (effectiveView() === 'spread') {
      const st = spreadStart(b, b.page);
      const next = st + spreadPages(b, st).length;
      if (next < b.doc.n) targets.push(spreadPages(b, next));
      if (st > 0) targets.push(spreadPages(b, spreadStart(b, st - 1)));
    } else {
      if (b.page + 1 < b.doc.n) targets.push([b.page + 1]);
      if (b.page > 0) targets.push([b.page - 1]);
    }
    for (const list of targets) {
      const saved = b.zoom;
      const sizes = layoutSizes(b, list);
      b.zoom = saved;
      list.forEach((p, i) => b.doc.pageEl(p, sizes[i].w, sizes[i].h, b.rot));
    }
  }, 260);
}

// ---- continuous scroll

let scrollObserver = null;
let scrollSlots = [];

function disconnectScroll() {
  if (scrollObserver) scrollObserver.disconnect();
  scrollObserver = null;
  scrollSlots = [];
}

function renderScroll(opts = {}) {
  const b = S.cur;
  const keep = opts.keep ? viewportCenter() : null;
  disconnectScroll();
  const m = margin();
  const col = Math.max(120, Math.min(dom.viewer.clientWidth - 2 * m, 980) * b.zoom);
  let maxW = 1;
  for (let i = 0; i < b.doc.n; i++) maxW = Math.max(maxW, b.doc.size(i, b.rot).w);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < b.doc.n; i++) {
    const d = b.doc.size(i, b.rot);
    const w = Math.round((col * d.w) / maxW), h = Math.round((w * d.h) / d.w);
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.dataset.page = i;
    slot.style.width = `${w}px`;
    slot.style.height = `${h}px`;
    slot.sw = w;
    slot.sh = h;
    frag.appendChild(slot);
    scrollSlots.push(slot);
  }
  dom.pages.style.padding = `${m}px`;
  dom.pages.replaceChildren(frag);
  scrollObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const slot = e.target;
      const i = +slot.dataset.page;
      if (e.isIntersecting) {
        if (!slot.firstChild) {
          const el = b.doc.pageEl(i, slot.sw, slot.sh, b.rot);
          slot.appendChild(el);
          el.ready.then(() => paintHighlights(el, b.search.hits, b.search.hits[b.search.cur]));
        }
      } else if (slot.firstChild) {
        slot.replaceChildren();
      }
    }
  }, { root: dom.viewer, rootMargin: '150% 0px' });
  scrollSlots.forEach((s) => scrollObserver.observe(s));
  if (keep) restoreCenter(keep);
  else scrollToSlot(b.page, false);
  dom.viewer.classList.remove('grab');
}

function scrollToSlot(page, smooth) {
  const slot = scrollSlots[page];
  if (!slot) return;
  const top = slot.offsetTop - 12;
  dom.viewer.scrollTo({ top, left: (dom.viewer.scrollWidth - dom.viewer.clientWidth) / 2, behavior: smooth && S.settings.animations ? 'smooth' : 'auto' });
}

function pageAtScroll() {
  const y = dom.viewer.scrollTop + dom.viewer.clientHeight * 0.35;
  let lo = 0, hi = scrollSlots.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (scrollSlots[mid].offsetTop <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

let scrollRaf = 0;
dom.viewer.addEventListener('scroll', () => {
  if (!S.cur || effectiveView() !== 'scroll' || scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const p = pageAtScroll();
    if (p !== S.cur.page) { setPage(S.cur, p); updateChrome(); }
  });
});

// ============================================================================================
// navigation

function setPage(b, p) {
  p = clamp(p, 0, b.doc.n - 1);
  b.page = p;
  b.meta.lastPage = p;
  saveMeta(b.meta);
}

function finishAnim() {
  if (S.anim) {
    const a = S.anim;
    S.anim = null;
    a.cleanup();
  }
}

async function goTo(page, { history = false, animate = true } = {}) {
  const b = S.cur;
  if (!b) return;
  page = clamp(page, 0, b.doc.n - 1);
  if (history && page !== b.page) {
    b.history.push(b.page);
    if (b.history.length > 100) b.history.shift();
  }
  const view = effectiveView();
  if (view === 'scroll') {
    setPage(b, page);
    scrollToSlot(page, animate);
    updateChrome();
    return;
  }
  if (view === 'spread' && spreadStart(b, page) === spreadStart(b, b.page)) {
    setPage(b, page);
    updateChrome();
    return;
  }
  const dir = page > b.page ? 1 : -1;
  finishAnim();
  const oldSpread = $('.spread', dom.pages);
  const oldPages = oldSpread ? $$(':scope > .page', oldSpread) : [];
  setPage(b, page);
  if (!animate || !S.settings.animations || !oldSpread || reducedMotion()) {
    renderPaged({ edge: dir });
    updateChrome();
    return;
  }
  await animateTurn(b, oldSpread, oldPages, dir);
  updateChrome();
}

function turn(dir) {
  const b = S.cur;
  if (!b) return;
  const view = effectiveView();
  if (view === 'scroll') return goTo(b.page + dir);
  let target;
  if (view === 'spread') {
    const st = spreadStart(b, b.page);
    target = dir > 0 ? st + spreadPages(b, st).length : st > 0 ? spreadStart(b, st - 1) : -1;
  } else {
    target = b.page + dir;
  }
  if (target < 0 || target >= b.doc.n) {
    toast(dir > 0 ? '마지막 페이지입니다' : '첫 페이지입니다');
    return;
  }
  goTo(target);
}

function historyBack() {
  const b = S.cur;
  if (!b || !b.history.length) return;
  goTo(b.history.pop(), { animate: true });
}

function snapshot(pageEl) {
  const src = $('canvas', pageEl);
  const c = document.createElement('canvas');
  c.width = src.width || 1;
  c.height = src.height || 1;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  if (src.width) ctx.drawImage(src, 0, 0);
  return c;
}

async function animateTurn(b, oldSpread, oldPages, dir) {
  const list = visiblePages(b);
  const sizes = layoutSizes(b, list);
  const els = list.map((p, i) => b.doc.pageEl(p, sizes[i].w, sizes[i].h, b.rot));
  await Promise.race([Promise.all(els.map((e) => e.ready)), sleep(400)]);
  if (S.cur !== b || !oldSpread.isConnected) return;

  const canFlip = effectiveView() === 'spread' && oldPages.length === 2 && els.length === 2 && b.zoom === 1 &&
    Math.abs(oldPages[0].offsetWidth - sizes[0].w) < 2 && Math.abs(oldPages[0].offsetHeight - sizes[0].h) < 2;

  if (!canFlip) {
    const fresh = buildSpread(b, list, sizes, els);
    dom.pages.replaceChildren(fresh);
    dom.viewer.scrollTop = dir > 0 ? 0 : dom.viewer.scrollHeight;
    els.forEach((el) => el.ready.then(() => paintHighlights(el, b.search.hits, b.search.hits[b.search.cur])));
    const a = fresh.animate([{ opacity: 0, transform: `translateX(${dir * 30}px)` }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
    S.anim = { cleanup: () => a.finish() };
    a.finished.then(() => { if (S.anim && S.anim.cleanup) S.anim = null; }).catch(() => {});
    schedulePrefetch();
    return;
  }

  const [oL, oR] = oldPages;
  const [nL, nR] = els;
  const leaf = document.createElement('div');
  leaf.className = 'leaf' + (dir < 0 ? ' from-left' : '');
  const front = document.createElement('div');
  front.className = 'face front';
  const back = document.createElement('div');
  back.className = 'face back';
  front.append(snapshot(dir > 0 ? oR : oL), Object.assign(document.createElement('div'), { className: 'shade' }));
  back.append(snapshot(dir > 0 ? nL : nR), Object.assign(document.createElement('div'), { className: 'shade' }));
  leaf.append(front, back);
  const cast = document.createElement('div');
  cast.className = 'cast ' + (dir > 0 ? 'r' : 'l');
  const wL = oL.offsetWidth, wR = oR.offsetWidth;
  if (dir > 0) {
    leaf.style.left = `${wL}px`;
    leaf.style.width = `${wR}px`;
    leaf.style.transformOrigin = 'left center';
    nR.classList.add('pr');
    oldSpread.replaceChild(nR, oR);
  } else {
    leaf.style.left = '0px';
    leaf.style.width = `${wL}px`;
    leaf.style.transformOrigin = 'right center';
    nL.classList.add('pl');
    oldSpread.replaceChild(nL, oL);
  }
  oldSpread.append(cast, leaf);

  const dur = 720;
  const easing = 'cubic-bezier(.45,.06,.3,1)';
  const anims = [
    leaf.animate([{ transform: 'rotateY(0deg)' }, { transform: `rotateY(${dir > 0 ? -180 : 180}deg)` }], { duration: dur, easing }),
    $('.shade', front).animate([{ opacity: 0 }, { opacity: 0.9 }], { duration: dur / 2, easing: 'ease-in', fill: 'forwards' }),
    $('.shade', back).animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: dur / 2, delay: dur / 2, easing: 'ease-out', fill: 'both' }),
    cast.animate([{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], { duration: dur, easing: 'linear' }),
  ];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    anims.forEach((a) => a.cancel());
    leaf.remove();
    cast.remove();
    if (S.cur !== b) return;
    const fresh = buildSpread(b, list, sizes, els);
    dom.pages.replaceChildren(fresh);
    els.forEach((el) => el.ready.then(() => paintHighlights(el, b.search.hits, b.search.hits[b.search.cur])));
    schedulePrefetch();
  };
  S.anim = { cleanup };
  try { await anims[0].finished; } catch { /* cancelled */ }
  if (S.anim && S.anim.cleanup === cleanup) { S.anim = null; cleanup(); }
}

// ---- zoom

function setZoom(z, anchor) {
  const b = S.cur;
  if (!b) return;
  z = clamp(z, effectiveView() === 'scroll' ? 0.4 : 0.5, 6);
  if (Math.abs(z - 1) < 0.03) z = 1;
  if (z === b.zoom) return;
  const v = dom.viewer.getBoundingClientRect();
  const a = anchor ? { x: anchor.x - v.left, y: anchor.y - v.top } : { x: dom.viewer.clientWidth / 2, y: dom.viewer.clientHeight / 2 };
  const c = { x: (dom.viewer.scrollLeft + a.x) / dom.viewer.scrollWidth, y: (dom.viewer.scrollTop + a.y) / dom.viewer.scrollHeight };
  b.zoom = z;
  renderReader();
  restoreCenter(c, a);
  updatePanCursor();
}

function zoomStep(dir) {
  const b = S.cur;
  if (!b) return;
  const z = b.zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.01) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.01);
  if (next) setZoom(next);
}

// ============================================================================================
// bookmarks, search, misc actions

function sectionIndex(b, page) {
  let best = -1, bestPage = -1;
  b.doc.outline.forEach((e, i) => {
    if (e.page >= 0 && e.page <= page && e.page >= bestPage) { best = i; bestPage = e.page; }
  });
  return best;
}
function sectionTitle(b, page) {
  const i = sectionIndex(b, page);
  return i >= 0 ? b.doc.outline[i].title : '';
}

function toggleBookmark() {
  const b = S.cur;
  if (!b) return;
  const marks = b.meta.marks;
  const i = marks.findIndex((m) => m.page === b.page);
  if (i >= 0) {
    marks.splice(i, 1);
    toast('책갈피를 삭제했습니다');
  } else {
    marks.push({ page: b.page, note: sectionTitle(b, b.page), time: Date.now() });
    marks.sort((x, y) => x.page - y.page);
    toast(`p. ${b.page + 1}에 책갈피를 추가했습니다`);
  }
  saveMeta(b.meta);
  updateChrome();
  if (S.settings.sideTab === 'marks' || S.settings.sideTab === 'thumbs') renderSidebar();
}

async function editMark(i) {
  const b = S.cur;
  const m = b && b.meta.marks[i];
  if (!m) return;
  const v = await modal({ title: '책갈피 메모', text: `p. ${m.page + 1} 책갈피에 남길 메모`, input: { value: m.note, placeholder: '메모' }, ok: '저장' });
  if (v === null) return;
  m.note = v.trim();
  saveMeta(b.meta);
  renderSidebar();
}

function openSearch() {
  if (!S.cur) return;
  document.body.classList.add('searching');
  $('#btnSearch').classList.add('on');
  dom.searchInput.focus();
  dom.searchInput.select();
}

function closeSearch() {
  const b = S.cur;
  document.body.classList.remove('searching');
  $('#btnSearch').classList.remove('on');
  if (b) {
    b.search.token++;
    b.search = { query: '', hits: [], cur: -1, scanning: false, token: b.search.token, done: 0, matchCase: b.search.matchCase };
    dom.searchInput.value = '';
    refreshHighlights();
    updateChrome();
    if (S.settings.sideTab === 'search') renderSidebar();
  }
  dom.viewer.focus({ preventScroll: true });
}

async function runSearch(q) {
  const b = S.cur;
  if (!b) return;
  const s = b.search;
  s.query = q;
  s.hits = [];
  s.cur = -1;
  s.scanning = true;
  s.done = 0;
  const token = ++s.token;
  if (!S.settings.sidebar || S.settings.sideTab !== 'search') {
    S.settings.sidebar = true;
    S.settings.sideTab = 'search';
    saveSettings();
    applySettings();
    if (effectiveView() !== 'scroll') renderReader({ keep: true });
  }
  renderSidebar();
  const n = b.doc.n, start = b.page;
  let jumped = false, lastUi = 0;
  for (let k = 0; k < n; k++) {
    if (token !== s.token || b.doc.destroyed) return;
    const p = (start + k) % n;
    let hits = [];
    try { hits = await b.doc.search(p, q, s.matchCase); } catch { /* skip page */ }
    if (token !== s.token) return;
    if (hits.length && s.hits.length < 5000) {
      let at = s.hits.findIndex((h) => h.page > p);
      if (at < 0) at = s.hits.length;
      s.hits.splice(at, 0, ...hits);
      if (!jumped && S.cur === b) {
        jumped = true;
        s.cur = at;
        goTo(p, { history: true });
      } else if (s.cur >= at) {
        s.cur += hits.length;
      }
      refreshHighlights();
    }
    s.done = k + 1;
    if (performance.now() - lastUi > 120) {
      lastUi = performance.now();
      updateSearchUi();
      await sleep(0);
    }
  }
  s.scanning = false;
  updateSearchUi();
  if (!s.hits.length && S.cur === b) toast(`“${q}” 검색 결과가 없습니다`);
}

function nextHit(dir) {
  const b = S.cur;
  if (!b || !b.search.hits.length) return;
  const s = b.search;
  const n = s.hits.length;
  s.cur = s.cur < 0 ? (dir > 0 ? 0 : n - 1) : (s.cur + dir + n) % n;
  goTo(s.hits[s.cur].page, { history: true });
  refreshHighlights();
  updateSearchUi(true);
}

function refreshHighlights() {
  const b = S.cur;
  if (!b) return;
  $$('.page', dom.pages).forEach((el) => paintHighlights(el, b.search.hits, b.search.hits[b.search.cur]));
}

function updateSearchUi(scrollIntoView = false) {
  const b = S.cur;
  if (!b) return;
  const s = b.search;
  let count = '';
  if (s.query) {
    if (!s.hits.length) count = s.scanning ? '검색 중…' : '0개';
    else count = `${s.cur >= 0 ? s.cur + 1 : '–'}/${s.hits.length}${s.scanning ? '…' : ''}`;
  }
  $('#searchCount').textContent = count;
  $('#btnCase').classList.toggle('on', s.matchCase);
  updateTicks();
  if (S.settings.sidebar && S.settings.sideTab === 'search') {
    renderSearchPanel();
    if (scrollIntoView) $('.hit-item.on', $('#panel-search'))?.scrollIntoView({ block: 'nearest' });
  }
}

async function copyPageText() {
  const b = S.cur;
  if (!b) return;
  const texts = await Promise.all(visiblePages(b).map((p) => b.doc.pageText(p)));
  const text = texts.join('\n\n').trim();
  if (!text) return toast('이 페이지에는 텍스트가 없습니다 (스캔 이미지일 수 있음)');
  try {
    await navigator.clipboard.writeText(text);
    toast('페이지 텍스트를 클립보드에 복사했습니다');
  } catch {
    toast('클립보드에 접근할 수 없습니다');
  }
}

async function gotoDialog() {
  const b = S.cur;
  if (!b) return;
  const v = await modal({ title: '페이지로 이동', text: `1 – ${b.doc.n} 사이의 페이지 번호 또는 페이지 레이블`, input: { value: String(b.page + 1) }, ok: '이동' });
  if (v === null) return;
  const s = v.trim();
  if (b.doc.labels) {
    const i = b.doc.labels.findIndex((l) => l && l.toLowerCase() === s.toLowerCase());
    if (i >= 0 && b.doc.labels[i] !== String(i + 1)) return goTo(i, { history: true });
  }
  const p = parseInt(s, 10);
  if (!(p >= 1 && p <= b.doc.n)) return toast(`1부터 ${b.doc.n} 사이의 숫자를 입력하세요`);
  goTo(p - 1, { history: true });
}

function rotate(dir) {
  const b = S.cur;
  if (!b) return;
  b.meta.rotation = (((b.meta.rotation || 0) + dir) % 4 + 4) % 4;
  saveMeta(b.meta);
  renderReader();
}

function docInfo() {
  const b = S.cur;
  if (!b) return;
  const info = b.doc.info || {};
  const d = b.doc.size(b.page, 0);
  const mm = (pt) => Math.round((pt / 72) * 25.4);
  const row = (k, v) => `<dt>${k}</dt><dd>${esc(v || '-')}</dd>`;
  modal({
    title: '문서 정보', cancel: null, ok: '닫기',
    html: `<dl>${row('제목', b.meta.title)}${row('저자', info.Author)}${row('페이지', `${b.doc.n}쪽`)}${row('크기', `${Math.round(d.w)} × ${Math.round(d.h)} pt (${mm(d.w)} × ${mm(d.h)} mm)`)}${row('파일', `${b.meta.name} · ${(b.meta.size / 1048576).toFixed(1)} MB`)}${row('목차', `${b.doc.outline.length}개 항목`)}${row('책갈피', `${b.meta.marks.length}개`)}${row('PDF 버전', info.PDFFormatVersion)}${row('작성 도구', info.Producer || info.Creator)}${row('추가한 날', new Date(b.meta.added).toLocaleString('ko-KR'))}</dl>`,
  });
}

function showHelp() {
  const keys = [
    ['← → · PgUp PgDn', '이전 / 다음 페이지'], ['Ctrl+O', 'PDF 열기 (여러 개)'],
    ['Space · Shift+Space', '다음 / 이전'], ['Ctrl+F · F3', '검색 / 다음 결과'],
    ['Home · End', '처음 / 끝으로'], ['Ctrl+B', '책갈피 추가·삭제'],
    ['Ctrl+G', '페이지로 이동'], ['Ctrl+Shift+C', '페이지 텍스트 복사'],
    ['Alt+← · Backspace', '이전 위치로'], ['Alt+]  Alt+[', '다음 / 이전 책'],
    ['1 · 2 · 3', '한 쪽 / 두 쪽 / 스크롤'], ['S', '사이드바'],
    ['Ctrl+휠 · Ctrl +/−', '확대 / 축소'], ['T · N', '테마 / 페이지 색상'],
    ['Ctrl+0 · 더블 클릭', '화면에 맞춤 / 확대 전환'], ['R · F', '회전 / 전체 화면'],
    ['스와이프', '페이지 넘기기 (터치)'], ['Esc', '검색·전체 화면 닫기'],
  ];
  modal({
    title: '단축키', cancel: null, ok: '닫기', wide: true,
    html: `<div class="keys">${keys.map(([k, d]) => `<div><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('')}</div>`,
  });
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => toast('전체 화면을 사용할 수 없습니다'));
}

document.addEventListener('fullscreenchange', () => {
  const fs = !!document.fullscreenElement;
  document.body.classList.toggle('immersive', fs && !!S.cur);
  const btn = $('#btnFullscreen');
  btn.dataset.icon = fs ? 'minimize' : 'maximize';
  btn.dataset.tip = fs ? '전체 화면 끝내기 (Esc)' : '전체 화면 (F11)';
  hydrateIcons(btn.parentElement);
  if (fs) toast('전체 화면 · 위아래로 마우스를 옮기면 메뉴가 보입니다');
  setTimeout(() => S.cur && renderReader({ keep: true }), 120);
});

function moreMenu(anchor) {
  const b = S.cur;
  const st = S.settings;
  const build = () => {
    const items = [
      { label: '테마', chips: [['light', '라이트'], ['sepia', '세피아'], ['dark', '다크']].map(([k, t]) => ({ text: t, on: st.theme === k, run: () => setSetting('theme', k) })) },
      { label: '페이지 색상', chips: [['auto', '자동'], ['original', '원본'], ['sepia', '세피아'], ['night', '야간']].map(([k, t]) => ({ text: t, on: st.filter === k, run: () => setSetting('filter', k) })) },
      { label: '보기 방식', chips: [['single', '한 쪽'], ['spread', '두 쪽'], ['scroll', '스크롤']].map(([k, t]) => ({ text: t, on: st.view === k, run: () => setSetting('view', k) })) },
      '-',
      { text: '두 쪽 보기에서 표지 따로', toggle: st.coverAlone, run: () => setSetting('coverAlone', !st.coverAlone) },
      { text: '페이지 넘김 애니메이션', toggle: st.animations, run: () => setSetting('animations', !st.animations) },
      { text: '가장자리 클릭으로 넘기기', toggle: st.clickTurn, run: () => setSetting('clickTurn', !st.clickTurn) },
      '-',
      { text: '시계 방향 회전', icon: 'rotate', kbd: 'R', disabled: !b, run: () => rotate(1) },
      { text: '페이지로 이동…', icon: 'chevronRight', kbd: 'Ctrl+G', disabled: !b, run: gotoDialog },
      { text: '페이지 텍스트 복사', icon: 'copy', kbd: 'Ctrl+Shift+C', disabled: !b, run: copyPageText },
      { text: '문서 정보', icon: 'info', disabled: !b, run: docInfo },
      { text: 'PDF 다운로드', icon: 'download', disabled: !b, run: () => downloadBook(b.meta) },
      { text: '책 닫기', icon: 'x', kbd: 'Ctrl+W', disabled: !b, run: () => closeBook() },
      '-',
      { text: '단축키', icon: 'keyboard', kbd: '?', run: showHelp },
    ];
    items.rebuild = build;
    return items;
  };
  openMenu(anchor, build());
}

// ============================================================================================
// chrome (top bar, bottom bar, slider)

function updateChrome() {
  const b = S.cur;
  $('#brandSub').textContent = S.open.length && !b ? `열린 책 ${S.open.length}권` : '';
  if (!b) return;
  const n = b.doc.n;
  const vis = effectiveView() === 'scroll' ? [b.page] : visiblePages(b);
  const first = vis[0], last = vis[vis.length - 1];
  $('#docTitle').textContent = b.meta.title;
  const sec = sectionTitle(b, b.page);
  $('#docSection').textContent = sec && sec !== b.meta.title ? sec : '';

  const range = last > first ? `${first + 1}–${last + 1}` : `${first + 1}`;
  const label = b.doc.labels && b.doc.labels[first] && b.doc.labels[first] !== String(first + 1) ? b.doc.labels[first] : '';
  $('#btnGoto').innerHTML = `${label ? `<small>${esc(label)}</small>` : ''}${range} / ${n}`;
  const pct = Math.round(((last + 1) / n) * 100);
  const remain = n - 1 - last;
  $('#readInfo').textContent = `${pct}% · ${remain > 0 ? `${remain}쪽 남음` : '마지막 페이지'}`;
  const frac = n > 1 ? first / (n - 1) : 0;
  $('#sliderFill').style.width = `${frac * 100}%`;
  $('#sliderThumb').style.left = `${frac * 100}%`;

  const view = effectiveView();
  $('#btnPrev').disabled = view === 'spread' ? spreadStart(b, b.page) === 0 : b.page === 0;
  $('#btnNext').disabled = last >= n - 1;
  $('#edgePrev').disabled = $('#btnPrev').disabled;
  $('#edgeNext').disabled = $('#btnNext').disabled;
  const back = $('#btnBack');
  back.hidden = !b.history.length;
  if (b.history.length) back.dataset.tip = `p. ${b.history[b.history.length - 1] + 1}(으)로 돌아가기 (Alt+←)`;

  const marked = b.meta.marks.some((m) => m.page === b.page);
  const bm = $('#btnBookmark');
  bm.classList.toggle('marked', marked);
  bm.dataset.tip = marked ? '책갈피 삭제 (Ctrl+B)' : '이 페이지에 책갈피 (Ctrl+B)';

  const zl = $('#btnZoomFit');
  const ps = $('.page', dom.pages);
  const pctZoom = ps ? Math.round((ps.offsetWidth / b.doc.size(+ps.dataset.page, b.rot).w) * 75) : 100;
  zl.textContent = b.zoom === 1 ? '맞춤' : `${pctZoom}%`;
  zl.classList.toggle('custom', b.zoom !== 1);
  updateTicks();
  updateSidebarState();
}

function updateTicks() {
  const b = S.cur;
  const box = $('#sliderTicks');
  if (!b) { box.innerHTML = ''; return; }
  const n = b.doc.n;
  const pos = (p) => (n > 1 ? (p / (n - 1)) * 100 : 0);
  let html = '';
  const seen = new Set();
  for (const h of b.search.hits) {
    const k = Math.round(pos(h.page) * 4);
    if (seen.has(k)) continue;
    seen.add(k);
    html += `<i style="left:${pos(h.page)}%"></i>`;
  }
  for (const m of b.meta.marks) html += `<b style="left:${pos(m.page)}%"></b>`;
  box.innerHTML = html;
}

(function initSlider() {
  const sl = dom.slider;
  let dragging = false;
  const pageAt = (x) => {
    const r = sl.getBoundingClientRect();
    const n = S.cur ? S.cur.doc.n : 1;
    return clamp(Math.round(((x - r.left) / r.width) * (n - 1)), 0, n - 1);
  };
  const bubble = (x, page) => {
    const r = sl.getBoundingClientRect();
    const bub = $('#sliderBubble');
    bub.style.left = `${clamp(x - r.left, 0, r.width)}px`;
    $('b', bub).textContent = `p. ${page + 1}`;
    $('span', bub).textContent = S.cur ? sectionTitle(S.cur, page) : '';
  };
  sl.addEventListener('pointerdown', (e) => {
    if (!S.cur) return;
    dragging = true;
    sl.classList.add('drag');
    sl.setPointerCapture(e.pointerId);
    S.cur.history.push(S.cur.page);
    const p = pageAt(e.clientX);
    bubble(e.clientX, p);
    goTo(p, { animate: false });
  });
  sl.addEventListener('pointermove', (e) => {
    if (!S.cur) return;
    const p = pageAt(e.clientX);
    bubble(e.clientX, p);
    if (dragging && p !== S.cur.page) goTo(p, { animate: false });
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sl.classList.remove('drag');
    const b = S.cur;
    if (b && b.history.length && b.history[b.history.length - 1] === b.page) b.history.pop();
    updateChrome();
  };
  sl.addEventListener('pointerup', end);
  sl.addEventListener('pointercancel', end);
})();

// ============================================================================================
// sidebar

function renderSidebar() {
  const tab = S.settings.sideTab;
  if (!S.settings.sidebar) return;
  if (tab === 'library') renderLibraryPanel();
  else if (tab === 'toc') renderTocPanel();
  else if (tab === 'thumbs') renderThumbsPanel();
  else if (tab === 'marks') renderMarksPanel();
  else renderSearchPanel();
}

function emptyNote(title, text) { return `<div class="empty-note"><b>${esc(title)}</b>${esc(text)}</div>`; }

function renderLibraryPanel() {
  const p = $('#panel-library');
  const openIds = new Set(S.open.map((b) => b.meta.id));
  const recent = sortedLibrary().filter((m) => !openIds.has(m.id));
  const item = (m, kind, i) => {
    const pct = Math.round(progressOf(m) * 100);
    const on = S.cur && S.cur.meta === m;
    const sub = `p. ${(m.lastPage || 0) + 1} / ${m.pages} · ${pct}%${kind === 'recent' ? ` · ${relTime(m.lastOpened || m.added)}` : ''}`;
    return `<div class="item${on ? ' on' : ''}" data-kind="${kind}" data-id="${m.id}" role="button" tabindex="0">
      <span class="mini-cover" style="${m.cover ? `background-image:url(${m.cover})` : `background:${toneFor(m.title)}`}"></span>
      <span class="meta"><div class="t">${esc(m.title)}</div><div class="s">${sub}</div><div class="bar"><i style="width:${pct}%"></i></div></span>
      ${kind === 'open' ? `<button class="mini-btn x" data-close="${i}" data-tip="책 닫기 (Ctrl+W)">${icon('x')}</button>` : ''}</div>`;
  };
  let html = '';
  if (S.open.length) html += `<div class="sec-head">열린 책 <span>${S.open.length}</span></div>` + S.open.map((b, i) => item(b.meta, 'open', i)).join('');
  if (recent.length) html += '<div class="sec-head">최근 읽은 책</div>' + recent.map((m) => item(m, 'recent')).join('');
  if (!S.library.length) html += emptyNote('서재가 비어 있습니다', 'PDF를 열면 이곳에 책이 쌓입니다.');
  html += `<button class="ghost-btn" data-act="open">${icon('plus')}PDF 열기</button>`;
  p.innerHTML = html;
}

$('#panel-library').addEventListener('click', (e) => {
  if (e.target.closest('[data-act="open"]')) return dom.fileInput.click();
  const c = e.target.closest('[data-close]');
  if (c) { e.stopPropagation(); return closeBook(S.open[+c.dataset.close]); }
  const it = e.target.closest('.item');
  if (it) { openBook(it.dataset.id); maybeCloseDrawer(); }
});
$('#panel-library').addEventListener('contextmenu', (e) => {
  const it = e.target.closest('.item');
  if (!it) return;
  e.preventDefault();
  const meta = S.library.find((m) => m.id === it.dataset.id);
  if (meta) bookMenu(meta, null, { x: e.clientX, y: e.clientY });
});

function renderTocPanel() {
  const p = $('#panel-toc');
  const b = S.cur;
  if (!b) { p.innerHTML = emptyNote('열린 책이 없습니다', '책을 열면 목차가 이곳에 표시됩니다.'); return; }
  const toc = b.doc.outline;
  if (!toc.length) { p.innerHTML = emptyNote('목차가 없는 문서입니다', '‘페이지’ 탭의 미리보기나 하단 슬라이더로 이동해 보세요.'); return; }
  const cur = sectionIndex(b, b.page);
  p.innerHTML = toc.map((e, i) => `<button class="toc-item d${Math.min(e.depth, 1)}${i === cur ? ' on' : ''}" data-i="${i}" style="padding-left:${12 + Math.min(e.depth, 6) * 14}px" title="${esc(e.title)}">
    <span class="tt">${esc(e.title)}</span><span class="pg">${e.page >= 0 ? esc(b.doc.label(e.page)) : ''}</span></button>`).join('');
  $('.toc-item.on', p)?.scrollIntoView({ block: 'center' });
}
$('#panel-toc').addEventListener('click', (e) => {
  const it = e.target.closest('.toc-item');
  if (!it || !S.cur) return;
  const entry = S.cur.doc.outline[+it.dataset.i];
  if (entry.page >= 0) { goTo(entry.page, { history: true }); maybeCloseDrawer(); }
  else if (entry.url) window.open(entry.url, '_blank', 'noopener');
  else toast('이 항목은 연결된 페이지가 없습니다');
});

let thumbObserver = null;
function renderThumbsPanel() {
  const p = $('#panel-thumbs');
  const b = S.cur;
  if (thumbObserver) thumbObserver.disconnect();
  if (!b) { p.innerHTML = emptyNote('열린 책이 없습니다', '책을 열면 페이지 미리보기가 표시됩니다.'); return; }
  const marks = new Set(b.meta.marks.map((m) => m.page));
  let html = '<div class="thumbs">';
  for (let i = 0; i < b.doc.n; i++) {
    const d = b.doc.size(i, 0);
    html += `<button class="thumb-cell${i === b.page ? ' on' : ''}" data-p="${i}"><span class="tc" style="--ar:${(d.w / d.h).toFixed(3)}"></span><span>${marks.has(i) ? `<span class="mk">●</span> ` : ''}${esc(b.doc.label(i))}</span></button>`;
  }
  p.innerHTML = html + '</div>';
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const cell = e.target;
      const i = +cell.dataset.p;
      thumbObserver.unobserve(cell);
      const put = (c) => { const box = $('.tc', cell); if (box && !box.firstChild) box.appendChild(c); };
      if (b.thumbs.has(i)) { put(b.thumbs.get(i)); continue; }
      b.doc.thumbnail(i, 120).then((c) => {
        b.thumbs.set(i, c);
        if (b.thumbs.size > 400) b.thumbs.delete(b.thumbs.keys().next().value);
        put(c);
      }).catch(() => {});
    }
  }, { root: p, rootMargin: '300px 0px' });
  $$('.thumb-cell', p).forEach((c) => thumbObserver.observe(c));
  $('.thumb-cell.on', p)?.scrollIntoView({ block: 'center' });
}
$('#panel-thumbs').addEventListener('click', (e) => {
  const c = e.target.closest('.thumb-cell');
  if (c && S.cur) { goTo(+c.dataset.p, { history: true }); maybeCloseDrawer(); }
});

function renderMarksPanel() {
  const p = $('#panel-marks');
  const b = S.cur;
  if (!b) { p.innerHTML = emptyNote('열린 책이 없습니다', '책을 열고 Ctrl+B를 눌러 책갈피를 추가하세요.'); return; }
  const has = b.meta.marks.some((m) => m.page === b.page);
  let html = `<div style="padding:4px 4px 10px"><button class="primary-btn block${has ? ' done' : ''}" data-act="add">${has ? `${icon('check')}이 페이지는 책갈피됨` : `${icon('plus')}이 페이지에 책갈피`}</button></div>`;
  if (!b.meta.marks.length) html += emptyNote('아직 책갈피가 없습니다', '표시해 두고 싶은 페이지에서 Ctrl+B 또는 상단의 책갈피 버튼을 누르세요.');
  const vis = new Set(visiblePages(b));
  b.meta.marks.forEach((m, i) => {
    html += `<div class="item mark-item${vis.has(m.page) ? ' on' : ''}" data-i="${i}" role="button" tabindex="0">
      <span class="rib">${icon('ribbon')}</span>
      <span class="meta"><div class="t">p. ${esc(b.doc.label(m.page))}</div><div class="s">${m.note ? esc(m.note) : '<span style="color:var(--faint)">메모 없음</span>'}</div></span>
      <span class="when">${relTime(m.time)}</span>
      <span class="acts"><button class="mini-btn" data-edit="${i}" data-tip="메모 편집">${icon('edit')}</button><button class="mini-btn" data-del="${i}" data-tip="삭제">${icon('trash')}</button></span></div>`;
  });
  p.innerHTML = html;
}
$('#panel-marks').addEventListener('click', (e) => {
  const b = S.cur;
  if (!b) return;
  if (e.target.closest('[data-act="add"]')) { if (!b.meta.marks.some((m) => m.page === b.page)) toggleBookmark(); renderMarksPanel(); return; }
  const ed = e.target.closest('[data-edit]');
  if (ed) { e.stopPropagation(); return editMark(+ed.dataset.edit); }
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    b.meta.marks.splice(+del.dataset.del, 1);
    saveMeta(b.meta);
    renderMarksPanel();
    updateChrome();
    toast('책갈피를 삭제했습니다');
    return;
  }
  const it = e.target.closest('.mark-item');
  if (it) { goTo(b.meta.marks[+it.dataset.i].page, { history: true }); maybeCloseDrawer(); }
});

function renderSearchPanel() {
  const p = $('#panel-search');
  const b = S.cur;
  if (!b) { p.innerHTML = emptyNote('열린 책이 없습니다', '책을 연 뒤 Ctrl+F로 검색하세요.'); return; }
  const s = b.search;
  if (!s.query) { p.innerHTML = emptyNote('본문 검색', 'Ctrl+F 또는 상단의 돋보기를 눌러 이 책 전체에서 단어를 찾습니다.'); return; }
  const pct = Math.round((s.done / b.doc.n) * 100);
  let html = `<div class="sec-head"><span>“${esc(s.query)}” · ${s.hits.length}개</span><span>${s.scanning ? `검색 중 ${pct}%` : ''}</span></div>`;
  if (s.scanning) html += `<div class="progress-line"><i style="width:${pct}%"></i></div>`;
  if (!s.hits.length && !s.scanning) html += emptyNote('결과 없음', '철자를 확인하거나 대소문자 구분(Aa)을 꺼 보세요. 스캔 이미지 PDF는 검색되지 않습니다.');
  const limit = Math.min(s.hits.length, 1500);
  for (let i = 0; i < limit; i++) {
    const h = s.hits[i];
    html += `<button class="hit-item${i === s.cur ? ' on' : ''}" data-i="${i}"><div class="p">p. ${esc(b.doc.label(h.page))}</div><div class="snip">${esc(h.pre)}<mark>${esc(h.mid)}</mark>${esc(h.post)}</div></button>`;
  }
  if (s.hits.length > limit) html += `<div class="empty-note">외 ${s.hits.length - limit}개 결과 · F3으로 계속 이동</div>`;
  const top = p.scrollTop;
  p.innerHTML = html;
  p.scrollTop = top;
}
$('#panel-search').addEventListener('click', (e) => {
  const it = e.target.closest('.hit-item');
  const b = S.cur;
  if (!it || !b) return;
  b.search.cur = +it.dataset.i;
  goTo(b.search.hits[b.search.cur].page, { history: true });
  refreshHighlights();
  updateSearchUi();
  maybeCloseDrawer();
});

function updateSidebarState() {
  const b = S.cur;
  if (!b || !S.settings.sidebar) return;
  const tab = S.settings.sideTab;
  if (tab === 'toc') {
    const cur = sectionIndex(b, b.page);
    $$('#panel-toc .toc-item').forEach((el) => el.classList.toggle('on', +el.dataset.i === cur));
  } else if (tab === 'thumbs') {
    const vis = new Set(effectiveView() === 'scroll' ? [b.page] : visiblePages(b));
    let first = null;
    $$('#panel-thumbs .thumb-cell').forEach((el) => {
      const on = vis.has(+el.dataset.p);
      el.classList.toggle('on', on);
      if (on && !first) first = el;
    });
    if (first) {
      const panel = $('#panel-thumbs');
      const r = first.getBoundingClientRect(), pr = panel.getBoundingClientRect();
      if (r.top < pr.top || r.bottom > pr.bottom) first.scrollIntoView({ block: 'center' });
    }
  } else if (tab === 'marks') {
    renderMarksPanel();
  } else if (tab === 'library') {
    $$('#panel-library .item[data-kind="open"]').forEach((el) => {
      const m = S.library.find((x) => x.id === el.dataset.id);
      if (m && m === b.meta) {
        const pct = Math.round(progressOf(m) * 100);
        $('.s', el).textContent = `p. ${m.lastPage + 1} / ${m.pages} · ${pct}%`;
        $('.bar i', el).style.width = `${pct}%`;
      }
    });
  }
}

function maybeCloseDrawer() {
  if (innerWidth <= 860 && S.settings.sidebar) setSetting('sidebar', false);
}

// ============================================================================================
// events

hydrateIcons();

$('#btnHome').onclick = () => (S.cur ? goHome() : S.open[0] && activate(S.open[0]));
$('#btnSidebar').onclick = () => setSetting('sidebar', !S.settings.sidebar);
$('#scrim').onclick = () => setSetting('sidebar', false);
$('#btnOpen').onclick = () => dom.fileInput.click();
$('#btnTheme').onclick = cycleTheme;
$('#btnMore').onclick = (e) => (dom.menu.classList.contains('on') ? closeMenu() : moreMenu(e.currentTarget));
$('#btnFullscreen').onclick = toggleFullscreen;
$('#btnSearch').onclick = () => (document.body.classList.contains('searching') ? closeSearch() : openSearch());
$('#btnBookmark').onclick = toggleBookmark;
$('#btnZoomIn').onclick = () => zoomStep(1);
$('#btnZoomOut').onclick = () => zoomStep(-1);
$('#btnZoomFit').onclick = () => { if (S.cur) { S.cur.zoom = 1; renderReader(); } };
$('#btnPrev').onclick = () => turn(-1);
$('#btnNext').onclick = () => turn(1);
$('#edgePrev').onclick = () => turn(-1);
$('#edgeNext').onclick = () => turn(1);
$('#btnBack').onclick = historyBack;
$('#btnGoto').onclick = gotoDialog;
$('#btnHitNext').onclick = () => nextHit(1);
$('#btnHitPrev').onclick = () => nextHit(-1);
$('#btnSearchClose').onclick = closeSearch;
$('#btnCase').onclick = () => {
  const b = S.cur;
  if (!b) return;
  b.search.matchCase = !b.search.matchCase;
  $('#btnCase').classList.toggle('on', b.search.matchCase);
  toast(b.search.matchCase ? '대소문자 구분: 켬' : '대소문자 구분: 끔');
  if (b.search.query) runSearch(b.search.query);
};
$$('#viewSeg button').forEach((btn) => (btn.onclick = () => setSetting('view', btn.dataset.view)));
$$('#tabs button').forEach((btn) => (btn.onclick = () => setSetting('sideTab', btn.dataset.tab)));
dom.fileInput.onchange = () => { addFiles(dom.fileInput.files); dom.fileInput.value = ''; };

dom.searchInput.addEventListener('keydown', (e) => {
  const b = S.cur;
  if (e.key === 'Enter') {
    e.preventDefault();
    const q = dom.searchInput.value.trim();
    if (!q || !b) return;
    if (q !== b.search.query) runSearch(q);
    else nextHit(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  } else if (e.key === 'F3') {
    e.preventDefault();
    nextHit(e.shiftKey ? -1 : 1);
  }
  e.stopPropagation();
});

// links inside pages
dom.pages.addEventListener('click', (e) => {
  const a = e.target.closest('.lnk');
  if (a && a.dataset.dest !== undefined) {
    e.preventDefault();
    e.stopPropagation();
    goTo(+a.dataset.dest, { history: true });
  }
});

// viewer: click-to-turn, drag-to-pan, swipe, wheel
(function initViewerInput() {
  const v = dom.viewer;
  let down = null;
  let moved = false;
  v.addEventListener('pointerdown', (e) => {
    if (!S.cur || e.button !== 0) return;
    moved = false;
    down = { x: e.clientX, y: e.clientY, sl: v.scrollLeft, st: v.scrollTop, type: e.pointerType, t: performance.now(),
      pan: v.classList.contains('grab') && !e.target.closest('.textLayer span') && e.pointerType === 'mouse' };
    if (down.pan) { v.classList.add('grabbing'); v.setPointerCapture(e.pointerId); }
  });
  v.addEventListener('pointermove', (e) => {
    if (S.cur && !down && e.pointerType === 'mouse') edgeHints(e);
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    if (down.pan) { v.scrollLeft = down.sl - dx; v.scrollTop = down.st - dy; }
  });
  v.addEventListener('pointerleave', () => edgeHints(null));
  const up = (e) => {
    if (!down) return;
    const d = down;
    down = null;
    v.classList.remove('grabbing');
    if (!S.cur || effectiveView() === 'scroll') return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    const zoomed = v.classList.contains('grab');
    if (d.type !== 'mouse' && !zoomed && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && performance.now() - d.t < 800) {
      turn(dx < 0 ? 1 : -1);
      return;
    }
    if (moved || zoomed || !S.settings.clickTurn) return;
    if (e.target.closest('.lnk, button')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const r = v.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    if (fx < 0.3) turn(-1);
    else if (fx > 0.7) turn(1);
  };
  v.addEventListener('pointerup', up);
  v.addEventListener('pointercancel', () => { down = null; v.classList.remove('grabbing'); });
  v.addEventListener('dblclick', (e) => {
    if (!S.cur || e.target.closest('.lnk')) return;
    const r = v.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    if (S.settings.clickTurn && effectiveView() !== 'scroll' && (fx < 0.3 || fx > 0.7) && S.cur.zoom === 1) return;
    window.getSelection()?.removeAllRanges();
    setZoom(S.cur.zoom > 1.05 ? 1 : 2, { x: e.clientX, y: e.clientY });
  });

  let acc = 0, cooldown = 0;
  v.addEventListener('wheel', (e) => {
    const b = S.cur;
    if (!b) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const f = Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1));
      setZoom(b.zoom * f, { x: e.clientX, y: e.clientY });
      return;
    }
    if (effectiveView() === 'scroll' || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    const canScroll = v.scrollHeight > v.clientHeight + 2;
    if (canScroll) {
      const atTop = v.scrollTop <= 0, atBottom = v.scrollTop + v.clientHeight >= v.scrollHeight - 1;
      if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) { acc = 0; return; }
    }
    e.preventDefault();
    const now = performance.now();
    if (now < cooldown) return;
    const d = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    if (Math.sign(d) !== Math.sign(acc)) acc = 0;
    acc += d;
    if (Math.abs(acc) >= 80) {
      turn(acc > 0 ? 1 : -1);
      acc = 0;
      cooldown = now + 260;
    }
  }, { passive: false });
})();

function edgeHints(e) {
  const prev = $('#edgePrev'), next = $('#edgeNext');
  let side = 0;
  if (e && S.settings.clickTurn && effectiveView() !== 'scroll' && !dom.viewer.classList.contains('grab')) {
    const r = dom.viewer.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    side = fx < 0.3 ? -1 : fx > 0.7 ? 1 : 0;
  }
  prev.classList.toggle('show', side < 0);
  next.classList.toggle('show', side > 0);
}

// show chrome near the edges in full screen
document.addEventListener('mousemove', (e) => {
  if (!document.body.classList.contains('immersive')) return;
  const near = e.clientY < 70 || e.clientY > innerHeight - 64 || dom.menu.classList.contains('on') || document.body.classList.contains('searching');
  document.body.classList.toggle('show-chrome', near);
});

// keyboard
document.addEventListener('keydown', (e) => {
  if (dom.modalWrap.classList.contains('on')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey, b = S.cur;
  const view = effectiveView();
  const handled = () => e.preventDefault();
  if (k === 'Escape') {
    if (dom.menu.classList.contains('on')) return closeMenu();
    if (document.body.classList.contains('searching')) return closeSearch();
    if (innerWidth <= 860 && S.settings.sidebar) return setSetting('sidebar', false);
    return;
  }
  if (ctrl) {
    const lk = k.toLowerCase();
    if (lk === 'o') { handled(); return dom.fileInput.click(); }
    if (lk === 'h') { handled(); return S.cur ? goHome() : S.open[0] && activate(S.open[0]); }
    if (!b) return;
    if (lk === 'f') { handled(); return openSearch(); }
    if (lk === 'g') { handled(); return gotoDialog(); }
    if (lk === 'b' || lk === 'd') { handled(); return toggleBookmark(); }
    if (lk === 'w') { handled(); return closeBook(); }
    if (lk === 'c' && e.shiftKey) { handled(); return copyPageText(); }
    if (k === '=' || k === '+') { handled(); return zoomStep(1); }
    if (k === '-') { handled(); return zoomStep(-1); }
    if (k === '0') { handled(); b.zoom = 1; return renderReader(); }
    if (k === 'Home') { handled(); return goTo(0, { history: true }); }
    if (k === 'End') { handled(); return goTo(b.doc.n - 1, { history: true }); }
    return;
  }
  if (e.altKey) {
    if (k === 'ArrowLeft') { handled(); return historyBack(); }
    if ((k === ']' || k === '[') && S.open.length) {
      handled();
      const i = S.open.indexOf(b);
      return activate(S.open[(i + (k === ']' ? 1 : -1) + S.open.length) % S.open.length]);
    }
    return;
  }
  switch (k) {
    case '?': handled(); return showHelp();
    case 'F1': handled(); return showHelp();
    case 'F11': handled(); return toggleFullscreen();
    case 'f': case 'F': return toggleFullscreen();
    case 't': case 'T': return cycleTheme();
    case 'n': case 'N': {
      const order = ['auto', 'original', 'sepia', 'night'];
      const next = order[(order.indexOf(S.settings.filter) + 1) % 4];
      setSetting('filter', next);
      return toast(`페이지 색상: ${{ auto: '테마에 맞춤', original: '원본', sepia: '세피아', night: '야간' }[next]}`);
    }
    case 's': case 'S': return setSetting('sidebar', !S.settings.sidebar);
    case '1': return setSetting('view', 'single');
    case '2': return setSetting('view', 'spread');
    case '3': return setSetting('view', 'scroll');
  }
  if (!b) return;
  switch (k) {
    case 'ArrowRight': case 'PageDown':
      if (view === 'scroll' && k === 'PageDown') return;
      handled(); return turn(1);
    case 'ArrowLeft': case 'PageUp':
      if (view === 'scroll' && k === 'PageUp') return;
      handled(); return turn(-1);
    case ' ':
      if (view === 'scroll') return;
      handled(); return turn(e.shiftKey ? -1 : 1);
    case 'ArrowDown': case 'ArrowUp': {
      if (view === 'scroll') return;
      const v = dom.viewer;
      if (v.scrollHeight > v.clientHeight + 2) {
        const dir = k === 'ArrowDown' ? 1 : -1;
        const atEnd = dir > 0 ? v.scrollTop + v.clientHeight >= v.scrollHeight - 1 : v.scrollTop <= 0;
        if (!atEnd) return;
      }
      handled(); return turn(k === 'ArrowDown' ? 1 : -1);
    }
    case 'Home': handled(); return goTo(0, { history: true });
    case 'End': handled(); return goTo(b.doc.n - 1, { history: true });
    case 'Backspace': handled(); return historyBack();
    case 'b': case 'B': return toggleBookmark();
    case 'r': return rotate(1);
    case 'R': return rotate(-1);
    case 'F3': handled(); return nextHit(e.shiftKey ? -1 : 1);
  }
});
document.addEventListener('mouseup', (e) => { if (e.button === 3) historyBack(); });

// drag & drop
(function initDrop() {
  let depth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('#dropOverlay').classList.add('on'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) $('#dropOverlay').classList.remove('on'); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('#dropOverlay').classList.remove('on');
    addFiles(e.dataTransfer.files);
  });
})();

// resize
let resizeRaf = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    const prev = document.body.dataset.view;
    document.body.dataset.view = effectiveView();
    if (S.cur) renderReader({ keep: prev === document.body.dataset.view });
  });
}).observe(dom.viewer);

window.addEventListener('beforeunload', () => {
  for (const b of S.open) saveMeta(b.meta, true);
});

// ============================================================================================
// boot

(async function boot() {
  if (innerWidth <= 860) S.settings.sidebar = false;  // the drawer starts closed on small screens
  applySettings();
  S.library = await Store.allBooks();
  for (const m of S.library) { m.marks = m.marks || []; }
  renderShelf();
  renderSidebar();
  updateChrome();
  // ?open=<url> loads a PDF from a URL (same origin or CORS-enabled)
  const params = new URLSearchParams(location.search);
  const url = params.get('open');
  if (url) {
    try {
      showLoading(true);
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      const blob = await res.blob();
      const name = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'document.pdf';
      await addFiles([new File([blob], name, { type: 'application/pdf', lastModified: 0 })]);
    } catch (e) {
      showLoading(false);
      toast('PDF를 불러오지 못했습니다');
    }
    if (S.cur) {
      if (params.get('view')) setSetting('view', params.get('view'));
      if (params.get('page')) goTo(+params.get('page') - 1, { animate: false });
      if (params.get('search')) { dom.searchInput.value = params.get('search'); openSearch(); runSearch(params.get('search')); }
      if (params.get('home')) goHome();
    }
  }
  if (params.get('theme')) setSetting('theme', params.get('theme'));
  if (params.get('sidebar')) { S.settings.sidebar = true; setSetting('sideTab', params.get('sidebar')); }
})();
