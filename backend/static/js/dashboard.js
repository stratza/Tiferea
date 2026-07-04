// Live cluster dashboard shown on the welcome screen: stat cards that update
// from the same /ws/events stream that feeds the tree.

import { $, el } from './util.js';
import { on, state } from './state.js';

function podBad(p) {
  const r = (p.reason || p.phase || '').toLowerCase();
  if (p.phase === 'Failed' || r.includes('crash') || r.includes('error') ||
      r.includes('backoff')) return true;
  if (p.phase === 'Running' && !p.containers.every((c) => c.ready)) return true;
  return false;
}

function compute() {
  const pods = [...state.pods.values()];
  const namespaces = new Set(pods.map((p) => p.namespace));
  const nodes = new Set(pods.map((p) => p.node).filter(Boolean));
  const running = pods.filter(
    (p) => p.phase === 'Running' && p.containers.every((c) => c.ready)).length;
  const issues = pods.filter(podBad).length;
  let sessions = 0;
  for (const list of state.presence.values()) sessions += list.length;
  return {
    Namespaces: { v: namespaces.size },
    Pods: { v: pods.length },
    Running: { v: running, tone: 'ok' },
    Issues: { v: issues, tone: issues ? 'bad' : 'muted' },
    Nodes: { v: state.metrics.nodes?.length || nodes.size },
    Sessions: { v: sessions, tone: sessions ? 'accent' : 'muted' },
  };
}

// Count-up so a card that jumps from - to a number feels alive.
function animateTo(node, target) {
  const from = parseInt(node.dataset.v || '0', 10);
  if (from === target) { node.textContent = String(target); return; }
  node.dataset.v = String(target);
  const steps = 14;
  let i = 0;
  const tick = () => {
    i++;
    const val = Math.round(from + (target - from) * (i / steps));
    node.textContent = String(val);
    if (i < steps) requestAnimationFrame(tick);
    else node.textContent = String(target);
  };
  requestAnimationFrame(tick);
}

let cards = null;

function render() {
  const host = $('#dash-stats');
  if (!host) return;
  const stats = compute();
  if (!cards) {
    cards = {};
    host.replaceChildren(...Object.entries(stats).map(([label, s]) => {
      const num = el('div', { class: `dash-num tone-${s.tone || 'fg'}`, 'data-v': '0' });
      cards[label] = num;
      return el('div', { class: 'dash-card stat' },
        num, el('div', { class: 'dash-label', text: label }));
    }));
  }
  for (const [label, s] of Object.entries(stats)) {
    const num = cards[label];
    if (!num) continue;
    num.className = `dash-num tone-${s.tone || 'fg'}`;
    animateTo(num, s.v);
  }
}

export function initDashboard() {
  render();
  on('pods', render);
  on('metrics', render);
  on('presence', render);
  on('hello', render);
}
