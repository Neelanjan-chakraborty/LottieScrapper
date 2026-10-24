// Lottie Scraper — side panel UI
/* global lottie, LottieScanner, LottieZip, LottieExtract */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const DEFAULTS = {
    mode: 'quick',
    embedImages: true,
    includeOriginals: true,
    minify: true,
    saveAs: false,
    autoplay: true,
    checker: false,
    maxPages: 15,
    maxScripts: 80,
    maxCandidates: 400
  };

  const state = {
    settings: { ...DEFAULTS },
    tab: null,
    scannedTab: null,
    items: [],
    selected: new Set(),
    filter: '',
    sort: 'found',
    scanCtrl: null,
    exportCtrl: null
  };

  // ---------------------------------------------------------------- utils
  const fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');
  const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : s.toFixed(s < 10 ? 2 : 1) + 's');
  const hostOf = (u) => { try { return new URL(u).hostname; } catch (_) { return ''; } };
  const sanitize = (s) => (s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/\s+/g, ' ').replace(/^[.\s-]+|[.\s-]+$/g, '').slice(0, 80);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const nameFor = (item, idx) => sanitize(item.baseName) || sanitize(item.meta.name) || `animation-${idx + 1}`;

  function primarySource(item) {
    if (item.dotLottie) return ['dotlottie', '.lottie'];
    const s = item.sources[0] || '';
    if (s.startsWith('runtime')) return ['runtime', 'Runtime'];
    if (s.includes('inline')) return ['inline', 'Inline'];
    if (s === 'network' || s === 'preload') return ['network', 'Network'];
    if (s === 'player') return ['network', 'Player'];
    if (s === 'script') return ['inline', 'Bundle'];
    if (s === 'crawl') return ['network', 'Crawl'];
    return ['', s.toUpperCase().slice(0, 7) || 'DOM'];
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ---------------------------------------------------------------- settings
  async function loadSettings() {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      state.settings = { ...DEFAULTS, ...(settings || {}) };
    } catch (_) {}
    $$('[data-setting]').forEach((el) => {
      const v = state.settings[el.dataset.setting];
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
    });
    setMode(state.settings.mode, false);
    document.body.classList.toggle('checker', state.settings.checker);
  }
  function saveSettings() {
    chrome.storage.local.set({ settings: state.settings }).catch(() => {});
  }
  $$('[data-setting]').forEach((el) => {
    el.addEventListener('change', () => {
      const key = el.dataset.setting;
      if (el.type === 'checkbox') state.settings[key] = el.checked;
      else {
        const n = Math.max(+el.min || 1, Math.min(+el.max || 9999, parseInt(el.value, 10) || DEFAULTS[key]));
        el.value = n;
        state.settings[key] = n;
      }
      if (key === 'checker') document.body.classList.toggle('checker', el.checked);
      if (key === 'autoplay') refreshPlayback();
      saveSettings();
    });
  });

  function setMode(mode, save = true) {
    state.settings.mode = mode;
    $$('.segmented button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    if (save) saveSettings();
  }
  $$('.segmented button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  // ---------------------------------------------------------------- tab tracking
  async function refreshTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tab = tab || null;
    $('#tabTitle').textContent = tab?.title || 'No page';
    $('#tabHost').textContent = tab?.url ? hostOf(tab.url) || tab.url.split(':')[0] : '';
    const fav = $('#favicon');
    if (tab?.favIconUrl && /^https?:|^data:/.test(tab.favIconUrl)) { fav.src = tab.favIconUrl; fav.style.visibility = ''; }
    else fav.style.visibility = 'hidden';
    if (tab) {
      chrome.runtime.sendMessage({ type: 'getDetected', tabId: tab.id }).then((r) => setDetected(r?.count || 0)).catch(() => setDetected(0));
    }
  }
  function setDetected(n) {
    $('#detectCount').textContent = n;
    $('#detector').classList.toggle('zero', !n);
  }
  chrome.tabs.onActivated.addListener(refreshTab);
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (id === state.tab?.id && (info.status === 'complete' || info.title || info.favIconUrl)) refreshTab();
  });
  setInterval(() => { if (state.tab && !document.hidden) refreshTab(); }, 4000);

  // ---------------------------------------------------------------- previews
  // Preview pool: performance + memory
  //  * cards near the viewport get a player, built one per idle slot (no long tasks while scrolling)
  //  * only cards actually on screen play; everything else is paused
  //  * at most MAX_LIVE players exist; the least-recently-seen off-screen ones are destroyed
  //  * each player parses its own copy from the item's JSON string (no retained object graphs)
  //  * thumbnails render at the animation's authored frame rate (no sub-frame interpolation)
  const MAX_LIVE = 32;
  const players = new Map(); // id -> { anim, lastSeen }
  const onScreen = new Set();
  const mountQueue = [];
  let mountScheduled = false;
  let gridPaused = false; // while the detail sheet covers the grid

  const nearIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const id = e.target.dataset.id;
      if (e.isIntersecting) queueMount(id);
      else {
        const i = mountQueue.indexOf(id);
        if (i !== -1) mountQueue.splice(i, 1);
      }
    }
  }, { rootMargin: '400px 0px' });

  const visIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const id = e.target.dataset.id;
      if (e.isIntersecting) onScreen.add(id); else onScreen.delete(id);
      const p = players.get(id);
      if (p) { p.lastSeen = performance.now(); applyPlayState(id, p); }
    }
  }, { rootMargin: '0px' });

  const idle = window.requestIdleCallback
    ? (cb, opts) => window.requestIdleCallback(cb, opts)
    : (cb) => setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 8 }), 16);

  function queueMount(id) {
    if (players.has(id) || mountQueue.includes(id)) return;
    // visible cards first
    if (onScreen.has(id)) mountQueue.unshift(id); else mountQueue.push(id);
    if (!mountScheduled) { mountScheduled = true; idle(pumpMounts, { timeout: 120 }); }
  }

  function pumpMounts(deadline) {
    mountScheduled = false;
    let budget = 2; // at most two builds per idle slot keeps frames under 16ms
    while (mountQueue.length && budget-- > 0 && (deadline.didTimeout || deadline.timeRemaining() > 4)) {
      const id = mountQueue.shift();
      const card = cardById.get(id);
      if (card && card.isConnected && !card.hidden) mountPreview(card, id);
    }
    if (mountQueue.length) { mountScheduled = true; idle(pumpMounts, { timeout: 120 }); }
  }

  function applyPlayState(id, p) {
    if (!p.ready) return;
    const shouldPlay = state.settings.autoplay && !gridPaused && !document.hidden && onScreen.has(id);
    if (shouldPlay) { if (p.anim.isPaused) p.anim.play(); }
    else if (!p.anim.isPaused || !p.posed) {
      if (state.settings.autoplay && p.posed) p.anim.pause();
      else { p.anim.goToAndStop(Math.floor(p.anim.totalFrames / 2), true); p.posed = true; }
    }
  }

  function evictIfNeeded() {
    if (players.size <= MAX_LIVE) return;
    const off = [...players.entries()].filter(([id]) => !onScreen.has(id)).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    while (players.size > MAX_LIVE && off.length) unmountPreview(off.shift()[0]);
  }

  function mountPreview(card, id) {
    if (players.has(id)) return;
    const item = itemById.get(id);
    if (!item) return;
    const holder = card.querySelector('.preview');
    holder.querySelector('.anim')?.remove();
    holder.querySelector('.err')?.remove();
    const box = document.createElement('div');
    box.className = 'anim';
    holder.appendChild(box);
    try {
      const anim = lottie.loadAnimation({
        container: box,
        renderer: 'svg',
        loop: true,
        autoplay: false,
        animationData: JSON.parse(item.json),
        rendererSettings: { preserveAspectRatio: 'xMidYMid meet', progressiveLoad: true, hideOnTransparent: true }
      });
      anim.setSubframe(false);
      const p = { anim, lastSeen: performance.now(), ready: false, posed: false };
      players.set(id, p);
      anim.addEventListener('DOMLoaded', () => {
        p.ready = true;
        holder.querySelector('.loading')?.remove();
        anim.goToAndStop(Math.floor(anim.totalFrames / 2), true);
        p.posed = true;
        applyPlayState(id, p);
      });
      anim.addEventListener('data_failed', () => showPreviewError(holder));
      evictIfNeeded();
    } catch (_) {
      showPreviewError(holder);
    }
  }
  function showPreviewError(holder) {
    holder.querySelector('.loading')?.remove();
    holder.querySelector('.anim')?.remove();
    if (!holder.querySelector('.err')) holder.insertAdjacentHTML('beforeend', '<div class="err">Preview unavailable<br>(export still works)</div>');
  }
  function unmountPreview(id) {
    const p = players.get(id);
    if (!p) return;
    try { p.anim.destroy(); } catch (_) {}
    players.delete(id);
    const holder = cardById.get(id)?.querySelector('.preview');
    if (holder) {
      holder.querySelector('.anim')?.remove();
      if (!holder.querySelector('.loading')) holder.insertAdjacentHTML('afterbegin', '<div class="loading"></div>');
    }
  }
  function remountPreview(id) {
    unmountPreview(id);
    if (cardById.has(id)) queueMount(id);
  }
  function refreshPlayback() {
    for (const [id, p] of players) applyPlayState(id, p);
  }
  document.addEventListener('visibilitychange', refreshPlayback);

  // ---------------------------------------------------------------- grid
  const grid = $('#grid');
  const itemById = new Map();
  const cardById = new Map();
  const displayName = (item) => item.name;

  function cardHtml(item) {
    const [cls, label] = primarySource(item);
    const m = item.meta;
    return `
      <div class="sel"><span class="box"></span></div>
      <span class="badge ${cls}">${esc(label)}</span>
      <div class="preview"><div class="loading"></div></div>
      <div class="quick">
        <button data-act="copy" title="Copy JSON"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>
        <button data-act="download" title="Download JSON"><svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg></button>
      </div>
      <div class="info">
        <div class="name" title="${esc(item.name)}">${esc(item.name)}</div>
        <div class="facts"><span>${m.width}×${m.height} · ${m.fps}fps</span><span class="sz">${fmtDur(m.duration)} · ${fmtBytes(item.size)}</span></div>
      </div>`;
  }

  // Cards arrive in bursts during a scan; build them in one fragment per frame.
  const pendingCards = [];
  let cardsScheduled = false;
  function enqueueCard(item) {
    pendingCards.push(item);
    if (!cardsScheduled) { cardsScheduled = true; requestAnimationFrame(flushCards); }
  }
  function flushCards() {
    cardsScheduled = false;
    const frag = document.createDocumentFragment();
    const built = [];
    for (const item of pendingCards.splice(0)) {
      const card = document.createElement('div');
      card.className = 'card' + (state.selected.has(item.id) ? ' selected' : '');
      card.dataset.id = item.id;
      card.innerHTML = cardHtml(item);
      if (!matchesFilter(item)) card.hidden = true;
      cardById.set(item.id, card);
      built.push(card);
      frag.appendChild(card);
    }
    grid.appendChild(frag); // empties the fragment — observe from `built`
    for (const card of built) observeCard(card);
    updateSelectionUi();
  }
  function observeCard(card) { nearIO.observe(card); visIO.observe(card); }

  function updateCard(item, how) {
    const card = cardById.get(item.id);
    if (!card) return;
    const [cls, label] = primarySource(item);
    const b = card.querySelector('.badge');
    b.className = 'badge ' + cls;
    b.textContent = label;
    if (how === 'replaced') {
      card.querySelector('.sz').textContent = `${fmtDur(item.meta.duration)} · ${fmtBytes(item.size)}`;
      if (players.has(item.id)) remountPreview(item.id);
      scheduleSelectionUi();
    }
  }

  function matchesFilter(item) {
    const q = state.filter;
    if (!q) return true;
    if (!item.haystack) item.haystack = [item.name, item.url, item.meta.name, item.sources.join(' '), `${item.meta.width}x${item.meta.height}`].join('\n').toLowerCase();
    return item.haystack.includes(q);
  }

  function visibleItems() {
    return state.filter ? state.items.filter(matchesFilter) : state.items;
  }

  function applyFilterSort() {
    const order = [...state.items];
    const by = {
      name: (a, b) => a.name.localeCompare(b.name),
      size: (a, b) => b.size - a.size,
      duration: (a, b) => b.meta.duration - a.meta.duration,
      layers: (a, b) => b.meta.layers - a.meta.layers
    }[state.sort];
    if (by) order.sort(by);
    const frag = document.createDocumentFragment();
    for (const item of order) {
      const card = cardById.get(item.id);
      if (!card) continue;
      card.hidden = !matchesFilter(item);
      frag.appendChild(card);
    }
    grid.appendChild(frag);
    updateSelectionUi();
  }

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filter = e.target.value.trim().toLowerCase(); applyFilterSort(); }, 120);
  });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; applyFilterSort(); });

  grid.addEventListener('click', async (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const item = itemById.get(card.dataset.id);
    if (!item) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'copy') return copyJson(item);
    if (act === 'download') return downloadJson(item);
    if (e.target.closest('.sel') || e.metaKey || e.ctrlKey || e.shiftKey) return toggleSelect(item.id);
    openDetail(item);
  });

  function toggleSelect(id, force, deferUi) {
    const on = force ?? !state.selected.has(id);
    if (on) state.selected.add(id); else state.selected.delete(id);
    cardById.get(id)?.classList.toggle('selected', on);
    if (!deferUi) scheduleSelectionUi();
  }

  $('#selectAll').addEventListener('change', (e) => {
    for (const i of visibleItems()) toggleSelect(i.id, e.target.checked, true);
    updateSelectionUi();
  });

  let selUiScheduled = false;
  function scheduleSelectionUi() {
    if (selUiScheduled) return;
    selUiScheduled = true;
    requestAnimationFrame(() => { selUiScheduled = false; updateSelectionUi(); });
  }

  function updateSelectionUi() {
    const vis = visibleItems();
    let selVisible = 0;
    for (const i of vis) if (state.selected.has(i.id)) selVisible++;
    let selCount = 0, size = 0;
    for (const i of state.items) if (state.selected.has(i.id)) { selCount++; size += i.size; }
    const all = $('#selectAll');
    all.checked = vis.length > 0 && selVisible === vis.length;
    all.indeterminate = selVisible > 0 && selVisible < vis.length;
    $('#countLabel').textContent = `${state.items.length} found`;
    $('#selCount').textContent = `${selCount} selected`;
    $('#selSize').textContent = selCount ? `≈ ${fmtBytes(size)} of JSON` : 'Select animations to export';
    $('#btnZip').disabled = !selCount;
    $('#btnJson').disabled = !selCount;
    $('#toolbar').hidden = !state.items.length;
    $('#dock').hidden = !state.items.length;
    $('#empty').hidden = !!state.items.length || !!state.scanCtrl;
  }

  // ---------------------------------------------------------------- scanning
  $('#btnScan').addEventListener('click', startScan);
  $('#btnCancel').addEventListener('click', () => state.scanCtrl?.abort());

  function resetResults() {
    for (const id of [...players.keys()]) unmountPreview(id);
    nearIO.disconnect();
    visIO.disconnect();
    onScreen.clear();
    mountQueue.length = 0;
    pendingCards.length = 0;
    grid.textContent = '';
    itemById.clear();
    cardById.clear();
    state.items = [];
    state.selected.clear();
  }

  async function startScan() {
    if (state.scanCtrl) return;
    await refreshTab();
    const tab = state.tab;
    if (!tab || !/^(https?|file):/.test(tab.url || '')) {
      showEmpty('error', 'This page can’t be scanned', 'Open a regular website (http/https) and try again. Browser pages and the Web Store are off-limits to extensions.');
      return;
    }
    resetResults();
    state.scannedTab = tab;
    state.scanCtrl = new AbortController();
    const btn = $('#btnScan');
    btn.classList.add('scanning');
    btn.disabled = true;
    $('span', btn).textContent = 'Scanning…';
    $('#progress').hidden = false;
    $('#empty').hidden = true;
    setProgress({ pct: 0, phase: 'Starting…', detail: '', stats: {} });

    try {
      const { items, stats } = await LottieScanner.scan(tab, state.settings, {
        signal: state.scanCtrl.signal,
        onProgress: setProgress,
        onFound: (item, how) => {
          if (how) return updateCard(item, how);
          item.name = nameFor(item, state.items.length);
          state.items.push(item);
          itemById.set(item.id, item);
          state.selected.add(item.id);
          enqueueCard(item);
        }
      });
      if (stats.hookMissing && items.some((i) => i.restored)) {
        toast('Tip: reload the page once so Lottie Scraper can capture original files directly');
      }
      const msg = items.length
        ? `Found ${items.length} animation${items.length === 1 ? '' : 's'}`
        : 'No Lottie animations found';
      if (!(stats.hookMissing && items.some((i) => i.restored))) toast(stats.errors && items.length ? `${msg} · ${stats.errors} URL(s) skipped` : msg);
      if (!items.length) {
        showEmpty('', 'No Lottie animations found', state.settings.mode === 'quick'
          ? 'Try Deep mode to dig through script bundles and every JSON response, or Crawl to check linked pages.'
          : 'Nothing Lottie-shaped turned up. Some animations load only after you scroll or interact — do that, then scan again.');
      }
    } catch (e) {
      if (e instanceof LottieScanner.Cancelled || state.scanCtrl.signal.aborted) {
        toast(`Scan cancelled · kept ${state.items.length} result(s)`);
        if (!state.items.length) showEmpty('', 'Scan cancelled', 'Press Scan page to start again.');
      } else {
        console.error(e);
        showEmpty('error', 'Scan failed', e.message || String(e));
      }
    } finally {
      state.scanCtrl = null;
      btn.classList.remove('scanning');
      btn.disabled = false;
      $('span', btn).textContent = 'Scan again';
      setTimeout(() => { if (!state.scanCtrl) $('#progress').hidden = true; }, 900);
      applyFilterSort();
    }
  }

  // Progress can fire hundreds of times per second; paint at most once per frame.
  let progressState = null;
  let progressScheduled = false;
  function setProgress(st) {
    progressState = st;
    if (progressScheduled) return;
    progressScheduled = true;
    requestAnimationFrame(() => { progressScheduled = false; paintProgress(progressState); });
  }
  function paintProgress({ pct, phase, detail, stats }) {
    const p = Math.round(pct);
    $('#fill').style.width = p + '%';
    $('#pct').textContent = p + '%';
    $('#phase').textContent = phase;
    $('#detail').textContent = detail || '';
    const s = stats || {};
    const chip = (label, v, hot) => (v ? `<span class="chip${hot ? ' hot' : ''}"><b>${v}</b> ${label}</span>` : '');
    $('#chips').innerHTML =
      chip('found', s.found, true) + chip('frames', s.frames) + chip('pages', s.pages) +
      chip('scripts', s.scripts) + (s.candidates ? `<span class="chip"><b>${s.checked}/${s.candidates}</b> URLs</span>` : '') +
      chip('skipped', s.errors);
  }

  function showEmpty(kind, title, text) {
    const e = $('#empty');
    e.hidden = false;
    e.classList.toggle('error', kind === 'error');
    $('#emptyTitle').textContent = title;
    $('#emptyText').textContent = text;
  }

  // ---------------------------------------------------------------- export helpers
  // Fast path: the stored JSON string is already the minified export.
  async function prepareJson(item, signal) {
    const needsImages = state.settings.embedImages && item.meta.images > item.meta.embeddedImages;
    if (!needsImages && state.settings.minify) return item.json;
    let data = JSON.parse(item.json);
    if (needsImages) {
      const base = item.url && !item.url.startsWith('data:') ? item.url : item.pageUrl;
      data = await LottieScanner.embedAssets(data, base, signal);
    }
    return state.settings.minify ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  }

  async function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url, filename, saveAs: state.settings.saveAs, conflictAction: 'uniquify' });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    }
  }

  function folderName() {
    const host = hostOf(state.scannedTab?.url || '') || 'page';
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `lottie-${host}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  async function downloadJson(item) {
    try {
      const json = await prepareJson(item);
      await download(new Blob([json], { type: 'application/json' }), `${item.name}.json`);
      toast('Downloading JSON');
    } catch (e) {
      toast('Download failed: ' + e.message);
    }
  }

  async function copyJson(item) {
    try {
      await navigator.clipboard.writeText(await prepareJson(item));
      toast('JSON copied to clipboard');
    } catch (e) {
      toast('Copy failed: ' + e.message);
    }
  }

  function uniqueNamer() {
    const used = new Set();
    return (name, ext) => {
      let n = name, i = 2;
      while (used.has((n + ext).toLowerCase())) n = `${name}-${i++}`;
      used.add((n + ext).toLowerCase());
      return n + ext;
    };
  }

  // ---------------------------------------------------------------- ZIP export
  function showExport(pct, title, detail) {
    if ($('#exportOverlay').hidden) { gridPaused = true; refreshPlayback(); }
    $('#exportOverlay').hidden = false;
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    $('#exportPct').textContent = p + '%';
    $('#ringFg').style.strokeDashoffset = String(326.7 * (1 - p / 100));
    if (title) $('#exportTitle').textContent = title;
    $('#exportDetail').textContent = detail || '';
  }
  $('#btnExportCancel').addEventListener('click', () => state.exportCtrl?.abort());

  $('#btnZip').addEventListener('click', async () => {
    const items = state.items.filter((i) => state.selected.has(i.id));
    if (!items.length || state.exportCtrl) return;
    state.exportCtrl = new AbortController();
    const signal = state.exportCtrl.signal;
    try {
      const zip = new LottieZip.ZipWriter();
      const nameJson = uniqueNamer();
      const nameLottie = uniqueNamer();
      const index = [];
      const steps = items.length + 1;
      for (let i = 0; i < items.length; i++) {
        if (signal.aborted) throw new LottieScanner.Cancelled();
        const item = items[i];
        const base = item.name;
        showExport((i / steps) * 100, `Packing ${items.length} animation${items.length === 1 ? '' : 's'}…`, base);
        const file = 'json/' + nameJson(base, '.json');
        await zip.add(file, await prepareJson(item, signal));
        let original = null;
        if (state.settings.includeOriginals && item.dotLottie) {
          original = 'dotlottie/' + nameLottie(sanitize(item.dotLottie.fileName.replace(/\.lottie$/i, '')) || base, '.lottie');
          await zip.add(original, item.dotLottie.bytes, { compress: false });
        }
        index.push({
          file, original, name: item.meta.name || base, width: item.meta.width, height: item.meta.height,
          fps: item.meta.fps, frames: item.meta.frames, duration: +item.meta.duration.toFixed(3),
          layers: item.meta.layers, version: item.meta.version, source: item.url, detectedBy: item.sources, page: item.pageUrl
        });
      }
      showExport(((steps - 1) / steps) * 100, 'Finalising ZIP…', 'index.json');
      await zip.add('index.json', JSON.stringify({
        scrapedFrom: state.scannedTab?.url, title: state.scannedTab?.title, date: new Date().toISOString(),
        tool: 'Lottie Scraper', count: index.length, animations: index
      }, null, 2));
      const blob = zip.finish();
      showExport(100, 'Saving…', fmtBytes(blob.size));
      await download(blob, folderName() + '.zip');
      toast(`ZIP ready · ${items.length} file(s) · ${fmtBytes(blob.size)}`);
    } catch (e) {
      toast(e instanceof LottieScanner.Cancelled || signal.aborted ? 'Export cancelled' : 'Export failed: ' + e.message);
    } finally {
      state.exportCtrl = null;
      setTimeout(() => { $('#exportOverlay').hidden = true; gridPaused = dlg.open; refreshPlayback(); }, 500);
    }
  });

  $('#btnJson').addEventListener('click', async () => {
    const items = state.items.filter((i) => state.selected.has(i.id));
    if (!items.length || state.exportCtrl) return;
    state.exportCtrl = new AbortController();
    const signal = state.exportCtrl.signal;
    const folder = folderName();
    const namer = uniqueNamer();
    try {
      for (let i = 0; i < items.length; i++) {
        if (signal.aborted) throw new LottieScanner.Cancelled();
        const item = items[i];
        const base = item.name;
        showExport((i / items.length) * 100, `Saving ${items.length} JSON file(s)…`, base);
        await download(new Blob([await prepareJson(item, signal)], { type: 'application/json' }), `${folder}/${namer(base, '.json')}`);
      }
      showExport(100, 'Done', '');
      toast(`Saved ${items.length} JSON file(s) to Downloads/${folder}`);
    } catch (e) {
      toast(e instanceof LottieScanner.Cancelled || signal.aborted ? 'Export cancelled' : 'Export failed: ' + e.message);
    } finally {
      state.exportCtrl = null;
      setTimeout(() => { $('#exportOverlay').hidden = true; gridPaused = dlg.open; refreshPlayback(); }, 500);
    }
  });

  // ---------------------------------------------------------------- detail sheet
  const dlg = $('#detailDlg');
  let detailAnim = null;
  let detailItem = null;
  const speeds = [1, 1.5, 2, 0.5];
  const bgs = ['', 'checker', 'dark', 'light'];
  let bgIdx = 0;

  function openDetail(item) {
    detailItem = item;
    const m = item.meta;
    $('#dTitle').textContent = item.name;
    const stage = $('#dStage');
    stage.innerHTML = '<div class="anim"></div>';
    stage.style.aspectRatio = m.width && m.height ? `${m.width} / ${m.height}` : '1';
    const cells = [
      ['Size', `${m.width}×${m.height}`], ['Frame rate', `${m.fps} fps`], ['Frames', m.frames], ['Duration', fmtDur(m.duration)],
      ['Layers', m.layers], ['Precomps', m.precomps], ['Images', m.images ? `${m.images} (${m.embeddedImages} embedded)` : 0],
      ['JSON', fmtBytes(item.size)], ['Version', m.version || '—'], ['Markers', m.markers], ['Fonts', m.fonts], ['3D', m.is3d ? 'Yes' : 'No']
    ];
    $('#dMeta').innerHTML = cells.map(([k, v]) => `<div class="meta"><small>${esc(k)}</small><span>${esc(v)}</span></div>`).join('');
    $('#dSources').innerHTML =
      `<div class="tags">${item.sources.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` +
      (item.url ? `<div class="src">${esc(item.url.startsWith('data:') ? item.url.slice(0, 60) + '…' : item.url)}</div>` : '<div class="src">Embedded in page — no standalone URL</div>') +
      (item.restored ? '<div class="src note">Recovered from the live player and restored to its original path data.</div>' : '');
    $('#dDotLottie').hidden = !item.dotLottie;
    $('#dLocate').hidden = !item.elementId || state.scannedTab?.id !== state.tab?.id;
    $('#dOpen').hidden = !item.url || item.url.startsWith('data:');
    $('#dSpeed').textContent = '1×';
    dlg.showModal();
    gridPaused = true; // the sheet covers the grid — stop spending frames on it
    refreshPlayback();

    detailAnim?.destroy();
    try {
      detailAnim = lottie.loadAnimation({
        container: $('.anim', stage), renderer: 'svg', loop: true, autoplay: true,
        animationData: JSON.parse(item.json)
      });
      const scrub = $('#dScrub');
      detailAnim.addEventListener('DOMLoaded', () => { scrub.max = Math.max(0, Math.floor(detailAnim.totalFrames) - 1); });
      const frameLabel = $('#dFrame');
      let lastFrame = -1;
      detailAnim.addEventListener('enterFrame', () => {
        const f = Math.floor(detailAnim.currentFrame);
        if (f === lastFrame) return; // only touch the DOM when the frame number changes
        lastFrame = f;
        scrub.value = f;
        frameLabel.textContent = `${f} / ${Math.floor(detailAnim.totalFrames)}`;
      });
      setPlayIcon(true);
    } catch (_) {
      stage.innerHTML = '<div class="preview"><div class="err">Preview unavailable</div></div>';
    }
  }

  function setPlayIcon(playing) {
    $('#dPlay').innerHTML = playing
      ? '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  }
  $('#dPlay').addEventListener('click', () => {
    if (!detailAnim) return;
    if (detailAnim.isPaused) { detailAnim.play(); setPlayIcon(true); } else { detailAnim.pause(); setPlayIcon(false); }
  });
  $('#dScrub').addEventListener('input', (e) => { detailAnim?.goToAndStop(+e.target.value, true); setPlayIcon(false); });
  $('#dSpeed').addEventListener('click', (e) => {
    const cur = parseFloat(e.target.textContent);
    const next = speeds[(speeds.indexOf(cur) + 1) % speeds.length];
    detailAnim?.setSpeed(next);
    e.target.textContent = next + '×';
  });
  $('#dBg').addEventListener('click', () => {
    const stage = $('#dStage');
    stage.classList.remove(...bgs.filter(Boolean));
    bgIdx = (bgIdx + 1) % bgs.length;
    if (bgs[bgIdx]) stage.classList.add(bgs[bgIdx]);
  });
  $('#dDownload').addEventListener('click', () => detailItem && downloadJson(detailItem));
  $('#dCopy').addEventListener('click', () => detailItem && copyJson(detailItem));
  $('#dDotLottie').addEventListener('click', async () => {
    if (!detailItem?.dotLottie) return;
    await download(new Blob([detailItem.dotLottie.bytes], { type: 'application/zip' }), sanitize(detailItem.dotLottie.fileName) || 'animation.lottie');
    toast('Downloading .lottie');
  });
  $('#dOpen').addEventListener('click', () => detailItem?.url && chrome.tabs.create({ url: detailItem.url, active: false }));
  $('#dLocate').addEventListener('click', async () => {
    if (!detailItem?.elementId || !state.scannedTab) return;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: state.scannedTab.id, frameIds: [detailItem.frameId || 0] },
        func: LottieScanner.highlightElement,
        args: [detailItem.elementId]
      });
      toast(res?.result ? 'Highlighted on page' : 'Element is no longer on the page');
      if (res?.result) dlg.close();
    } catch (_) {
      toast('Could not reach the page');
    }
  });
  dlg.addEventListener('close', () => {
    detailAnim?.destroy();
    detailAnim = null;
    $('#dStage').textContent = '';
    gridPaused = false;
    refreshPlayback();
  });

  // generic close buttons / backdrop click
  $$('dialog').forEach((d) => {
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') || e.target === d) d.close();
    });
  });
  $('#btnSettings').addEventListener('click', () => $('#settingsDlg').showModal());

  // keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || $('dialog[open]')) return;
    if (e.key === 's' || e.key === 'Enter') { e.preventDefault(); startScan(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); visibleItems().forEach((i) => toggleSelect(i.id, true)); }
  });

  // ---------------------------------------------------------------- init
  try { $('#version').textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) {}
  loadSettings();
  refreshTab();
  updateSelectionUi();
})();
