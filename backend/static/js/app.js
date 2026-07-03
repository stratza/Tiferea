// TifEra console bootstrap: identity, events connection, sidebar wiring,
// theme, RBAC/trust banners, broadcast-input bar, keyboard shortcuts.

import { $, clientLabel, el, promptNameOnce, setClientName, toast } from './util.js';
import { connect, on, state } from './state.js';
import * as tree from './tree.js';
import { broadcastLine, refreshThemes } from './terminal.js';
import { openMetrics } from './metricsview.js';
import { openTopology } from './topologyview.js';
import { openActions, openEventsFeed, openSnippets } from './toolsview.js';

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
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#filter').focus();
    $('#filter').select();
  }
});

// -- broadcast-input bar ---------------------------------------------------

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

// -- status surfaces -----------------------------------------------------------------

on('hello', () => {
  const id = state.identity;
  $('#identity').textContent =
    `${id.namespace}/${id.pod} @ ${id.node || '?'} · v${id.version} · no auth: network access = full control`;
});

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
  if (!state.connected) toast('events connection lost - reconnecting…', 'warn', 2500);
});

tree.init();
connect();
