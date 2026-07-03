// Live inventory tree (namespaces → pods → containers) with search/
// filter, presence badges and the TifEra self-pod mark
//. Fed by watch deltas - no manual reload.

import { $, el, fmtAge, sessionLabel } from './util.js';
import { isSelfPod, on, state } from './state.js';
import { openTerminal } from './terminal.js';
import { openLogs } from './logsview.js';
import { openFiles } from './files.js';
import { openPod } from './podpanel.js';

let filter = '';
const collapsed = new Set();
let pending = false;

export function setFilter(value) {
  filter = value.trim().toLowerCase();
  render();
}

export function init() {
  on('pods', schedule);
  on('presence', schedule);
  on('hello', schedule);
}

function schedule() {
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; render(); }, 150);
}

function podMatches(p) {
  if (!filter) return true;
  const labelStr = Object.entries(p.labels || {}).map(([k, v]) => `${k}=${v}`).join(' ');
  const hay = `${p.namespace} ${p.name} ${p.node} ${labelStr} ` +
              p.containers.map((c) => c.name).join(' ');
  return filter.split(/\s+/).every((term) => hay.toLowerCase().includes(term));
}

function phaseClass(p) {
  const r = (p.reason || p.phase || '').toLowerCase();
  if (r.includes('crash') || r.includes('error') || r.includes('backoff') ||
      p.phase === 'Failed') return 'st-bad';
  if (r === 'terminating' || p.phase === 'Succeeded') return 'st-done';
  if (p.phase === 'Running' && p.containers.every((c) => c.ready)) return 'st-ok';
  return 'st-warn';
}

function presenceBadge(target) {
  const sessions = state.presence.get(target) || [];
  if (!sessions.length) return null;
  const names = [...new Set(sessions.map(sessionLabel))].join(', ');
  const starts = sessions.map((s) =>
    `${sessionLabel(s)} since ${new Date(s.startedAt * 1000).toLocaleTimeString()}`).join('\n');
  return el('span', { class: 'presence-badge',
                      title: `active shells:\n${starts}` , text: `${sessions.length}⌨ ${names}` });
}

function containerRow(p, c) {
  const target = `${p.namespace}/${p.name}/${c.name}`;
  return el('div', { class: 'ctr-row' },
    el('span', { class: `dot state-${c.state}`, title: c.state }),
    el('button', { class: 'ctr-name', title: `open shell in ${c.name}`,
                   text: c.name,
                   onclick: () => openTerminal(p.namespace, p.name, c.name) }),
    c.restarts ? el('span', { class: 'restarts', text: `${c.restarts}↻` }) : null,
    presenceBadge(target),
    el('span', { class: 'ctr-actions' },
      el('button', { text: '📜', title: 'logs',
                     onclick: () => openLogs(p.namespace, p.name, [c.name]) }),
      el('button', { text: '📁', title: 'files',
                     onclick: () => openFiles(p.namespace, p.name, c.name) })));
}

function podRow(p) {
  const self = isSelfPod(p.namespace, p.name);
  return el('div', { class: 'pod-block' },
    el('div', { class: 'pod-row' },
      el('span', { class: `dot ${phaseClass(p)}`, title: p.reason || p.phase }),
      el('button', { class: 'pod-name', text: p.name, title: 'pod details',
                     onclick: () => openPod(p) }),
      self ? el('span', { class: 'self-badge', title:
        'this is the TifEra console pod', text: 'console' }) : null,
      el('span', { class: 'muted pod-meta',
                   text: `${p.reason || p.phase} · ${fmtAge(p.createdAt)}`
                         + (p.restarts ? ` · ${p.restarts}↻` : '') })),
    ...p.containers.map((c) => containerRow(p, c)));
}

function render() {
  const treeEl = $('#tree');
  const byNs = new Map();
  for (const p of state.pods.values()) {
    if (!podMatches(p)) continue;
    if (!byNs.has(p.namespace)) byNs.set(p.namespace, []);
    byNs.get(p.namespace).push(p);
  }
  const sections = [...byNs.keys()].sort().map((ns) => {
    const pods = byNs.get(ns).sort((a, b) => a.name.localeCompare(b.name));
    const isCollapsed = collapsed.has(ns) && !filter;
    return el('div', { class: 'ns-block' },
      el('button', {
        class: 'ns-header',
        onclick: () => {
          if (collapsed.has(ns)) collapsed.delete(ns); else collapsed.add(ns);
          render();
        },
      }, `${isCollapsed ? '▸' : '▾'} ${ns} `, el('span', { class: 'muted', text: `(${pods.length})` })),
      isCollapsed ? null : el('div', { class: 'ns-body' }, ...pods.map(podRow)));
  });
  treeEl.replaceChildren(...(sections.length ? sections
    : [el('div', { class: 'muted pad', text: state.pods.size
        ? 'nothing matches the filter'
        : 'no pods visible (waiting for the watch stream…)' })]));
}
