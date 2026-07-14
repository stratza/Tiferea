// Tab manager with split-pane tiling (feature 4).
//
// Tabs are opened as before, but the panel area can show 1, 2 or 4 of them at
// once in a grid. `slots` holds which tab occupies each visible pane; the
// `focused` slot is where new tabs land and where keyboard focus goes.

import { $, el } from './util.js';

const tabs = [];      // {id, title, kind, el, onClose, onShow, onHide, restore}
const changeListeners = [];
let layout = 1;       // 1 | 2 | 4 visible panes

// Workspace persistence hooks (feature 6): fire when the set of open tabs
// changes; restoreList() gives serializable descriptors for open tabs.
export function onTabsChange(fn) { changeListeners.push(fn); }
function fireChange() { for (const fn of changeListeners) { try { fn(); } catch { /* */ } } }
export function restoreList() { return tabs.filter((t) => t.restore).map((t) => t.restore); }
let slots = [null];   // length === layout; each holds a tabId or null
let focused = 0;      // index into slots
let blinkId = null;
let shown = new Set(); // tabIds currently visible (for onShow/onHide diffing)

export function findTab(id) {
  return tabs.find((t) => t.id === id) || null;
}

export function getActive() {
  return findTab(slots[focused]);
}

export function focusOrBlink(id) {
  const tab = findTab(id);
  if (!tab) return false;
  activate(id);
  blinkId = id;
  renderBar();
  tab.el.classList.add('flash');
  setTimeout(() => {
    blinkId = null;
    renderBar();
    tab.el.classList.remove('flash');
  }, 900);
  return true;
}

export function addTab(tab) {
  tabs.push(tab);
  tab.el.classList.add('panel');
  tab.el.addEventListener('mousedown', () => {
    const s = slots.indexOf(tab.id);
    if (s >= 0 && s !== focused) { focused = s; apply(); }
  });
  $('#panels').append(tab.el);
  slots[focused] = tab.id;   // land in the focused pane
  apply();
  fireChange();
  return tab;
}

// Bring a tab into the focused pane (or just refocus it if already visible).
export function activate(id) {
  if (!findTab(id)) return;
  const existing = slots.indexOf(id);
  if (existing >= 0) focused = existing;
  else slots[focused] = id;
  apply();
}

export function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [tab] = tabs.splice(i, 1);
  tab.onClose?.();
  tab.el.remove();
  shown.delete(id);
  // Free any pane it held, then backfill from an off-screen tab if possible.
  for (let s = 0; s < slots.length; s++) {
    if (slots[s] === id) {
      const spare = tabs.find((t) => !slots.includes(t.id));
      slots[s] = spare ? spare.id : null;
    }
  }
  // Collapse back to plain tabs once there's nothing left to tile.
  if (tabs.length <= 1 && layout > 1) { setLayout(1); fireChange(); return; }
  apply();
  fireChange();
}

export function setTitle(id, title) {
  const tab = findTab(id);
  if (tab) { tab.title = title; renderBar(); }
}

export function setLayout(n) {
  if (n === layout) return;
  const old = slots.filter(Boolean);
  layout = n;
  slots = new Array(n).fill(null);
  // Keep previously visible tabs, then backfill remaining panes.
  old.slice(0, n).forEach((id, i) => { slots[i] = id; });
  const offscreen = tabs.filter((t) => !slots.includes(t.id));
  for (let s = 0; s < n && offscreen.length; s++) {
    if (!slots[s]) slots[s] = offscreen.shift().id;
  }
  if (focused >= n) focused = n - 1;
  apply();
}

function updateWelcome() {
  $('#welcome')?.classList.toggle('hidden', tabs.length > 0);
}

// Reconcile DOM with the slots model: visibility, ordering, focus ring,
// empty-pane placeholders, and onShow/onHide callbacks.
function apply() {
  const panels = $('#panels');
  panels.className = `layout-${layout}`;

  const nowShown = new Set(slots.filter(Boolean));
  for (const id of shown) {
    if (!nowShown.has(id)) findTab(id)?.onHide?.();
  }

  for (const tab of tabs) {
    const s = slots.indexOf(tab.id);
    const vis = s >= 0;
    tab.el.classList.toggle('shown', vis);
    tab.el.classList.toggle('focused', vis && s === focused && layout > 1);
    if (vis) tab.el.style.order = String(s);
  }

  // Placeholders for empty panes so the grid keeps its shape and the focused
  // empty pane is still visible.
  panels.querySelectorAll('.slot-empty').forEach((n) => n.remove());
  if (layout > 1) {
    slots.forEach((id, s) => {
      if (id) return;
      const ph = el('div', { class: 'slot-empty', style: `order:${s}` },
        el('span', { text: 'empty pane · click a tab or a container' }));
      if (s === focused) ph.classList.add('focused');
      ph.addEventListener('mousedown', () => { focused = s; apply(); });
      panels.append(ph);
    });
  }

  for (const id of nowShown) {
    if (!shown.has(id)) findTab(id)?.onShow?.();
  }
  shown = nowShown;

  updateWelcome();
  renderBar();
}

function layoutBtn(n, glyph, title) {
  return el('button', {
    class: `layout-opt ${layout === n ? 'active' : ''}`,
    title, onclick: () => setLayout(n),
  }, glyph);
}

function renderBar() {
  const bar = $('#tabbar');
  const tabEls = tabs.map((t) => {
    const s = slots.indexOf(t.id);
    return el('div', {
      class: `tab ${t.kind || ''} ${s >= 0 ? 'visible' : ''}`
             + (s === focused && s >= 0 ? ' active' : '')
             + (t.id === blinkId ? ' blink' : ''),
      onclick: () => activate(t.id),
      // Middle-click (scroll-wheel button) closes the tab, like a browser.
      onmousedown: (e) => { if (e.button === 1) e.preventDefault(); },
      onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } },
    },
    el('span', { class: 'tab-title', text: t.title }),
    el('button', {
      class: 'tab-close', title: 'Close',
      onclick: (e) => { e.stopPropagation(); closeTab(t.id); },
    }, '×'));
  });
  // Split controls only appear when there is something to tile (2+ tabs) or
  // while a split is active, so a single tab is never accidentally split.
  const showCtl = tabs.length >= 2 || layout > 1;
  const ctl = showCtl ? el('div', { class: 'layout-ctl' },
    el('span', { class: 'layout-label', text: 'Layout' }),
    layoutBtn(1, '1', 'Single (tabs)'),
    layoutBtn(2, '2', 'Split in two'),
    layoutBtn(4, '4', 'Four panes')) : null;
  bar.replaceChildren(...tabEls, ...(ctl ? [ctl] : []));
}
