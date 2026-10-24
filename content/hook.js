// Lottie Scraper — runtime interceptor (MAIN world, document_start)
// Catches Lottie JSON the moment the page parses or loads it, before players
// mutate the data. Captures stay in-page until the side panel asks for them.
(() => {
  const KEY = Symbol.for('__lottie_scraper__');
  if (window[KEY]) return;

  const store = { items: [], urls: new Set(), fps: new Set(), max: 200 };
  try {
    Object.defineProperty(window, KEY, { value: store, enumerable: false, configurable: false });
  } catch (_) {
    return;
  }

  const origParse = JSON.parse;
  const origStringify = JSON.stringify;

  const isLottie = (o) =>
    o !== null &&
    typeof o === 'object' &&
    !Array.isArray(o) &&
    Array.isArray(o.layers) &&
    typeof o.fr === 'number' &&
    typeof o.ip === 'number' &&
    typeof o.op === 'number';

  const fingerprint = (o) => [o.nm, o.v, o.w, o.h, o.fr, o.ip, o.op, o.layers.length].join('|');

  const clone = (o) => {
    try { return structuredClone(o); } catch (_) {}
    try { return origParse(origStringify(o)); } catch (_) {}
    return o;
  };

  const notify = () => {
    try {
      document.dispatchEvent(new CustomEvent('__lottie_scraper_found', { detail: store.items.length }));
    } catch (_) {}
  };

  const record = (o, source, url) => {
    const fp = fingerprint(o);
    if (store.fps.has(fp) || store.items.length >= store.max) return;
    store.fps.add(fp);
    store.items.push({ data: clone(o), source, url: url || null });
    notify();
  };

  // Look at the value and up to two levels below it (APIs often wrap animations).
  const scan = (o, source, url, depth = 0) => {
    if (!o || typeof o !== 'object') return;
    if (isLottie(o)) return record(o, source, url);
    if (depth >= 2) return;
    let n = 0;
    if (Array.isArray(o)) {
      for (const v of o) { if (++n > 60) break; if (v && typeof v === 'object') scan(v, source, url, depth + 1); }
    } else {
      for (const k in o) {
        if (++n > 60) break;
        const v = o[k];
        if (v && typeof v === 'object') scan(v, source, url, depth + 1);
      }
    }
  };

  // JSON.parse — catches webpack-inlined JSON modules and text responses
  const wrappedParse = function parse(text, reviver) {
    const result = origParse.apply(this, arguments);
    try {
      if (typeof text === 'string' && text.length > 120 && text.indexOf('layers') !== -1) scan(result, 'JSON.parse');
    } catch (_) {}
    return result;
  };
  try { JSON.parse = wrappedParse; } catch (_) {}

  // fetch().json()
  try {
    const origJson = Response.prototype.json;
    Response.prototype.json = function json() {
      const url = this.url;
      return origJson.apply(this, arguments).then((r) => {
        try { scan(r, 'fetch', url); } catch (_) {}
        return r;
      });
    };
  } catch (_) {}

  // XMLHttpRequest (lottie-web loads `path` with responseType = 'json')
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function open() {
      try {
        this.addEventListener('load', function () {
          try {
            const url = this.responseURL;
            if (this.responseType === 'json') return scan(this.response, 'xhr', url);
            if (this.responseType === '' || this.responseType === 'text') {
              const t = this.responseText;
              if (t && t.length < 40e6 && t.indexOf('"layers"') !== -1) scan(origParse(t), 'xhr', url);
            }
          } catch (_) {}
        });
      } catch (_) {}
      return origOpen.apply(this, arguments);
    };
  } catch (_) {}

  // Global lottie-web / bodymovin libraries: wrap loadAnimation once they appear
  const wrapLib = (lib) => {
    try {
      if (!lib || typeof lib.loadAnimation !== 'function' || lib[KEY]) return lib;
      const orig = lib.loadAnimation;
      lib.loadAnimation = function loadAnimation(params) {
        try {
          if (params && params.animationData) scan(params.animationData, 'loadAnimation');
          else if (params && typeof params.path === 'string') {
            store.urls.add(new URL(params.path, document.baseURI).href);
            notify();
          }
        } catch (_) {}
        return orig.apply(this, arguments);
      };
      Object.defineProperty(lib, KEY, { value: true });
    } catch (_) {}
    return lib;
  };

  for (const name of ['lottie', 'bodymovin']) {
    try {
      let value = wrapLib(window[name]);
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get() { return value; },
        set(v) { value = wrapLib(v); }
      });
    } catch (_) {}
  }
})();
