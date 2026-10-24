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

  function displayName(item, idx) {
    return sanitize(item.baseName) || sanitize(item.meta.name) || `animation-${idx + 1}`;
  }

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
  setInterval(() => { if (state.tab) refreshTab(); }, 4000);

  // ---------------------------------------------------------------- previews
  const players = new Map(); // id -> lottie AnimationItem
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const id = e.target.dataset.id;
      if (e.isIntersecting) mountPreview(e.target, id);
      else unmountPreview(id, e.target);
    }
  }, { rootMargin: '150px' });

  function mountPreview(card, id) {
    if (players.has(id)) return;
    const item = state.items.find((i) => i.id === id);
    if (!item) return;
    const holder = $('.preview', card);
    holder.querySelector('.anim')?.remove();
    const box = document.createElement('div');
    box.className = 'anim';
    holder.appendChild(box);
    try {
      const anim = lottie.loadAnimation({
        container: box,
        renderer: 'svg',
        loop: true,
        autoplay: false,
        animationData: structuredClone(item.data),
        rendererSettings: { preserveAspectRatio: 'xMidYMid meet', progressiveLoad: true }
      });
      anim.addEventListener('DOMLoaded', () => {
        holder.querySelector('.loading')?.remove();
        if (state.settings.autoplay) anim.play();
        else anim.goToAndStop(Math.floor(anim.totalFrames / 2), true);
      });
      anim.addEventListener('data_failed', () => showPreviewError(holder));
      players.set(id, anim);
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
    const anim = players.get(id);
    if (anim) { try { anim.destroy(); } catch (_) {} players.delete(id); }
  }
  function refreshPlayback() {
    for (const anim of players.values()) {
      if (state.settings.autoplay) anim.play();
      else anim.goToAndStop(Math.floor(anim.totalFrames / 2), true);
    }
  }

  // ---------------------------------------------------------------- grid
  const grid = $('#grid');

  function cardHtml(item, idx) {
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
        <div class="name" title="${esc(displayName(item, idx))}">${esc(displayName(item, idx))}</div>
        <div class="facts"><span>${m.width}×${m.height} · ${m.fps}fps</span><span>${fmtDur(m.duration)} · ${fmtBytes(item.size)}</span></div>
      </div>`;
  }

  function addCard(item) {
    const idx = state.items.indexOf(item);
    const card = document.createElement('div');
    card.className = 'card' + (state.selected.has(item.id) ? ' selected' : '');
    card.dataset.id = item.id;
    card.innerHTML = cardHtml(item, idx);
    grid.appendChild(card);
    io.observe(card);
    if (!matchesFilter(item)) card.hidden = true;
    return card;
  }

  function updateCard(item) {
    const card = grid.querySelector(`.card[data-id="${item.id}"]`);
    if (!card) return;
    const [cls, label] = primarySource(item);
    const b = $('.badge', card);
    b.className = 'badge ' + cls;
    b.textContent = label;
  }

  function matchesFilter(item) {
    const q = state.filter.trim().toLowerCase();
    if (!q) return true;
    const idx = state.items.indexOf(item);
    return [displayName(item, idx), item.url, item.meta.name, item.sources.join(' '), `${item.meta.width}x${item.meta.height}`]
      .some((s) => (s || '').toLowerCase().includes(q));
  }

  function visibleItems() {
    return state.items.filter(matchesFilter);
  }

  function applyFilterSort() {
    const order = [...state.items];
    const by = {
      found: () => 0,
      name: (a, b) => displayName(a, state.items.indexOf(a)).localeCompare(displayName(b, state.items.indexOf(b))),
      size: (a, b) => b.size - a.size,
      duration: (a, b) => b.meta.duration - a.meta.duration,
      layers: (a, b) => b.meta.layers - a.meta.layers
    }[state.sort];
    if (state.sort !== 'found') order.sort(by);
    for (const item of order) {
      const card = grid.querySelector(`.card[data-id="${item.id}"]`);
      if (!card) continue;
      card.hidden = !matchesFilter(item);
      grid.appendChild(card);
    }
    updateSelectionUi();
  }

  $('#search').addEventListener('input', (e) => { state.filter = e.target.value; applyFilterSort(); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; applyFilterSort(); });

  grid.addEventListener('click', async (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const item = state.items.find((i) => i.id === card.dataset.id);
    if (!item) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'copy') return copyJson(item);
    if (act === 'download') return downloadJson(item);
    if (e.target.closest('.sel') || e.metaKey || e.ctrlKey || e.shiftKey) return toggleSelect(item.id);
    openDetail(item);
  });

  function toggleSelect(id, force) {
    const on = force ?? !state.selected.has(id);
    if (on) state.selected.add(id); else state.selected.delete(id);
    grid.querySelector(`.card[data-id="${id}"]`)?.classList.toggle('selected', on);
    updateSelectionUi();
  }

  $('#selectAll').addEventListener('change', (e) => {
    const vis = visibleItems();
    vis.forEach((i) => toggleSelect(i.id, e.target.checked));
  });

  function updateSelectionUi() {
    const vis = visibleItems();
    const selVisible = vis.filter((i) => state.selected.has(i.id)).length;
    const all = $('#selectAll');
    all.checked = vis.length > 0 && selVisible === vis.length;
    all.indeterminate = selVisible > 0 && selVisible < vis.length;
    $('#countLabel').textContent = `${state.items.length} found`;
    const sel = state.items.filter((i) => state.selected.has(i.id));
    const size = sel.reduce((s, i) => s + i.size, 0);
    $('#selCount').textContent = `${sel.length} selected`;
    $('#selSize').textContent = sel.length ? `≈ ${fmtBytes(size)} of JSON` : 'Select animations to export';
    $('#btnZip').disabled = !sel.length;
    $('#btnJson').disabled = !sel.length;
    $('#toolbar').hidden = !state.items.length;
    $('#dock').hidden = !state.items.length;
    $('#empty').hidden = !!state.items.length || !!state.scanCtrl;
  }

  // ---------------------------------------------------------------- scanning
  $('#btnScan').addEventListener('click', startScan);
  $('#btnCancel').addEventListener('click', () => state.scanCtrl?.abort());

  function resetResults() {
    for (const id of [...players.keys()]) unmountPreview(id);
    io.disconnect();
    grid.innerHTML = '';
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
        onFound: (item, merged) => {
          if (merged) return updateCard(item);
          state.items.push(item);
          state.selected.add(item.id);
          addCard(item);
          updateSelectionUi();
        }
      });
      const msg = items.length
        ? `Found ${items.length} animation${items.length === 1 ? '' : 's'}`
        : 'No Lottie animations found';
      toast(stats.errors && items.length ? `${msg} · ${stats.errors} URL(s) skipped` : msg);
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

  function setProgress({ pct, phase, detail, stats }) {
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
  async function prepareJson(item, signal) {
    let data = structuredClone(item.data);
    if (state.settings.embedImages) {
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
      await download(new Blob([json], { type: 'application/json' }), `${displayName(item, state.items.indexOf(item))}.json`);
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
        const base = displayName(item, state.items.indexOf(item));
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
      setTimeout(() => { $('#exportOverlay').hidden = true; }, 500);
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
        const base = displayName(item, state.items.indexOf(item));
        showExport((i / items.length) * 100, `Saving ${items.length} JSON file(s)…`, base);
        await download(new Blob([await prepareJson(item, signal)], { type: 'application/json' }), `${folder}/${namer(base, '.json')}`);
      }
      showExport(100, 'Done', '');
      toast(`Saved ${items.length} JSON file(s) to Downloads/${folder}`);
    } catch (e) {
      toast(e instanceof LottieScanner.Cancelled || signal.aborted ? 'Export cancelled' : 'Export failed: ' + e.message);
    } finally {
      state.exportCtrl = null;
      setTimeout(() => { $('#exportOverlay').hidden = true; }, 500);
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
    const idx = state.items.indexOf(item);
    const m = item.meta;
    $('#dTitle').textContent = displayName(item, idx);
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
      (item.url ? `<div class="src">${esc(item.url.startsWith('data:') ? item.url.slice(0, 60) + '…' : item.url)}</div>` : '<div class="src">Embedded in page — no standalone URL</div>');
    $('#dDotLottie').hidden = !item.dotLottie;
    $('#dLocate').hidden = !item.elementId || state.scannedTab?.id !== state.tab?.id;
    $('#dOpen').hidden = !item.url || item.url.startsWith('data:');
    $('#dSpeed').textContent = '1×';
    dlg.showModal();

    detailAnim?.destroy();
    try {
      detailAnim = lottie.loadAnimation({
        container: $('.anim', stage), renderer: 'svg', loop: true, autoplay: true,
        animationData: structuredClone(item.data)
      });
      const scrub = $('#dScrub');
      detailAnim.addEventListener('DOMLoaded', () => { scrub.max = Math.max(0, Math.floor(detailAnim.totalFrames) - 1); });
      detailAnim.addEventListener('enterFrame', () => {
        scrub.value = Math.floor(detailAnim.currentFrame);
        $('#dFrame').textContent = `${Math.floor(detailAnim.currentFrame)} / ${Math.floor(detailAnim.totalFrames)}`;
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
  dlg.addEventListener('close', () => { detailAnim?.destroy(); detailAnim = null; });

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
