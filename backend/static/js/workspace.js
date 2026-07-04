// Workspace persistence (feature 6): when enabled in Settings, remember which
// tabs are open and reopen them on reload. Terminals/kubectl come back as
// fresh sessions (the old PTYs are gone), views come back as-is.

import { onTabsChange, restoreList } from './tabs.js';
import { podByName } from './state.js';
import { openTerminal } from './terminal.js';
import { openFiles } from './files.js';
import { openLogs } from './logsview.js';
import { openPod } from './podpanel.js';
import { openKubectl } from './kubectl.js';
import { openMetrics } from './metricsview.js';
import { openTopology } from './topologyview.js';
import { openActions, openEventsFeed, openSnippets } from './toolsview.js';
import { openRecordings } from './recordings.js';
import { openDescribe } from './describe.js';

const KEY = 'tifera.workspace';

export function persistEnabled() {
  return localStorage.getItem('tifera.restoreTabs') === '1';
}

function save() {
  if (!persistEnabled()) { localStorage.removeItem(KEY); return; }
  try { localStorage.setItem(KEY, JSON.stringify(restoreList())); } catch { /* quota */ }
}

function dispatch(d) {
  switch (d.kind) {
    case 'terminal': return openTerminal(d.ns, d.pod, d.ctr);
    case 'files': return openFiles(d.ns, d.pod, d.ctr);
    case 'logs': return openLogs(d.ns, d.pod, d.ctrs || []);
    case 'pod': { const p = podByName(d.ns, d.name); if (p) openPod(p); return; }
    case 'kubectl': return openKubectl();
    case 'metrics': return openMetrics();
    case 'topology': return openTopology();
    case 'events': return openEventsFeed();
    case 'actions': return openActions();
    case 'snippets': return openSnippets();
    case 'recordings': return openRecordings();
    case 'describe': return openDescribe(d.k, d.ns, d.name);
    default: return undefined;
  }
}

let restored = false;

// Called once after the first pod snapshot so pod-based tabs can resolve.
export function restoreWorkspace() {
  if (restored || !persistEnabled()) { restored = true; return; }
  restored = true;
  let list = [];
  try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { list = []; }
  for (const d of list) {
    try { dispatch(d); } catch { /* skip a broken entry */ }
  }
}

export function initWorkspace() {
  onTabsChange(save);
}

// Turning persistence off should forget the stored set immediately.
export function setPersist(on) {
  localStorage.setItem('tifera.restoreTabs', on ? '1' : '0');
  if (on) save(); else localStorage.removeItem(KEY);
}
