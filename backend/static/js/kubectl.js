// In-cluster kubectl console (Rancher-style): an xterm terminal wired to
// /ws/kubectl, a shell in TifEra's own container where kubectl runs as
// TifEra's ServiceAccount.

import { el, qsClient, toast, wsUrl } from './util.js';
import { addTab, focusOrBlink } from './tabs.js';
import { termTheme } from './terminal.js';

export function openKubectl() {
  const tabId = 'kubectl';
  if (focusOrBlink(tabId)) return;

  const fontKey = 'tifera.termFontSize';
  let fontSize = parseInt(localStorage.getItem(fontKey) || '14', 10);

  const banner = el('div', { class: 'term-banner' },
    'kubectl console - runs as TifEra\'s ServiceAccount, bounded by its RBAC '
    + '(not cluster-admin). Try: ',
    el('code', { text: 'kubectl get pods -A' }));

  const searchInput = el('input', {
    class: 'term-search', placeholder: 'search (Enter / Shift+Enter)',
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      if (e.shiftKey) search.findPrevious(searchInput.value);
      else search.findNext(searchInput.value);
    },
  });
  const toolbar = el('div', { class: 'term-toolbar' },
    el('span', { class: 'target-label', text: 'kubectl' }),
    el('span', { class: 'muted', text: 'in-cluster' }),
    searchInput,
    el('button', { text: 'A−', onclick: () => setFont(fontSize - 1) }),
    el('button', { text: 'A+', onclick: () => setFont(fontSize + 1) }),
    el('button', { text: 'restart', title: 'restart the console shell',
                   onclick: () => { deliberate = true; try { ws?.close(); } catch { /* */ } reconnect(); } }));

  const termHost = el('div', { class: 'term-host' });
  const root = el('div', { class: 'term-root' }, toolbar, banner, termHost);

  const term = new Terminal({
    scrollback: 10000, fontSize,
    fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
    theme: termTheme(), cursorBlink: true, allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);

  let ws = null;
  let exited = false;
  let deliberate = false;
  const encoder = new TextEncoder();

  function setFont(size) {
    fontSize = Math.min(28, Math.max(8, size));
    localStorage.setItem(fontKey, String(fontSize));
    term.options.fontSize = fontSize;
    fit.fit();
  }
  function statusLine(msg) { term.write(`\r\n\x1b[33m── ${msg} ──\x1b[0m\r\n`); }
  function send(text) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(text)); }
  function sendCtrl(o) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }

  function connect() {
    exited = false;
    const url = `/ws/kubectl?${qsClient()}&cols=${term.cols}&rows=${term.rows}`;
    ws = new WebSocket(wsUrl(url));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        if (m.type === 'exit') { exited = true; statusLine(`console ended: ${m.message}`); }
        else if (m.type === 'error') { exited = true; statusLine(m.error); toast(m.error, 'error'); }
      } else {
        term.write(new Uint8Array(e.data));
      }
    };
    ws.onclose = () => { if (!exited && !deliberate) statusLine('connection closed'); };
  }
  function reconnect() { deliberate = false; term.clear(); connect(); }

  term.onData((d) => { if (!exited) send(d); });
  term.onResize(({ cols, rows }) => sendCtrl({ type: 'resize', cols, rows }));

  const resizeObserver = new ResizeObserver(() => {
    if (root.classList.contains('shown')) fit.fit();
  });

  addTab({
    id: tabId, title: '⎈ kubectl', kind: 'terminal', el: root,
    restore: { kind: 'kubectl' },
    onShow: () => { fit.fit(); term.focus(); },
    onClose: () => {
      deliberate = true;
      sendCtrl({ type: 'close' });
      try { ws?.close(); } catch { /* already closed */ }
      resizeObserver.disconnect();
      term.dispose();
    },
  });

  term.open(termHost);
  fit.fit();
  resizeObserver.observe(termHost);
  connect();
  term.focus();
}
