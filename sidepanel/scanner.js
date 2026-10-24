// Lottie Scraper — scan pipeline (runs in the side panel).
/* global LottieExtract, LottieZip */
(function (root) {
  'use strict';
  const X = LottieExtract;

  // ======================================================================
  // Functions injected into the page. They must be self-contained.
  // ======================================================================

  // ISOLATED world. Requires shared/extract.js to be injected first.
  function pageCollector(opts) {
    const X = self.LottieExtract;
    const base = document.baseURI;
    const candidates = [];
    const seen = new Set();
    const inline = [];

    const tag = (el) => {
      if (!el || !el.setAttribute) return null;
      let id = el.getAttribute('data-lsid');
      if (!id) { id = 'd' + Math.random().toString(36).slice(2, 9); el.setAttribute('data-lsid', id); }
      return id;
    };
    const addUrl = (u, source, el, boost = 0) => {
      const abs = X.resolveUrl(u, base);
      if (!abs || seen.has(abs)) return;
      seen.add(abs);
      candidates.push({ url: abs, source, elementId: el ? tag(el) : null, score: X.urlScore(abs) + boost });
    };
    const addValue = (val, source, el) => {
      if (!val || typeof val !== 'string') return;
      const v = val.trim();
      if (v[0] === '{') {
        const o = X.parseLoose(v);
        X.findLotties(o).forEach((d) => inline.push({ data: d, source, elementId: tag(el) }));
      } else if (/\.(json|lottie)(\?|$)/i.test(v) || /lottie/i.test(v) || v.startsWith('data:')) {
        addUrl(v, source, el, 6);
      }
    };

    // Walk the DOM including open shadow roots
    const all = [];
    const shadowHtml = [];
    const walk = (rootNode) => {
      const els = rootNode.querySelectorAll('*');
      for (const el of els) {
        all.push(el);
        if (el.shadowRoot) { shadowHtml.push(el.shadowRoot.innerHTML); walk(el.shadowRoot); }
      }
    };
    walk(document);

    const PLAYER_TAGS = /^(lottie-player|dotlottie-player|dotlottie-wc|lottie-interactive|lottie-web|tgs-player|lottie-animation)$/i;
    const ATTRS = ['src', 'data-src', 'path', 'data-path', 'data-animation-path', 'data-anim-path', 'data-bm-path',
      'data-lottie', 'data-lottie-src', 'data-lottie-path', 'data-lottie-url', 'data-json', 'data-json-src',
      'data-animation', 'data-animation-data', 'animationdata', 'data-url', 'data-file'];
    for (const el of all) {
      const isPlayer = PLAYER_TAGS.test(el.tagName) || el.getAttribute('data-animation-type') === 'lottie';
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (v && (isPlayer || a !== 'src')) addValue(v, isPlayer ? 'player' : 'dom', el);
      }
      if (el.tagName === 'SOURCE' || el.tagName === 'A') {
        const h = el.getAttribute('src') || el.getAttribute('href');
        if (h && /\.(lottie|json)(\?|$)/i.test(h)) addUrl(h, 'link', el, 2);
      }
      // Elementor / generic JSON-ish settings attributes
      const settings = el.getAttribute('data-settings');
      if (settings && /lottie|\.json/i.test(settings)) {
        X.harvestUrls(X.decodeEntities(settings), base).forEach((u) => addUrl(u, 'dom', el, 4));
      }
    }

    // Static text of the document (inline scripts, JSON blobs, attributes)
    let html = document.documentElement.outerHTML;
    if (shadowHtml.length) html += '\n' + shadowHtml.join('\n');
    if (html.length > 30e6) html = html.slice(0, 30e6);
    const res = X.scanText(html, base);
    res.urls.forEach((u) => addUrl(u, 'html'));
    res.inline.forEach((d) => inline.push({ data: d, source: 'inline', elementId: null }));

    // Resources the page already loaded
    try {
      for (const e of performance.getEntriesByType('resource')) {
        const u = e.name;
        if (/\.(json|lottie)(\?|$)/i.test(u)) addUrl(u, 'network', null, 2);
        else if (opts.deep && (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') && /lottie|anim/i.test(u)) addUrl(u, 'network', null, 1);
      }
    } catch (_) {}

    const scripts = [...document.scripts].map((s) => s.src).filter(Boolean);
    document.querySelectorAll('link[rel="modulepreload"][href],link[rel="preload"][as="script"][href]').forEach((l) => scripts.push(l.href));
    document.querySelectorAll('link[rel="preload"][href],link[rel="prefetch"][href]').forEach((l) => {
      if (/\.(json|lottie)(\?|$)/i.test(l.href)) addUrl(l.href, 'preload', null, 3);
    });

    const links = [];
    if (opts.crawl) {
      const origin = location.origin;
      const ls = new Set();
      document.querySelectorAll('a[href]').forEach((a) => {
        try {
          const u = new URL(a.getAttribute('href'), base);
          if (u.origin !== origin) return;
          if (/\.(png|jpe?g|gif|webp|svg|pdf|zip|mp4|webm|mp3|css|js|json|lottie|xml|ico)(\?|$)/i.test(u.pathname)) return;
          u.hash = '';
          if (u.href !== location.href) ls.add(u.href);
        } catch (_) {}
      });
      links.push(...ls);
    }

    let rendered = 0;
    try {
      const svgs = new Set();
      document.querySelectorAll('[id^="__lottie_element_"]').forEach((n) => { const s = n.closest('svg'); if (s) svgs.add(s); });
      rendered = svgs.size;
    } catch (_) {}

    return {
      url: location.href,
      title: document.title,
      candidates,
      inline,
      scripts: [...new Set(scripts)],
      links,
      rendered,
      isTop: window === window.top
    };
  }

  // MAIN world — reads players, lottie-web registries and the hook store.
  function runtimeCollector() {
    const out = [];
    const seenObj = new WeakSet();
    const tag = (el) => {
      if (!el || !el.setAttribute) return null;
      let id = el.getAttribute('data-lsid');
      if (!id) { id = 'r' + Math.random().toString(36).slice(2, 9); el.setAttribute('data-lsid', id); }
      return id;
    };
    // Keep lottie-web's `completed` / `__complete` flags: the side panel needs them to
    // undo the player's in-place edits. Only drop the precomp `layers` it attaches
    // (a duplicate of the asset's layers).
    const replacer = function (key, value) {
      if (key === 'layers' && this && this.ty === 0 && this.refId) return undefined;
      if (key === '__used') return undefined;
      return value;
    };
    const push = (data, source, url, el, pristine) => {
      try {
        if (data && typeof data === 'object') {
          if (seenObj.has(data)) return;
          seenObj.add(data);
          if (!Array.isArray(data.layers)) return;
          out.push({ json: JSON.stringify(data, replacer), source, url: url || null, elementId: tag(el), pristine: !!pristine });
        } else if (url) {
          out.push({ json: null, source, url, elementId: tag(el) });
        }
      } catch (_) {}
    };

    // 1. Pristine captures from the document_start hook
    const store = window[Symbol.for('__lottie_scraper__')];
    if (store) {
      for (const it of store.items) out.push({ json: it.json, source: 'runtime:' + it.source, url: it.url, elementId: null, pristine: true });
      store.urls.forEach((u) => push(null, 'runtime:loadAnimation', u, null));
    }

    // 2. Global lottie-web registries
    for (const name of ['lottie', 'bodymovin', 'Lottie', 'lottieWeb']) {
      try {
        const lib = window[name];
        if (!lib || typeof lib.getRegisteredAnimations !== 'function') continue;
        for (const anim of lib.getRegisteredAnimations()) {
          let url = null;
          if (anim.path && anim.fileName) { try { url = new URL(anim.path + anim.fileName + '.json', document.baseURI).href; } catch (_) {} }
          push(anim.animationData, 'runtime:lottie-web', url, anim.wrapper);
        }
      } catch (_) {}
    }

    // 3. Web-component players (including inside open shadow roots)
    const players = [];
    const walk = (r) => {
      r.querySelectorAll('*').forEach((el) => {
        if (/^(lottie-player|dotlottie-player|dotlottie-wc|lottie-interactive|tgs-player)$/i.test(el.tagName)) players.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    };
    try { walk(document); } catch (_) {}
    for (const el of players) {
      try {
        let data = null;
        const inst = typeof el.getLottie === 'function' ? el.getLottie() : el._lottie || el.lottie;
        if (inst && inst.animationData) data = inst.animationData;
        if (!data && el.animationData) data = el.animationData;
        let src = el.src || el.getAttribute('src');
        if (typeof src !== 'string' || src.trim().startsWith('{')) src = null;
        let url = null;
        if (src) { try { url = new URL(src, document.baseURI).href; } catch (_) {} }
        if (data) push(data, 'runtime:' + el.tagName.toLowerCase(), url, el);
        else if (url) push(null, 'runtime:' + el.tagName.toLowerCase(), url, el);
      } catch (_) {}
    }
    return { hooked: !!store, items: out };
  }

  // Highlight an element on the page (ISOLATED world).
  function highlightElement(id) {
    const find = (r) => {
      const hit = r.querySelector(`[data-lsid="${CSS.escape(id)}"]`);
      if (hit) return hit;
      for (const el of r.querySelectorAll('*')) if (el.shadowRoot) { const h = find(el.shadowRoot); if (h) return h; }
      return null;
    };
    const el = find(document);
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', borderRadius: '12px',
      border: '3px solid #2dd4bf', boxShadow: '0 0 0 6px rgba(45,212,191,.25), 0 0 40px rgba(139,92,246,.55)',
      transition: 'opacity .6s ease, transform .6s ease', opacity: '0', transform: 'scale(1.08)'
    });
    const place = () => {
      const b = el.getBoundingClientRect();
      Object.assign(box.style, { left: b.left - 6 + 'px', top: b.top - 6 + 'px', width: b.width + 12 + 'px', height: b.height + 12 + 'px' });
    };
    place();
    document.documentElement.appendChild(box);
    requestAnimationFrame(() => { box.style.opacity = '1'; box.style.transform = 'scale(1)'; });
    const iv = setInterval(place, 50);
    setTimeout(() => { box.style.opacity = '0'; }, 2200);
    setTimeout(() => { clearInterval(iv); box.remove(); }, 2900);
    return !!r;
  }

  // ======================================================================
  // Side-panel helpers
  // ======================================================================

  class Cancelled extends Error {}

  async function pool(items, limit, worker, signal) {
    let i = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        if (signal?.aborted) throw new Cancelled();
        const idx = i++;
        await worker(items[idx], idx);
      }
    });
    await Promise.all(runners);
  }

  async function fetchBytes(url, { timeout = 20000, maxBytes = 60e6, signal } = {}) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, credentials: 'include', cache: 'force-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const len = +res.headers.get('content-length') || 0;
      if (len > maxBytes) throw new Error('Too large');
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error('Too large');
      return { bytes: buf, contentType: (res.headers.get('content-type') || '').toLowerCase(), finalUrl: res.url || url };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  const dec = new TextDecoder();
  const isZip = (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function mimeFor(name, fallback = 'image/png') {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' }[ext] || fallback;
  }

  // dotLottie (v1 and v2) -> [{data, id}]
  async function unpackDotLottie(bytes) {
    const entries = LottieZip.readZip(bytes);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const anims = entries.filter((e) => /^(animations|a)\/[^/]+\.json$/i.test(e.name));
    const images = entries.filter((e) => /^(images|i)\/[^/]+$/i.test(e.name));
    let manifest = null;
    if (byName.has('manifest.json')) {
      try { manifest = JSON.parse(dec.decode(await byName.get('manifest.json').read())); } catch (_) {}
    }
    const imageData = new Map();
    for (const img of images) {
      const file = img.name.split('/').pop();
      imageData.set(file, `data:${mimeFor(file)};base64,${bytesToBase64(await img.read())}`);
    }
    const out = [];
    for (const a of anims) {
      try {
        const data = JSON.parse(dec.decode(await a.read()));
        if (!X.isLottie(data)) continue;
        for (const asset of data.assets || []) {
          if (asset && asset.p && !asset.layers && imageData.has(asset.p)) {
            asset.p = imageData.get(asset.p);
            asset.u = '';
            asset.e = 1;
          }
        }
        out.push({ data, id: a.name.split('/').pop().replace(/\.json$/i, '') });
      } catch (_) {}
    }
    return { animations: out, manifest };
  }

  // Inline external image assets so the exported JSON is fully self-contained.
  async function embedAssets(data, baseUrl, signal) {
    const assets = Array.isArray(data.assets) ? data.assets : [];
    await pool(assets.filter((a) => a && a.p && !a.layers && a.e !== 1 && !/^data:/.test(a.p)), 4, async (a) => {
      try {
        const u = new URL((a.u || '') + a.p, baseUrl || undefined).href;
        const { bytes, contentType } = await fetchBytes(u, { timeout: 15000, maxBytes: 25e6, signal });
        const mime = contentType.startsWith('image/') ? contentType.split(';')[0] : mimeFor(a.p);
        a.p = `data:${mime};base64,${bytesToBase64(bytes)}`;
        a.u = '';
        a.e = 1;
      } catch (e) {
        if (e instanceof Cancelled) throw e;
      }
    }, signal);
    return data;
  }

  // ======================================================================
  // Main scan
  // ======================================================================
  //   mode: 'quick' | 'deep' | 'crawl'
  //   onFound(item) — streamed as animations are discovered
  //   onProgress({pct, phase, detail, stats})
  async function scan(tab, settings, { onFound, onProgress, signal }) {
    const deep = settings.mode !== 'quick';
    const crawl = settings.mode === 'crawl';
    const stats = { frames: 0, candidates: 0, checked: 0, scripts: 0, pages: 0, found: 0, errors: 0 };
    const found = new Map(); // fingerprint -> item
    const checkedUrls = new Set();
    const candidates = new Map(); // url -> {url, source, frameId, elementId, score}
    let pctFloor = 0;

    const progress = (from, to, done, total, phase, detail) => {
      const p = from + (to - from) * (total ? Math.min(1, done / total) : 1);
      pctFloor = Math.max(pctFloor, p);
      onProgress({ pct: pctFloor, phase, detail, stats: { ...stats } });
    };
    const check = () => { if (signal.aborted) throw new Cancelled(); };

    // Items keep the animation as a compact JSON string (not a live object graph):
    // ~5-10x less memory, and every preview/export parses its own fresh copy.
    // `restored` marks data recovered from a player (lottie-web edits it in place);
    // a pristine copy found later (e.g. by fetching the source URL) replaces it.
    const addFound = (data, info) => {
      const restored = info.fromPlayer ? X.restoreLottie(data) : false;
      const fp = X.fingerprint(data);
      const existing = found.get(fp);
      if (existing) {
        let replaced = false;
        if (existing.restored && !restored) {
          existing.json = JSON.stringify(data);
          existing.size = existing.json.length;
          existing.meta = X.meta(data);
          existing.restored = false;
          replaced = true;
        }
        if (info.url && !existing.url) existing.url = info.url;
        if (info.elementId && !existing.elementId) { existing.elementId = info.elementId; existing.frameId = info.frameId; }
        if (!existing.sources.includes(info.source)) existing.sources.push(info.source);
        if (info.dotLottie && !existing.dotLottie) existing.dotLottie = info.dotLottie;
        if (info.baseName && !existing.baseName) existing.baseName = info.baseName;
        onFound(existing, replaced ? 'replaced' : 'merged');
        return;
      }
      const json = JSON.stringify(data);
      const item = {
        id: 'a' + (found.size + 1) + '_' + Math.random().toString(36).slice(2, 6),
        json,
        size: json.length,
        restored,
        meta: X.meta(data),
        url: info.url || null,
        pageUrl: info.pageUrl || tab.url,
        frameId: info.frameId ?? 0,
        elementId: info.elementId || null,
        sources: [info.source],
        dotLottie: info.dotLottie || null,
        baseName: info.baseName || null
      };
      found.set(fp, item);
      stats.found = found.size;
      onFound(item, false);
    };

    const addCandidate = (url, source, extra = {}) => {
      if (!url || candidates.has(url)) return;
      candidates.set(url, { url, source, score: X.urlScore(url) + (extra.boost || 0), frameId: extra.frameId ?? 0, elementId: extra.elementId || null, pageUrl: extra.pageUrl });
    };

    const handleText = (text, base, source, pageUrl) => {
      const res = X.scanText(text, base);
      res.urls.forEach((u) => addCandidate(u, source, { pageUrl }));
      res.inline.forEach((d) => addFound(d, { source: source + ':inline', pageUrl }));
    };

    // ---------- Phase 1: page collectors ----------
    progress(0, 0, 0, 1, 'Injecting detectors', tab.url);
    const target = { tabId: tab.id, allFrames: true };
    let pageResults = [];
    let runtimeResults = [];
    try {
      await chrome.scripting.executeScript({ target, files: ['shared/extract.js'] });
      pageResults = await chrome.scripting.executeScript({ target, func: pageCollector, args: [{ deep, crawl }] });
    } catch (e) {
      throw new Error('Cannot access this page. Chrome blocks extensions on internal pages, the Web Store and some PDFs.');
    }
    check();
    progress(0, 8, 1, 2, 'Reading runtime animations', '');
    try {
      runtimeResults = await chrome.scripting.executeScript({ target, world: 'MAIN', func: runtimeCollector });
    } catch (_) {}
    check();

    const frameUrls = new Map();
    for (const r of pageResults) {
      if (!r.result) continue;
      stats.frames++;
      frameUrls.set(r.frameId, r.result.url);
    }

    // runtime first: hook captures are pristine copies of the data
    let hooked = runtimeResults.length === 0;
    for (const r of runtimeResults) {
      const res = r.result || {};
      if (res.hooked) hooked = true;
      for (const it of res.items || []) {
        const pageUrl = frameUrls.get(r.frameId) || tab.url;
        // a known source URL always gets fetched: the file on the server is the untouched original
        if (it.url) addCandidate(it.url, it.source, { boost: 8, frameId: r.frameId, elementId: it.elementId, pageUrl });
        if (!it.json) continue;
        try {
          const data = JSON.parse(it.json);
          if (X.isLottie(data)) addFound(data, { source: it.source, url: it.url, elementId: it.elementId, frameId: r.frameId, pageUrl, fromPlayer: !it.pristine });
        } catch (_) {}
      }
    }
    stats.hookMissing = !hooked;

    const scripts = new Map(); // url -> pageUrl
    const links = new Set();
    for (const r of pageResults) {
      const res = r.result;
      if (!res) continue;
      res.inline.forEach((it) => addFound(it.data, { source: it.source, elementId: it.elementId, frameId: r.frameId, pageUrl: res.url }));
      res.candidates.forEach((c) => addCandidate(c.url, c.source, { boost: c.score - X.urlScore(c.url), frameId: r.frameId, elementId: c.elementId, pageUrl: res.url }));
      if (deep) res.scripts.forEach((s) => { if (!scripts.has(s)) scripts.set(s, res.url); });
      res.links.forEach((l) => links.add(l));
    }

    // network log from the service worker
    try {
      const net = (await chrome.runtime.sendMessage({ type: 'getNetwork', tabId: tab.id })) || [];
      for (const n of net) {
        if (n.byExt || /lottie/i.test(n.url) || /lottie/.test(n.contentType)) addCandidate(n.url, 'network', { boost: 3 });
        else if (deep && n.kind !== 'main_frame' && n.kind !== 'sub_frame') addCandidate(n.url, 'network', { boost: -1 });
      }
    } catch (_) {}
    progress(0, 12, 1, 1, 'Page analysed', `${stats.frames} frame(s)`);

    // ---------- Phase 2: crawl same-origin pages ----------
    if (crawl && links.size) {
      const pages = [...links].slice(0, settings.maxPages);
      let done = 0;
      await pool(pages, 4, async (pageUrl) => {
        try {
          const { bytes, contentType } = await fetchBytes(pageUrl, { timeout: 20000, maxBytes: 15e6, signal });
          if (!/html|xml|text\/plain/.test(contentType) && contentType) return;
          const html = dec.decode(bytes);
          handleText(html, pageUrl, 'crawl', pageUrl);
          const doc = new DOMParser().parseFromString(html, 'text/html');
          doc.querySelectorAll('script[src]').forEach((s) => {
            try { const u = new URL(s.getAttribute('src'), pageUrl).href; if (!scripts.has(u)) scripts.set(u, pageUrl); } catch (_) {}
          });
          stats.pages++;
        } catch (e) {
          if (e instanceof Cancelled || signal.aborted) throw new Cancelled();
          stats.errors++;
        } finally {
          progress(12, 30, ++done, pages.length, 'Crawling site', pageUrl);
        }
      }, signal);
    }

    // ---------- Phase 3: external scripts ----------
    if (deep && scripts.size) {
      const list = [...scripts.keys()].slice(0, settings.maxScripts);
      let done = 0;
      await pool(list, 6, async (src) => {
        try {
          const { bytes } = await fetchBytes(src, { timeout: 20000, maxBytes: 25e6, signal });
          handleText(dec.decode(bytes), src, 'script', scripts.get(src));
          stats.scripts++;
        } catch (e) {
          if (e instanceof Cancelled || signal.aborted) throw new Cancelled();
          stats.errors++;
        } finally {
          progress(crawl ? 30 : 12, 45, ++done, list.length, 'Scanning scripts', src);
        }
      }, signal);
    }

    // ---------- Phase 4: validate candidate URLs ----------
    const queue = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, settings.maxCandidates);
    stats.candidates = queue.length;
    let done = 0;
    await pool(queue, 6, async (c) => {
      if (checkedUrls.has(c.url)) return;
      checkedUrls.add(c.url);
      try {
        const { bytes, finalUrl } = await fetchBytes(c.url, { signal });
        const fileName = decodeURIComponent((finalUrl.split('?')[0].split('/').pop() || '').replace(/\.(json|lottie)$/i, '')) || null;
        if (isZip(bytes)) {
          const { animations } = await unpackDotLottie(bytes);
          animations.forEach((a, i) => addFound(a.data, {
            source: c.source, url: finalUrl, elementId: c.elementId, frameId: c.frameId, pageUrl: c.pageUrl,
            dotLottie: { bytes, fileName: (fileName || 'animation') + '.lottie' },
            baseName: animations.length > 1 ? `${fileName || 'animation'}-${a.id || i + 1}` : fileName
          }));
        } else {
          let text = dec.decode(bytes).trim();
          if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
          if (text[0] === '{' || text[0] === '[') {
            let parsed = null;
            try { parsed = JSON.parse(text); } catch (_) {}
            const list = parsed ? X.findLotties(parsed) : [];
            list.forEach((d) => addFound(d, { source: c.source, url: finalUrl, elementId: c.elementId, frameId: c.frameId, pageUrl: c.pageUrl, baseName: list.length === 1 ? fileName : null }));
          }
        }
      } catch (e) {
        if (e instanceof Cancelled || signal.aborted) throw new Cancelled();
        stats.errors++;
      } finally {
        stats.checked++;
        progress(45, 100, ++done, queue.length, 'Validating candidates', c.url);
      }
    }, signal);

    progress(100, 100, 1, 1, 'Done', '');
    return { items: [...found.values()], stats };
  }

  root.LottieScanner = { scan, embedAssets, highlightElement, fetchBytes, Cancelled, bytesToBase64, pageCollector, runtimeCollector };
})(self);
