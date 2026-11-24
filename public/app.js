'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (n) => n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const ICONS = {
  photo: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
  albums: 'M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z',
  upload: 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z',
  admin: 'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z',
  play: 'M8 5v14l11-7z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  left: 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  right: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[n]}"/></svg>`;

async function api(path, { json, method, body } = {}) {
  const opts = { credentials: 'same-origin', method, body };
  if (json !== undefined) {
    opts.method = method || 'POST';
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(json);
  }
  const r = await fetch(path, opts);
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  if (!r.ok) throw Object.assign(new Error(data?.message || r.statusText), { status: r.status });
  return data;
}

let me = null;
let tab = 'photos';
let albumPath = '';
let queue = [];               // [{file, state: 'wait'|'up'|'done'|'err', msg, note}]
let sharedFromCache = false;  // queue came from the Android share sheet
let onQueueChange = null;     // set by the upload view while it is on screen
let needsSetup = false;       // no users yet: the first registration creates the admin
const up = { running: false, idx: 0, total: 0, pct: 0, msg: '' };

const root = $('#app');
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const fileUrl = (p) => '/files/' + encPath(p);
const thumbUrl = (p, size) => `/api/thumb?path=${encodeURIComponent(p)}${size ? '&size=' + size : ''}`;
const extOf = (n) => (n.includes('.') ? n.split('.').pop() : '').slice(0, 5);
const base = (p) => p.split('/').pop();

// ---------- boot ----------
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { me = await api('/api/me'); } catch { me = null; }
  if (me) await loadShared();
  else needsSetup = await api('/api/setup-status').then((r) => r.needsSetup).catch(() => false);
  render();
}

async function loadShared() {
  if (!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', '/');
  try {
    const cache = await caches.open('shared');
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('x-name') || 'shared-file');
      queue.push({ file: new File([blob], name, { type: blob.type, lastModified: Date.now() }), state: 'wait' });
    }
    sharedFromCache = queue.length > 0;
    tab = 'upload';
  } catch { /* ignore */ }
}

function render() {
  onQueueChange = null;
  if (!me) return renderLogin();
  const tabs = [['photos', 'photo', 'Photos'], ['albums', 'albums', 'Albums']];
  if (me.isAdmin) tabs.push(['admin', 'admin', 'Admin']);
  const titles = { photos: 'Photos', albums: 'Albums', upload: 'Upload', account: 'Account', admin: 'Admin' };
  root.innerHTML = `
    <header class="topbar">
      <div class="title"><span>${titles[tab]}</span></div>
      <button class="iconbtn" id="b-up" aria-label="Upload">${icon('upload')}</button>
      <button class="iconbtn" id="b-acc" aria-label="Account"><span class="avatar">${esc(me.username[0].toUpperCase())}</span></button>
    </header>
    <main id="view" class="page ${tab === 'photos' || tab === 'albums' ? 'wide' : ''}"></main>
    <div class="pill" id="pill" hidden></div>
    <nav class="tabs">${tabs.map(([k, ic, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${icon(ic)}${l}</button>`).join('')}</nav>`;
  root.querySelectorAll('nav.tabs button').forEach((b) => b.onclick = () => { tab = b.dataset.tab; if (tab === 'albums') albumPath = ''; render(); });
  $('#b-up').onclick = () => { tab = 'upload'; render(); };
  $('#b-acc').onclick = () => { tab = 'account'; render(); };
  updatePill();
  const view = $('#view');
  const fn = { photos: viewPhotos, albums: viewAlbums, upload: viewUpload, account: viewAccount, admin: viewAdmin }[tab];
  Promise.resolve(fn(view)).catch((e) => {
    if (e.status === 401) { me = null; render(); } else view.innerHTML = `<p class="err" style="padding:16px">${esc(e.message)}</p>`;
  });
}

function renderLogin() {
  const setup = needsSetup;
  root.innerHTML = `
    <div class="login">
      <div class="logo">${icon('photo')}</div>
      <h1>${setup ? 'Welcome' : 'Photos'}</h1>
      <p class="muted">${setup ? 'Create the admin account to get started. It can add other users and choose which folders they can see.' : 'Sign in to continue'}</p>
      <form id="f" class="card">
        <label>Username</label><input type="text" name="username" autocomplete="username" autocapitalize="none" required>
        <label>Password${setup ? ' (min 8 characters)' : ''}</label><input type="password" name="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required ${setup ? 'minlength="8"' : ''}>
        ${setup ? '<label>Confirm password</label><input type="password" name="confirm" autocomplete="new-password" required>' : ''}
        <p class="err" id="e"></p>
        <button class="full">${setup ? 'Create admin account' : 'Sign in'}</button>
      </form>
    </div>`;
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const body = { username: fd.get('username'), password: fd.get('password') };
    try {
      if (setup) {
        if (fd.get('password') !== fd.get('confirm')) throw new Error("Passwords don't match");
        await api('/api/setup', { json: body });
        needsSetup = false;
      } else await api('/api/login', { json: body });
      me = await api('/api/me');
      tab = 'photos';
      render();
    } catch (e) {
      $('#e').textContent = e.message;
      if (e.status === 409) { needsSetup = false; renderLogin(); } // someone else finished setup first
    }
  };
}

function updatePill() {
  const pill = $('#pill');
  if (!pill) return;
  if (up.running) {
    const overall = Math.round(((up.idx + up.pct / 100) / up.total) * 100);
    pill.hidden = false;
    pill.innerHTML = `Uploading ${Math.min(up.idx + 1, up.total)} of ${up.total}<div class="bar"><i style="width:${overall}%"></i></div>`;
  } else if (up.msg) {
    pill.hidden = false;
    pill.textContent = up.msg;
  } else pill.hidden = true;
}

// ---------- gallery ----------
function dayLabel(t) {
  const d = new Date(t), now = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

// items: [{p: 'Folder/Sub/file.jpg', t: ms, s: bytes, k: 'i'|'h'|'v'|'o'}], already newest-first
function renderGallery(el, items) {
  if (!items.length) {
    el.innerHTML = `<div class="empty">${icon('photo')}<p>Nothing here yet</p></div>`;
    return;
  }
  el.innerHTML = '<div id="g"></div><div class="sentinel" id="s"></div>';
  const g = $('#g', el);
  const viewable = items.filter((x) => x.k !== 'o');
  const vIndex = new Map(viewable.map((x, i) => [x, i]));
  const CHUNK = 240;
  let i = 0, lastKey = null, grid = null;

  const videoObs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const v = e.target; videoObs.unobserve(v);
      v.src = v.dataset.src;
    }
  }, { rootMargin: '300px' });

  const tileHtml = (x, idx) => {
    if (x.k === 'i' || x.k === 'h') return `<button class="tile" data-i="${idx}"><img loading="lazy" decoding="async" alt="" src="${thumbUrl(x.p)}"></button>`;
    if (x.k === 'v') return `<button class="tile" data-i="${idx}"><video muted playsinline preload="metadata" data-src="${fileUrl(x.p)}#t=0.1"></video><span class="badge">${icon('play')}</span></button>`;
    return `<button class="tile" data-i="${idx}"><span class="ext">${esc(extOf(base(x.p)) || 'file')}</span></button>`;
  };

  const more = () => {
    const end = Math.min(i + CHUNK, items.length);
    for (; i < end; i++) {
      const x = items[i];
      const key = new Date(x.t).toDateString();
      if (key !== lastKey) {
        lastKey = key;
        const h = document.createElement('div'); h.className = 'day'; h.textContent = dayLabel(x.t);
        grid = document.createElement('div'); grid.className = 'grid';
        g.append(h, grid);
      }
      grid.insertAdjacentHTML('beforeend', tileHtml(x, i));
    }
    g.querySelectorAll('video[data-src]:not([src])').forEach((v) => videoObs.observe(v));
    if (i >= items.length) sentinelObs.disconnect();
  };
  const sentinelObs = new IntersectionObserver((e) => { if (e[0].isIntersecting) more(); }, { rootMargin: '1500px' });
  sentinelObs.observe($('#s', el));
  more();

  g.addEventListener('load', (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('ld'); }, true);
  g.addEventListener('loadeddata', (e) => e.target.classList.add('ld'), true);
  g.addEventListener('error', (e) => {
    const tile = e.target.closest?.('.tile');
    if (tile && e.target.tagName === 'IMG') tile.innerHTML = `<span class="ext">${esc(extOf(base(items[tile.dataset.i].p)) || 'img')}</span>`;
  }, true);
  g.onclick = (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const x = items[Number(tile.dataset.i)];
    if (x.k === 'o') window.open(fileUrl(x.p), '_blank', 'noopener');
    else openLightbox(viewable, vIndex.get(x));
  };
}

// ---------- lightbox ----------
let lb = null;
function openLightbox(list, start) {
  if (lb) return;
  let i = start;
  const el = document.createElement('div');
  el.className = 'lb';
  el.innerHTML = `
    <div class="lb-top">
      <button class="iconbtn" data-a="close" aria-label="Close">${icon('close')}</button>
      <div class="meta"><div id="lb-n"></div><small id="lb-d"></small></div>
      <a class="iconbtn" id="lb-dl" download aria-label="Download original">${icon('download')}</a>
    </div>
    <div class="lb-stage" id="lb-s"></div>
    <button class="iconbtn lb-nav prev" data-a="prev" aria-label="Previous">${icon('left')}</button>
    <button class="iconbtn lb-nav next" data-a="next" aria-label="Next">${icon('right')}</button>`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  history.pushState({ lb: 1 }, '');

  const show = (n) => {
    i = (n + list.length) % list.length;
    const x = list[i];
    $('#lb-n', el).textContent = base(x.p);
    $('#lb-d', el).textContent = new Date(x.t).toLocaleString() + ' · ' + fmtSize(x.s);
    const dl = $('#lb-dl', el); dl.href = fileUrl(x.p); dl.setAttribute('download', base(x.p));
    const stage = $('#lb-s', el);
    stage.innerHTML = '<div class="spin"></div>';
    const done = () => $('.spin', stage)?.remove();
    if (x.k === 'v') {
      const v = document.createElement('video');
      v.controls = true; v.autoplay = true; v.playsInline = true; v.src = fileUrl(x.p);
      v.onloadeddata = done;
      v.onerror = () => { stage.innerHTML = `<div class="lb-fallback">This video can't be played in the browser.<br><a href="${fileUrl(x.p)}" download>Download it</a></div>`; };
      stage.appendChild(v);
    } else {
      const img = new Image();
      img.alt = '';
      img.onload = done;
      img.onerror = () => { stage.innerHTML = `<div class="lb-fallback">Couldn't show this image.<br><a href="${fileUrl(x.p)}" download>Download the original</a></div>`; };
      img.src = /\.gif$/i.test(x.p) ? fileUrl(x.p) : thumbUrl(x.p, 'l');
      stage.appendChild(img);
    }
    for (const d of [1, -1]) { // warm the neighbours
      const nx = list[(i + d + list.length) % list.length];
      if (nx && nx.k !== 'v') new Image().src = thumbUrl(nx.p, 'l');
    }
  };

  const close = (fromPop) => {
    if (!lb) return;
    lb = null;
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
    el.remove();
    if (!fromPop && history.state?.lb) history.back();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(i - 1);
    else if (e.key === 'ArrowRight') show(i + 1);
  };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'close') close();
    else if (a === 'prev') show(i - 1);
    else if (a === 'next') show(i + 1);
  });
  let sx = 0, sy = 0;
  el.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (e.target.closest('video[controls]') && Math.abs(dx) < 80) return;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 80) show(i + (dx < 0 ? 1 : -1));
    else if (dy > 110 && Math.abs(dx) < 60) close();
  }, { passive: true });
  lb = { close };
  show(i);
}
window.addEventListener('popstate', () => { if (lb) lb.close(true); });

// ---------- views: photos / albums ----------
async function viewPhotos(el) {
  el.innerHTML = '<div class="empty"><p>Loading…</p></div>';
  const { items } = await api('/api/timeline');
  renderGallery(el, items.filter((x) => x.k !== 'o'));
}

async function viewAlbums(el) {
  const data = await api('/api/list?path=' + encodeURIComponent(albumPath));
  const parts = albumPath.split('/').filter(Boolean);
  const crumbs = parts.length
    ? `<div class="crumbs"><a href="#" data-p="">Albums</a>${parts.map((p, i) => ` / <a href="#" data-p="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`).join('')}</div>`
    : '';
  el.innerHTML = `${crumbs}
    ${data.dirs.length ? `<div class="albums">${data.dirs.map((d) => {
      const inf = data.info?.[d] || {};
      const cover = inf.cover ? `<img loading="lazy" decoding="async" alt="" src="${thumbUrl(inf.cover)}">` : '';
      const n = inf.count ?? 0;
      return `<button class="album" data-p="${esc([...parts, d].join('/'))}"><span class="cover">${icon('folder')}${cover}</span><b>${esc(d)}</b><small>${n} item${n === 1 ? '' : 's'}</small></button>`;
    }).join('')}</div>` : ''}
    <div id="gal"></div>
    ${!parts.length && !data.dirs.length ? `<div class="empty">${icon('albums')}<p>No albums yet</p></div>` : ''}`;
  el.querySelectorAll('[data-p]').forEach((a) => a.onclick = (ev) => { ev.preventDefault(); albumPath = a.dataset.p; render(); });
  el.addEventListener('load', (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('ld'); }, true);
  el.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);
  if (parts.length) {
    const items = data.files.map((f) => ({ p: [...parts, f.name].join('/'), t: Math.round(f.mtime), s: f.size, k: f.k }));
    if (items.length) renderGallery($('#gal', el), items);
    else if (!data.dirs.length) $('#gal', el).innerHTML = `<div class="empty">${icon('photo')}<p>This album is empty</p></div>`;
  }
}

// ---------- upload ----------
function uploadOne(target, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?folder=${encodeURIComponent(target)}&mtime=${file.lastModified || 0}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
      if (xhr.status === 401) me = null;
      reject(new Error(xhr.status === 401 ? 'Signed out, please sign in again' : body?.message || 'Upload failed'));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    const fd = new FormData();
    fd.append('file', file, file.name);
    xhr.send(fd);
  });
}

async function startUploads(target) {
  if (up.running) return;
  const todo = queue.filter((q) => q.state === 'wait' || q.state === 'err');
  if (!todo.length) return;
  Object.assign(up, { running: true, idx: 0, total: todo.length, pct: 0, msg: '' });
  const lock = await navigator.wakeLock?.request('screen').catch(() => null);
  let ok = 0;
  for (const q of todo) {
    q.state = 'up'; up.pct = 0; updatePill(); onQueueChange?.();
    try {
      const r = await uploadOne(target, q.file, (pct) => { up.pct = pct; updatePill(); });
      const s = r?.saved?.[0];
      q.state = 'done'; q.note = s?.converted ? 'converted to JPG' : s?.warning || '';
      ok++;
    } catch (e) { q.state = 'err'; q.msg = e.message; }
    up.idx++; onQueueChange?.();
  }
  lock?.release?.();
  up.running = false;
  up.msg = ok === todo.length ? `✓ ${ok} uploaded` : `${ok} of ${todo.length} uploaded, ${todo.length - ok} failed`;
  updatePill();
  setTimeout(() => { up.msg = ''; updatePill(); }, 4000);
  if (sharedFromCache && queue.every((q) => q.state === 'done')) { caches.delete('shared'); sharedFromCache = false; }
  setTimeout(() => { queue = queue.filter((q) => q.state !== 'done'); onQueueChange?.(); }, 3000);
  if (!me) render();
  else if ((tab === 'photos' || tab === 'albums') && !lb) render();
}

async function viewUpload(el) {
  const folders = (await api('/api/folders')).filter((f) => f.level === 'upload');
  if (!folders.length) {
    el.innerHTML = `<h1>Upload</h1><p class="muted">You don't have upload access to any folder yet. Ask the admin.</p>`;
    return;
  }
  const lastFolder = store.get('folder');
  el.innerHTML = `
    <h1>Upload</h1>
    ${sharedFromCache ? `<div class="banner">📤 ${queue.length} item(s) shared to this app. Pick a folder and tap Upload.</div>` : ''}
    <div class="card">
      <label>Folder</label>
      <select id="folder">${folders.map((f) => `<option ${f.name === lastFolder ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
      <label>Sub-folder</label>
      <select id="sub"></select>
      <input type="text" id="newsub" placeholder="New sub-folder name" hidden style="margin-top:8px">
    </div>
    <div class="card">
      <label class="btn secondary full" style="margin:0">Choose photos / videos
        <input id="pick" type="file" multiple accept="image/*,video/*,.heic,.heif" hidden>
      </label>
      <div id="q"></div>
      <p class="err" id="e"></p>
      <button id="go" class="full">Upload</button>
      <p class="muted" style="margin:10px 0 0">HEIC photos are converted to JPG on the server.</p>
    </div>`;

  const fillSub = () => {
    const f = folders.find((x) => x.name === $('#folder').value);
    const savedSub = store.get('sub:' + f.name) || '';
    $('#sub').innerHTML = `<option value="">(top level of ${esc(f.name)})</option>` +
      f.dirs.map((d) => `<option ${d === savedSub ? 'selected' : ''}>${esc(d)}</option>`).join('') +
      `<option value="__new">+ New sub-folder…</option>`;
    $('#newsub').hidden = true;
  };
  fillSub();
  $('#folder').onchange = fillSub;
  $('#sub').onchange = () => { $('#newsub').hidden = $('#sub').value !== '__new'; };

  const drawQueue = () => {
    if (!$('#q')) return;
    $('#q').innerHTML = queue.map((q) => `
      <div class="item"><div style="min-width:0;flex:1">
        <div class="name">${esc(q.file.name)}</div>
        <div class="muted">${fmtSize(q.file.size)}${q.state === 'up' ? ' · uploading…' : q.state === 'done' ? ` · <span class="ok">uploaded${q.note ? ' (' + esc(q.note) + ')' : ''}</span>` : q.state === 'err' ? ` · <span class="err">${esc(q.msg)}</span>` : ''}</div>
      </div></div>`).join('');
    $('#go').disabled = up.running || !queue.some((q) => q.state === 'wait' || q.state === 'err');
  };
  onQueueChange = drawQueue;
  drawQueue();

  $('#pick').onchange = (ev) => {
    for (const file of ev.target.files) queue.push({ file, state: 'wait' });
    ev.target.value = '';
    drawQueue();
  };

  $('#go').onclick = () => {
    const folder = $('#folder').value;
    let sub = $('#sub').value;
    if (sub === '__new') sub = $('#newsub').value.trim().replace(/[\/\\]/g, '-');
    if ($('#sub').value === '__new' && !sub) { $('#e').textContent = 'Enter a name for the new sub-folder'; return; }
    $('#e').textContent = '';
    store.set('folder', folder);
    store.set('sub:' + folder, sub);
    startUploads(sub ? `${folder}/${sub}` : folder);
    drawQueue();
  };
}

// ---------- account ----------
async function viewAccount(el) {
  const origin = location.origin;
  el.innerHTML = `
    <h1>${esc(me.username)}</h1>
    <form id="pw" class="card"><h3>Change password</h3>
      <label>Current password</label><input type="password" name="cur" autocomplete="current-password" required>
      <label>New password (min 8 characters)</label><input type="password" name="next" autocomplete="new-password" required minlength="8">
      <p class="err" id="pe"></p><button>Update password</button>
    </form>
    <div class="card"><h3>API token</h3>
      <p class="muted">Lets the iOS Shortcut (or a script) upload as you without a password. Generating a new token replaces the old one. It is shown only once.</p>
      <div id="tok"></div>
      <div class="row"><button id="gen">${me.hasToken ? 'Replace token' : 'Generate token'}</button>
      ${me.hasToken ? '<button id="rev" class="danger">Revoke</button>' : ''}</div>
    </div>
    <div class="card"><h3>iPhone: share straight from Photos</h3>
      <p class="muted">iOS can't add web apps to the share sheet, so install this Shortcut once. It uploads <b>any number of photos or videos</b>, one at a time, into the folder you pick.</p>
      <ol>
        <li>Generate your <b>API token</b> above and copy it.</li>
        <li>On your iPhone, tap <a class="btn" href="/Upload-to-server.shortcut" style="padding:6px 14px">Download Shortcut</a> and choose <b>Add Shortcut</b>.</li>
        <li>When asked for the server address enter <code>${esc(origin)}</code>, then paste your token.</li>
      </ol>
      <p class="muted">Then in Photos: select as many photos as you like → Share → <b>Upload to server</b> → pick the folder.</p>
      <details style="margin-top:10px"><summary class="muted">Build it by hand instead</summary>
      <ol>
        <li>Open <b>Shortcuts</b> → <b>+</b> → name it <b>Upload to server</b>.</li>
        <li>Tap <b>ⓘ</b> → turn on <b>Show in Share Sheet</b> and accept <b>Images</b> and <b>Media</b>.</li>
        <li><b>Get Contents of URL</b>: <code>${esc(origin)}/api/targets</code>, Method <b>GET</b>, Header <code>Authorization</code> = <code>Bearer YOUR_TOKEN</code>.</li>
        <li><b>Choose from List</b> (input: Contents of URL). This is where you pick the folder once for the whole batch.</li>
        <li><b>URL Encode</b> the <i>Chosen Item</i>.</li>
        <li><b>Repeat with Each</b> item in <i>Shortcut Input</i>, and inside the loop:
          <ol type="a">
            <li><b>Get Name</b> of <i>Repeat Item</i>, then <b>URL Encode</b> it.</li>
            <li><b>Get Contents of URL</b>: <code>${esc(origin)}/api/upload?folder=</code><i>Encoded folder</i><code>&amp;name=</code><i>Encoded name</i>, Method <b>POST</b>, Header <code>Authorization</code> = <code>Bearer YOUR_TOKEN</code>, Request Body <b>File</b> = <i>Repeat Item</i>.</li>
          </ol>
        </li>
        <li>After <b>End Repeat</b>: <b>Show Notification</b> "Uploaded".</li>
      </ol>
      </details>
      <p class="muted">Android: install this app (browser menu → Install app), then share photos from the gallery and choose <b>Photos</b>.</p>
    </div>
    <div class="card"><button id="out" class="secondary full">Sign out</button></div>`;

  $('#pw').onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      await api('/api/password', { json: { current: fd.get('cur'), next: fd.get('next') } });
      $('#pe').className = 'ok'; $('#pe').textContent = 'Password updated'; ev.target.reset();
    } catch (e) { $('#pe').className = 'err'; $('#pe').textContent = e.message; }
  };
  $('#gen').onclick = async () => {
    const { token } = await api('/api/token', { json: {} });
    me.hasToken = true;
    $('#tok').innerHTML = `<p>Copy it now:</p><pre>${esc(token)}</pre>`;
    $('#gen').textContent = 'Replace token';
  };
  if ($('#rev')) $('#rev').onclick = async () => { await api('/api/token', { method: 'DELETE' }); me.hasToken = false; render(); };
  $('#out').onclick = async () => { await api('/api/logout', { json: {} }); me = null; queue = []; render(); };
}

// ---------- admin ----------
async function viewAdmin(el) {
  const [users, folders] = await Promise.all([api('/api/admin/users'), api('/api/admin/folders')]);
  const ownerId = Math.min(...users.map((u) => u.id)); // the first admin: can't be demoted or deleted
  el.innerHTML = `
    <h1>Admin</h1>
    <h2>Folders</h2>
    <p class="muted">Every folder inside <code>/data</code>. Mount extra volumes as <code>/data/&lt;name&gt;</code> or create one here.</p>
    <div class="chips">${folders.map((f) => `<span class="chip">${esc(f)}</span>`).join('') || '<span class="muted">none yet</span>'}</div>
    <form id="nf" class="row"><input type="text" name="name" placeholder="New folder name" required><button>Create</button></form>
    <h2>Users</h2>
    ${users.map((u) => {
      const isOwner = u.id === ownerId, isSelf = u.username === me.username;
      const canEdit = !isOwner && !isSelf; // type change / delete
      return `
      <div class="card" data-id="${u.id}">
        <div class="row" style="justify-content:space-between"><strong>${esc(u.username)}${isSelf ? ' (you)' : ''}</strong>
          <span class="muted">${isOwner ? 'Owner · ' : ''}${u.hasToken ? 'has API token' : ''}</span></div>
        <label>User type</label>
        ${canEdit
          ? `<select data-type><option value="standard" ${u.isAdmin ? '' : 'selected'}>Standard user</option><option value="admin" ${u.isAdmin ? 'selected' : ''}>Admin</option></select>`
          : `<p style="margin:0">${u.isAdmin ? 'Admin' : 'Standard user'}</p>`}
        ${u.isAdmin ? '<p class="muted">Admins can manage users and folders and see every folder.</p>'
          : folders.length ? `<div class="perm-grid" style="margin:10px 0">${folders.map((f) => `
          <span>${esc(f)}</span>
          <select data-folder="${esc(f)}">
            ${[['', 'No access'], ['read', 'Read'], ['upload', 'Read & upload']].map(([v, l]) => `<option value="${v}" ${(u.perms[f] || '') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>`).join('')}</div>` : '<p class="muted">Create a folder first.</p>'}
        <div class="row">${u.isAdmin ? '' : '<button data-act="save">Save access</button>'}
          <button data-act="pw" class="secondary">Reset password</button>
          ${canEdit ? '<button data-act="del" class="danger">Delete</button>' : ''}</div>
        <p class="muted msg"></p>
      </div>`;
    }).join('')}
    <h3>Add user</h3>
    <form id="nu" class="card">
      <label>Username</label><input type="text" name="username" autocapitalize="none" required>
      <label>Password (min 8 characters)</label><input type="password" name="password" autocomplete="new-password" required minlength="8">
      <label>User type</label>
      <select name="type"><option value="standard">Standard user (choose folder access after)</option><option value="admin">Admin (full access, manages users)</option></select>
      <p class="err" id="ne"></p><button>Add user</button>
    </form>`;

  $('#nf').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api('/api/admin/folders', { json: { name: new FormData(ev.target).get('name') } }); render(); }
    catch (e) { alert(e.message); }
  };
  $('#nu').onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try { await api('/api/admin/users', { json: { username: fd.get('username'), password: fd.get('password'), type: fd.get('type') } }); render(); }
    catch (e) { $('#ne').textContent = e.message; }
  };
  el.querySelectorAll('.card[data-id]').forEach((card) => {
    const id = card.dataset.id, msg = $('.msg', card);
    card.onchange = async (ev) => {
      if (!ev.target.matches('select[data-type]')) return;
      try {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', json: { type: ev.target.value } });
        render();
      } catch (e) { msg.textContent = e.message; }
    };
    card.onclick = async (ev) => {
      const act = ev.target.dataset?.act;
      if (!act) return;
      try {
        if (act === 'save') {
          const perms = {};
          card.querySelectorAll('select[data-folder]').forEach((s) => { if (s.value) perms[s.dataset.folder] = s.value; });
          await api(`/api/admin/users/${id}/perms`, { method: 'PUT', json: { perms } });
          msg.textContent = 'Saved ✓';
        } else if (act === 'pw') {
          const password = prompt('New password (min 8 characters):');
          if (!password) return;
          await api(`/api/admin/users/${id}`, { method: 'PATCH', json: { password } });
          msg.textContent = 'Password reset ✓';
        } else if (act === 'del') {
          if (!confirm('Delete this user? Their uploaded files are kept.')) return;
          await api(`/api/admin/users/${id}`, { method: 'DELETE' });
          render();
        }
      } catch (e) { msg.textContent = e.message; }
    };
  });
}

boot();
