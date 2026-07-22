// Pod detail panel: containers with live usage + usage-history charts,
// requests/limits comparison, opt-in disk usage, events
//, YAML view and restart quick action.

import { api, cpuToMillicores, el, fmtAge, fmtBytes, fmtCpu, memToBytes,
         qsClient, toast } from './util.js';
import { canOperate, isSelfPod, off, on, state } from './state.js';
import { addTab, focusOrBlink } from './tabs.js';
import { openTerminal } from './terminal.js';
import { openFiles } from './files.js';
import { openLogs } from './logsview.js';
import { timeChart } from './chart.js';

function usageCell(usage, requestQ, limitQ, fmt, toNumber) {
  const cell = el('span');
  if (usage === null || usage === undefined) {
    cell.textContent = '–';
    return cell;
  }
  const req = toNumber(requestQ);
  const lim = toNumber(limitQ);
  let cls = 'usage-ok';
  if (lim !== null && usage > lim * 0.9) cls = 'usage-over';
  else if (req !== null && usage > req) cls = 'usage-warn';
  else if (req !== null && usage < req * 0.2) cls = 'usage-under';
  cell.append(
    el('span', { class: cls, text: fmt(usage) }),
    el('span', { class: 'muted',
                 text: ` / ${requestQ || '–'} / ${limitQ || '–'}` }));
  cell.title = 'Usage / request / limit';
  return cell;
}

export function openPod(pod) {
  const tabId = `pod-${pod.uid}`;
  if (focusOrBlink(tabId)) return;
  const { namespace, name } = pod;
  const self = isSelfPod(namespace, name);

  const header = el('div', { class: 'pod-header' });
  const containersBox = el('div');
  const dfBox = el('div', { class: 'df-box' });
  const eventsBox = el('div', { class: 'events-box' });
  const yamlBox = el('pre', { class: 'yaml-box hidden' });
  const sparks = new Map();  // container -> {cpu: chart, mem: chart, spec}

  const root = el('div', { class: 'pod-root' }, header,
    el('h3', { text: 'Containers' }), containersBox,
    el('h3', { text: 'Disk usage (sampled via df, opt-in)' }), dfBox,
    el('h3', { text: 'Events' }), eventsBox,
    el('h3', { text: 'Pod YAML' }),
    el('button', { text: 'Load YAML', onclick: async (e) => {
      try {
        yamlBox.textContent = await api(`/api/pods/${namespace}/${name}/yaml`);
        yamlBox.classList.remove('hidden');
        e.target.remove();
      } catch (err) { toast(`YAML failed: ${err.message}`, 'error'); }
    } }),
    yamlBox);

  function current() {
    return state.pods.get(pod.uid)
      || [...state.pods.values()].find((p) => p.namespace === namespace && p.name === name)
      || null;
  }

  async function restart() {
    // Extra, explicit confirmation before killing our own console.
    const q1 = `Restart pod ${namespace}/${name} (delete it and let its controller reschedule)?`;
    if (!window.confirm(q1)) return;
    if (self && !window.confirm(
        'This is the TifEra pod itself - deleting it will TERMINATE YOUR CONSOLE '
        + 'and every open session. Really proceed?')) return;
    try {
      await api(`/api/pods/${namespace}/${name}?${qsClient()}`, { method: 'DELETE' });
      toast(`pod ${name} deleted - controller will reschedule it`, 'info');
    } catch (e) {
      toast(`restart failed: ${e.message}`, 'error');
    }
  }

  function renderHeader(p) {
    header.replaceChildren(
      el('span', { class: 'pod-title', text: `${namespace}/${name}` }),
      self ? el('span', { class: 'self-badge', text: 'this console' }) : null,
      el('span', { class: `phase phase-${(p?.reason || p?.phase || 'Unknown').toLowerCase()}`,
                   text: p ? (p.reason || p.phase) : 'deleted' }),
      el('span', { class: 'muted', text: p ? ` node ${p.node} · age ${fmtAge(p.createdAt)} · ${p.restarts} restarts` : '' }),
      canOperate() ? el('button', { text: '🔄 Restart pod', class: 'danger', onclick: restart }) : null,
      canOperate() ? el('button', { text: '📚 Merged logs', onclick: () => {
        const cp = current();
        if (cp) openLogs(namespace, name, cp.containers.map((c) => c.name));
      } }) : null);
  }

  function destroySparks() {
    for (const s of sparks.values()) { s.cpu.destroy(); s.mem.destroy(); }
    sparks.clear();
  }

  function renderContainers(p) {
    if (!p) { containersBox.textContent = 'pod no longer exists'; return; }
    destroySparks();
    const rows = p.containers.map((c) => {
      const cpuChart = timeChart({ fmtY: fmtCpu, height: 44, compact: true });
      const memChart = timeChart({ fmtY: fmtBytes, height: 44, compact: true });
      sparks.set(c.name, { cpu: cpuChart, mem: memChart, spec: c });
      const usage = state.metrics.pods[`${namespace}/${name}/${c.name}`] || {};
      return el('tr', {},
        el('td', {}, el('span', { class: `dot state-${c.state}` }), ` ${c.name}`),
        el('td', { class: 'muted mono', text: c.image }),
        el('td', { text: `${c.state}${c.ready ? '' : ' (not ready)'} · ${c.restarts}↻` }),
        el('td', {}, usageCell(usage.cpu, c.requests?.cpu, c.limits?.cpu, fmtCpu, cpuToMillicores)),
        el('td', {}, usageCell(usage.mem, c.requests?.memory, c.limits?.memory, fmtBytes, memToBytes)),
        el('td', {}, el('div', { class: 'chart-pair compact' }, cpuChart.el, memChart.el)),
        el('td', { class: 'fs-actions' }, ...(canOperate() ? [
          el('button', { text: '⌨', title: 'Shell', onclick: () => openTerminal(namespace, name, c.name) }),
          el('button', { text: '📜', title: 'Logs', onclick: () => openLogs(namespace, name, [c.name]) }),
          el('button', { text: '⏮', title: 'Previous logs', onclick: () => openLogs(namespace, name, [c.name], { previous: true }) }),
          el('button', { text: '📁', title: 'Files', onclick: () => openFiles(namespace, name, c.name) }),
          el('button', { text: '💽', title: 'Disk usage', onclick: () => loadDf(c.name) }),
        ] : [el('span', { class: 'muted', text: 'Read-only' })])));
    });
    containersBox.replaceChildren(el('table', { class: 'fs-table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Container' }), el('th', { text: 'Image' }),
        el('th', { text: 'State' }), el('th', { text: 'CPU' }),
        el('th', { text: 'Memory' }), el('th', { text: 'Last 60 min (CPU, mem)' }),
        el('th', { text: '' }))),
      el('tbody', {}, ...rows)));
    drawSparks();
  }

  async function drawSparks() {
    const ref = (value, label, tone) => (value !== null ? { label, value, tone } : null);
    for (const [cname, s] of sparks) {
      try {
        const r = await api(`/api/metrics/history?target=${encodeURIComponent(`${namespace}/${name}/${cname}`)}`);
        if (!sparks.has(cname) || sparks.get(cname) !== s) continue;  // panel re-rendered meanwhile
        s.cpu.set(r.samples.map((x) => [x[0], x[1]]),
          [ref(cpuToMillicores(s.spec.requests?.cpu), 'request', 'warn'),
           ref(cpuToMillicores(s.spec.limits?.cpu), 'limit', 'bad')].filter(Boolean));
        s.mem.set(r.samples.map((x) => [x[0], x[2]]),
          [ref(memToBytes(s.spec.requests?.memory), 'request', 'warn'),
           ref(memToBytes(s.spec.limits?.memory), 'limit', 'bad')].filter(Boolean));
      } catch { /* metrics may be unavailable */ }
    }
  }

  async function loadDf(cname) {
    dfBox.textContent = `sampling df in ${cname}…`;
    try {
      const r = await api(`/api/fs/${namespace}/${name}/${cname}/df`);
      dfBox.replaceChildren(el('table', { class: 'fs-table' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'Filesystem' }), el('th', { text: 'Mount' }),
          el('th', { text: 'Used' }), el('th', { text: 'Size' }), el('th', { text: '%' }))),
        el('tbody', {}, ...r.filesystems.map((f) => el('tr', {},
          el('td', { class: 'mono', text: f.filesystem }),
          el('td', { class: 'mono', text: f.mount }),
          el('td', { text: fmtBytes(f.usedKb * 1024) }),
          el('td', { text: fmtBytes(f.sizeKb * 1024) }),
          el('td', { text: f.sizeKb ? `${Math.round(100 * f.usedKb / f.sizeKb)}%` : '–' }))))));
    } catch (e) {
      dfBox.textContent = `df failed: ${e.message}`;
    }
  }

  async function loadEvents() {
    try {
      const r = await api(`/api/events?namespace=${namespace}&name=${name}`);
      eventsBox.replaceChildren(
        el('button', { text: '🔄 Refresh events', onclick: loadEvents }),
        ...r.events.slice(0, 50).map((ev) => el('div', {
          class: `event-line ${ev.type === 'Warning' ? 'lvl-warn' : ''}`,
          text: `${ev.time ? new Date(ev.time).toLocaleTimeString() : ''} [${ev.type}] ${ev.reason}: ${ev.message} (×${ev.count})`,
        })));
      if (r.events.length === 0) eventsBox.append(el('div', { class: 'muted', text: 'no events' }));
    } catch (e) {
      eventsBox.textContent = `events failed: ${e.message}`;
    }
  }

  const rerender = () => { const p = current(); renderHeader(p); renderContainers(p); };
  const onPods = (m) => {
    if (!m.pod || (m.pod.namespace === namespace && m.pod.name === name)) rerender();
  };
  const onMetrics = () => rerender();
  on('pods', onPods);
  on('metrics', onMetrics);

  addTab({ id: tabId, title: `📦 ${name}`, kind: 'pod', el: root,
           restore: { kind: 'pod', ns: namespace, name },
           onClose: () => { off('pods', onPods); off('metrics', onMetrics); destroySparks(); } });
  rerender();
  loadEvents();
}
