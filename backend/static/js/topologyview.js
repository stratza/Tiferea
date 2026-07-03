// Interactive topology graph (Services → Pods, workloads → Pods,
// optional ConfigMap/Secret mounts) with a small force layout, unhealthy
// paths highlighted and click-through to pod details.

import { api, el, toast } from './util.js';
import { podByName, state } from './state.js';
import { addTab, focusOrBlink } from './tabs.js';
import { openPod } from './podpanel.js';

const TAB_ID = 'topology';
const SVGNS = 'http://www.w3.org/2000/svg';
const COLORS = { Pod: '#9ece6a', Service: '#7aa2f7', Deployment: '#bb9af7',
                 StatefulSet: '#bb9af7', DaemonSet: '#bb9af7', Job: '#bb9af7',
                 ReplicaSet: '#bb9af7', ConfigMap: '#565f89', Secret: '#e0af68' };

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
  const toolbar = el('div', { class: 'term-toolbar' },
    el('span', { class: 'target-label', text: 'Topology' }), nsSel,
    el('label', {}, mountsBox, 'mounts'),
    el('button', { text: '⟳ refresh', onclick: refresh }), status);
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

    // Wheel zoom via viewBox.
    svg.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const [x, y, w, h] = svg.getAttribute('viewBox').split(' ').map(Number);
      const f = ev.deltaY > 0 ? 1.15 : 0.87;
      const nw = w * f, nh = h * f;
      svg.setAttribute('viewBox',
        `${x + (w - nw) / 2} ${y + (h - nh) / 2} ${nw} ${nh}`);
    }, { passive: false });

    svgHost.replaceChildren(svg);
  }

  addTab({ id: TAB_ID, title: '🕸 Topology', kind: 'topology', el: root });
  fillNamespaces();
  refresh();
}
