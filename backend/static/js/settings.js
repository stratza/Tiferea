// Settings dialog: appearance, terminal, workspace persistence (feature 6),
// and identity. All client-side, stored in localStorage.

import { $, client, clientLabel, el, setClientName } from './util.js';
import { refreshThemes, setTermFontSize } from './terminal.js';
import { persistEnabled, setPersist } from './workspace.js';

function applyTheme(t) {
  document.body.dataset.theme = t;
  localStorage.setItem('tifera.theme', t);
  refreshThemes();
  render();
}

function row(label, ...controls) {
  return el('div', { class: 'set-row' },
    el('div', { class: 'set-label', text: label }),
    el('div', { class: 'set-control' }, ...controls));
}

function themeBtn(v, label) {
  const active = (document.body.dataset.theme || 'dark') === v;
  return el('button', { class: `seg-btn ${active ? 'active' : ''}`, onclick: () => applyTheme(v) }, label);
}

function render() {
  const box = $('#settings-box');
  if (!box) return;
  const fontSize = parseInt(localStorage.getItem('tifera.termFontSize') || '14', 10);
  const nameInput = el('input', { value: clientLabel(), placeholder: 'display name' });
  box.replaceChildren(
    el('div', { class: 'set-head' },
      el('span', { text: 'Settings' }),
      el('button', { class: 'set-close', title: 'close', onclick: close }, '×')),

    el('div', { class: 'set-section' },
      el('h4', { text: 'Appearance' }),
      row('Theme', el('div', { class: 'seg' }, themeBtn('dark', 'Dark'), themeBtn('light', 'Light')))),

    el('div', { class: 'set-section' },
      el('h4', { text: 'Terminal' }),
      row('Font size',
        el('input', { type: 'number', min: '8', max: '28', value: String(fontSize), class: 'set-num',
                      onchange: (e) => setTermFontSize(parseInt(e.target.value, 10) || 14) }),
        el('span', { class: 'muted', text: 'px · applies to open terminals' }))),

    el('div', { class: 'set-section' },
      el('h4', { text: 'Workspace' }),
      row('Restore open tabs on reload',
        toggle(persistEnabled(), (on) => { setPersist(on); }),
        el('span', { class: 'muted', text: 'reopens the same views next visit' }))),

    el('div', { class: 'set-section' },
      el('h4', { text: 'Identity' }),
      row('Display name', nameInput,
        el('button', { text: 'save', onclick: () => {
          setClientName(nameInput.value);
          $('#client-name-btn').textContent = clientLabel();
        } }),
        el('span', { class: 'muted', text: 'shown to other operators' }))),

    el('div', { class: 'set-foot muted', text: `client id ${client.id}` }),
  );
}

function toggle(on, onChange) {
  const box = el('input', { type: 'checkbox', class: 'set-toggle', checked: on || null });
  box.addEventListener('change', () => onChange(box.checked));
  return el('label', { class: 'set-toggle-wrap' }, box);
}

export function openSettings() {
  render();
  $('#settings').classList.remove('hidden');
}

export function close() {
  $('#settings').classList.add('hidden');
}

export function initSettings() {
  const overlay = $('#settings');
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
  });
}
