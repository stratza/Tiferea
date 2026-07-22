// Cluster metrics dashboard: headline cards (cluster totals + governance),
// node meters, and a filterable, risk-sortable container table with
// click-to-expand 60-minute usage charts (from the poller's history).

import { api, cpuToMillicores, el, fmtBytes, fmtCpu, fmtTime, memToBytes } from './util.js';
import { off, on, podByName, state } from './state.js';
import { addTab, focusOrBlink } from './tabs.js';
import { openPod } from './podpanel.js';
import { timeChart } from './chart.js';

const TAB_ID = 'metrics';

const SORTS = {
  cpu:       { label: 'CPU usage',           key: (r) => r.cpu },
  mem:       { label: 'Memory usage',        key: (r) => r.mem },
  cpuLimPct: { label: 'CPU % of limit',      key: (r) => r.cpuLimPct ?? -1 },
  memLimPct: { label: 'Memory % of limit',   key: (r) => r.memLimPct ?? -1 },
  cpuReqPct: { label: 'CPU % of request',    key: (r) => r.cpuReqPct ?? -1 },
  memReqPct: { label: 'Memory % of request', key: (r) => r.memReqPct ?? -1 },
};

function bar(used, total, fmt) {
  const pct = total ? Math.min(100, Math.round(100 * used / total)) : 0;
  return el('div', { class: 'meter', title: `${fmt(used)} of ${fmt(total)}` },
    el('div', { class: `meter-fill ${pct > 90 ? 'usage-over' : pct > 70 ? 'usage-warn' : ''}`,
                style: `width:${pct}%` }),
    el('span', { class: 'meter-text', text: `${fmt(used)} / ${fmt(total)} (${pct}%)` }));
}

function usageCls(u, req, lim) {
  if (lim !== null && u > lim * 0.9) return 'usage-over';
  if (req !== null && u > req) return 'usage-warn';
  return '';
}

export function openMetrics() {
  if (focusOrBlink(TAB_ID)) return;
  let sortBy = 'cpu';
  let filter = '';
  let expanded = null;   // container target whose chart row is open
  let charts = null;     // { cpu, mem } timeChart pair for the expanded row
  let closed = false;

  const filterInput = el('input', { class: 'log-filter', placeholder: 'Filter ns/pod/container…',
    oninput: () => { filter = filterInput.value.trim().toLowerCase(); renderTable(); } });
  const sortSel = el('select', { title: 'Sort containers by',
    onchange: () => { sortBy = sortSel.value; renderTable(); } },
    ...Object.entries(SORTS).map(([v, s]) => el('option', { value: v, text: s.label })));

  const notice = el('div', { class: 'banner hidden' });
  const pollLine = el('div', { class: 'muted' });
  const cardsBox = el('div', { class: 'metric-cards' });
  const nodesBox = el('div');
  const tableBox = el('div');
  const content = el('div', { class: 'hidden' },
    pollLine,
    cardsBox,
    el('h3', { text: 'Nodes (allocatable vs used)' }), nodesBox,
    el('h3', { text: 'Containers' }),
    el('div', { class: 'metrics-tablebar' }, filterInput, sortSel,
      el('span', { class: 'muted', text: 'Click a row for its 60-minute history' })),
    tableBox);
  const body = el('div', { class: 'metrics-root' }, notice, content);

  // -- headline cards ------------------------------------------------------

  function numCard(label, value, tone = '', hint = '') {
    return el('div', { class: 'mcard', title: hint || null },
      el('div', { class: `mcard-num ${tone ? `tone-${tone}` : ''}`, text: String(value) }),
      el('div', { class: 'mcard-label', text: label }));
  }

  function meterCard(label, used, total, fmt) {
    const pct = total ? Math.min(100, Math.round(100 * used / total)) : 0;
    return el('div', { class: 'mcard', title: `${fmt(used)} of ${fmt(total)} allocatable` },
      el('div', { class: `mcard-num ${pct > 90 ? 'tone-bad' : pct > 70 ? 'tone-warn' : ''}`,
                  text: `${pct}%` }),
      el('div', { class: 'meter' },
        el('div', { class: `meter-fill ${pct > 90 ? 'usage-over' : pct > 70 ? 'usage-warn' : ''}`,
                    style: `width:${pct}%` })),
      el('div', { class: 'mcard-sub', text: `${fmt(used)} / ${fmt(total)}` }),
      el('div', { class: 'mcard-label', text: label }));
  }

  function renderCards(m) {
    const sum = (k) => m.nodes.reduce((a, n) => a + (n[k] || 0), 0);
    const pods = [...state.pods.values()];
    let containers = 0;
    let noReq = 0;
    let noLim = 0;
    for (const p of pods) {
      for (const c of p.containers) {
        containers++;
        if (!c.requests?.cpu || !c.requests?.memory) noReq++;
        if (!c.limits?.cpu || !c.limits?.memory) noLim++;
      }
    }
    cardsBox.replaceChildren(
      meterCard('Cluster CPU', sum('cpu'), sum('cpuAlloc'), fmtCpu),
      meterCard('Cluster memory', sum('mem'), sum('memAlloc'), fmtBytes),
      numCard('Pods', pods.length),
      numCard('Containers', containers),
      numCard('No requests', noReq, noReq ? 'warn' : 'muted',
              'Containers without CPU + memory requests set'),
      numCard('No limits', noLim, noLim ? 'warn' : 'muted',
              'Containers without CPU + memory limits set'));
  }

  // -- nodes -----------------------------------------------------------------

  function renderNodes(m) {
    nodesBox.replaceChildren(el('table', { class: 'fs-table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Node' }), el('th', { text: 'CPU (used / allocatable)' }),
        el('th', { text: 'Memory (used / allocatable)' }))),
      el('tbody', {}, ...m.nodes.map((n) => el('tr', {},
        el('td', { class: 'mono', text: n.name }),
        el('td', {}, bar(n.cpu, n.cpuAlloc, fmtCpu)),
        el('td', {}, bar(n.mem, n.memAlloc, fmtBytes)))))));
  }

  // -- container table -------------------------------------------------------

  function buildRows(m) {
    const rows = [];
    for (const [target, u] of Object.entries(m.pods)) {
      const parts = target.split('/');
      if (parts.length !== 3) continue;   // container-level entries only
      if (filter && !target.toLowerCase().includes(filter)) continue;
      const [ns, podName, cname] = parts;
      const pod = podByName(ns, podName);
      const spec = pod?.containers.find((c) => c.name === cname) || {};
      const cpuReq = cpuToMillicores(spec.requests?.cpu);
      const cpuLim = cpuToMillicores(spec.limits?.cpu);
      const memReq = memToBytes(spec.requests?.memory);
      const memLim = memToBytes(spec.limits?.memory);
      rows.push({
        target, pod,
        cpu: u.cpu, mem: u.mem,
        cpuReq, cpuLim, memReq, memLim,
        cpuReqQ: spec.requests?.cpu, cpuLimQ: spec.limits?.cpu,
        memReqQ: spec.requests?.memory, memLimQ: spec.limits?.memory,
        cpuReqPct: cpuReq ? (u.cpu / cpuReq) * 100 : null,
        cpuLimPct: cpuLim ? (u.cpu / cpuLim) * 100 : null,
        memReqPct: memReq ? (u.mem / memReq) * 100 : null,
        memLimPct: memLim ? (u.mem / memLim) * 100 : null,
        noReq: !spec.requests?.cpu || !spec.requests?.memory,
        noLim: !spec.limits?.cpu || !spec.limits?.memory,
        risk: (cpuLim !== null && u.cpu > cpuLim * 0.9)
           || (memLim !== null && u.mem > memLim * 0.9),
      });
    }
    rows.sort((a, b) => SORTS[sortBy].key(b) - SORTS[sortBy].key(a));
    return rows.slice(0, 100);
  }

  function usageCell(u, req, lim, reqQ, limQ, limPct, fmt) {
    return el('td', { class: usageCls(u, req, lim) },
      `${fmt(u)} `,
      el('span', { class: 'pct', text: `/ ${reqQ || '–'} / ${limQ || '–'}` }),
      limPct !== null
        ? el('span', { class: `pct ${limPct > 90 ? 'usage-over' : ''}`,
                       text: ` · ${Math.round(limPct)}% of limit` })
        : null);
  }

  function destroyCharts() {
    if (charts) {
      charts.cpu.destroy();
      charts.mem.destroy();
      charts = null;
    }
  }

  async function loadCharts(r) {
    let resp;
    try {
      resp = await api(`/api/metrics/history?target=${encodeURIComponent(r.target)}`);
    } catch { return; }   // metrics may be unavailable
    if (closed || expanded !== r.target || !charts) return;
    const ref = (value, label, tone) => (value !== null ? { label, value, tone } : null);
    charts.cpu.set(resp.samples.map((s) => [s[0], s[1]]),
      [ref(r.cpuReq, 'request', 'warn'), ref(r.cpuLim, 'limit', 'bad')].filter(Boolean));
    charts.mem.set(resp.samples.map((s) => [s[0], s[2]]),
      [ref(r.memReq, 'request', 'warn'), ref(r.memLim, 'limit', 'bad')].filter(Boolean));
  }

  function renderTable() {
    const m = state.metrics;
    if (m.available !== true) return;
    destroyCharts();
    const rows = buildRows(m);
    const trs = [];
    for (const r of rows) {
      trs.push(el('tr', { class: `clickable ${r.risk ? 'row-risk' : ''}`,
        onclick: () => { expanded = expanded === r.target ? null : r.target; renderTable(); } },
        el('td', { class: 'mono' }, r.target,
          r.noReq ? el('span', { class: 'risk-badge', text: 'no req',
                                 title: 'No CPU/memory requests set' }) : null,
          r.noLim ? el('span', { class: 'risk-badge', text: 'no lim',
                                 title: 'No CPU/memory limits set' }) : null),
        usageCell(r.cpu, r.cpuReq, r.cpuLim, r.cpuReqQ, r.cpuLimQ, r.cpuLimPct, fmtCpu),
        usageCell(r.mem, r.memReq, r.memLim, r.memReqQ, r.memLimQ, r.memLimPct, fmtBytes),
        el('td', { class: 'fs-actions' }, r.pod
          ? el('button', { text: '📦', title: 'Pod details',
                           onclick: (e) => { e.stopPropagation(); openPod(r.pod); } })
          : null)));
      if (expanded === r.target) {
        charts = {
          cpu: timeChart({ fmtY: fmtCpu, height: 150 }),
          mem: timeChart({ fmtY: fmtBytes, height: 150 }),
        };
        trs.push(el('tr', { class: 'chart-row' }, el('td', { colspan: '4' },
          el('div', { class: 'chart-pair' },
            el('div', {}, el('div', { class: 'chart-title', text: 'CPU (last 60 min)' }), charts.cpu.el),
            el('div', {}, el('div', { class: 'chart-title', text: 'Memory (last 60 min)' }), charts.mem.el)))));
        loadCharts(r);
      }
    }
    tableBox.replaceChildren(rows.length
      ? el('table', { class: 'fs-table' },
          el('thead', {}, el('tr', {},
            el('th', { text: 'Container (ns/pod/name)' }),
            el('th', { text: 'CPU (usage / request / limit)' }),
            el('th', { text: 'Memory (usage / request / limit)' }),
            el('th', { text: '' }))),
          el('tbody', {}, ...trs))
      : el('div', { class: 'muted pad', text: 'No containers match this filter.' }));
  }

  // -- top-level render ------------------------------------------------------

  function render() {
    if (closed) return;
    const m = state.metrics;
    if (m.available === false) {
      notice.textContent =
        'metrics.k8s.io is not available - install metrics-server to see CPU/memory usage. '
        + 'TifEra keeps working without it.';
      notice.classList.remove('hidden');
      content.classList.add('hidden');
      return;
    }
    if (m.available !== true) {
      notice.textContent = 'Waiting for the first metrics poll…';
      notice.classList.remove('hidden');
      content.classList.add('hidden');
      return;
    }
    notice.classList.add('hidden');
    content.classList.remove('hidden');
    pollLine.textContent = m.ts ? `Last poll: ${fmtTime(m.ts)}` : '';
    renderCards(m);
    renderNodes(m);
    renderTable();
  }

  const onMetrics = () => { if (!closed) render(); };
  addTab({ id: TAB_ID, title: '📊 Metrics', kind: 'metrics', el: body,
           restore: { kind: 'metrics' },
           onClose: () => { closed = true; off('metrics', onMetrics); destroyCharts(); } });
  on('metrics', onMetrics);
  render();
}
