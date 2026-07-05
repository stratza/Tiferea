// Global state fed by /ws/events (inventory, presence, metrics, rbac deltas)
// with auto-reconnect. Views subscribe with on(type, fn).

import { client, wsUrl } from './util.js';

export const state = {
  pods: new Map(),        // uid -> pod summary
  presence: new Map(),    // "ns/pod/container" -> [session, ...]
  metrics: { pods: {}, nodes: [], available: null },
  identity: {},
  rbac: null,             // null = check running, [] = ok, [...] = missing
  connected: false,
  user: null,             // { username, role } once authenticated
};

const ROLE_LEVEL = { viewer: 1, operator: 2, admin: 3 };
export function role() { return state.user ? state.user.role : 'viewer'; }
export function canOperate() { return ROLE_LEVEL[role()] >= ROLE_LEVEL.operator; }
export function isAdmin() { return role() === 'admin'; }
export function isViewer() { return role() === 'viewer'; }

const handlers = {};

export function on(type, fn) {
  (handlers[type] ||= []).push(fn);
}

function emit(type, msg = {}) {
  for (const fn of handlers[type] || []) {
    try { fn(msg); } catch (e) { console.error(`handler for '${type}' failed`, e); }
  }
}

export function isSelfPod(namespace, pod) {
  return state.identity.namespace === namespace && state.identity.pod === pod;
}

export function podByName(namespace, name) {
  for (const p of state.pods.values()) {
    if (p.namespace === namespace && p.name === name) return p;
  }
  return null;
}

function route(m) {
  switch (m.type) {
    case 'hello':
      state.identity = m.identity || {};
      state.rbac = m.rbacMissing;
      state.pods = new Map((m.pods || []).map((p) => [p.uid, p]));
      state.presence = new Map(Object.entries(m.presence || {}));
      if (m.metrics) state.metrics = m.metrics;
      emit('hello', m);
      emit('pods');
      emit('presence', {});
      emit('rbac');
      emit('metrics', {});
      break;
    case 'snapshot':
      state.pods = new Map((m.pods || []).map((p) => [p.uid, p]));
      emit('pods');
      break;
    case 'pod':
      if (m.op === 'delete') state.pods.delete(m.pod.uid);
      else state.pods.set(m.pod.uid, m.pod);
      emit('pods', m);
      break;
    case 'presence':
      if (m.sessions.length) state.presence.set(m.target, m.sessions);
      else state.presence.delete(m.target);
      emit('presence', m);
      break;
    case 'metrics':
      if (m.available === false) {
        state.metrics.available = false;
      } else {
        state.metrics = { pods: m.pods, nodes: m.nodes, available: true, ts: m.ts };
      }
      emit('metrics', m);
      break;
    case 'rbac':
      state.rbac = m.missing;
      emit('rbac');
      break;
    case 'editor':
      emit('editor', m);
      break;
    default:
      break;
  }
}

export function connect() {
  const ws = new WebSocket(wsUrl(
    `/ws/events?clientId=${client.id}&clientName=${encodeURIComponent(client.name)}`));
  ws.onopen = () => { state.connected = true; emit('conn'); };
  ws.onmessage = (e) => route(JSON.parse(e.data));
  ws.onclose = () => {
    state.connected = false;
    emit('conn');
    setTimeout(connect, 2000);
  };
}
