// Bookmark Studio — persistence: IndexedDB for books (PDF blobs + metadata), localStorage for settings
'use strict';

const Store = (() => {
  const DB_NAME = 'bookmark-studio';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      console.warn('Library storage disabled:', err);
      return null;
    });
    return dbPromise;
  }

  async function tx(storeName, mode, fn) {
    const db = await open();
    if (!db) return undefined;
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      let result;
      Promise.resolve(fn(store)).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const req2p = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  async function allBooks() {
    try {
      const list = await tx('books', 'readonly', (s) => req2p(s.getAll()));
      return list || [];
    } catch (e) { console.warn(e); return []; }
  }

  async function putBook(meta) {
    try { await tx('books', 'readwrite', (s) => { s.put(meta); }); } catch (e) { console.warn(e); }
  }

  async function putFile(id, blob) {
    try { await tx('files', 'readwrite', (s) => { s.put(blob, id); }); return true; }
    catch (e) { console.warn('Could not store file (quota?)', e); return false; }
  }

  async function getFile(id) {
    try { return await tx('files', 'readonly', (s) => req2p(s.get(id))); } catch (e) { return undefined; }
  }

  async function removeBook(id) {
    try {
      await tx('books', 'readwrite', (s) => { s.delete(id); });
      await tx('files', 'readwrite', (s) => { s.delete(id); });
    } catch (e) { console.warn(e); }
  }

  // ---- settings
  const DEFAULTS = {
    theme: 'light',        // light | sepia | dark
    filter: 'auto',        // auto | original | sepia | night
    view: 'spread',        // single | spread | scroll
    coverAlone: true,
    animations: true,
    clickTurn: true,
    sidebar: false,
    sideTab: 'library',
  };
  function loadSettings() {
    try {
      const raw = localStorage.getItem('bookmark-studio:settings');
      return Object.assign({}, DEFAULTS, raw ? JSON.parse(raw) : {});
    } catch { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings(s) {
    try { localStorage.setItem('bookmark-studio:settings', JSON.stringify(s)); } catch { /* private mode */ }
  }

  // stable id from file identity
  async function fileId(file) {
    const key = `${file.name}|${file.size}|${file.lastModified || 0}`;
    if (window.crypto && crypto.subtle) {
      try {
        const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(key));
        return Array.from(new Uint8Array(buf)).slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch { /* fall through (insecure context) */ }
    }
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    return 'f' + (h >>> 0).toString(16) + key.length.toString(16);
  }

  return { allBooks, putBook, putFile, getFile, removeBook, loadSettings, saveSettings, fileId };
})();
