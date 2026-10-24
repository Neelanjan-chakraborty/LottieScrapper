// Lottie Scraper — shared extraction engine.
// Loaded into pages (via chrome.scripting), into the side panel, and into Node for tests.
(function (root) {
  'use strict';

  // ---------- Lottie validation & metadata ----------
  function isLottie(o) {
    return (
      o !== null &&
      typeof o === 'object' &&
      !Array.isArray(o) &&
      Array.isArray(o.layers) &&
      typeof o.fr === 'number' &&
      typeof o.ip === 'number' &&
      typeof o.op === 'number' &&
      ('v' in o || ('w' in o && 'h' in o))
    );
  }

  // Finds Lottie objects at `o` or nested inside it (e.g. API envelopes).
  function findLotties(o, maxDepth = 4, out = [], depth = 0) {
    if (!o || typeof o !== 'object' || out.length >= 50) return out;
    if (isLottie(o)) { out.push(o); return out; }
    if (depth >= maxDepth) return out;
    const vals = Array.isArray(o) ? o : Object.values(o);
    for (let i = 0; i < vals.length && i < 200; i++) {
      const v = vals[i];
      if (v && typeof v === 'object') findLotties(v, maxDepth, out, depth + 1);
    }
    return out;
  }

  function fingerprint(o) {
    const names = o.layers.slice(0, 8).map((l) => (l && l.nm) || '').join(',');
    return [o.nm, o.v, o.w, o.h, o.fr, o.ip, o.op, o.layers.length, (o.assets || []).length, names].join('|');
  }

  function meta(o) {
    const assets = Array.isArray(o.assets) ? o.assets : [];
    const images = assets.filter((a) => a && a.p && !a.layers);
    const frames = Math.max(0, (o.op || 0) - (o.ip || 0));
    return {
      name: typeof o.nm === 'string' ? o.nm : '',
      version: typeof o.v === 'string' ? o.v : '',
      width: o.w | 0,
      height: o.h | 0,
      fps: Math.round((o.fr || 0) * 100) / 100,
      frames,
      duration: o.fr ? frames / o.fr : 0,
      layers: o.layers.length,
      precomps: assets.filter((a) => a && Array.isArray(a.layers)).length,
      images: images.length,
      embeddedImages: images.filter((a) => a.e === 1 || /^data:/.test(a.p || '')).length,
      markers: Array.isArray(o.markers) ? o.markers.length : 0,
      fonts: o.fonts && Array.isArray(o.fonts.list) ? o.fonts.list.length : 0,
      is3d: !!o.ddd
    };
  }

  // Strip keys that lottie-web adds when it "completes" data at runtime.
  function cleanReplacer(key, value) {
    if (key === 'completed' || (typeof key === 'string' && key.startsWith('__'))) return undefined;
    if (key === 'layers' && this && this.ty === 0 && this.refId) return undefined;
    return value;
  }

  // ---------- undo lottie-web's in-place "completeData" ----------
  // When lottie-web loads an animation it rewrites the data in place:
  //   * every path's in/out tangents become absolute (i += v, o += v) in shape
  //     layers, masks and font glyphs — re-exporting that data distorts shapes;
  //   * precomp layers get `layers` attached, layers get `completed: true`,
  //     the root gets `__complete: true`, glyphs get default transforms.
  // `restoreLottie` reverses exactly those steps so the export matches the original file.
  function relPath(p) {
    if (!p || !Array.isArray(p.v) || !Array.isArray(p.i) || !Array.isArray(p.o)) return;
    for (let n = 0; n < p.v.length; n++) {
      const v = p.v[n], i = p.i[n], o = p.o[n];
      if (!v || !i || !o) continue;
      i[0] -= v[0]; i[1] -= v[1];
      o[0] -= v[0]; o[1] -= v[1];
    }
  }
  function relProp(k) {
    if (!k) return;
    if (k.i) return relPath(k);
    if (!Array.isArray(k)) return;
    for (const kf of k) {
      if (kf && kf.s) relPath(kf.s[0]);
      if (kf && kf.e) relPath(kf.e[0]);
    }
  }
  function relShapes(arr) {
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      if (!s) continue;
      if (s.ty === 'sh' && s.ks) relProp(s.ks.k);
      else if (s.ty === 'gr') relShapes(s.it);
    }
  }
  function stripInternal(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (const v of o) stripInternal(v); return; }
    for (const k of Object.keys(o)) {
      // lottie-web's runtime bookkeeping: `completed`, `__complete`, `__used`, `_render`, …
      // (the Lottie schema has no keys starting with an underscore)
      if (k === 'completed' || k.charCodeAt(0) === 95) delete o[k];
      else stripInternal(o[k]);
    }
  }
  // Returns true when the data had been modified by a player and was repaired.
  function restoreLottie(data) {
    if (!isLottie(data)) return false;
    const seen = new Set();
    let touched = !!data.__complete;
    const fixLayers = (layers) => {
      if (!Array.isArray(layers)) return;
      for (const l of layers) {
        if (!l || seen.has(l)) continue;
        seen.add(l);
        if (l.ty === 0 && l.refId && Array.isArray(l.layers)) delete l.layers;
        if (!l.completed) continue;
        touched = true;
        if (l.hasMask && Array.isArray(l.masksProperties)) for (const m of l.masksProperties) if (m && m.pt) relProp(m.pt.k);
        if (l.ty === 4) relShapes(l.shapes);
      }
    };
    fixLayers(data.layers);
    for (const a of data.assets || []) if (a && Array.isArray(a.layers)) fixLayers(a.layers);
    // Glyph shapes are completed once per file (only flagged by `__complete`),
    // and only for files exported by bodymovin >= 4.7.99.
    const ver = String(data.v || '100').split('.').map((n) => parseInt(n, 10) || 0);
    const glyphsCompleted = ver[0] > 4 || (ver[0] === 4 && (ver[1] > 7 || (ver[1] === 7 && (ver[2] || 0) >= 99)));
    const DEFAULT_KS = '{"p":{"k":[0,0],"a":0},"s":{"k":[100,100],"a":0},"a":{"k":[0,0],"a":0},"r":{"k":0,"a":0},"o":{"k":100,"a":0}}';
    if (data.__complete && glyphsCompleted && Array.isArray(data.chars)) {
      for (const ch of data.chars) {
        const d = ch && ch.data;
        if (!d) continue;
        if (Array.isArray(d.layers) && d.refId) delete d.layers;
        if (!Array.isArray(d.shapes)) continue;
        relShapes(d.shapes);
        if (!ch.t) {
          const last = d.shapes[d.shapes.length - 1];
          if (last && last.ty === 'no') d.shapes.pop();
          const it = d.shapes[0] && d.shapes[0].it;
          if (Array.isArray(it) && it.length > 1 && it[it.length - 1].ty === 'tr' && it[it.length - 2].ty === 'tr') it.pop();
        }
        if (d.ip === 0 && d.op === 99999 && d.st === 0 && d.sr === 1) { delete d.ip; delete d.op; delete d.st; delete d.sr; }
        if (d.ks && JSON.stringify(d.ks) === DEFAULT_KS) delete d.ks;
      }
    }
    stripInternal(data);
    return touched;
  }

  // ---------- text helpers ----------
  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    return s
      .replace(/&quot;|&#34;|&#x22;/gi, '"')
      .replace(/&#39;|&#x27;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&');
  }

  function resolveUrl(u, base) {
    if (!u || typeof u !== 'string') return null;
    u = u.trim();
    if (!u || u.startsWith('blob:') || u.startsWith('javascript:')) return null;
    if (u.startsWith('data:')) return /^data:application\/(json|zip|octet-stream)|^data:text\/(plain|json)/i.test(u) ? u : null;
    try {
      const url = new URL(u, base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      url.hash = '';
      return url.href;
    } catch (_) {
      return null;
    }
  }

  // ---------- URL harvesting ----------
  const ABS_RE = /(?:https?:)?\/\/[^\s"'`<>()\\{}|^\[\]]+?\.(?:json|lottie)(?:\?[^\s"'`<>()\\{}|^\[\]]*)?(?![\w.\/-])/gi;
  const REL_RE = /["'`(=]\s*((?:\.{0,2}\/)?[\w\-.~%@+]+(?:\/[\w\-.~%@+]+)*\.(?:json|lottie)(?:\?[^\s"'`<>()\\{}|^]*)?)\s*["'`)]/gi;
  const NOISE_RE = /(?:^|\/)(?:manifest|site\.webmanifest|package(?:-lock)?|tsconfig|jsconfig|composer|asset-manifest|build-manifest|react-loadable-manifest|_buildManifest|_ssgManifest|middleware-manifest|app-build-manifest|webpack-stats|browserconfig|oembed|sw|service-worker|swagger|openapi)\.json\b|\/wp-json\/|\.map(?:\.json)?(?:\?|$)/i;

  function harvestUrls(text, base, limit = 2000) {
    const found = new Set();
    if (!text) return [];
    const t = text.indexOf('\\/') !== -1 ? text.replace(/\\\//g, '/') : text;
    let m;
    ABS_RE.lastIndex = 0;
    while ((m = ABS_RE.exec(t)) && found.size < limit) {
      const r = resolveUrl(m[0], base);
      if (r && !NOISE_RE.test(r)) found.add(r);
    }
    REL_RE.lastIndex = 0;
    while ((m = REL_RE.exec(t)) && found.size < limit) {
      if (/^\/\//.test(m[1])) continue;
      const r = resolveUrl(m[1], base);
      if (r && !NOISE_RE.test(r)) found.add(r);
    }
    return [...found];
  }

  function urlScore(u) {
    let s = 0;
    if (/lottie|bodymovin|lottiefiles|lottie\.host/i.test(u)) s += 5;
    if (/\.lottie(?:\?|$)/i.test(u)) s += 4;
    if (/anim|motion|icon|loader|illustration/i.test(u)) s += 2;
    if (/\.json(?:\?|$)/i.test(u)) s += 1;
    if (/i18n|locale|translation|config|settings|schema|api\//i.test(u)) s -= 2;
    return s;
  }

  // ---------- inline JSON carving ----------
  // Walk backwards from `idx` to the `{` that opens the object containing it.
  function findObjectStart(text, idx, maxBack = 4e6) {
    let depth = 0;
    const stop = Math.max(0, idx - maxBack);
    for (let i = idx - 1; i >= stop; i--) {
      const c = text.charCodeAt(i);
      if (c === 34) { // " (apostrophes are too common in prose/code to treat as delimiters here)
        let j = i - 1;
        while (j >= stop) {
          if (text.charCodeAt(j) === c) {
            let bs = 0, k = j - 1;
            while (k >= 0 && text.charCodeAt(k) === 92) { bs++; k--; }
            if (bs % 2 === 0) break;
          }
          j--;
        }
        i = j;
        continue;
      }
      if (c === 125 || c === 93) depth++; // } ]
      else if (c === 123 || c === 91) { // { [
        if (depth > 0) depth--;
        else if (c === 123) return i;
      }
    }
    return -1;
  }

  // Forward-match the object that opens at `start`.
  function findObjectEnd(text, start, maxLen = 60e6) {
    let depth = 0;
    const stop = Math.min(text.length, start + maxLen);
    for (let i = start; i < stop; i++) {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 39 || c === 96) {
        for (i++; i < stop; i++) {
          const d = text.charCodeAt(i);
          if (d === 92) { i++; continue; }
          if (d === c) break;
        }
        continue;
      }
      if (c === 123 || c === 91) depth++;
      else if (c === 125 || c === 93) {
        depth--;
        if (depth === 0) return c === 125 ? i : -1;
      }
    }
    return -1;
  }

  // JS object literal -> JSON (handles unquoted keys, single quotes, !0/!1, .5, trailing commas)
  function jsToJson(s) {
    let out = '';
    const n = s.length;
    let i = 0;
    while (i < n) {
      const c = s[i];
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1, str = '';
        while (j < n && s[j] !== c) {
          if (s[j] === '\\') { str += s[j] + s[j + 1]; j += 2; continue; }
          str += s[j++];
        }
        if (j >= n) return null;
        if (c === '"') out += '"' + str + '"';
        else out += '"' + str.replace(/\\'/g, "'").replace(/\\`/g, '`').replace(/(^|[^\\])((?:\\\\)*)"/g, '$1$2\\"') + '"';
        i = j + 1;
        continue;
      }
      if (c === '!' && (s[i + 1] === '0' || s[i + 1] === '1') && !/[\w.]/.test(s[i + 2] || '')) {
        out += s[i + 1] === '0' ? 'true' : 'false';
        i += 2;
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < n && /[\w$]/.test(s[j])) j++;
        const word = s.slice(i, j);
        let k = j;
        while (k < n && /\s/.test(s[k])) k++;
        if (s[k] === ':') out += JSON.stringify(word);
        else if (word === 'true' || word === 'false' || word === 'null') out += word;
        else if (word === 'void' && s.slice(k, k + 1) === '0') { out += 'null'; j = k + 1; }
        else if (word === 'undefined' || word === 'NaN' || word === 'Infinity') out += 'null';
        else return null; // real code — not a literal
        i = j;
        continue;
      }
      if (c === '.' && /\d/.test(s[i + 1] || '')) {
        out += /[\d]/.test(out[out.length - 1] || '') ? '.' : '0.';
        i++;
        continue;
      }
      if (c === ',') {
        let k = i + 1;
        while (k < n && /\s/.test(s[k])) k++;
        if (s[k] === '}' || s[k] === ']') { i++; continue; }
      }
      out += c;
      i++;
    }
    return out.replace(/(\d)\.(?=[,\]}\s])/g, '$1');
  }

  function parseLoose(raw) {
    try { return JSON.parse(raw); } catch (_) {}
    if (raw.indexOf("\\'") !== -1) {
      try { return JSON.parse(raw.replace(/\\'/g, "'")); } catch (_) {}
    }
    try {
      const j = jsToJson(raw);
      if (j) return JSON.parse(j);
    } catch (_) {}
    return null;
  }

  const LAYERS_RE = /["']?\blayers["']?\s*:\s*\[/g;
  const KEY_TEST = (raw, k) => new RegExp('["\']?\\b' + k + '["\']?\\s*:').test(raw);

  function carveInline(text, limit = 60) {
    const out = [];
    if (!text || text.indexOf('layers') === -1) return out;
    const seen = new Set();
    let covered = -1;
    let m, tries = 0;
    LAYERS_RE.lastIndex = 0;
    while ((m = LAYERS_RE.exec(text)) && out.length < limit && tries < 3000) {
      tries++;
      if (m.index < covered) continue;
      let pos = m.index;
      for (let climb = 0; climb < 5; climb++) {
        const start = findObjectStart(text, pos);
        if (start < 0) break;
        const end = findObjectEnd(text, start);
        if (end < 0) break;
        const raw = text.slice(start, end + 1);
        if (raw.length > 150 && KEY_TEST(raw, 'fr') && KEY_TEST(raw, 'op') && KEY_TEST(raw, 'ip')) {
          const obj = parseLoose(raw);
          if (obj && isLottie(obj)) {
            const fp = fingerprint(obj);
            if (!seen.has(fp)) { seen.add(fp); out.push(obj); }
            covered = end;
            LAYERS_RE.lastIndex = end;
            break;
          }
        }
        pos = start; // climb to the enclosing object
      }
    }
    return out;
  }

  // Scan a blob of text (HTML or JS) for everything Lottie-shaped.
  function scanText(text, base, opts = {}) {
    let t = text || '';
    const urls = harvestUrls(decodeEntities(t), base, opts.urlLimit || 2000);
    let inline = carveInline(decodeEntities(t), opts.inlineLimit || 60);
    // double-encoded JSON strings: "{\"v\":\"5.7\",...}"
    if (t.indexOf('\\"layers\\"') !== -1) {
      const unescaped = t.replace(/\\\\/g, '\u0000').replace(/\\"/g, '"').replace(/\u0000/g, '\\');
      const more = carveInline(unescaped, opts.inlineLimit || 60);
      const fps = new Set(inline.map(fingerprint));
      inline = inline.concat(more.filter((o) => !fps.has(fingerprint(o))));
    }
    return { urls, inline };
  }

  const api = {
    isLottie, findLotties, fingerprint, meta, cleanReplacer, restoreLottie,
    decodeEntities, resolveUrl, harvestUrls, urlScore,
    carveInline, parseLoose, jsToJson, scanText
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LottieExtract = api;
})(typeof self !== 'undefined' ? self : globalThis);
