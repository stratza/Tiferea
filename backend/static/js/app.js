// TifEra console bootstrap: identity, events connection, sidebar wiring,
// theme, RBAC/trust banners, broadcast bar, status bar, command palette.

import { $, clientLabel, el, promptNameOnce, setClientName, toast } from './util.js';
import { connect, on, state } from './state.js';
import * as tree from './tree.js';
import { broadcastLine, refreshThemes } from './terminal.js';
import { openMetrics } from './metricsview.js';
import { openTopology } from './topologyview.js';
import { openActions, openEventsFeed, openSnippets } from './toolsview.js';
import { initDashboard } from './dashboard.js';
import { initPalette, openPalette } from './palette.js';

// -- theme -------------------------------------------------------------

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  localStorage.setItem('tifera.theme', theme);
  refreshThemes();
}
applyTheme(localStorage.getItem('tifera.theme') || 'dark');
$('#theme-btn').addEventListener('click', () =>
  applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'));

// -- client identity ---------------------------------------------------

function renderClientBadge() {
  $('#client-name-btn').textContent = clientLabel();
}
promptNameOnce();
renderClientBadge();
$('#client-name-btn').addEventListener('click', () => {
  const n = window.prompt('display name (visible to other operators):',
                          clientLabel());
  if (n !== null) {
    setClientName(n);
    renderClientBadge();
    toast('name updated - applies to sessions you open from now on', 'info', 4000);
  }
});

// -- sidebar wiring ---------------------------------------------------------------

const OPENERS = { metrics: openMetrics, topology: openTopology,
                  events: openEventsFeed, actions: openActions,
                  snippets: openSnippets };
for (const btn of document.querySelectorAll('#global-tabs [data-open]')) {
  btn.addEventListener('click', () => OPENERS[btn.dataset.open]());
}

$('#filter').addEventListener('input', (e) => tree.setFilter(e.target.value));
$('#search-trigger').addEventListener('click', openPalette);

// -- broadcast bar ---------------------------------------------------------

$('#bcast-toggle').addEventListener('click', () => {
  const bar = $('#bcast-bar');
  bar.classList.toggle('hidden');
  if (!bar.classList.contains('hidden')) $('#bcast-input').focus();
});
$('#bcast-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value) {
    broadcastLine(e.target.value);
    e.target.value = '';
  }
});

// -- status bar ----------------------------------------------------------------------

function podBad(p) {
  const r = (p.reason || p.phase || '').toLowerCase();
  if (p.phase === 'Failed' || r.includes('crash') || r.includes('error') ||
      r.includes('backoff')) return true;
  if (p.phase === 'Running' && !p.containers.every((c) => c.ready)) return true;
  return false;
}

function updateCounts() {
  const pods = [...state.pods.values()];
  const running = pods.filter(
    (p) => p.phase === 'Running' && p.containers.every((c) => c.ready)).length;
  const issues = pods.filter(podBad).length;
  $('#sb-counts').replaceChildren(
    el('span', { class: 'sb-metric', title: 'pods' }, el('span', { class: 'sb-dot ok' }), `${running} running`),
    el('span', { class: `sb-metric ${issues ? 'warn' : ''}`, title: 'pods with issues' },
       el('span', { class: `sb-dot ${issues ? 'bad' : 'muted'}` }), `${issues} issues`),
    el('span', { class: 'sb-metric', title: 'total pods' }, `${pods.length} pods`));
  let sessions = 0;
  for (const list of state.presence.values()) sessions += list.length;
  $('#sb-sessions').textContent = sessions ? `⌨ ${sessions} session${sessions > 1 ? 's' : ''}` : '';
}

on('hello', () => {
  const id = state.identity;
  $('#sb-cluster').textContent = `${id.namespace}/${id.pod} @ ${id.node || '?'}`;
  $('#sb-version').textContent = `v${id.version}`;
  updateCounts();
});
on('pods', updateCounts);
on('presence', updateCounts);

function updateConn() {
  const ok = state.connected;
  $('#sb-conn').classList.toggle('online', ok);
  $('#sb-conn').classList.toggle('offline', !ok);
  $('#sb-conn-text').textContent = ok ? 'connected' : 'reconnecting…';
}

on('rbac', () => {
  const banner = $('#rbac-banner');
  if (!state.rbac || !state.rbac.length) {
    banner.classList.add('hidden');
    return;
  }
  banner.textContent =
    `⚠ ServiceAccount is missing permissions: ${state.rbac.join(', ')} - `
    + 'some features will fail. Fix the ClusterRole in deploy/tifera.yaml.';
  banner.classList.remove('hidden');
});

on('metrics', () => {
  $('#metrics-banner').classList.toggle('hidden', state.metrics.available !== false);
});

on('conn', () => {
  document.body.classList.toggle('disconnected', !state.connected);
  updateConn();
  if (!state.connected) toast('events connection lost - reconnecting…', 'warn', 2500);
});

// -- boot ------------------------------------------------------------------------------

updateConn();
tree.init();
initDashboard();
initPalette();
connect();
