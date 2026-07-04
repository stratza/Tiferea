// Interactive shell tabs (xterm.js), with reconnect-on-drop,
// mutual same-container warnings, broadcast input and
// ephemeral debug container fallback.

import { $, api, client, el, qsClient, sessionLabel, toast, wsUrl } from './util.js';
import { on } from './state.js';
import { addTab, closeTab, focusOrBlink, getActive } from './tabs.js';

let seq = 0;
const handles = new Map(); // tabId -> handle

export function termTheme() {
  const dark = document.body.dataset.theme !== 'light';
  return dark
    ? { background: '#141415', foreground: '#e6e6e6', cursor: '#ffffff',
        cursorAccent: '#141415', selectionBackground: '#3a3a3c' }
    : { background: '#ffffff', foreground: '#1c1c1e', cursor: '#1c1c1e',
        cursorAccent: '#ffffff', selectionBackground: '#d4d4d6' };
}

export function refreshThemes() {
  for (const h of handles.values()) h.term.options.theme = termTheme();
}

// Send a line to every terminal whose Broadcast box is checked.
export function broadcastLine(text) {
  let n = 0;
  for (const h of handles.values()) {
    if (h.bcast.checked && !h.exited) { h.sendText(text + '\r'); n++; }
  }
  toast(n ? `sent to ${n} terminal${n > 1 ? 's' : ''}` : 'no terminals have Broadcast checked',
        n ? 'info' : 'warn', 2500);
}

export function pasteToActive(text) {
  const active = getActive();
  const h = active && handles.get(active.id);
  if (h && !h.exited) { h.term.paste(text); h.term.focus(); }
  else toast('no active terminal tab', 'warn');
}

let snippetsCache = null;
async function loadSnippets() {
  try { snippetsCache = (await api('/api/snippets')).snippets; }
  catch { snippetsCache = []; }
  return snippetsCache;
}
export function invalidateSnippets() { snippetsCache = null; }

export function openTerminal(namespace, pod, container, opts = {}) {
  const target = `${namespace}/${pod}/${container}`;
  // One tab per container by default: clicking again focuses + blinks it.
  // The ⊕ toolbar button opens a deliberate extra session; presence
  // badges still count both.
  const tabId = opts.fresh ? `term-${target}#${++seq}` : `term-${target}`;
  if (!opts.fresh && focusOrBlink(tabId)) return;
  const fontKey = 'tifera.termFontSize';
  let fontSize = parseInt(localStorage.getItem(fontKey) || '14', 10);

  const banner = el('div', { class: 'term-banner hidden' });
  const searchInput = el('input', {
    class: 'term-search', placeholder: 'search (Enter / Shift+Enter)',
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      if (e.shiftKey) search.findPrevious(searchInput.value);
      else search.findNext(searchInput.value);
    },
  });
  const bcast = el('input', { type: 'checkbox', title: 'include in broadcast input' });
  const snippetSel = el('select', { class: 'snippet-select', title: 'insert snippet' },
    el('option', { value: '', text: 'snippets…' }));
  snippetSel.addEventListener('focus', async () => {
    const snippets = snippetsCache || await loadSnippets();
    snippetSel.replaceChildren(el('option', { value: '', text: 'snippets…' }),
      ...snippets.map((s) => el('option', { value: s.command, text: s.name })));
  });
  snippetSel.addEventListener('change', () => {
    if (snippetSel.value) { term.paste(snippetSel.value); term.focus(); }
    snippetSel.value = '';
  });

  const shellLabel = el('span', { class: 'muted', text: opts.shell || '…' });
  const toolbar = el('div', { class: 'term-toolbar' },
    el('span', { class: 'target-label', text: target }), shellLabel,
    el('button', { text: '⊕', title: 'open another session in this container',
                   onclick: () => openTerminal(namespace, pod, container,
                                               { ...opts, fresh: true }) }),
    el('label', { class: 'bcast-label', title: 'broadcast-input target' }, bcast, 'Broadcast'),
    snippetSel, searchInput,
    el('button', { text: 'A−', title: 'smaller font', onclick: () => setFont(fontSize - 1) }),
    el('button', { text: 'A+', title: 'larger font', onclick: () => setFont(fontSize + 1) }),
    el('button', { text: 'kill', class: 'danger', title: 'terminate this session',
                   onclick: () => { deliberate = true; sendCtrl({ type: 'close' }); } }));

  const termHost = el('div', { class: 'term-host' });
  const root = el('div', { class: 'term-root' }, toolbar, banner, termHost);

  const term = new Terminal({
    scrollback: 10000,
    fontSize,
    fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
    theme: termTheme(),
    cursorBlink: true,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);

  let ws = null;
  let sessionId = null;
  let exited = false;
  let deliberate = false;
  let reconnectAttempts = 0;
  let knownOthers = new Set();

  function setFont(size) {
    fontSize = Math.min(28, Math.max(8, size));
    localStorage.setItem(fontKey, String(fontSize));
    term.options.fontSize = fontSize;
    fit.fit();
  }

  function statusLine(msg) {
    term.write(`\r\n\x1b[33m── ${msg} ──\x1b[0m\r\n`);
  }

  function sendCtrl(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  const encoder = new TextEncoder();
  function sendText(text) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(text));
  }

  function markExited(message) {
    if (exited) return;
    exited = true;
    statusLine(message || 'session ended');
  }

  // Persistent banner naming other clients with shells here.
  function updateBanner(others) {
    if (!others.length) {
      banner.classList.add('hidden');
      return;
    }
    const names = [...new Set(others.map(sessionLabel))].join(', ');
    banner.textContent = `⚠ ${names} also ${others.length > 1 ? 'have shells' : 'has a shell'} open in this container`;
    banner.classList.remove('hidden');
  }

  function offerDebugContainer(error) {
    banner.classList.remove('hidden');
    banner.replaceChildren(
      `no shell found in ${container} - `,
      el('button', {
        text: 'attach ephemeral debug container',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const r = await api(`/api/debug/${namespace}/${pod}?container=${container}&${qsClient()}`,
                                { method: 'POST' });
            closeTab(tabId);
            openTerminal(namespace, pod, r.debugContainer, { shell: 'sh' });
          } catch (err) {
            toast(`debug container failed: ${err.message}`, 'error');
            e.target.disabled = false;
          }
        },
      }));
    statusLine(error);
  }

  function connect(reattach) {
    let url = `/ws/terminal/${namespace}/${pod}/${container}?${qsClient()}`;
    if (opts.shell) url += `&shell=${encodeURIComponent(opts.shell)}`;
    if (reattach && sessionId) url += `&sessionId=${sessionId}`;
    ws = new WebSocket(wsUrl(url));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        if (m.type === 'ready') {
          sessionId = m.sessionId;
          reconnectAttempts = 0;
          shellLabel.textContent = m.shell;
          if (reattach) statusLine('reconnected');
          const others = m.others || [];
          knownOthers = new Set(others.map((s) => s.sessionId));
          if (others.length && !reattach) {
            // Joining-side warning.
            toast(`${[...new Set(others.map(sessionLabel))].join(', ')} already has a shell open in this container`, 'warn');
          }
          updateBanner(others);
        } else if (m.type === 'exit') {
          markExited(`session ended: ${m.message}`);
        } else if (m.type === 'error') {
          if (m.shellNotFound) offerDebugContainer(m.error);
          else markExited(m.error);
        }
      } else {
        term.write(new Uint8Array(e.data));
      }
    };
    ws.onclose = () => {
      if (exited || deliberate) return;
      if (!sessionId || reconnectAttempts >= 5) {
        markExited('connection lost');
        return;
      }
      reconnectAttempts++;
      statusLine(`connection lost - reconnecting (${reconnectAttempts})`);
      setTimeout(() => { if (!exited && !deliberate) connect(true); }, 1500);
    };
  }

  term.onData((d) => { if (!exited) sendText(d); });
  term.onResize(({ cols, rows }) => sendCtrl({ type: 'resize', cols, rows }));

  const resizeObserver = new ResizeObserver(() => {
    if (root.classList.contains('active')) fit.fit();
  });

  // Live presence for this target: warn when another client joins/leaves.
  on('presence', (m) => {
    if (m.target !== target || exited) return;
    const others = (m.sessions || []).filter(
      (s) => s.clientId !== client.id);
    const ids = new Set(others.map((s) => s.sessionId));
    for (const s of others) {
      if (!knownOthers.has(s.sessionId)) {
        toast(`${sessionLabel(s)} just opened a shell in ${target}`, 'warn');
      }
    }
    for (const id of knownOthers) {
      if (!ids.has(id)) toast(`a shell of another client on ${target} closed`, 'info', 3000);
    }
    knownOthers = ids;
    updateBanner(others);
  });

  const handle = {
    term, bcast, target, sendText,
    get exited() { return exited; },
  };
  handles.set(tabId, handle);

  addTab({
    id: tabId,
    title: `⌨ ${container}`,
    kind: 'terminal',
    el: root,
    onShow: () => { fit.fit(); term.focus(); },
    onClose: () => {
      deliberate = true;
      exited = true;   // stop presence toasts from the stale handler
      sendCtrl({ type: 'close' });
      try { ws?.close(); } catch { /* already closed */ }
      resizeObserver.disconnect();
      handles.delete(tabId);
      term.dispose();
    },
  });

  term.open(termHost);
  fit.fit();
  resizeObserver.observe(termHost);
  connect(false);
  term.focus();
}
