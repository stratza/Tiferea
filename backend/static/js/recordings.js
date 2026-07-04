// Session recording playback (feature 1): lists .cast files and replays them
// in an xterm terminal with play/pause/seek/speed controls.

import { $, api, el, fmtBytes, fmtTime, toast } from './util.js';
import { addTab, findTab, focusOrBlink } from './tabs.js';
import { termTheme } from './terminal.js';

const TAB_ID = 'recordings';

export function openRecordings() {
  if (focusOrBlink(TAB_ID)) return;
  const list = el('div', { class: 'rec-list' });
  const player = el('div', { class: 'rec-player' });
  const root = el('div', { class: 'tools-root' },
    el('div', { class: 'term-toolbar' },
      el('span', { class: 'target-label', text: 'Session recordings' }),
      el('button', { text: 'refresh', onclick: load })),
    el('div', { class: 'rec-split' }, list, player));

  async function load() {
    let data;
    try { data = await api('/api/recordings'); }
    catch (e) { toast(`recordings failed: ${e.message}`, 'error'); return; }
    if (!data.recordings.length) {
      list.replaceChildren(el('div', { class: 'muted pad', text:
        data.recordingEnabled
          ? 'no recordings yet - open a shell to record one.'
          : 'recording is disabled. Set TIFERA_RECORD_SESSIONS=1 (or Helm '
            + 'config.recordSessions=true) to capture sessions.' }));
      return;
    }
    list.replaceChildren(...data.recordings.map((r) => el('div', { class: 'rec-item' },
      el('button', { class: 'rec-open', onclick: () => play(r) },
        el('div', { class: 'rec-title', text: r.title || r.name }),
        el('div', { class: 'rec-meta muted',
                    text: `${r.timestamp ? fmtTime(r.timestamp) : ''} · ${fmtBytes(r.size)}` })),
      el('button', { class: 'danger rec-del', title: 'delete', onclick: async (e) => {
        e.stopPropagation();
        if (!window.confirm(`delete recording ${r.name}?`)) return;
        try { await api(`/api/recordings/${encodeURIComponent(r.name)}`, { method: 'DELETE' }); load(); }
        catch (err) { toast(`delete failed: ${err.message}`, 'error'); }
      } }, 'del'))));
  }

  let current = null;   // active player controller
  async function play(rec) {
    current?.stop();
    player.replaceChildren(el('div', { class: 'muted pad', text: `loading ${rec.name}…` }));
    let text;
    try { text = await api(`/api/recordings/${encodeURIComponent(rec.name)}`); }
    catch (e) { toast(`cannot load recording: ${e.message}`, 'error'); return; }
    current = buildPlayer(rec, text, player);
  }

  addTab({ id: TAB_ID, title: 'Recordings', kind: 'tools', el: root,
           restore: { kind: 'recordings' },
           onClose: () => current?.stop() });
  load();
}

// Parse an asciinema v2 cast and drive an xterm terminal.
function buildPlayer(rec, text, host) {
  const lines = text.split('\n').filter(Boolean);
  let header = {};
  try { header = JSON.parse(lines[0]); } catch { /* keep defaults */ }
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const [t, kind, data] = JSON.parse(lines[i]);
      if (kind === 'o') events.push([t, data]);
    } catch { /* skip malformed */ }
  }
  const duration = events.length ? events[events.length - 1][0] : 0;

  const term = new Terminal({
    rows: header.height || 24, cols: header.width || 80, scrollback: 5000,
    fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 13,
    theme: termTheme(), disableStdin: true, convertEol: false,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  let idx = 0;
  let playing = false;
  let baseWall = 0;     // performance.now() when playback (re)started
  let baseCast = 0;     // cast time at that moment
  let speed = 1;
  let raf = null;

  const timeLabel = el('span', { class: 'muted', text: `0:00 / ${fmt(duration)}` });
  const bar = el('div', { class: 'rec-bar' }, el('div', { class: 'rec-bar-fill' }));
  const playBtn = el('button', { onclick: toggle }, 'play');
  const speedBtn = el('button', { title: 'playback speed', onclick: () => {
    speed = speed >= 4 ? 1 : speed * 2;
    speedBtn.textContent = `${speed}x`;
    if (playing) { baseWall = performance.now(); baseCast = castTime(); }
  } }, '1x');

  const termHost = el('div', { class: 'rec-term' });
  host.replaceChildren(
    el('div', { class: 'rec-controls' },
      playBtn,
      el('button', { title: 'restart', onclick: () => seek(0) }, 'restart'),
      speedBtn, timeLabel, bar,
      el('span', { class: 'rec-title muted', text: rec.title || rec.name })),
    termHost);
  term.open(termHost);
  requestAnimationFrame(() => fit.fit());

  bar.addEventListener('click', (e) => {
    const r = bar.getBoundingClientRect();
    seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration);
  });

  function castTime() { return baseCast + ((performance.now() - baseWall) / 1000) * speed; }
  function fmt(s) { const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }

  // Render all events up to time `t` from scratch (used for seeking).
  function renderUpTo(t) {
    term.reset();
    let i = 0;
    while (i < events.length && events[i][0] <= t) { term.write(events[i][1]); i++; }
    idx = i;
  }

  function seek(t) {
    t = Math.max(0, Math.min(t, duration));
    renderUpTo(t);
    baseCast = t; baseWall = performance.now();
    updateUi(t);
    if (!playing && t < duration) { /* stay paused */ }
  }

  function updateUi(t) {
    timeLabel.textContent = `${fmt(t)} / ${fmt(duration)}`;
    bar.firstChild.style.width = `${duration ? (t / duration) * 100 : 0}%`;
  }

  function loop() {
    if (!playing) return;
    const t = castTime();
    while (idx < events.length && events[idx][0] <= t) { term.write(events[idx][1]); idx++; }
    updateUi(Math.min(t, duration));
    if (t >= duration) { pause(); updateUi(duration); return; }
    raf = requestAnimationFrame(loop);
  }

  function start() {
    if (idx >= events.length) { renderUpTo(0); }
    playing = true; playBtn.textContent = 'pause';
    baseWall = performance.now(); baseCast = idx ? events[idx - 1][0] : 0;
    raf = requestAnimationFrame(loop);
  }
  function pause() {
    playing = false; playBtn.textContent = 'play';
    if (raf) cancelAnimationFrame(raf);
  }
  function toggle() { playing ? pause() : start(); }

  updateUi(0);
  start();

  return { stop: () => { pause(); term.dispose(); } };
}
