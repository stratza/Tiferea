// Interactive shell tabs (xterm.js): reconnect-on-drop, same-container
// warnings, broadcast input, ephemeral debug fallback, and collaborative
// shared sessions (feature 1).

import { $, api, client, el, qsClient, sessionLabel, toast, wsUrl } from './util.js';
import { off, on } from './state.js';
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

// Live-apply a terminal font size to every open terminal (Settings).
export function setTermFontSize(size) {
  size = Math.min(28, Math.max(8, size));
  localStorage.setItem('tifera.termFontSize', String(size));
  for (const h of handles.values()) {
    h.term.options.fontSize = size;
    try { h.fit.fit(); } catch { /* not visible */ }
  }
}

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

// Join a shared session someone else owns (feature 1).
export function joinSession(namespace, pod, container, sessionId, owner) {
  openTerminal(namespace, pod, container, { join: sessionId, owner, fresh: true });
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
  const joining = !!opts.join;
  // One tab per container by default; joins and + open extra sessions.
  const tabId = (opts.fresh || joining) ? `term-${target}#${++seq}` : `term-${target}`;
  if (!opts.fresh && !joining && focusOrBlink(tabId)) return;
  const fontKey = 'tifera.termFontSize';
  let fontSize = parseInt(localStorage.getItem(fontKey) || '14', 10);

  const banner = el('div', { class: 'term-banner hidden' });
  const searchInput = el('input', {
    class: 'term-search', placeholder: 'Search (Enter / Shift+Enter)',
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      if (e.shiftKey) search.findPrevious(searchInput.value);
      else search.findNext(searchInput.value);
    },
  });
  const bcast = el('input', { type: 'checkbox', title: 'Include in broadcast input' });
  const snippetSel = el('select', { class: 'snippet-select', title: 'Insert snippet' },
    el('option', { value: '', text: 'Snippets…' }));
  snippetSel.addEventListener('focus', async () => {
    const snippets = snippetsCache || await loadSnippets();
    snippetSel.replaceChildren(el('option', { value: '', text: 'Snippets…' }),
      ...snippets.map((s) => el('option', { value: s.command, text: s.name })));
  });
  snippetSel.addEventListener('change', () => {
    if (snippetSel.value) { term.paste(snippetSel.value); term.focus(); }
    snippetSel.value = '';
  });

  const shellLabel = el('span', { class: 'muted', text: opts.shell || '…' });

  // Owner-only share toggle; collaborators get a leave button instead.
  const shareBtn = el('button', { class: 'share-btn', title: 'Share this session with other operators',
    onclick: () => { shared = !shared; sendCtrl({ type: 'share', on: shared }); renderBanner(); updateShareBtn(); } },
    '🤝 Share');
  function updateShareBtn() {
    shareBtn.textContent = shared ? '🤝 Sharing' : '🤝 Share';
    shareBtn.classList.toggle('active', shared);
  }

  const ownerCtrls = [
    el('button', { text: '➕', title: 'Open another session in this container',
                   onclick: () => openTerminal(namespace, pod, container, { ...opts, join: null, fresh: true }) }),
    shareBtn,
    el('button', { text: '🛑 Kill', class: 'danger', title: 'Terminate this session',
                   onclick: () => { deliberate = true; sendCtrl({ type: 'close' }); } }),
  ];
  const joinCtrls = [
    el('button', { text: '🚪 Leave', class: 'danger', title: 'Leave this shared session',
                   onclick: () => { deliberate = true; closeTab(tabId); } }),
  ];

  const toolbar = el('div', { class: 'term-toolbar' },
    el('span', { class: 'target-label', text: target }), shellLabel,
    el('label', { class: 'bcast-label', title: 'Broadcast-input target' }, bcast, 'Broadcast'),
    snippetSel, searchInput,
    el('button', { text: 'A−', title: 'Smaller font', onclick: () => setFont(fontSize - 1) }),
    el('button', { text: 'A+', title: 'Larger font', onclick: () => setFont(fontSize + 1) }),
    ...(joining ? joinCtrls : ownerCtrls));

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
  let sessionId = opts.join || null;
  let exited = false;
  let deliberate = false;
  let reconnectAttempts = 0;
  let knownOthers = new Set();
  let shared = false;
  let participants = 1;
  let others = [];

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

  // One banner conveys the most important state: join / sharing / co-tenant.
  function renderBanner() {
    banner.classList.remove('shared', 'joined');
    if (joining) {
      banner.classList.add('joined');
      banner.textContent =
        `joined ${opts.owner || 'a'}'s shared session · ${participants} connected · everyone here can type`;
      banner.classList.remove('hidden');
      return;
    }
    if (shared) {
      banner.classList.add('shared');
      banner.replaceChildren(
        `sharing this session · ${participants} connected · anyone who can reach TifEra can join and type `,
        el('button', { class: 'link-btn', text: 'Stop sharing',
                       onclick: () => { shared = false; sendCtrl({ type: 'share', on: false }); renderBanner(); updateShareBtn(); } }));
      banner.classList.remove('hidden');
      return;
    }
    if (others.length) {
      const names = [...new Set(others.map(sessionLabel))].join(', ');
      banner.textContent = `${names} also ${others.length > 1 ? 'have shells' : 'has a shell'} open in this container`;
      banner.classList.remove('hidden');
      return;
    }
    banner.classList.add('hidden');
  }

  function offerDebugContainer(error) {
    banner.classList.remove('hidden');
    banner.replaceChildren(
      `no shell found in ${container} - `,
      el('button', {
        text: 'Attach ephemeral debug container',
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
    if (joining) url += `&join=${sessionId}`;
    else if (reattach && sessionId) url += `&sessionId=${sessionId}`;
    ws = new WebSocket(wsUrl(url));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        if (m.type === 'ready') {
          sessionId = m.sessionId;
          reconnectAttempts = 0;
          shellLabel.textContent = m.shell;
          shared = !!m.shared;
          updateShareBtn();
          if (reattach) statusLine('reconnected');
          if (joining && !reattach) statusLine(`joined ${m.owner || 'shared'} session`);
          others = (m.others || []);
          knownOthers = new Set(others.map((s) => s.sessionId));
          if (others.length && !reattach && !joining) {
            toast(`${[...new Set(others.map(sessionLabel))].join(', ')} already has a shell open in this container`, 'warn');
          }
          renderBanner();
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
    if (root.classList.contains('shown')) fit.fit();
  });

  // Live presence: co-tenant warnings, and participant counts for our own
  // shared/joined session.
  function onPresence(m) {
    if (m.target !== target || exited) return;
    const sessions = m.sessions || [];
    const mine = sessions.find((s) => s.sessionId === sessionId);
    if (mine) participants = mine.participants || 1;
    others = sessions.filter((s) => s.clientId !== client.id && s.sessionId !== sessionId);
    const ids = new Set(others.map((s) => s.sessionId));
    if (!joining) {
      for (const s of others) {
        if (!knownOthers.has(s.sessionId)) {
          toast(`${sessionLabel(s)} just opened a shell in ${target}`, 'warn');
        }
      }
    }
    knownOthers = ids;
    renderBanner();
  }
  on('presence', onPresence);

  const handle = {
    term, fit, bcast, target, sendText,
    get exited() { return exited; },
  };
  handles.set(tabId, handle);

  addTab({
    id: tabId,
    title: `${joining ? '🔗' : '⌨'} ${container}`,
    kind: 'terminal',
    el: root,
    restore: joining ? null : { kind: 'terminal', ns: namespace, pod, ctr: container },
    onShow: () => { fit.fit(); term.focus(); },
    onClose: () => {
      deliberate = true;
      exited = true;
      // A collaborator leaving just detaches; the owner closing kills it.
      if (!joining) sendCtrl({ type: 'close' });
      try { ws?.close(); } catch { /* already closed */ }
      resizeObserver.disconnect();
      off('presence', onPresence);
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
