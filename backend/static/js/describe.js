// YAML view for any resource the palette surfaces, with opt-in edit & apply
// (feature 5). Secret values arrive masked and Secrets are not editable.

import { api, el, toast } from './util.js';
import { canOperate } from './state.js';
import { addTab, focusOrBlink } from './tabs.js';

// Kinds the backend accepts a YAML apply for (mirrors resources._WRITERS).
const EDITABLE = new Set(['Service', 'ConfigMap', 'Deployment', 'StatefulSet', 'DaemonSet']);

export function openDescribe(kind, namespace, name) {
  const tabId = `describe-${kind}/${namespace}/${name}`;
  if (focusOrBlink(tabId)) return;
  const url = `/api/describe/${kind}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
  const editable = EDITABLE.has(kind) && canOperate();

  const view = el('pre', { class: 'yaml-box grow', text: 'loading…' });
  const editor = el('textarea', { class: 'editor-area hidden', spellcheck: 'false' });
  const toolbar = el('div', { class: 'term-toolbar' },
    el('span', { class: 'target-label', text: `${kind} · ${namespace}/${name}` }));
  const root = el('div', { class: 'describe-root' }, toolbar, view, editor);

  let editing = false;

  function setToolbar() {
    const btns = [el('button', { text: '🔄', title: 'Reload', onclick: load })];
    if (editable && !editing) {
      btns.push(el('button', { text: '✏ Edit', title: 'Edit & apply YAML', onclick: startEdit }));
    } else if (editing) {
      btns.push(
        el('button', { text: '✅ Apply', class: 'primary', title: 'Apply the edited YAML', onclick: apply }),
        el('button', { text: '✖ Cancel', onclick: cancel }));
    }
    toolbar.replaceChildren(
      el('span', { class: 'target-label', text: `${kind} · ${namespace}/${name}` }),
      ...btns);
  }

  async function load() {
    try {
      view.textContent = await api(url);
    } catch (e) {
      view.textContent = `failed to describe ${kind}/${name}: ${e.message}`;
      toast(`describe failed: ${e.message}`, 'error');
    }
  }

  function startEdit() {
    editing = true;
    editor.value = view.textContent;
    view.classList.add('hidden');
    editor.classList.remove('hidden');
    setToolbar();
    editor.focus();
  }

  function cancel() {
    editing = false;
    editor.classList.add('hidden');
    view.classList.remove('hidden');
    setToolbar();
  }

  async function apply() {
    try {
      await api(url, { method: 'PUT', headers: { 'Content-Type': 'text/yaml' }, body: editor.value });
      toast(`applied ${kind}/${name}`, 'info');
      cancel();
      load();
    } catch (e) {
      if (e.status === 409) {
        toast('resource changed since you loaded it - refresh, re-edit, and re-apply', 'warn', 7000);
      } else {
        toast(`apply failed: ${e.message}`, 'error', 7000);
      }
    }
  }

  addTab({ id: tabId, title: `📄 ${name}`, kind: 'describe', el: root,
           restore: { kind: 'describe', k: kind, ns: namespace, name } });
  setToolbar();
  load();
}
