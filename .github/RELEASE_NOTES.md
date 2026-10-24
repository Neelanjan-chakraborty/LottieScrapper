## Lottie Scraper v1.0.0 — first public release 🎉

Detect, preview and bulk-download every Lottie animation on any website.

### ⬇️ Install
1. Download **`lottie-scraper-v1.0.0.zip`** below and unzip it.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`) and enable **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder.
4. Pin **Lottie Scraper** and click it on any page to open the side panel.

### ✨ Highlights
- **Live detector:** the toolbar badge counts Lottie animations on each tab.
- **Three scan modes:** Quick (DOM, runtime and network), Deep (adds script bundles and every JSON response) and Crawl (adds same-origin pages).
- **Runtime interception:** catches animations from `JSON.parse`, `fetch`, `XHR` and `lottie.loadAnimation` before players change the data.
- **Text carving:** finds inline JSON, webpack `JSON.parse('…')` strings, minified JS object literals and escaped URLs.
- **dotLottie support:** reads v1 and v2 archives and embeds their images in the extracted JSON.
- **Previews:** cards play as you scroll, and a detail player has scrubbing, speed and background controls.
- **One-click ZIP:** contains `json/`, the original `dotlottie/` files and an `index.json` manifest. Progress is shown and the export can be cancelled.
- **No third-party dependencies:** ZIP files are built with the browser's native compression.

Requires Chrome / Edge / Brave **116+**.

Made by **Neelanjan Chakraborty**.
