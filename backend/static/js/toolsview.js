// Operator tools: action log, cluster events feed and
// the snippets library.

import { api, el, fmtTime, toast } from './util.js';
import { state } from './state.js';
import { activate, addTab, findTab } from './tabs.js';
import { invalidateSnippets, pasteToActive } from './terminal.js';

export function openActions() {
  const TAB_ID = 'actions';
  if (findTab(TAB_ID)) { activate(TAB_ID); return; }
  const tbody = el('tbody');
  const root = el('div', { class: 'tools-root' },
    el('div', { class: 'term-toolbar' },
      el('span', { class: 'target-label', text: 'Action log' }),
      el('button', { text: 'refresh refresh', onclick: load }),
      el('a', { class: 'button', text: 'get export JSONL', href: '/api/actions/export',
                download: 'tifera-actions.jsonl' }),
      el('span', { class: 'muted',
                   text: 'names are self-declared - attribution is cooperative, not forensic' })),
    el('div', { class: 'fs-scroll' },
      el('table', { class: 'fs-table' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'time' }), el('th', { text: 'action' }),
          el('th', { text: 'client' }), el('th', { text: 'ip' }),
          el('th', { text: 'target' }), el('th', { text: 'detail' }))),
        tbody)));

  async function load() {
    try {
      const r = await api('/api/actions?limit=500');
      tbody.replaceChildren(...r.actions.map((a) => el('tr', {},
        el('td', { text: fmtTime(a.ts) }),
        el('td', { class: 'mono', text: a.action }),
        el('td', { text: a.clientName || (a.clientId || '').slice(0, 6) || '–' }),
        el('td', { class: 'mono', text: a.clientIp || '–' }),
        el('td', { class: 'mono',
                   text: [a.namespace, a.pod, a.container].filter(Boolean).join('/') || '–' }),
        el('td', { class: 'muted', text: a.detail || '' }))));
    } catch (e) {
      toast(`action log failed: ${e.message}`, 'error');
    }
  }
  addTab({ id: TAB_ID, title: 'Actions', kind: 'tools', el: root });
  load();
}

export function openEventsFeed() {
  const TAB_ID = 'eventsfeed';
  if (findTab(TAB_ID)) { activate(TAB_ID); return; }
  const nsSel = el('select', { onchange: () => load() });
  const tbody = el('tbody');
  let timer = null;

  const root = el('div', { class: 'tools-root' },
    el('div', { class: 'term-toolbar' },
      el('span', { class: 'target-label', text: 'Cluster events' }), nsSel,
      el('button', { text: 'refresh refresh', onclick: () => load() })),
    el('div', { class: 'fs-scroll' },
      el('table', { class: 'fs-table' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'time' }), el('th', { text: 'type' }),
          el('th', { text: 'object' }), el('th', { text: 'reason' }),
          el('th', { text: 'message' }), el('th', { text: '×' }))),
        tbody)));

  function fillNamespaces() {
    const namespaces = [...new Set([...state.pods.values()].map((p) => p.namespace))].sort();
    const cur = nsSel.value;
    nsSel.replaceChildren(el('option', { value: '', text: 'all namespaces' }),
      ...namespaces.map((ns) => el('option', { value: ns, text: ns })));
    nsSel.value = cur;
  }

  async function load() {
    try {
      const r = await api(`/api/events?namespace=${nsSel.value}`);
      tbody.replaceChildren(...r.events.map((ev) => el('tr', {
        class: ev.type === 'Warning' ? 'lvl-warn' : '' },
        el('td', { text: ev.time ? new Date(ev.time).toLocaleString() : '–' }),
        el('td', { text: ev.type }),
        el('td', { class: 'mono', text: `${ev.kind}/${ev.namespace}/${ev.name}` }),
        el('td', { text: ev.reason }),
        el('td', { text: ev.message }),
        el('td', { text: String(ev.count) }))));
    } catch (e) {
      toast(`events failed: ${e.message}`, 'error');
    }
  }

  addTab({
    id: TAB_ID, title: 'Events', kind: 'tools', el: root,
    onShow: () => { timer = setInterval(load, 10000); },
    onHide: () => clearInterval(timer),
    onClose: () => clearInterval(timer),
  });
  fillNamespaces();
  load();   // onShow (fired by addTab) starts the auto-refresh interval
}

export function openSnippets() {
  const TAB_ID = 'snippets';
  if (findTab(TAB_ID)) { activate(TAB_ID); return; }
  const tbody = el('tbody');
  const nameInput = el('input', { placeholder: 'name' });
  const cmdInput = el('input', { placeholder: 'command', class: 'grow' });

  const root = el('div', { class: 'tools-root' },
    el('div', { class: 'term-toolbar' },
      el('span', { class: 'target-label', text: 'Command snippets' }),
      nameInput, cmdInput,
      el('button', { text: '+ add', onclick: async () => {
        if (!nameInput.value || !cmdInput.value) { toast('name and command required', 'warn'); return; }
        try {
          await api('/api/snippets', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: nameInput.value, command: cmdInput.value }),
          });
          nameInput.value = ''; cmdInput.value = '';
          invalidateSnippets();
          load();
        } catch (e) { toast(`add failed: ${e.message}`, 'error'); }
      } })),
    el('div', { class: 'fs-scroll' },
      el('table', { class: 'fs-table' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'name' }), el('th', { text: 'command' }), el('th', { text: '' }))),
        tbody)));

  async function load() {
    try {
      const r = await api('/api/snippets');
      tbody.replaceChildren(...r.snippets.map((s) => el('tr', {},
        el('td', { text: s.name }),
        el('td', { class: 'mono', text: s.command }),
        el('td', { class: 'fs-actions' },
          el('button', { text: 'insert', title: 'insert into active terminal',
                         onclick: () => pasteToActive(s.command) }),
          el('button', { text: 'del', class: 'danger', onclick: async () => {
            await api(`/api/snippets/${s.id}`, { method: 'DELETE' });
            invalidateSnippets();
            load();
          } })))));
    } catch (e) {
      toast(`snippets failed: ${e.message}`, 'error');
    }
  }
  addTab({ id: TAB_ID, title: 'Snippets', kind: 'tools', el: root });
  load();
}
