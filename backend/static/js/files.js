// Per-container filesystem browser, chunked uploads with
// progress, tar.gz directory downloads, small-file editor with mutual
// edit warnings, bookmarks, and inline actions.

import { api, client, el, fmtBytes, qsClient, sessionLabel, toast } from './util.js';
import { on } from './state.js';
import { addTab, focusOrBlink } from './tabs.js';

const CHUNK = 8 * 1024 * 1024;   // upload slice size

const TYPE_ICONS = { dir: '📁', file: '📄', link: '🔗', block: '💽', char: '💽',
                     fifo: '⏩', socket: '🔌' };

function joinPath(dir, name) {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

function parentOf(path) {
  const clean = path.replace(/\/+$/, '');
  const parent = clean.slice(0, clean.lastIndexOf('/'));
  return parent || '/';
}

// Poor-man's syntax highlighting for the read-only viewer.
function highlight(text) {
  const out = document.createElement('pre');
  out.className = 'code-view';
  for (const line of text.split('\n')) {
    const div = document.createElement('div');
    if (/^\s*(#|\/\/|--|;)/.test(line)) div.className = 'hl-comment';
    else if (/^\s*[[{]?"?[\w.-]+"?\s*[:=]/.test(line)) div.className = 'hl-key';
    div.textContent = line || ' ';
    out.append(div);
  }
  return out;
}

export function openFiles(namespace, pod, container, startPath = '/') {
  const target = `${namespace}/${pod}/${container}`;
  const tabId = `files-${target}`;
  if (focusOrBlink(tabId)) return;
  const base = `/api/fs/${namespace}/${pod}/${container}`;
  const bookmarkKey = `tifera.bookmarks.${target}`;
  let path = startPath;
  let editing = null;   // path currently open in the editor

  const pathInput = el('input', { class: 'path-input', value: path,
    onkeydown: (e) => { if (e.key === 'Enter') load(pathInput.value.trim() || '/'); } });
  const crumbs = el('div', { class: 'crumbs' });
  const tbody = el('tbody');
  const progress = el('div', { class: 'progress hidden' });
  const editorHost = el('div', { class: 'editor-overlay hidden' });

  const bookmarkSel = el('select', { class: 'bookmark-select' });
  function bookmarks() {
    try { return JSON.parse(localStorage.getItem(bookmarkKey) || '[]'); }
    catch { return []; }
  }
  function renderBookmarks() {
    bookmarkSel.replaceChildren(
      el('option', { value: '', text: 'bookmarks…' }),
      ...bookmarks().map((b) => el('option', { value: b, text: b })));
  }
  bookmarkSel.addEventListener('change', () => {
    if (bookmarkSel.value) load(bookmarkSel.value);
    bookmarkSel.value = '';
  });

  const fileInput = el('input', { type: 'file', multiple: true, class: 'hidden' });
  fileInput.addEventListener('change', () => uploadFiles(fileInput.files));

  const toolbar = el('div', { class: 'fs-toolbar' },
    el('span', { class: 'target-label', text: target }),
    el('button', { text: '⬆ up', onclick: () => load(parentOf(path)) }),
    el('button', { text: '⟳', title: 'refresh', onclick: () => load(path) }),
    pathInput,
    el('button', { text: '★', title: 'bookmark this path', onclick: () => {
      const b = bookmarks();
      if (!b.includes(path)) { b.push(path); localStorage.setItem(bookmarkKey, JSON.stringify(b)); }
      renderBookmarks();
      toast(`bookmarked ${path}`, 'info', 2000);
    } }),
    bookmarkSel,
    el('button', { text: '+ dir', onclick: async () => {
      const name = window.prompt('new directory name:');
      if (!name) return;
      await op({ op: 'mkdir', path: joinPath(path, name) });
    } }),
    el('button', { text: '⇧ upload', onclick: () => fileInput.click() }),
    el('a', { text: '⇩ dir as tar.gz', class: 'button',
              href: `${base}/download?path=${encodeURIComponent(path)}&dir=1&${qsClient()}` }),
    fileInput);

  const table = el('table', { class: 'fs-table' },
    el('thead', {}, el('tr', {},
      el('th', { text: 'name' }), el('th', { text: 'size' }),
      el('th', { text: 'perms' }), el('th', { text: 'owner' }),
      el('th', { text: 'modified' }), el('th', { text: '' }))),
    tbody);

  const root = el('div', { class: 'fs-root' }, toolbar, crumbs, progress,
                  el('div', { class: 'fs-scroll' }, table), editorHost);

  root.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('droptarget'); });
  root.addEventListener('dragleave', () => root.classList.remove('droptarget'));
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    root.classList.remove('droptarget');
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });

  async function op(body) {
    try {
      await api(`${base}/op?${qsClient()}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await load(path);
    } catch (e) {
      toast(`${body.op} failed: ${e.message}`, 'error');
    }
  }

  async function uploadFiles(files) {
    for (const file of files) {
      const dest = joinPath(path, file.name);
      progress.classList.remove('hidden');
      try {
        for (let off = 0; off < file.size || off === 0; off += CHUNK) {
          const slice = file.slice(off, off + CHUNK);
          const last = off + CHUNK >= file.size;
          progress.textContent =
            `uploading ${file.name}: ${Math.min(100, Math.round(100 * off / (file.size || 1)))}%`;
          await api(`${base}/upload?path=${encodeURIComponent(dest)}&append=${off ? 1 : 0}` +
                    `&final=${last ? 1 : 0}&total=${file.size}&${qsClient()}`,
                    { method: 'POST', body: slice });
          if (last) break;
        }
        toast(`uploaded ${file.name} (${fmtBytes(file.size)})`, 'info', 3000);
      } catch (e) {
        toast(`upload of ${file.name} failed: ${e.message}`, 'error');
        break;
      }
    }
    progress.classList.add('hidden');
    await load(path);
  }

  function renderCrumbs() {
    const parts = path.split('/').filter(Boolean);
    const items = [el('button', { text: '/', onclick: () => load('/') })];
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      const p = acc;
      items.push(el('span', { text: '›' }),
                 el('button', { text: part, onclick: () => load(p) }));
    }
    crumbs.replaceChildren(...items);
  }

  function row(entry) {
    const full = joinPath(path, entry.name);
    const nameCell = el('td', { class: `fs-name ${entry.type}` },
      `${TYPE_ICONS[entry.type] || '📄'} ${entry.name}`,
      entry.linkTarget ? el('span', { class: 'muted', text: ` → ${entry.linkTarget}` }) : null);
    const actions = el('td', { class: 'fs-actions' },
      entry.type !== 'dir'
        ? el('a', { text: '⇩', title: 'download', class: 'button',
                    href: `${base}/download?path=${encodeURIComponent(full)}&${qsClient()}` })
        : el('a', { text: '⇩', title: 'download as tar.gz', class: 'button',
                    href: `${base}/download?path=${encodeURIComponent(full)}&dir=1&${qsClient()}` }),
      entry.type === 'file'
        ? el('button', { text: '👁', title: 'view', onclick: () => openViewer(full) }) : null,
      entry.type === 'file'
        ? el('button', { text: '✎', title: 'edit', onclick: () => openEditor(full) }) : null,
      el('button', { text: '↔', title: 'rename', onclick: () => {
        const to = window.prompt(`rename ${entry.name} to (full path):`, full);
        if (to && to !== full) op({ op: 'rename', path: full, to });
      } }),
      el('button', { text: '⛓', title: 'chmod', onclick: () => {
        const mode = window.prompt(`chmod ${entry.name} (e.g. 644, u+x):`, '');
        if (mode) op({ op: 'chmod', path: full, mode });
      } }),
      el('button', { text: '🗑', title: 'delete', class: 'danger', onclick: () => {
        if (window.confirm(`delete ${full}${entry.type === 'dir' ? ' (recursively)' : ''}?`)) {
          op({ op: 'delete', path: full });
        }
      } }));
    const tr = el('tr', {},
      nameCell,
      el('td', { text: entry.type === 'dir' ? '–' : fmtBytes(entry.size) }),
      el('td', { class: 'mono', text: entry.perms }),
      el('td', { class: 'mono', text: `${entry.uid}:${entry.gid}` }),
      el('td', { text: entry.mtimeText }),
      actions);
    tr.addEventListener('dblclick', () => {
      if (entry.type === 'dir') load(full);
      else if (entry.type === 'link' && entry.linkTarget) {
        load(entry.linkTarget.startsWith('/') ? entry.linkTarget : joinPath(path, entry.linkTarget));
      } else openViewer(full);
    });
    return tr;
  }

  async function load(p) {
    try {
      const r = await api(`${base}/list?path=${encodeURIComponent(p)}`);
      path = p;
      pathInput.value = p;
      renderCrumbs();
      const entries = r.entries.sort((a, b) =>
        (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
      tbody.replaceChildren(...entries.map(row));
    } catch (e) {
      toast(`cannot list ${p}: ${e.message}`, 'error');
    }
  }

  async function editorSession(action, p) {
    try {
      const r = await api('/api/editor', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, namespace, pod, container, path: p,
                               clientId: client.id, clientName: client.name }),
      });
      return r.others || [];
    } catch { return []; }
  }

  function closeOverlay() {
    if (editing) { editorSession('close', editing); editing = null; }
    editorHost.classList.add('hidden');
    editorHost.replaceChildren();
  }

  async function openViewer(p) {
    try {
      const r = await api(`${base}/file?path=${encodeURIComponent(p)}`);
      editorHost.replaceChildren(
        el('div', { class: 'editor-bar' },
          el('span', { class: 'target-label', text: `${p} (read-only)` }),
          el('button', { text: 'edit', onclick: () => openEditor(p) }),
          el('button', { text: 'close', onclick: closeOverlay })),
        highlight(r.text));
      editorHost.classList.remove('hidden');
    } catch (e) {
      toast(`cannot view ${p}: ${e.message}`, 'error');
    }
  }

  async function openEditor(p) {
    let r;
    try {
      r = await api(`${base}/file?path=${encodeURIComponent(p)}`);
    } catch (e) {
      toast(`cannot edit ${p}: ${e.message}`, 'error');
      return;
    }
    let mtime = r.mtime ?? -1;
    editing = p;
    const others = await editorSession('open', p);
    const warn = el('div', { class: `term-banner ${others.length ? '' : 'hidden'}` });
    const setWarn = (editors) => {
      if (!editors.length) { warn.classList.add('hidden'); return; }
      warn.textContent =
        `⚠ ${[...new Set(editors.map(sessionLabel))].join(', ')} is editing this file too`;
      warn.classList.remove('hidden');
    };
    setWarn(others);
    if (others.length) {
      toast(`${[...new Set(others.map(sessionLabel))].join(', ')} already has this file open in the editor`, 'warn');
    }

    const area = el('textarea', { class: 'editor-area', spellcheck: 'false' });
    area.value = r.text;
    const save = async (force) => {
      try {
        const resp = await api(
          `${base}/file?path=${encodeURIComponent(p)}&mtime=${mtime}&force=${force ? 1 : 0}&${qsClient()}`,
          { method: 'PUT', body: area.value });
        mtime = resp.mtime ?? -1;
        toast(`saved ${p}`, 'info', 2500);
        load(path);
      } catch (e) {
        if (e.status === 409 && window.confirm(
            'This file changed underneath you since you opened it. Overwrite anyway?')) {
          save(true);
        } else if (e.status !== 409) {
          toast(`save failed: ${e.message}`, 'error');
        }
      }
    };
    editorHost.replaceChildren(
      el('div', { class: 'editor-bar' },
        el('span', { class: 'target-label', text: p }),
        el('button', { text: '💾 save', onclick: () => save(false) }),
        el('button', { text: 'close', onclick: closeOverlay })),
      warn, area);
    editorHost.classList.remove('hidden');
    area.focus();

    on('editor', (m) => {
      if (m.target !== target || m.path !== p || editing !== p) return;
      const rest = (m.editors || []).filter((x) => x.clientId !== client.id);
      setWarn(rest);
    });
  }

  addTab({
    id: tabId,
    title: `📁 ${container}`,
    kind: 'files',
    el: root,
    onClose: closeOverlay,
  });
  renderBookmarks();
  load(path);
}
