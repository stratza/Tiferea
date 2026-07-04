// Interactive topology graph (Services → Pods, workloads → Pods,
// optional ConfigMap/Secret mounts) with a small force layout, unhealthy
// paths highlighted and click-through to pod details.

import { api, el, toast } from './util.js';
import { podByName, state } from './state.js';
import { addTab, focusOrBlink } from './tabs.js';
import { openPod } from './podpanel.js';

const TAB_ID = 'topology';
const SVGNS = 'http://www.w3.org/2000/svg';
// Monochrome palette: kinds are distinguished by shade, size and label;
// red is reserved for unhealthy states.
const COLORS = { Pod: '#c2c2c2', Service: '#8e8e8e', Deployment: '#5f5f5f',
                 StatefulSet: '#5f5f5f', DaemonSet: '#5f5f5f', Job: '#5f5f5f',
                 ReplicaSet: '#5f5f5f', ConfigMap: '#a8a8a8', Secret: '#787878' };

function layout(nodes, edges) {
  const pos = new Map();
  const n = nodes.length;
  const R = Math.max(300, n * 12);
  nodes.forEach((node, i) => {
    const a = (2 * Math.PI * i) / n;
    pos.set(node.id, { x: R * Math.cos(a) * (0.4 + Math.random() * 0.6),
                       y: R * Math.sin(a) * (0.4 + Math.random() * 0.6) });
  });
  const adj = edges.map((e) => [e.from, e.to]);
  const iterations = n > 250 ? 60 : 150;
  const k = Math.sqrt((R * R * 4) / Math.max(n, 1));
  for (let it = 0; it < iterations; it++) {
    const disp = new Map(nodes.map((nd) => [nd.id, { x: 0, y: 0 }]));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos.get(nodes[i].id), b = pos.get(nodes[j].id);
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy || 0.01;
        const f = (k * k) / d2;
        dx *= f; dy *= f;
        const da = disp.get(nodes[i].id), db = disp.get(nodes[j].id);
        da.x += dx; da.y += dy; db.x -= dx; db.y -= dy;
      }
    }
    for (const [from, to] of adj) {
      const a = pos.get(from), b = pos.get(to);
      if (!a || !b) continue;
      const dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d * d) / k / d * 0.05;
      const da = disp.get(from), db = disp.get(to);
      da.x -= dx * f; da.y -= dy * f; db.x += dx * f; db.y += dy * f;
    }
    const temp = 30 * (1 - it / iterations) + 2;
    for (const nd of nodes) {
      const p = pos.get(nd.id), d = disp.get(nd.id);
      const len = Math.sqrt(d.x * d.x + d.y * d.y) || 0.01;
      p.x += (d.x / len) * Math.min(len, temp);
      p.y += (d.y / len) * Math.min(len, temp);
    }
  }
  return pos;
}

export function openTopology() {
  if (focusOrBlink(TAB_ID)) return;

  const nsSel = el('select', {});
  const mountsBox = el('input', { type: 'checkbox', title: 'show ConfigMap/Secret mounts' });
  const status = el('span', { class: 'muted' });
  const svgHost = el('div', { class: 'topo-host' });
  let resetView = null;   // assigned by draw(); re-fits the whole graph
  const toolbar = el('div', { class: 'term-toolbar' },
    el('span', { class: 'target-label', text: 'Topology' }), nsSel,
    el('label', {}, mountsBox, 'mounts'),
    el('button', { text: 'refresh refresh', onclick: refresh }),
    el('button', { text: 'fit', title: 'fit graph to view (or double-click the map)',
                   onclick: () => resetView?.() }),
    status,
    el('span', { class: 'muted', text: 'drag to pan · wheel to zoom' }));
  const root = el('div', { class: 'topo-root' }, toolbar, svgHost);

  function fillNamespaces() {
    const namespaces = [...new Set([...state.pods.values()].map((p) => p.namespace))].sort();
    const cur = nsSel.value;
    nsSel.replaceChildren(el('option', { value: '', text: 'all namespaces' }),
      ...namespaces.map((ns) => el('option', { value: ns, text: ns })));
    nsSel.value = cur;
  }
  nsSel.addEventListener('change', refresh);
  mountsBox.addEventListener('change', refresh);

  async function refresh() {
    status.textContent = 'loading…';
    let graph;
    try {
      graph = await api(`/api/topology?namespace=${nsSel.value}&mounts=${mountsBox.checked ? 1 : 0}`);
    } catch (e) {
      status.textContent = '';
      toast(`topology failed: ${e.message}`, 'error');
      return;
    }
    if (graph.nodes.length > 400 && !nsSel.value) {
      status.textContent = `${graph.nodes.length} nodes - pick a namespace to render`;
      svgHost.replaceChildren();
      return;
    }
    status.textContent = `${graph.nodes.length} nodes, ${graph.edges.length} edges`;
    draw(graph);
  }

  function draw({ nodes, edges }) {
    const pos = layout(nodes, edges);
    const xs = [...pos.values()].map((p) => p.x);
    const ys = [...pos.values()].map((p) => p.y);
    const pad = 60;
    const minX = Math.min(...xs, 0) - pad, maxX = Math.max(...xs, 0) + pad;
    const minY = Math.min(...ys, 0) - pad, maxY = Math.max(...ys, 0) + pad;

    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
    svg.classList.add('topo-svg');

    for (const e of edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      const line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      line.setAttribute('class',
        `topo-edge ${e.kind} ${e.healthy === false ? 'unhealthy' : ''}`);
      svg.append(line);
    }
    for (const n of nodes) {
      const p = pos.get(n.id);
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('transform', `translate(${p.x},${p.y})`);
      g.classList.add('topo-node');
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('r', n.kind === 'Pod' ? 10 : n.kind === 'Service' ? 12 : 9);
      c.setAttribute('fill', COLORS[n.kind] || '#888');
      if (n.healthy === false) c.setAttribute('class', 'unhealthy');
      const label = document.createElementNS(SVGNS, 'text');
      label.setAttribute('y', 24);
      label.textContent = `${n.kind === 'Pod' ? '' : n.kind.toLowerCase() + '/'}${n.name}`;
      const title = document.createElementNS(SVGNS, 'title');
      title.textContent = `${n.kind} ${n.namespace}/${n.name}` +
        (n.phase ? ` - ${n.phase}` : '') + (n.healthy === false ? ' (unhealthy)' : '');
      g.append(c, label, title);
      if (n.kind === 'Pod') {
        g.classList.add('clickable');
        g.addEventListener('click', () => {
          const pod = podByName(n.namespace, n.name);
          if (pod) openPod(pod);
          else toast('pod no longer exists', 'warn');
        });
      }
      svg.append(g);
    }

    // Map-style navigation via the viewBox: drag to pan, wheel zooms toward
    // the cursor, double-click or the toolbar button re-fits the graph.
    const fit = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    let vb = { ...fit };
    const applyVb = () =>
      svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    applyVb();
    resetView = () => { vb = { ...fit }; applyVb(); };

    const toWorld = (ev) => {
      const r = svg.getBoundingClientRect();
      return { x: vb.x + ((ev.clientX - r.left) / r.width) * vb.w,
               y: vb.y + ((ev.clientY - r.top) / r.height) * vb.h };
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
      const r = svg.getBoundingClientRect();
      const dx = ((ev.clientX - drag.sx) / r.width) * vb.w;
      const dy = ((ev.clientY - drag.sy) / r.height) * vb.h;
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
      }
    }, true);
    svg.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      resetView();
    });

    svgHost.replaceChildren(svg);
  }

  addTab({ id: TAB_ID, title: 'Topology', kind: 'topology', el: root });
  fillNamespaces();
  refresh();
}
