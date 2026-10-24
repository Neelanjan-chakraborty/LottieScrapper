#!/usr/bin/env bash
# Packs the extension into dist/lottie-scraper-v<version>.zip (ready for "Load unpacked" or the Chrome Web Store).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="dist/lottie-scraper-v${VERSION}.zip"
mkdir -p dist
rm -f "$OUT"
zip -qr -X "$OUT" manifest.json background.js content shared sidepanel icons LICENSE -x '*.DS_Store'
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
