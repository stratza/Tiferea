// Read-only YAML view for any resource the palette surfaces (feature 5).
// Secret values arrive already masked from the backend.

import { api, el, toast } from './util.js';
import { addTab, focusOrBlink } from './tabs.js';

export function openDescribe(kind, namespace, name) {
  const tabId = `describe-${kind}/${namespace}/${name}`;
  if (focusOrBlink(tabId)) return;
  const body = el('pre', { class: 'yaml-box grow', text: 'loading…' });
  const root = el('div', { class: 'describe-root' },
    el('div', { class: 'term-toolbar' },
      el('span', { class: 'target-label', text: `${kind} · ${namespace}/${name}` }),
      el('button', { text: '⟳', title: 'reload', onclick: load })),
    body);

  async function load() {
    try {
      body.textContent = await api(
        `/api/describe/${kind}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);
    } catch (e) {
      body.textContent = `failed to describe ${kind}/${name}: ${e.message}`;
      toast(`describe failed: ${e.message}`, 'error');
    }
  }

  addTab({ id: tabId, title: `📄 ${name}`, kind: 'describe', el: root });
  load();
}
