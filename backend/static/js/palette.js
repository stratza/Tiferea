// Command palette (Ctrl+K): fuzzy-ish search across pods & containers plus
// jump-to-view commands. Keyboard-driven, overlay, closes on Esc / click-out.

import { $, api, el } from './util.js';
import { canOperate, state } from './state.js';
import { openTerminal } from './terminal.js';
import { openPod } from './podpanel.js';
import { openDescribe } from './describe.js';
import { openMetrics } from './metricsview.js';
import { openTopology } from './topologyview.js';
import { openActions, openEventsFeed, openSnippets } from './toolsview.js';
import { openKubectl } from './kubectl.js';
import { openRecordings } from './recordings.js';

const MAX = 40;
let items = [];
let sel = 0;

// Non-pod resource name index (feature 5), refreshed lazily on palette open.
let resources = [];
let resourcesAt = 0;
const KIND_ICON = { Service: '🔀', ConfigMap: '🗄', Secret: '🔑',
                    Deployment: '📦', StatefulSet: '🗃', DaemonSet: '🛰' };

async function refreshResources() {
  if (Date.now() - resourcesAt < 15000 && resources.length) return;
  try {
    resources = (await api('/api/resources')).resources || [];
    resourcesAt = Date.now();
  } catch { /* RBAC or transient - palette still works for pods/views */ }
}

function views() {
  const v = [
    { icon: '📊', title: 'Metrics', sub: 'view', run: openMetrics },
    { icon: '🕸', title: 'Topology', sub: 'view', run: openTopology },
    { icon: '🔔', title: 'Events', sub: 'view', run: openEventsFeed },
  ];
  if (canOperate()) {
    v.unshift({ icon: '⎈', title: 'kubectl', sub: 'in-cluster console', run: openKubectl });
    v.push({ icon: '🧾', title: 'Actions', sub: 'action log', run: openActions },
           { icon: '✂', title: 'Snippets', sub: 'view', run: openSnippets },
           { icon: '🎬', title: 'Recordings', sub: 'session playback', run: openRecordings });
  }
  return v;
}

function build(query) {
  const q = query.trim().toLowerCase();
  const out = [];
  for (const v of views()) {
    if (!q || v.title.toLowerCase().includes(q)) out.push(v);
  }
  if (q) {
    for (const p of state.pods.values()) {
      if (out.length > MAX) break;
      const podHay = `${p.namespace}/${p.name}`.toLowerCase();
      let addedPod = false;
      if (canOperate()) {
        for (const c of p.containers) {
          const hay = `${podHay}/${c.name}`.toLowerCase();
          if (hay.includes(q)) {
            out.push({
              icon: '⌨', title: c.name,
              sub: `shell · ${p.namespace}/${p.name}`,
              run: () => openTerminal(p.namespace, p.name, c.name),
            });
            addedPod = true;
          }
        }
      }
      if (!addedPod && podHay.includes(q)) {
        out.push({
          icon: '📦', title: p.name, sub: `pod · ${p.namespace}`,
          run: () => openPod(p),
        });
      }
    }
    for (const r of resources) {
      if (out.length > MAX) break;
      // Skip helm bookkeeping secrets - pure noise.
      if (r.kind === 'Secret' && r.name.startsWith('sh.helm.release.v1.')) continue;
      if (`${r.namespace}/${r.name}`.toLowerCase().includes(q) ||
          r.kind.toLowerCase().includes(q)) {
        out.push({
          icon: KIND_ICON[r.kind] || '',
          title: r.name, sub: `${r.kind} · ${r.namespace}`,
          run: () => openDescribe(r.kind, r.namespace, r.name),
        });
      }
    }
  }
  return out.slice(0, MAX + 5);
}

function renderList() {
  const list = $('#palette-list');
  list.replaceChildren(...items.map((it, i) =>
    el('div', {
      class: `palette-item ${i === sel ? 'sel' : ''}`,
      onmousemove: () => { if (sel !== i) { sel = i; paint(); } },
      onclick: () => choose(i),
    },
    el('span', { class: 'palette-ico', text: it.icon }),
    el('span', { class: 'palette-title', text: it.title }),
    el('span', { class: 'palette-sub', text: it.sub }))));
  if (!items.length) {
    list.replaceChildren(el('div', { class: 'palette-empty', text: 'no matches' }));
  }
}

function paint() {
  const rows = $('#palette-list').children;
  for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('sel', i === sel);
  rows[sel]?.scrollIntoView({ block: 'nearest' });
}

function refresh() {
  items = build($('#palette-input').value);
  sel = 0;
  renderList();
}

function choose(i) {
  const it = items[i];
  close();
  it?.run?.();
}

export function openPalette() {
  const p = $('#palette');
  p.classList.remove('hidden');
  const input = $('#palette-input');
  input.value = '';
  refresh();
  input.focus();
  refreshResources().then(() => {
    if (!p.classList.contains('hidden')) refresh();
  });
}

export function close() {
  $('#palette').classList.add('hidden');
}

export function initPalette() {
  const overlay = $('#palette');
  const input = $('#palette-input');

  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (overlay.classList.contains('hidden')) openPalette();
      else close();
    }
  });
}
