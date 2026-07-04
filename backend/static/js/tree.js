// Live inventory tree (namespaces → pods → containers): search/filter,
// presence badges, self-pod mark, join-shared-session affordance (feature 1)
// and multi-select bulk actions (feature 7). Fed by watch deltas.

import { $, api, client, el, fmtAge, qsClient, sessionLabel, toast } from './util.js';
import { isSelfPod, on, state } from './state.js';
import { joinSession, openTerminal } from './terminal.js';
import { openLogs } from './logsview.js';
import { openFiles } from './files.js';
import { openPod } from './podpanel.js';

let filter = '';
const collapsed = new Set();
const selected = new Set();   // pod uids selected for bulk actions
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

// -- bulk actions (feature 7) --------------------------------------------

function selectedPods() {
  return [...selected].map((uid) => state.pods.get(uid)).filter(Boolean);
}

function clearSelection() {
  selected.clear();
  render();
}

async function bulkRestart() {
  const pods = selectedPods();
  if (!pods.length) return;
  if (!window.confirm(
      `Restart ${pods.length} pod(s)? Each is deleted and rescheduled by its controller.`)) return;
  if (pods.some((p) => isSelfPod(p.namespace, p.name)) && !window.confirm(
      'One of these is the TifEra console pod - restarting it will terminate your '
      + 'console and every open session. Proceed?')) return;
  let ok = 0; let fail = 0;
  for (const p of pods) {
    try {
      await api(`/api/pods/${p.namespace}/${p.name}?${qsClient()}`, { method: 'DELETE' });
      ok++;
    } catch { fail++; }
  }
  toast(`restarted ${ok} pod(s)${fail ? `, ${fail} failed` : ''}`, fail ? 'warn' : 'info');
  clearSelection();
}

function bulkShells() {
  const pods = selectedPods();
  if (pods.length > 8 && !window.confirm(`Open ${pods.length} shells at once?`)) return;
  for (const p of pods) {
    const c = p.containers[0];
    if (c) openTerminal(p.namespace, p.name, c.name);
  }
  clearSelection();
}

function renderBulkBar() {
  const bar = $('#bulkbar');
  if (!bar) return;
  if (!selected.size) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.replaceChildren(
    el('span', { class: 'bulk-count', text: `${selected.size} selected` }),
    el('button', { class: 'danger', text: '⟳ restart', onclick: bulkRestart }),
    el('button', { text: '⌨ shells', onclick: bulkShells }),
    el('button', { text: 'clear', onclick: clearSelection }));
}

// -- rendering -----------------------------------------------------------

function presenceBadge(target) {
  const sessions = state.presence.get(target) || [];
  if (!sessions.length) return null;
  const names = [...new Set(sessions.map(sessionLabel))].join(', ');
  const starts = sessions.map((s) =>
    `${sessionLabel(s)} since ${new Date(s.startedAt * 1000).toLocaleTimeString()}`
    + (s.shared ? ' · sharing' : '')).join('\n');
  const shared = sessions.some((s) => s.shared);
  return el('span', {
    class: `presence-badge ${shared ? 'shared' : ''}`,
    title: `active shells:\n${starts}`,
    text: `${shared ? '🔗' : ''}${sessions.length}⌨ ${names}`,
  });
}

function joinButton(namespace, pod, container, target) {
  const sessions = state.presence.get(target) || [];
  const s = sessions.find((x) => x.shared && x.clientId !== client.id);
  if (!s) return null;
  return el('button', {
    class: 'join-btn', title: `join ${sessionLabel(s)}'s shared session`,
    onclick: () => joinSession(namespace, pod, container, s.sessionId, s.clientName),
  }, '🔗 join');
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
    joinButton(p.namespace, p.name, c.name, target),
    el('span', { class: 'ctr-actions' },
      el('button', { text: '📜', title: 'logs',
                     onclick: () => openLogs(p.namespace, p.name, [c.name]) }),
      el('button', { text: '📁', title: 'files',
                     onclick: () => openFiles(p.namespace, p.name, c.name) })));
}

function podRow(p) {
  const self = isSelfPod(p.namespace, p.name);
  const check = el('input', {
    type: 'checkbox', class: 'pod-check', title: 'select for bulk actions',
    checked: selected.has(p.uid) || null,
    onclick: (e) => {
      e.stopPropagation();
      if (e.target.checked) selected.add(p.uid); else selected.delete(p.uid);
      renderBulkBar();
    },
  });
  return el('div', { class: 'pod-block' },
    el('div', { class: 'pod-row' },
      check,
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
  // Drop selections for pods that no longer exist.
  for (const uid of [...selected]) if (!state.pods.has(uid)) selected.delete(uid);

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
  renderBulkBar();
}
