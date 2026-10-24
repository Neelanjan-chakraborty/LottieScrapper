## Lottie Scraper v1.1.0: faithful exports and performance 🚀

### 🐛 Fixed: corrupted animations
Animations taken from a running lottie-web player could export distorted, with spiky shapes and broken paths. lottie-web rewrites animation data in place after loading it: it converts every path tangent from relative to absolute and attaches internal flags and precomp references. v1.1.0:
- **Prefers the original file.** When a player's source URL is known, the untouched file is downloaded and replaces the player's copy.
- **Repairs the player copy otherwise.** `restoreLottie()` reverses lottie-web's edits exactly (shape paths, keyframed paths, masks, glyphs, flags). Tests check the result is byte-for-byte identical to the original.
- **Tells you when to reload.** If the page was open before the extension was installed, you're prompted to reload once so original files are captured directly.

### ⚡ Performance and memory
- **Smooth scrolling with hundreds of animations.** A benchmark of 216 heavy animations (27 layers at 1100×1100) runs at a steady **60 fps** with **0 long tasks**; v1.0.0 averaged 3 fps with 1-second frames on the same test.
- **Bounded preview pool.** Players are built during idle time, only visible cards play, at most 32 players exist, and the least recently seen ones are released.
- **Thumbnails at native frame rate.** Thumbnails render at the animation's own frame rate. The detail player keeps full sub-frame smoothness.
- **Grid pauses under overlays.** Grid animations pause while the detail sheet or export overlay is open.
- **Cheaper rendering.** Removed blur filters drawn over live animations and the fixed background that repainted on scroll, and added `content-visibility` and CSS containment to cards.
- **Less memory per animation.** Animations are stored as compact JSON strings instead of object graphs, both in the panel and in the page hook, with a 64 MB cap in the page.
- **Fewer DOM updates.** Cards, progress and selection updates are batched to one per frame, and search is debounced.
- **Faster export.** Minified exports reuse the stored JSON directly.

### ⬇️ Install
Download **`lottie-scraper-v1.1.0.zip`** below. Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the unzipped folder. If you're updating, click ↻ on the extension and reload your open tabs.

Made by **Neelanjan Chakraborty**.
