# LottieScrapper

A Chrome / Edge / Brave extension (Manifest V3) that **detects, previews and bulk-downloads every Lottie animation** on a web page, as clean `.json` files or a single ZIP.

## Features

- **Live detector.** The toolbar badge counts Lottie animations on each tab as you browse.
- **Scan modes**
  - **Quick:** DOM players, runtime hooks, the network log and inline JSON.
  - **Deep:** Quick, plus every external script bundle and every JSON response the tab loaded.
  - **Crawl:** Deep, plus up to N same-origin pages linked from the current page.
- **Side-panel UI.** Previews play as you scroll, with search, sort, multi-select, a detail view (play/pause, scrub, speed, background), metadata and copy/download buttons.
- **Progress feedback.** A progress bar with phase and stats is shown while scanning, and a progress ring is shown while building the ZIP. Both can be cancelled.
- **ZIP export.** The archive contains `json/*.json`, the original `dotlottie/*.lottie` files (optional) and an `index.json` manifest with metadata and source URLs.
- **Self-contained output.** External image assets are embedded as base64 (optional). Images in dotLottie files are always inlined.
- **Locate on page.** Scrolls to the element that renders an animation and highlights it.

## How detection works

| Layer | What it catches |
|---|---|
| `content/hook.js` (MAIN world, `document_start`) | `JSON.parse`, `Response.json()`, `XMLHttpRequest` and `lottie.loadAnimation` calls. It stores a clean copy before lottie-web changes the data. |
| Runtime collector | `lottie.getRegisteredAnimations()`, `<lottie-player>`, `<dotlottie-player>`, `<dotlottie-wc>` and open shadow roots |
| DOM collector | `src`, `data-src`, `data-animation-path`, Webflow `data-animation-type="lottie"`, Elementor `data-settings`, `<link rel=preload>` and the `performance` resource timeline |
| Text carving (`shared/extract.js`) | URLs ending in `.json` or `.lottie` (including HTML-entity and `\/`-escaped forms), inline JSON, webpack `JSON.parse('…')` strings, minified JS object literals (`{v:"5.7",fr:30,…,hd:!0}`) and double-encoded JSON |
| Service worker | Every JSON or `.lottie` response the tab receives, by content type |

Every candidate is downloaded and checked: it must be a JSON object with `layers[]`, `fr`, `ip` and `op` (Lottie nested inside API responses is found too), or a dotLottie v1/v2 archive. Duplicates are merged by fingerprint.

## Install (unpacked)

1. Clone this repo.
2. Open `chrome://extensions`, then turn on **Developer mode**.
3. Click **Load unpacked** and select the project folder.
4. Pin **Lottie Scraper**, then click the icon on any page to open the side panel.

## Project layout

```
manifest.json          MV3 manifest
background.js          side-panel wiring, badge, network capture
content/hook.js        runtime interceptor (MAIN world)
content/detector.js    passive badge detector
shared/extract.js      URL harvesting, JSON carving, validation, metadata
shared/zip.js          ZIP writer/reader on native CompressionStream (no deps)
sidepanel/             UI (index.html, styles.css, app.js) and scan pipeline (scanner.js)
sidepanel/lib/         lottie-web light build (no eval, MV3 CSP-safe) for previews
```

## Notes

- Chrome blocks extensions on `chrome://` pages, the Chrome Web Store and some built-in viewers.
- Previews use lottie-web's *light* renderer, which has no expression support. Animations that use expressions may look static in the preview, but the exported JSON is unchanged.
- Some animations load only after you scroll or interact with the page. Scroll first, then scan again.
- Only download animations you have the right to use.
