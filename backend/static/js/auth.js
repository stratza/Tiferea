// Authentication gate: first-run admin setup, login / continue-as-viewer, the
// status-bar user menu, and (admin) user management. Server enforces roles;
// this drives the UI and the login flow.

import { $, api, el, toast } from './util.js';

let onReady = null;

function gate() { return $('#auth-gate'); }

function shell(title, sub, ...children) {
  gate().replaceChildren(
    el('div', { class: 'auth-card' },
      el('div', { class: 'auth-brand', text: 'TifEra' }),
      el('h2', { text: title }),
      sub ? el('p', { class: 'auth-sub muted', text: sub }) : null,
      ...children));
  gate().classList.remove('hidden');
}

function field(label, type, ref) {
  const input = el('input', { type, autocomplete: 'off' });
  ref.el = input;
  return el('label', { class: 'auth-field' }, el('span', { text: label }), input);
}

function proceed(user) {
  state_set(user);
  gate().classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#statusbar').classList.remove('hidden');
  onReady?.(user);
}

// state.user is set here to avoid importing state before boot.
import { state } from './state.js';
function state_set(user) { state.user = user; }

// -- screens ----------------------------------------------------------------

function setupScreen() {
  const u = {}; const p = {}; const c = {};
  const err = el('div', { class: 'auth-err hidden' });
  async function submit() {
    err.classList.add('hidden');
    if (p.el.value !== c.el.value) { return showErr(err, 'passwords do not match'); }
    try {
      const r = await api('/api/auth/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u.el.value.trim(), password: p.el.value }),
      });
      proceed(r.user);
    } catch (e) { showErr(err, e.message); }
  }
  shell('Create the admin account',
    'First run - this admin is stored in a Kubernetes Secret. Choose a strong password (min 8 chars).',
    field('Admin username', 'text', u),
    field('Password', 'password', p),
    field('Confirm password', 'password', c),
    err,
    el('button', { class: 'auth-primary', onclick: submit }, 'Create admin'));
  u.el.focus();
  bindEnter([u, p, c], submit);
}

function loginScreen() {
  const u = {}; const p = {};
  const err = el('div', { class: 'auth-err hidden' });
  async function login() {
    err.classList.add('hidden');
    try {
      const r = await api('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u.el.value.trim(), password: p.el.value }),
      });
      proceed(r.user);
    } catch (e) { showErr(err, e.message); }
  }
  async function viewer() {
    try { const r = await api('/api/auth/viewer', { method: 'POST' }); proceed(r.user); }
    catch (e) { showErr(err, e.message); }
  }
  shell('Sign in', null,
    field('Username', 'text', u),
    field('Password', 'password', p),
    err,
    el('button', { class: 'auth-primary', onclick: login }, 'Sign in'),
    el('div', { class: 'auth-divider' }, el('span', { text: 'or' })),
    el('button', { class: 'auth-viewer', onclick: viewer }, 'Continue as Viewer'),
    el('p', { class: 'auth-note muted', text: 'Viewers get read-only access to non-sensitive data.' }));
  u.el.focus();
  bindEnter([u, p], login);
}

function showErr(node, msg) { node.textContent = msg; node.classList.remove('hidden'); }
function bindEnter(refs, fn) {
  for (const r of refs) r.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') fn(); });
}

// -- entry ------------------------------------------------------------------

export async function initAuth(ready) {
  onReady = ready;
  let s;
  try { s = await api('/api/auth/state'); }
  catch (e) {
    shell('TifEra is unavailable', `auth backend error: ${e.message}`);
    return;
  }
  if (s.user) { proceed(s.user); return; }
  if (!s.setup) setupScreen(); else loginScreen();
}

export async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* */ }
  location.reload();
}

// -- status-bar user menu ---------------------------------------------------

export function userMenu(user) {
  const admin = user.role === 'admin';
  return el('span', { class: 'sb-user' },
    el('span', { class: `sb-role role-${user.role}`, text: user.role }),
    el('span', { class: 'sb-username', text: user.username }),
    admin ? el('button', { class: 'sb-userbtn', title: 'manage users', onclick: openUsers }, 'Users') : null,
    el('button', { class: 'sb-userbtn', title: 'sign out', onclick: logout }, 'Sign out'));
}

// -- admin: user management -------------------------------------------------

export async function openUsers() {
  const overlay = $('#settings');   // reuse the modal overlay + styling
  const box = $('#settings-box');
  const list = el('div', { class: 'users-list' });

  async function load() {
    try {
      const r = await api('/api/auth/users');
      list.replaceChildren(...r.users.map((u) => el('div', { class: 'user-row' },
        el('span', { class: 'user-name', text: u.username }),
        roleSelect(u),
        el('button', { class: 'danger', title: 'delete', onclick: () => del(u.username) }, 'delete'))));
    } catch (e) { toast(`load users failed: ${e.message}`, 'error'); }
  }
  function roleSelect(u) {
    const sel = el('select', {},
      ...['viewer', 'operator', 'admin'].map((r) =>
        el('option', { value: r, text: r, selected: u.role === r || null })));
    sel.addEventListener('change', async () => {
      try { await api(`/api/auth/users/${encodeURIComponent(u.username)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: sel.value }) }); toast(`${u.username} → ${sel.value}`, 'info'); }
      catch (e) { toast(e.message, 'error'); load(); }
    });
    return sel;
  }
  async function del(name) {
    if (!window.confirm(`delete user ${name}?`)) return;
    try { await api(`/api/auth/users/${encodeURIComponent(name)}`, { method: 'DELETE' }); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  const nu = {}; const np = {}; const nr = {};
  async function add() {
    try {
      await api('/api/auth/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: nu.el.value.trim(), password: np.el.value, role: nr.el.value }) });
      nu.el.value = ''; np.el.value = '';
      load();
    } catch (e) { toast(`add failed: ${e.message}`, 'error'); }
  }
  nr.el = el('select', {}, ...['viewer', 'operator', 'admin'].map((r) => el('option', { value: r, text: r })));

  box.replaceChildren(
    el('div', { class: 'set-head' },
      el('span', { text: 'Users' }),
      el('button', { class: 'set-close', onclick: () => overlay.classList.add('hidden') }, '×')),
    el('div', { class: 'set-section' }, list),
    el('div', { class: 'set-section' },
      el('h4', { text: 'Add user' }),
      el('div', { class: 'user-add' },
        field('Username', 'text', nu), field('Password', 'password', np),
        el('label', { class: 'auth-field' }, el('span', { text: 'Role' }), nr.el),
        el('button', { class: 'primary', onclick: add }, 'add'))));
  overlay.classList.remove('hidden');
  load();
}
