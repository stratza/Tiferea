// Shared helpers: DOM, formatting, fetch, and client identity.

export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export function fmtBytes(n) {
  if (n === null || n === undefined) return '–';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function fmtCpu(millicores) {
  if (millicores === null || millicores === undefined) return '–';
  return millicores >= 1000 ? `${(millicores / 1000).toFixed(2)} cores` : `${Math.round(millicores)}m`;
}

export function fmtAge(iso) {
  if (!iso) return '–';
  let s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 120) return `${Math.round(s)}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function fmtTime(tsSeconds) {
  return new Date(tsSeconds * 1000).toLocaleString();
}

// K8s quantity strings ("250m", "1", "128Mi") for requests/limits.
export function cpuToMillicores(q) {
  if (!q) return null;
  if (q.endsWith('m')) return parseFloat(q);
  const n = parseFloat(q);
  return Number.isNaN(n) ? null : n * 1000;
}

export function memToBytes(q) {
  if (!q) return null;
  const units = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40,
                  k: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  for (const [suffix, mult] of Object.entries(units)) {
    if (q.endsWith(suffix)) return parseFloat(q) * mult;
  }
  const n = parseFloat(q);
  return Number.isNaN(n) ? null : n;
}

export async function api(path, opts = {}) {
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    let detail = resp.statusText;
    try { detail = (await resp.json()).detail || detail; } catch { /* not json */ }
    const err = new Error(detail);
    err.status = resp.status;
    throw err;
  }
  const ct = resp.headers.get('content-type') || '';
  return ct.includes('json') ? resp.json() : resp.text();
}

export function toast(msg, kind = 'info', ms = 6000) {
  const t = el('div', { class: `toast ${kind}`, text: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

export function wsUrl(path) {
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path;
}

// -- client identity: random ID + optional self-chosen display name ----------

function initClient() {
  let id = localStorage.getItem('tifera.clientId');
  if (!id) {
    id = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
    localStorage.setItem('tifera.clientId', id);
  }
  return { id, name: localStorage.getItem('tifera.clientName') || '' };
}

export const client = initClient();

export function clientLabel() {
  return client.name || client.id.slice(0, 6);
}

export function setClientName(name) {
  client.name = (name || '').trim();
  localStorage.setItem('tifera.clientName', client.name);
}

export function promptNameOnce() {
  if (localStorage.getItem('tifera.namePrompted')) return;
  localStorage.setItem('tifera.namePrompted', '1');
  const n = window.prompt(
    'Pick a display name other operators will see (optional, editable anytime):', '');
  if (n) setClientName(n);
}

export const qsClient = () =>
  `clientId=${client.id}&clientName=${encodeURIComponent(client.name)}`;

export function sessionLabel(s) {
  return s.clientName || s.clientId.slice(0, 6);
}
