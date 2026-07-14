// Live log viewer - follow/pause, regex filter, level highlighting,
// previous-instance logs, download, and a merged multi-container view.

import { el, qsClient, toast, wsUrl } from './util.js';
import { addTab, focusOrBlink } from './tabs.js';

const MAX_LINES = 20000;   // ring buffer
const MAX_DOM = 4000;
// CSI sequences (colors, cursor) and OSC sequences (titles).
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*\x07?|\x1b./g;

const LEVELS = [
  [/\b(FATAL|PANIC|ERROR|ERR|Traceback|Exception)\b/i, 'lvl-error'],
  [/\b(WARN|WARNING)\b/i, 'lvl-warn'],
  [/\b(DEBUG|TRACE)\b/i, 'lvl-debug'],
];

function levelClass(text) {
  for (const [re, cls] of LEVELS) if (re.test(text)) return cls;
  return '';
}

export function openLogs(namespace, pod, containers, opts = {}) {
  const tabId = `logs-${namespace}/${pod}/${[...containers].sort().join('+')}`;
  if (focusOrBlink(tabId)) return;
  const merged = containers.length > 1;
  const lines = [];   // {text, container, cls}
  const sockets = [];
  let paused = false;
  let follow = true;
  let filterRe = null;

  const output = el('div', { class: 'log-output' });

  const tailSel = el('select', {},
    ...[200, 500, 2000, 10000].map((n) =>
      el('option', { value: n, text: `Tail ${n}`, selected: n === 500 || null })));
  const prevBox = el('input', { type: 'checkbox', checked: opts.previous || null });
  const tsBox = el('input', { type: 'checkbox' });
  const followBox = el('input', { type: 'checkbox', checked: true });
  followBox.addEventListener('change', () => { follow = followBox.checked; });
  const pauseBtn = el('button', { text: '⏸ Pause', onclick: () => {
    paused = !paused;
    pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
    if (!paused) render();
  } });
  const filterInput = el('input', { placeholder: 'Filter (regex)', class: 'log-filter',
    oninput: () => {
      try {
        filterRe = filterInput.value ? new RegExp(filterInput.value, 'i') : null;
        filterInput.classList.remove('invalid');
      } catch { filterInput.classList.add('invalid'); return; }
      render(true);
    } });

  const downloads = containers.map((c) =>
    el('a', { class: 'button', text: `⬇ ${merged ? c : 'Download'}`,
              href: `/api/logs/${namespace}/${pod}/${c}?tailLines=0&previous=0` }));

  const toolbar = el('div', { class: 'term-toolbar' },
    el('span', { class: 'target-label', text: `${namespace}/${pod}${merged ? '' : '/' + containers[0]}` }),
    pauseBtn,
    el('label', {}, followBox, 'Follow'),
    el('label', { title: 'Previous instance' }, prevBox, 'Previous'),
    el('label', {}, tsBox, 'Timestamps'),
    tailSel, filterInput,
    el('button', { text: '🔄 Reopen', onclick: reopen }),
    ...downloads);

  const root = el('div', { class: 'log-root' }, toolbar, output);

  function lineNode(l) {
    const div = el('div', { class: `log-line ${l.cls}` });
    if (merged) div.append(el('span', { class: `log-src src-${l.srcIdx % 6}`, text: `[${l.container}] ` }));
    div.append(l.text);
    return div;
  }

  function passes(l) {
    return !filterRe || filterRe.test(l.text) || (merged && filterRe.test(l.container));
  }

  function render(full = false) {
    if (paused) return;
    if (full) {
      const visible = lines.filter(passes).slice(-MAX_DOM);
      output.replaceChildren(...visible.map(lineNode));
    }
    if (follow) output.scrollTop = output.scrollHeight;
  }

  function push(container, srcIdx, text) {
    text = text.replace(ANSI_RE, '');   // raw ANSI codes garble the view
    const l = { text, container, srcIdx, cls: levelClass(text) };
    lines.push(l);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    if (paused || !passes(l)) return;
    output.append(lineNode(l));
    while (output.childElementCount > MAX_DOM) output.firstElementChild.remove();
    if (follow) output.scrollTop = output.scrollHeight;
  }

  function closeAll() {
    for (const s of sockets) { s.deliberate = true; try { s.ws.close(); } catch { /* gone */ } }
    sockets.length = 0;
  }

  function open(container, srcIdx) {
    const url = `/ws/logs/${namespace}/${pod}/${container}` +
      `?tailLines=${tailSel.value}&previous=${prevBox.checked ? 1 : 0}` +
      `&timestamps=${tsBox.checked ? 1 : 0}&${qsClient()}`;
    const ws = new WebSocket(wsUrl(url));
    ws.binaryType = 'arraybuffer';
    const entry = { ws, deliberate: false };
    sockets.push(entry);
    const decoder = new TextDecoder();
    let rest = '';
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        if (m.type === 'error') toast(`${container}: ${m.error}`, 'error');
        else if (m.type === 'eof') push(container, srcIdx, '── end of log stream ──');
        return;
      }
      rest += decoder.decode(e.data, { stream: true });
      const parts = rest.split('\n');
      rest = parts.pop();
      for (const p of parts) push(container, srcIdx, p);
    };
    ws.onclose = () => {
      if (!entry.deliberate) push(container, srcIdx, '── stream closed ──');
    };
  }

  function reopen() {
    closeAll();
    lines.length = 0;
    output.replaceChildren();
    containers.forEach((c, i) => open(c, i));
  }

  addTab({
    id: tabId,
    title: `📜 ${merged ? pod : containers[0]}`,
    kind: 'logs',
    el: root,
    restore: { kind: 'logs', ns: namespace, pod, ctrs: containers },
    onClose: closeAll,
  });
  reopen();
}
