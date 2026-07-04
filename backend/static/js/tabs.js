// Tab manager for the main panel area.

import { $, el } from './util.js';

const tabs = [];      // {id, title, kind, el, onClose, onShow, onHide}
let activeId = null;
let blinkId = null;

export function findTab(id) {
  return tabs.find((t) => t.id === id) || null;
}

// Dedup helper: if a tab with this id exists, focus it and blink it so the
// user sees where it went, instead of opening a duplicate.
export function focusOrBlink(id) {
  const tab = findTab(id);
  if (!tab) return false;
  activate(id);
  blinkId = id;
  render();
  tab.el.classList.add('flash');
  setTimeout(() => {
    blinkId = null;
    render();
    tab.el.classList.remove('flash');
  }, 900);
  return true;
}

export function getActive() {
  return findTab(activeId);
}

// Show the welcome panel only when no tabs are open (hide, don't destroy, so
// closing the last tab brings it back instead of a blank screen).
function updateWelcome() {
  $('#welcome')?.classList.toggle('hidden', tabs.length > 0);
}

export function addTab(tab) {
  tabs.push(tab);
  tab.el.classList.add('panel');
  $('#panels').append(tab.el);
  updateWelcome();
  activate(tab.id);
  return tab;
}

export function activate(id) {
  const prev = getActive();
  if (prev && prev.id !== id) prev.onHide?.();
  // Strip .active from every panel, not just the tracked one - panels are
  // absolutely stacked, so any stray class makes tabs render on top of
  // each other.
  for (const t of tabs) {
    if (t.id !== id) t.el.classList.remove('active');
  }
  activeId = id;
  const tab = findTab(id);
  if (tab) {
    tab.el.classList.add('active');
    render();
    tab.onShow?.();
  }
}

export function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [tab] = tabs.splice(i, 1);
  tab.onClose?.();
  tab.el.remove();
  if (activeId === id) {
    activeId = null;
    if (tabs.length) activate(tabs[Math.max(0, i - 1)].id);
    else render();
  } else {
    render();
  }
  updateWelcome();
}

export function setTitle(id, title) {
  const tab = findTab(id);
  if (tab) { tab.title = title; render(); }
}

function render() {
  const bar = $('#tabbar');
  bar.replaceChildren(...tabs.map((t) =>
    el('div', {
      class: `tab ${t.kind || ''} ${t.id === activeId ? 'active' : ''}`
             + (t.id === blinkId ? ' blink' : ''),
      onclick: () => activate(t.id),
    },
    el('span', { class: 'tab-title', text: t.title }),
    el('button', {
      class: 'tab-close', title: 'close',
      onclick: (e) => { e.stopPropagation(); closeTab(t.id); },
    }, '×'))));
}
