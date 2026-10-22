// Bookmark Studio — inline stroke icons (24×24, currentColor)
'use strict';

const ICONS = {
  home: '<path d="M3.5 10.5 12 3.8l8.5 6.7"/><path d="M5.5 9v11h13V9"/><path d="M10 20v-6h4v6"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/><path d="M5.8 8.5h1.6M5.8 11.5h1.6"/>',
  filePlus: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/><path d="M12 11.5v6M9 14.5h6"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m20 20-4.6-4.6"/>',
  ribbon: '<path d="M7 3.8h10v16.4l-5-4.1-5 4.1z"/>',
  ribbonFill: '<path d="M7 3.8h10v16.4l-5-4.1-5 4.1z" fill="currentColor"/>',
  viewSingle: '<rect x="7" y="4.5" width="10" height="15" rx="1.6"/>',
  viewSpread: '<rect x="3.5" y="5.5" width="8" height="13" rx="1.4"/><rect x="12.5" y="5.5" width="8" height="13" rx="1.4"/>',
  viewScroll: '<rect x="6" y="3.5" width="12" height="7.5" rx="1.4"/><rect x="6" y="13" width="12" height="7.5" rx="1.4"/>',
  zoomIn: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m20 20-4.6-4.6M10.8 8v5.6M8 10.8h5.6"/>',
  zoomOut: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m20 20-4.6-4.6M8 10.8h5.6"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4"/>',
  moon: '<path d="M20 14.2A8 8 0 1 1 9.8 4a6.4 6.4 0 0 0 10.2 10.2z"/>',
  coffee: '<path d="M5 9h11v5.5a4.5 4.5 0 0 1-4.5 4.5h-2A4.5 4.5 0 0 1 5 14.5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8.5 3.5c-.8 1 .8 2 0 3M12 3.5c-.8 1 .8 2 0 3"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  maximize: '<path d="M8.5 3.5h-5v5M15.5 3.5h5v5M20.5 15.5v5h-5M3.5 15.5v5h5"/>',
  minimize: '<path d="M3.5 8.5h5v-5M20.5 8.5h-5v-5M15.5 20.5v-5h5M8.5 20.5v-5h-5"/>',
  chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
  chevronUp: '<path d="m6 14.5 6-6 6 6"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  arrowLeft: '<path d="M19.5 12h-15M10.5 18l-6-6 6-6"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  trash: '<path d="M4.5 7h15M10 3.8h4M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7"/><path d="M10 11v6M14 11v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4.5 19.5h4l10-10-4-4-10 10z"/><path d="m13 7 4 4"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.5"/><path d="M20 3.5v5h-5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 9.5h1M9.5 9.5h1M13 9.5h1M16.5 9.5h1M6 12.5h1M16.5 12.5h1M9.5 12.5h4.5M8 15.5h8"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14"/>',
  book: '<path d="M3.5 5.5c3-1 6-1 8.5.8v13c-2.5-1.8-5.5-1.8-8.5-.8z"/><path d="M20.5 5.5c-3-1-6-1-8.5.8v13c2.5-1.8 5.5-1.8 8.5-.8z"/>',
  library: '<path d="M4.5 4.5h3.5v15H4.5zM10 4.5h3.5v15H10z"/><path d="m15.6 5.4 3.4-.9 3 14.4-3.4.9z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r=".6" fill="currentColor"/><circle cx="4.8" cy="12" r=".6" fill="currentColor"/><circle cx="4.8" cy="17.5" r=".6" fill="currentColor"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
};

function icon(name, cls = '') {
  const body = ICONS[name] || '';
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.dataset.iconDone === el.dataset.icon) return;
    const label = el.querySelector(':scope > .label');
    el.innerHTML = icon(el.dataset.icon) + (label ? label.outerHTML : '');
    el.dataset.iconDone = el.dataset.icon;
  });
}
