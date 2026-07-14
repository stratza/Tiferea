// Topology - three levels of disclosure instead of one hairball:
//   1. Overview: namespace cards with health counts (any cluster size).
//   2. Namespace graph: deterministic layered layout, Services -> Workloads,
//      pods rolled up into workloads with ready/total badges.
//   3. Focus: click a service/workload to isolate its neighborhood and see
//      the pods behind it (click a pod for details).
// Plus search, an "Only problems" filter, hover highlighting, pan/zoom.

import { api, el, toast } from './util.js';
import { podByName } from './state.js';
import { addTab, focusOrBlink } from './tabs.js';
import { openPod } from './podpanel.js';
import { openDescribe } from './describe.js';

const TAB_ID = 'topology';
const SVGNS = 'http://www.w3.org/2000/svg';

const ROW = 26;          // vertical spacing inside a column
const COLW = 300;        // horizontal spacing between columns
const LABEL_MAX = 30;

const RADIUS = { Service: 7, Pod: 4.5, ConfigMap: 6, Secret: 6 };
const radius = (kind) => RADIUS[kind] ?? 8;   // workloads: 8
const isMount = (n) => n.kind === 'ConfigMap' || n.kind === 'Secret';
const trunc = (s) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s);

export function openTopology() {
  if (focusOrBlink(TAB_ID)) return;

  let overview = null;     // [{name, services, workloads, pods, unhealthy…}]
  let graphData = null;    // {namespace, nodes, edges} for the selected ns
  let focusId = null;
  let problemsOnly = false;
  let query = '';
  let resetView = null;    // assigned by drawGraph(); re-fits the view

  const nsSel = el('select', { title: 'Namespace (empty = overview)' });
  const searchInput = el('input', { class: 'log-filter', placeholder: 'Search…',
    oninput: () => { query = searchInput.value.trim().toLowerCase(); renderLevel(); } });
  const problemsBtn = el('button', { title: 'Show only unhealthy things and their neighbors',
    onclick: () => { problemsOnly = !problemsOnly; problemsBtn.classList.toggle('active', problemsOnly); renderLevel(); } },
    '⚠ Only problems');
  const mountsBox = el('input', { type: 'checkbox', title: 'Show ConfigMap/Secret mounts' });
  const focusChip = el('span', { class: 'focus-chip hidden' });
  const status = el('span', { class: 'muted' });
  const hint = el('span', { class: 'muted' });
  const host = el('div', { class: 'topo-host' });

  const toolbar = el('div', { class: 'term-toolbar' },
    el('span', { class: 'target-label', text: 'Topology' }), nsSel,
    searchInput, problemsBtn,
    el('label', { title: 'Show ConfigMap/Secret mounts' }, mountsBox, 'Mounts'),
    el('button', { text: '🔄 Refresh', onclick: refresh }),
    el('button', { text: '⤢ Fit', title: 'Fit graph to view (or double-click the map)',
                   onclick: () => resetView?.() }),
    focusChip, status, hint);
  const root = el('div', { class: 'topo-root' }, toolbar, host);

  nsSel.addEventListener('change', () => { focusId = null; refresh(); });
  mountsBox.addEventListener('change', () => { if (nsSel.value) refresh(); });

  function fillNamespaces() {
    const cur = nsSel.value;
    nsSel.replaceChildren(el('option', { value: '', text: 'Overview' }),
      ...(overview || []).map((s) => el('option', { value: s.name, text: s.name })));
    nsSel.value = cur;
  }

  async function refresh() {
    status.textContent = 'Loading…';
    try {
      if (!nsSel.value) {
        overview = (await api('/api/topology')).namespaces;
        fillNamespaces();
      } else {
        graphData = await api(
          `/api/topology?namespace=${encodeURIComponent(nsSel.value)}&mounts=${mountsBox.checked ? 1 : 0}`);
        if (focusId && !graphData.nodes.some((n) => n.id === focusId)) focusId = null;
      }
    } catch (e) {
      status.textContent = '';
      toast(`topology failed: ${e.message}`, 'error');
      return;
    }
    renderLevel();
  }

  function renderLevel() {
    if (nsSel.value && graphData) renderGraph();
    else if (overview) renderOverview();
  }

  // -- level 1: namespace overview cards ------------------------------------

  function renderOverview() {
    resetView = null;
    focusChip.classList.add('hidden');
    hint.textContent = 'Click a namespace to see its graph';
    const issues = (s) => s.unhealthyPods + s.unhealthyServices;
    let cards = overview;
    if (query) cards = cards.filter((s) => s.name.toLowerCase().includes(query));
    if (problemsOnly) cards = cards.filter((s) => issues(s) > 0);
    cards = [...cards].sort((a, b) => issues(b) - issues(a) || a.name.localeCompare(b.name));
    const total = overview.reduce((a, s) => a + issues(s), 0);
    status.textContent = `${overview.length} namespaces · ${total} issue${total === 1 ? '' : 's'}`;
    host.replaceChildren(cards.length
      ? el('div', { class: 'topo-cards' }, ...cards.map((s) => {
          const n = issues(s);
          return el('button', { class: `topo-card ${n ? 'bad' : ''}`,
            onclick: () => { nsSel.value = s.name; focusId = null; refresh(); } },
            el('div', { class: 'topo-card-name', text: s.name }),
            el('div', { class: 'topo-card-counts',
                        text: `${s.services} svc · ${s.workloads} workloads · ${s.pods} pods` }),
            el('div', { class: `topo-card-issues ${n ? 'bad' : 'ok'}`,
                        text: n ? `${n} issue${n > 1 ? 's' : ''}` : 'healthy' }));
        }))
      : el('div', { class: 'muted pad', text: 'No namespaces match.' }));
  }

  // -- level 2/3: layered namespace graph ------------------------------------

  function adjacency(edges) {
    const adj = new Map();
    const link = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
    for (const e of edges) { link(e.from, e.to); link(e.to, e.from); }
    return adj;
  }

  // Nodes that survive the focus / problems / search filters (each keeps the
  // matching seeds plus their direct neighbors).
  function visibleGraph() {
    const adj = adjacency(graphData.edges);
    let keep = new Set(graphData.nodes.map((n) => n.id));
    const restrict = (pred) => {
      const seeds = graphData.nodes.filter((n) => keep.has(n.id) && pred(n));
      const ok = new Set();
      for (const s of seeds) {
        ok.add(s.id);
        for (const nb of adj.get(s.id) || []) ok.add(nb);
      }
      keep = new Set([...keep].filter((id) => ok.has(id)));
    };
    if (focusId) restrict((n) => n.id === focusId);
    if (problemsOnly) restrict((n) => n.healthy === false);
    if (query) restrict((n) => `${n.kind}/${n.name}`.toLowerCase().includes(query));
    return {
      nodes: graphData.nodes.filter((n) => keep.has(n.id)),
      edges: graphData.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    };
  }

  function nodeLabel(n) {
    if (n.kind === 'Service') return trunc(n.name);
    if (isMount(n)) return trunc(`${n.kind.toLowerCase()}/${n.name}`);
    if (n.kind === 'PodEntry') return trunc(n.name);
    return `${trunc(`${n.kind.toLowerCase()}/${n.name}`)} · ${n.ready}/${n.total}`;
  }

  function nodeTitle(n) {
    if (n.kind === 'Service') {
      return `Service ${n.namespace}/${n.name}`
        + (n.clusterIp ? ` · ${n.clusterIp}` : '')
        + (n.healthy === false ? ' - no ready endpoints' : '');
    }
    if (isMount(n)) return `${n.kind} ${n.namespace}/${n.name} - click to view YAML`;
    if (n.kind === 'PodEntry') return `Pod ${n.name} - ${n.phase}${n.healthy ? '' : ' (unhealthy)'}`;
    return `${n.kind} ${n.namespace}/${n.name} · ${n.ready}/${n.total} pods ready`
      + (n.healthy === false ? ' (unhealthy)' : '');
  }

  function drawGraph() {
    const vis = visibleGraph();
    const ns = graphData.namespace;
    const showPods = !!focusId;

    const services = vis.nodes.filter((n) => n.kind === 'Service');
    const mounts = vis.nodes.filter(isMount);
    const workloads = vis.nodes.filter((n) => n.kind !== 'Service' && !isMount(n))
      .sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
    const wIdx = new Map(workloads.map((n, i) => [n.id, i]));
    const adj = adjacency(vis.edges);
    // Barycenter ordering: neighbors of adjacent workloads end up close, so
    // edges stay short; unconnected nodes sink to the bottom.
    const bary = (id) => {
      const idxs = [...(adj.get(id) || [])].map((x) => wIdx.get(x)).filter((x) => x !== undefined);
      return idxs.length ? idxs.reduce((a, b) => a + b, 0) / idxs.length : Infinity;
    };
    services.sort((a, b) => bary(a.id) - bary(b.id) || a.name.localeCompare(b.name));
    mounts.sort((a, b) => bary(a.id) - bary(b.id) || a.name.localeCompare(b.name));

    // Pods appear as a third column only in focus mode.
    const podNodes = [];
    const podEdges = [];
    if (showPods) {
      for (const w of workloads) {
        for (const p of (w.pods || [])) {
          const id = `pod:${ns}/${p.name}`;
          podNodes.push({ id, kind: 'PodEntry', name: p.name, phase: p.phase,
                          healthy: p.healthy, namespace: ns });
          podEdges.push({ from: w.id, to: id, kind: 'owns', healthy: p.healthy });
        }
      }
    }

    const columns = [
      { x: 0, title: `Services (${services.length})`, items: services, side: 'left' },
      { x: COLW, title: `Workloads (${workloads.length})`, items: workloads, side: 'right' },
    ];
    let nextX = COLW * 2;
    if (showPods) {
      columns.push({ x: nextX, title: `Pods (${podNodes.length})`, items: podNodes, side: 'right' });
      nextX += COLW * 0.95;
    }
    if (mounts.length) {
      columns.push({ x: nextX, title: `Mounts (${mounts.length})`, items: mounts, side: 'right' });
    }

    const maxRows = Math.max(1, ...columns.map((c) => c.items.length));
    const pos = new Map();
    for (const col of columns) {
      const off = ((maxRows - col.items.length) / 2) * ROW;   // center each column
      col.items.forEach((n, i) => pos.set(n.id, { x: col.x, y: off + i * ROW, side: col.side }));
    }

    const allEdges = [...vis.edges, ...podEdges];
    const hoverAdj = adjacency(allEdges);

    // status + focus chip
    const unhealthy = [...services, ...workloads].filter((n) => n.healthy === false).length;
    status.textContent =
      `${services.length} services · ${workloads.length} workloads · ${unhealthy} unhealthy`;
    hint.textContent = 'Click a node to focus · drag to pan · wheel to zoom';
    if (focusId) {
      const f = graphData.nodes.find((n) => n.id === focusId);
      focusChip.replaceChildren(`⌖ ${f ? f.name : focusId}`,
        el('button', { class: 'focus-chip-x', title: 'Clear focus',
                       onclick: () => { focusId = null; renderGraph(); } }, '×'));
      focusChip.classList.remove('hidden');
    } else {
      focusChip.classList.add('hidden');
    }

    if (!vis.nodes.length) {
      resetView = null;
      host.replaceChildren(el('div', { class: 'muted pad',
        text: graphData.nodes.length ? 'Nothing matches the current filters.'
                                     : 'No services or workloads in this namespace.' }));
      return;
    }

    const minX = -230;
    const maxX = columns[columns.length - 1].x + 240;
    const minY = -52;
    const maxY = maxRows * ROW + 24;

    const svg = document.createElementNS(SVGNS, 'svg');
    svg.classList.add('topo-svg');

    for (const col of columns) {
      const head = document.createElementNS(SVGNS, 'text');
      head.setAttribute('x', col.x);
      head.setAttribute('y', -28);
      head.setAttribute('text-anchor', 'middle');
      head.classList.add('topo-colhead');
      head.textContent = col.title;
      svg.append(head);
    }

    const edgeEls = [];
    for (const e of allEdges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      const fromKind = e.kind === 'owns' ? 8 : radius('Service');
      const x1 = a.x + fromKind + 3;
      const x2 = b.x - 12;
      const bend = Math.max(40, (x2 - x1) * 0.45);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d',
        `M ${x1} ${a.y} C ${x1 + bend} ${a.y}, ${x2 - bend} ${b.y}, ${x2} ${b.y}`);
      path.setAttribute('class',
        `topo-edge ${e.kind} ${e.healthy === false ? 'unhealthy' : ''}`);
      const title = document.createElementNS(SVGNS, 'title');
      title.textContent = e.kind === 'routes'
        ? `${e.ready}/${e.total} endpoints ready` : e.kind;
      path.append(title);
      svg.append(path);
      const els = [path];
      if (e.kind === 'routes' && e.healthy === false) {
        const t = document.createElementNS(SVGNS, 'text');
        t.setAttribute('x', (x1 + x2) / 2);
        t.setAttribute('y', (a.y + b.y) / 2 - 4);
        t.setAttribute('text-anchor', 'middle');
        t.classList.add('topo-edgelabel');
        t.textContent = `${e.ready}/${e.total}`;
        svg.append(t);
        els.push(t);
      }
      edgeEls.push({ els, from: e.from, to: e.to });
    }

    const nodeEls = new Map();
    for (const n of [...services, ...workloads, ...podNodes, ...mounts]) {
      const p = pos.get(n.id);
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('transform', `translate(${p.x},${p.y})`);
      g.classList.add('topo-node');
      if (n.id === focusId) g.classList.add('focused');
      const r = radius(n.kind === 'PodEntry' ? 'Pod' : n.kind);
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('r', r);
      if (n.healthy === false) c.setAttribute('class', 'unhealthy');
      const label = document.createElementNS(SVGNS, 'text');
      label.setAttribute('x', p.side === 'left' ? -(r + 6) : r + 6);
      label.setAttribute('y', 3);
      label.setAttribute('text-anchor', p.side === 'left' ? 'end' : 'start');
      label.textContent = nodeLabel(n);
      const title = document.createElementNS(SVGNS, 'title');
      title.textContent = nodeTitle(n);
      g.append(c, label, title);

      g.classList.add('clickable');
      if (n.kind === 'PodEntry') {
        g.addEventListener('click', () => {
          const pod = podByName(ns, n.name);
          if (pod) openPod(pod);
          else toast('pod no longer exists', 'warn');
        });
      } else if (isMount(n)) {
        g.addEventListener('click', () => openDescribe(n.kind, ns, n.name));
      } else {
        g.addEventListener('click', () => {
          focusId = focusId === n.id ? null : n.id;
          renderGraph();
        });
      }
      g.addEventListener('pointerenter', () => setHover(n.id));
      g.addEventListener('pointerleave', () => setHover(null));
      svg.append(g);
      nodeEls.set(n.id, g);
    }

    function setHover(id) {
      svg.classList.toggle('hovering', !!id);
      const rel = id ? new Set([id, ...(hoverAdj.get(id) || [])]) : new Set();
      nodeEls.forEach((gEl, nid) => gEl.classList.toggle('hl', rel.has(nid)));
      for (const e of edgeEls) {
        const on = id && (e.from === id || e.to === id);
        for (const elx of e.els) elx.classList.toggle('hl', !!on);
      }
    }

    // Map-style navigation via the viewBox: drag to pan, wheel zooms toward
    // the cursor, double-click or the toolbar button re-fits the graph.
    const fit = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    let vb = { ...fit };
    const applyVb = () => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    applyVb();
    resetView = () => { vb = { ...fit }; applyVb(); };

    const toWorld = (ev) => {
      const rct = svg.getBoundingClientRect();
      return { x: vb.x + ((ev.clientX - rct.left) / rct.width) * vb.w,
               y: vb.y + ((ev.clientY - rct.top) / rct.height) * vb.h };
    };

    svg.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = toWorld(ev);   // keep the point under the cursor fixed
      const f = Math.min(Math.max(ev.deltaY > 0 ? 1.15 : 0.87, 0.2), 5);
      const w = Math.min(Math.max(vb.w * f, fit.w / 40), fit.w * 8);
      const scale = w / vb.w;
      vb = { x: p.x - (p.x - vb.x) * scale, y: p.y - (p.y - vb.y) * scale,
             w, h: vb.h * scale };
      applyVb();
    }, { passive: false });

    let drag = null;
    let suppressClick = false;
    svg.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      drag = { sx: ev.clientX, sy: ev.clientY, vx: vb.x, vy: vb.y, moved: false };
      svg.setPointerCapture(ev.pointerId);
      svg.classList.add('dragging');
    });
    svg.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const rct = svg.getBoundingClientRect();
      const dx = ((ev.clientX - drag.sx) / rct.width) * vb.w;
      const dy = ((ev.clientY - drag.sy) / rct.height) * vb.h;
      if (Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) > 3) {
        drag.moved = true;
      }
      vb.x = drag.vx - dx;
      vb.y = drag.vy - dy;
      applyVb();
    });
    const endDrag = () => {
      if (drag?.moved) suppressClick = true;   // a pan is not a node click
      drag = null;
      svg.classList.remove('dragging');
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
    svg.addEventListener('click', (ev) => {
      if (suppressClick) {
        suppressClick = false;
        ev.stopPropagation();
        return;
      }
      // clicking empty space clears the focus
      if (ev.target === svg && focusId) { focusId = null; renderGraph(); }
    }, true);
    svg.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      resetView();
    });

    host.replaceChildren(svg);
  }

  function renderGraph() { drawGraph(); }

  addTab({ id: TAB_ID, title: '🕸 Topology', kind: 'topology', el: root,
           restore: { kind: 'topology' } });
  refresh();
}
