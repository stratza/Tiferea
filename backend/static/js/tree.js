// Inventory navigator: a modern, filterable list of namespaces → pods →
// containers. Segmented status filter (All / Running / Issues) and a
// "hide finished" toggle strip completed jobs, helm hooks and evicted pods.
// Containers render as chips; presence, join-shared, bulk-select all live here.

import { $, api, client, el, fmtAge, qsClient, sessionLabel, toast } from './util.js';
import { isSelfPod, on, state } from './state.js';
import { joinSession, openTerminal } from './terminal.js';
import { openLogs } from './logsview.js';
import { openFiles } from './files.js';
import { openPod } from './podpanel.js';

let filter = '';
let statusFilter = localStorage.getItem('tifera.statusFilter') || 'all';
let hideFinished = localStorage.getItem('tifera.hideFinished') !== '0';  // default on
const collapsed = new Set();
const selected = new Set();
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

// -- pod classification --------------------------------------------------

function isRunning(p) {
  return p.phase === 'Running' && p.containers.every((c) => c.ready);
}

function isIssue(p) {
  const r = (p.reason || p.phase || '').toLowerCase();
  if (p.phase === 'Failed' || r.includes('crash') || r.includes('error') ||
      r.includes('backoff')) return true;
  return p.phase === 'Running' && !p.containers.every((c) => c.ready);
}

// Finished / inaccessible: completed jobs, helm hooks (Succeeded), evictions -
// nothing you can shell into or act on.
function isFinished(p) {
  const r = (p.reason || '').toLowerCase();
  if (p.phase === 'Succeeded') return true;
  if (r === 'evicted' || r === 'completed') return true;
  const running = p.containers.some((c) => c.state === 'running');
  return !running && p.containers.length > 0
    && p.containers.every((c) => c.state === 'Completed');
}

function podMatches(p) {
  if (!filter) return true;
  const labelStr = Object.entries(p.labels || {}).map(([k, v]) => `${k}=${v}`).join(' ');
  const hay = `${p.namespace} ${p.name} ${p.node} ${labelStr} ` +
              p.containers.map((c) => c.name).join(' ');
  return filter.split(/\s+/).every((term) => hay.toLowerCase().includes(term));
}

function visible(p) {
  if (!podMatches(p)) return false;
  if (statusFilter === 'running') return isRunning(p);
  if (statusFilter === 'issues') return isIssue(p);
  if (hideFinished && isFinished(p)) return false;
  return true;
}

function phaseClass(p) {
  const r = (p.reason || p.phase || '').toLowerCase();
  if (r.includes('crash') || r.includes('error') || r.includes('backoff') ||
      p.phase === 'Failed') return 'st-bad';
  if (r === 'terminating' || p.phase === 'Succeeded' || r === 'completed') return 'st-done';
  if (isRunning(p)) return 'st-ok';
  return 'st-warn';
}

// -- bulk actions --------------------------------------------------------

function selectedPods() {
  return [...selected].map((uid) => state.pods.get(uid)).filter(Boolean);
}
function clearSelection() { selected.clear(); render(); }

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
    try { await api(`/api/pods/${p.namespace}/${p.name}?${qsClient()}`, { method: 'DELETE' }); ok++; }
    catch { fail++; }
  }
  toast(`restarted ${ok} pod(s)${fail ? `, ${fail} failed` : ''}`, fail ? 'warn' : 'info');
  clearSelection();
}

function bulkShells() {
  const pods = selectedPods();
  if (pods.length > 8 && !window.confirm(`Open ${pods.length} shells at once?`)) return;
  for (const p of pods) { const c = p.containers[0]; if (c) openTerminal(p.namespace, p.name, c.name); }
  clearSelection();
}

function renderBulkBar() {
  const bar = $('#bulkbar');
  if (!bar) return;
  if (!selected.size) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.replaceChildren(
    el('span', { class: 'bulk-count', text: `${selected.size} selected` }),
    el('button', { class: 'danger', text: 'refresh restart', onclick: bulkRestart }),
    el('button', { text: 'shells', onclick: bulkShells }),
    el('button', { text: 'clear', onclick: clearSelection }));
}

// -- controls ------------------------------------------------------------

function setStatus(v) {
  statusFilter = v;
  localStorage.setItem('tifera.statusFilter', v);
  render();
}
function toggleFinished() {
  hideFinished = !hideFinished;
  localStorage.setItem('tifera.hideFinished', hideFinished ? '1' : '0');
  render();
}

function renderControls(counts) {
  const seg = (v, label, n) => el('button', {
    class: `seg-btn ${statusFilter === v ? 'active' : ''}`,
    onclick: () => setStatus(v),
  }, label, n != null ? el('span', { class: 'seg-count', text: String(n) }) : null);

  $('#inv-controls').replaceChildren(
    el('div', { class: 'seg' },
      seg('all', 'All', counts.total),
      seg('running', 'Running', counts.running),
      seg('issues', 'Issues', counts.issues)),
    el('button', {
      class: `inv-toggle ${hideFinished ? 'active' : ''}`,
      title: 'hide completed jobs, helm hooks and evicted pods',
      onclick: toggleFinished,
    }, hideFinished ? '◉ hiding finished' : '○ show finished',
    counts.finished ? el('span', { class: 'seg-count', text: String(counts.finished) }) : null));
}

// -- rendering -----------------------------------------------------------

function containerChip(p, c) {
  const target = `${p.namespace}/${p.name}/${c.name}`;
  const sessions = state.presence.get(target) || [];
  const shared = sessions.find((x) => x.shared && x.clientId !== client.id);
  const actions = el('span', { class: 'chip-actions' },
    el('button', { title: 'logs', onclick: (e) => { e.stopPropagation(); openLogs(p.namespace, p.name, [c.name]); } }, '📜'),
    el('button', { title: 'files', onclick: (e) => { e.stopPropagation(); openFiles(p.namespace, p.name, c.name); } }, '📁'),
    shared ? el('button', { class: 'chip-join', title: `join ${sessionLabel(shared)}'s shared session`,
                            onclick: (e) => { e.stopPropagation(); joinSession(p.namespace, p.name, c.name, shared.sessionId, shared.clientName); } }, 'join') : null);
  return el('button', {
    class: `ctr-chip state-${c.state}`,
    title: `${c.name} · ${c.state}${c.ready ? '' : ' (not ready)'} - click to open a shell`,
    onclick: () => openTerminal(p.namespace, p.name, c.name),
  },
  el('span', { class: `dot state-${c.state}` }),
  el('span', { class: 'chip-name', text: c.name }),
  c.restarts ? el('span', { class: 'chip-meta', text: `${c.restarts}↻` }) : null,
  sessions.length ? el('span', { class: `chip-badge ${shared ? 'shared' : ''}`,
                                 text: `${sessions.length} sh` }) : null,
  actions);
}

function podCard(p) {
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
  return el('div', { class: 'pod-card' },
    el('div', { class: 'pod-line' },
      check,
      el('span', { class: `dot ${phaseClass(p)}`, title: p.reason || p.phase }),
      el('button', { class: 'pod-name', text: p.name, title: 'pod details',
                     onclick: () => openPod(p) }),
      self ? el('span', { class: 'self-badge', title: 'the TifEra console pod', text: 'console' }) : null,
      el('span', { class: 'pod-meta muted',
                   text: `${p.reason || p.phase} · ${fmtAge(p.createdAt)}`
                         + (p.restarts ? ` · ${p.restarts}↻` : '') })),
    el('div', { class: 'ctr-chips' }, ...p.containers.map((c) => containerChip(p, c))));
}

function render() {
  for (const uid of [...selected]) if (!state.pods.has(uid)) selected.delete(uid);

  const all = [...state.pods.values()];
  const counts = {
    total: all.filter(podMatches).length,
    running: all.filter((p) => podMatches(p) && isRunning(p)).length,
    issues: all.filter((p) => podMatches(p) && isIssue(p)).length,
    finished: all.filter((p) => podMatches(p) && isFinished(p)).length,
  };
  renderControls(counts);
  $('#inv-summary').textContent = `${all.length} pods`;

  const byNs = new Map();
  let shown = 0;
  for (const p of all) {
    if (!visible(p)) continue;
    shown++;
    if (!byNs.has(p.namespace)) byNs.set(p.namespace, []);
    byNs.get(p.namespace).push(p);
  }

  const sections = [...byNs.keys()].sort().map((ns) => {
    const pods = byNs.get(ns).sort((a, b) => a.name.localeCompare(b.name));
    const isCollapsed = collapsed.has(ns) && !filter;
    const issues = pods.filter(isIssue).length;
    return el('div', { class: 'ns-group' },
      el('button', {
        class: 'ns-head',
        onclick: () => {
          if (collapsed.has(ns)) collapsed.delete(ns); else collapsed.add(ns);
          render();
        },
      },
      el('span', { class: 'ns-caret', text: isCollapsed ? '▸' : '▾' }),
      el('span', { class: 'ns-name', text: ns }),
      el('span', { class: 'ns-count', text: String(pods.length) }),
      issues ? el('span', { class: 'ns-issue dot st-bad', title: `${issues} with issues` }) : null),
      isCollapsed ? null : el('div', { class: 'ns-body' }, ...pods.map(podCard)));
  });

  $('#tree').replaceChildren(...(sections.length ? sections
    : [el('div', { class: 'muted pad', text: state.pods.size
        ? (shown === 0 && (statusFilter !== 'all' || hideFinished)
            ? 'nothing matches this filter - try All / show finished'
            : 'nothing matches the filter')
        : 'no pods visible (waiting for the watch stream…)' })]));
  renderBulkBar();
}
