// Bookmark Studio — PDF document wrapper: page sizes, rendering, text search, outline, links
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const MAX_CANVAS_PIXELS = 16e6;

class BookDoc {
  constructor(meta, pdf) {
    this.meta = meta;
    this.pdf = pdf;
    this.n = pdf.numPages;
    this.sizes = new Array(this.n).fill(null); // unrotated, page /Rotate applied
    this.labels = null;
    this.outline = [];
    this.textCache = new Map();
    this.elCache = new Map();   // key -> page element (LRU by insertion order)
    this.linkCache = new Map();
    this.destroyed = false;
  }

  async init() {
    const first = await this.pdf.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    this.sizes[0] = { w: vp.width, h: vp.height };
    // fill a provisional size for every page, then measure the real ones in the background
    for (let i = 1; i < this.n; i++) this.sizes[i] = { w: vp.width, h: vp.height, guess: true };
    try { this.labels = await this.pdf.getPageLabels(); } catch { this.labels = null; }
    try { this.info = (await this.pdf.getMetadata()).info || {}; } catch { this.info = {}; }
  }

  async measureAll(onChange) {
    let changed = false;
    for (let i = 1; i < this.n && !this.destroyed; i++) {
      const p = await this.pdf.getPage(i + 1);
      const vp = p.getViewport({ scale: 1 });
      const s = this.sizes[i];
      if (Math.abs(s.w - vp.width) > 0.5 || Math.abs(s.h - vp.height) > 0.5) changed = true;
      this.sizes[i] = { w: vp.width, h: vp.height };
      if (changed && i % 50 === 0) { onChange(); changed = false; }
    }
    if (changed) onChange();
  }

  size(i, rot) {
    const s = this.sizes[i] || this.sizes[0];
    return rot % 180 ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
  }

  label(i) {
    return this.labels && this.labels[i] ? this.labels[i] : String(i + 1);
  }

  title() {
    const t = (this.info && this.info.Title || '').trim();
    if (!t || /microsoft word|untitled|\.docx?$|\.pdf$|powerpoint/i.test(t)) return null;
    return t;
  }

  async loadOutline() {
    let raw = null;
    try { raw = await this.pdf.getOutline(); } catch { raw = null; }
    const out = [];
    const walk = async (items, depth) => {
      for (const it of items || []) {
        if (out.length > 5000) return;
        out.push({ title: (it.title || '').trim() || '(제목 없음)', page: await this.resolveDest(it.dest), depth, url: it.url });
        if (it.items && it.items.length && depth < 12) await walk(it.items, depth + 1);
      }
    };
    await walk(raw, 0);
    this.outline = out;
    return out;
  }

  async resolveDest(dest) {
    try {
      if (!dest) return -1;
      const d = typeof dest === 'string' ? await this.pdf.getDestination(dest) : dest;
      if (!Array.isArray(d) || !d.length) return -1;
      const ref = d[0];
      if (typeof ref === 'number') return ref;
      return await this.pdf.getPageIndex(ref);
    } catch { return -1; }
  }

  // ---- page elements

  key(i, w, h, rot) { return `${i}|${Math.round(w)}|${Math.round(h)}|${rot}`; }

  pageEl(i, w, h, rot) {
    const k = this.key(i, w, h, rot);
    let el = this.elCache.get(k);
    if (el) {
      this.elCache.delete(k);
      this.elCache.set(k, el);
      return el;
    }
    el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = i;
    el.style.width = `${Math.round(w)}px`;
    el.style.height = `${Math.round(h)}px`;
    el.innerHTML = '<canvas></canvas><div class="hl-layer"></div><div class="textLayer"></div><div class="link-layer"></div>';
    el.ready = this.renderInto(el, i, w, rot).catch((e) => { if (e && e.name !== 'RenderingCancelledException') console.warn(e); });
    this.elCache.set(k, el);
    while (this.elCache.size > 18) {
      const [oldKey, oldEl] = this.elCache.entries().next().value;
      if (oldEl.isConnected) { this.elCache.delete(oldKey); this.elCache.set(oldKey, oldEl); break; }
      this.elCache.delete(oldKey);
      oldEl.cancel && oldEl.cancel();
    }
    return el;
  }

  async renderInto(el, i, cssW, rot) {
    const page = await this.pdf.getPage(i + 1);
    const rotation = (page.rotate + rot) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const scale = cssW / base.width;
    const vp = page.getViewport({ scale, rotation });
    el.vp = vp;
    let dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (vp.width * vp.height * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height));
    const canvas = el.querySelector('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width * dpr));
    canvas.height = Math.max(1, Math.floor(vp.height * dpr));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
    el.cancel = () => task.cancel();
    await task.promise;
    el.classList.add('rendered');

    // selectable text
    const textDiv = el.querySelector('.textLayer');
    try {
      const tc = await this.textContent(i);
      textDiv.style.setProperty('--scale-factor', scale);
      const t = pdfjsLib.renderTextLayer({ textContentSource: tc.raw, container: textDiv, viewport: vp, textDivs: [] });
      await t.promise;
    } catch (e) { /* text layer is optional */ }

    // links
    try {
      const links = await this.links(i);
      const layer = el.querySelector('.link-layer');
      for (const l of links) {
        const r = vp.convertToViewportRectangle(l.rect);
        const a = document.createElement('a');
        a.className = 'lnk';
        a.style.left = `${Math.min(r[0], r[2])}px`;
        a.style.top = `${Math.min(r[1], r[3])}px`;
        a.style.width = `${Math.abs(r[2] - r[0])}px`;
        a.style.height = `${Math.abs(r[3] - r[1])}px`;
        if (l.url) { a.href = l.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = l.url; }
        else { a.href = '#'; a.dataset.dest = l.page; a.title = `p. ${l.page + 1}`; }
        layer.appendChild(a);
      }
    } catch { /* ignore */ }
  }

  async links(i) {
    if (this.linkCache.has(i)) return this.linkCache.get(i);
    const page = await this.pdf.getPage(i + 1);
    const ann = await page.getAnnotations({ intent: 'display' });
    const out = [];
    for (const a of ann) {
      if (a.subtype !== 'Link') continue;
      if (a.url || a.unsafeUrl) out.push({ rect: a.rect, url: a.url || a.unsafeUrl });
      else if (a.dest) {
        const p = await this.resolveDest(a.dest);
        if (p >= 0) out.push({ rect: a.rect, page: p });
      }
    }
    this.linkCache.set(i, out);
    return out;
  }

  async thumbnail(i, width) {
    const page = await this.pdf.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: (width / base.width) * dpr });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  }

  // ---- text & search

  async textContent(i) {
    if (this.textCache.has(i)) return this.textCache.get(i);
    const page = await this.pdf.getPage(i + 1);
    const raw = await page.getTextContent();
    let str = '';
    const spans = [];
    for (const it of raw.items) {
      if (typeof it.str !== 'string') continue;
      const start = str.length;
      str += it.str;
      spans.push({ start, end: str.length, it });
      if (it.hasEOL) str += ' ';
    }
    const entry = { raw, str, spans };
    this.textCache.set(i, entry);
    if (this.textCache.size > 400) this.textCache.delete(this.textCache.keys().next().value);
    return entry;
  }

  async search(i, query, matchCase) {
    const t = await this.textContent(i);
    const hay = matchCase ? t.str : t.str.toLowerCase();
    const needle = matchCase ? query : query.toLowerCase();
    const hits = [];
    if (!needle) return hits;
    let from = 0;
    while (hits.length < 500) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      const rects = [];
      for (const s of t.spans) {
        if (s.end <= at || s.start >= end || !s.it.str.length) continue;
        const a = Math.max(at, s.start) - s.start;
        const b = Math.min(end, s.end) - s.start;
        const tr = s.it.transform;
        const fh = Math.hypot(tr[2], tr[3]) || s.it.height || 10;
        const len = s.it.str.length;
        const x0 = tr[4] + (s.it.width * a) / len;
        const x1 = tr[4] + (s.it.width * b) / len;
        rects.push([x0, tr[5] - fh * 0.22, x1, tr[5] + fh * 0.88]);
      }
      const pre = t.str.slice(Math.max(0, at - 28), at).replace(/\s+/g, ' ');
      const mid = t.str.slice(at, end);
      const post = t.str.slice(end, end + 70).replace(/\s+/g, ' ');
      hits.push({ page: i, rects, pre: (at > 28 ? '…' : '') + pre, mid, post: post + (end + 70 < t.str.length ? '…' : '') });
      from = end;
    }
    return hits;
  }

  async pageText(i) {
    const t = await this.textContent(i);
    return t.raw.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('');
  }

  destroy() {
    this.destroyed = true;
    for (const el of this.elCache.values()) el.cancel && el.cancel();
    this.elCache.clear();
    this.pdf.destroy();
  }
}

function paintHighlights(el, hits, curHit) {
  const layer = el.querySelector('.hl-layer');
  if (!layer) return;
  layer.innerHTML = '';
  if (!el.vp || !hits || !hits.length) return;
  const page = +el.dataset.page;
  for (const h of hits) {
    if (h.page !== page) continue;
    for (const r of h.rects) {
      const v = el.vp.convertToViewportRectangle(r);
      const d = document.createElement('div');
      d.className = 'hl' + (h === curHit ? ' cur' : '');
      d.style.left = `${Math.min(v[0], v[2]) - 1}px`;
      d.style.top = `${Math.min(v[1], v[3]) - 1}px`;
      d.style.width = `${Math.abs(v[2] - v[0]) + 2}px`;
      d.style.height = `${Math.abs(v[3] - v[1]) + 2}px`;
      layer.appendChild(d);
    }
  }
}
