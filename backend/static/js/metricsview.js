// Cluster metrics tab - node allocatable vs used and top
// pods by usage with requests/limits indicators.

import { cpuToMillicores, el, fmtBytes, fmtCpu, fmtTime, memToBytes } from './util.js';
import { on, podByName, state } from './state.js';
import { addTab, findTab, focusOrBlink } from './tabs.js';
import { openPod } from './podpanel.js';

const TAB_ID = 'metrics';
let sortBy = 'cpu';

function bar(used, total, fmt) {
  const pct = total ? Math.min(100, Math.round(100 * used / total)) : 0;
  return el('div', { class: 'meter', title: `${fmt(used)} of ${fmt(total)}` },
    el('div', { class: `meter-fill ${pct > 90 ? 'usage-over' : pct > 70 ? 'usage-warn' : ''}`,
                style: `width:${pct}%` }),
    el('span', { class: 'meter-text', text: `${fmt(used)} / ${fmt(total)} (${pct}%)` }));
}

export function openMetrics() {
  if (focusOrBlink(TAB_ID)) return;
  const body = el('div', { class: 'metrics-root' });
  addTab({ id: TAB_ID, title: 'Metrics', kind: 'metrics', el: body, restore: { kind: 'metrics' } });
  on('metrics', () => { if (findTab(TAB_ID)) render(); });
  render();

  function render() {
    const m = state.metrics;
    if (m.available === false) {
      body.replaceChildren(el('div', { class: 'banner', text:
        'metrics.k8s.io is not available - install metrics-server to see CPU/memory usage. '
        + 'TifEra keeps working without it.' }));
      return;
    }
    if (m.available === null) {
      body.replaceChildren(el('div', { class: 'muted', text: 'waiting for first metrics poll…' }));
      return;
    }

    const nodes = el('table', { class: 'fs-table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'node' }), el('th', { text: 'cpu (used / allocatable)' }),
        el('th', { text: 'memory (used / allocatable)' }))),
      el('tbody', {}, ...m.nodes.map((n) => el('tr', {},
        el('td', { class: 'mono', text: n.name }),
        el('td', {}, bar(n.cpu, n.cpuAlloc, fmtCpu)),
        el('td', {}, bar(n.mem, n.memAlloc, fmtBytes))))));

    // Container-level rows: "ns/pod/container".
    const rows = Object.entries(m.pods)
      .filter(([target]) => target.split('/').length === 3)
      .sort((a, b) => (b[1][sortBy === 'cpu' ? 'cpu' : 'mem']) - (a[1][sortBy === 'cpu' ? 'cpu' : 'mem']))
      .slice(0, 100);

    const podsTable = el('table', { class: 'fs-table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'container (ns/pod/name)' }),
        el('th', { text: 'cpu (usage / request / limit)' }),
        el('th', { text: 'memory (usage / request / limit)' }))),
      el('tbody', {}, ...rows.map(([target, usage]) => {
        const [ns, podName, cname] = target.split('/');
        const pod = podByName(ns, podName);
        const spec = pod?.containers.find((c) => c.name === cname) || {};
        const cls = (u, reqQ, limQ, toN) => {
          const lim = toN(limQ), req = toN(reqQ);
          if (lim !== null && u > lim * 0.9) return 'usage-over';
          if (req !== null && u > req) return 'usage-warn';
          return '';
        };
        const tr = el('tr', { class: pod ? 'clickable' : '' },
          el('td', { class: 'mono', text: target }),
          el('td', { class: cls(usage.cpu, spec.requests?.cpu, spec.limits?.cpu, cpuToMillicores),
                     text: `${fmtCpu(usage.cpu)} / ${spec.requests?.cpu || '–'} / ${spec.limits?.cpu || '–'}` }),
          el('td', { class: cls(usage.mem, spec.requests?.memory, spec.limits?.memory, memToBytes),
                     text: `${fmtBytes(usage.mem)} / ${spec.requests?.memory || '–'} / ${spec.limits?.memory || '–'}` }));
        if (pod) tr.addEventListener('click', () => openPod(pod));
        return tr;
      })));

    body.replaceChildren(
      el('div', { class: 'muted', text: m.ts ? `last poll: ${fmtTime(m.ts)}` : '' }),
      el('h3', { text: 'Nodes (allocatable vs used)' }), nodes,
      el('h3', {},
        `Top containers by `,
        el('button', { class: sortBy === 'cpu' ? 'active' : '',
                       text: 'cpu', onclick: () => { sortBy = 'cpu'; render(); } }),
        ' / ',
        el('button', { class: sortBy === 'mem' ? 'active' : '',
                       text: 'memory', onclick: () => { sortBy = 'mem'; render(); } })),
      podsTable);
  }
}
