// Lottie Scraper — passive detector (isolated world)
// Counts Lottie animations on the page and reports the number for the toolbar badge.
(() => {
  if (window.__lottieScraperDetector) return;
  window.__lottieScraperDetector = true;

  const PLAYER_SEL = [
    'lottie-player',
    'dotlottie-player',
    'dotlottie-wc',
    'lottie-interactive',
    'tgs-player',
    '[data-animation-type="lottie"]',
    '[data-lottie]',
    '[data-lottie-src]',
    '[data-animation-path]',
    '[data-bm-path]'
  ].join(',');

  let hookCount = 0;
  let last = -1;
  let timer = null;

  function domCount() {
    const players = document.querySelectorAll(PLAYER_SEL);
    // lottie-web's SVG renderer leaves `__lottie_element_N` ids in its defs
    const rendered = new Set();
    document.querySelectorAll('[id^="__lottie_element_"]').forEach((n) => {
      const svg = n.closest('svg');
      if (svg && !svg.parentElement?.closest(PLAYER_SEL)) rendered.add(svg);
    });
    return players.length + rendered.size;
  }

  function report() {
    timer = null;
    let count = 0;
    try { count = Math.max(domCount(), hookCount); } catch (_) {}
    if (count === last) return;
    last = count;
    try { chrome.runtime.sendMessage({ type: 'detect', count }).catch(() => {}); } catch (_) {}
  }

  function schedule(delay = 1200) {
    if (!timer) timer = setTimeout(report, delay);
  }

  document.addEventListener('__lottie_scraper_found', (e) => {
    hookCount = Math.max(hookCount, Number(e.detail) || 0);
    schedule(400);
  });

  new MutationObserver(() => schedule()).observe(document.documentElement, { childList: true, subtree: true });
  report();
})();
