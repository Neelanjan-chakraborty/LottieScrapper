// Unit tests for the extraction engine and ZIP code. Run: node tests/run.mjs
import { createRequire } from 'module'; import fs from 'fs'; import os from 'os'; import path from 'path'; import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const P = path.join(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lottie-scraper-'));
process.chdir(TMP);
const X = require(P + 'shared/extract.js'); const Z = require(P + 'shared/zip.js');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const anim = { v: '5.7.4', fr: 30, ip: 0, op: 60, w: 200, h: 200, nm: "Bob's \"hi\"", ddd: 0,
  assets: [{ id: 'comp_0', layers: [{ ty: 4, nm: 'inner', ks: {} }] }, { id: 'image_0', w: 10, h: 10, u: 'images/', p: 'img_0.png', e: 0 }],
  layers: [{ ty: 0, refId: 'comp_0', nm: 'pre' }, { ty: 4, nm: 'shape', ks: { o: { a: 0, k: 100 } } }] };
const J = JSON.stringify(anim);
// 1 plain JSON inside HTML script
let r = X.scanText(`<html><script>window.x = ${J};</script></html>`, 'https://ex.com/');
ok(r.inline.length === 1 && r.inline[0].nm === anim.nm, 'inline object in script');
// 2 webpack JSON.parse('...') string
r = X.scanText(`e.exports=JSON.parse('${J.replace(/'/g, "\\'")}')`, 'https://ex.com/');
ok(r.inline.length === 1, 'webpack JSON.parse string');
// 3 minified JS object literal
const lit = `var a={v:"5.7.4",fr:30,ip:0,op:60,w:200,h:200,nm:"x",ddd:0,assets:[{id:"comp_0",layers:[{ty:4,nm:"inner",ks:{},hd:!0}]}],layers:[{ty:0,refId:"comp_0",nm:"pre",sr:.5},{ty:4,nm:"shape",ks:{o:{a:0,k:100}},ao:!1}]};foo(a)`;
r = X.scanText(lit, 'https://ex.com/');
ok(r.inline.length === 1 && r.inline[0].layers[0].sr === 0.5 && r.inline[0].assets[0].layers[0].hd === true, 'JS object literal');
// 4 double-encoded
r = X.scanText(`{"props":{"anim":${JSON.stringify(J)}}}`, 'https://ex.com/');
ok(r.inline.length === 1, 'double-encoded JSON string');
// 5 html-entity attribute + escaped urls
r = X.scanText(`<div data-settings="{&quot;source_json&quot;:{&quot;url&quot;:&quot;https:\\/\\/cdn.ex.com\\/a\\/b.json&quot;}}"></div><lottie-player src="/anims/hero.lottie"></lottie-player><script src="x.js"></script>"manifest.json" 'rel/path/x.json?v=2'`, 'https://ex.com/page/');
ok(r.urls.includes('https://cdn.ex.com/a/b.json'), 'entity+escaped url ' + JSON.stringify(r.urls));
ok(r.urls.includes('https://ex.com/anims/hero.lottie'), 'relative .lottie');
ok(r.urls.includes('https://ex.com/page/rel/path/x.json?v=2'), 'relative json with query');
ok(!r.urls.some(u => u.includes('manifest')), 'noise filtered');
// 6 nested lottie inside bigger blob (Next data)
r = X.scanText(`<script id="__NEXT_DATA__">{"props":{"pageProps":{"blocks":[{"type":"hero","animation":${J}},{"t":"x"}]}}}</script>`, 'https://ex.com/');
ok(r.inline.length === 1, 'nested in __NEXT_DATA__');
// 7 two animations
r = X.scanText(`a=${J};b=${J.replace('"nm":', '"nm":"2nd","old":')}`, 'https://ex.com/');
ok(r.inline.length === 2, 'two animations: ' + r.inline.length);
// 8 non-lottie layers noise
r = X.scanText(`{"layers":[1,2],"map":"x"} it's a "quote" {fr:1}`, 'https://ex.com/');
ok(r.inline.length === 0, 'no false positives');
// meta / clean
const m = X.meta(anim); ok(m.frames === 60 && m.duration === 2 && m.precomps === 1 && m.images === 1, 'meta');
const dirty = JSON.parse(J); dirty.__complete = true; dirty.layers[0].layers = dirty.assets[0].layers; dirty.layers[1].completed = true;
ok(JSON.stringify(dirty, X.cleanReplacer) === J, 'cleanReplacer restores pristine JSON');
// restoreLottie: reverse lottie-web's in-place completeData (tangents -> absolute, flags, precomp refs)
{
  const P2 = (o) => ({ c: true, v: [[0, -50], [50, 0], [0, 50], [-50, 0]], i: [[-27.6 + o, 0], [0, -27.6], [27.6, 0], [0, 27.6]], o: [[27.6, 0], [0, 27.6], [-27.6, 0], [0, -27.6 + o]] });
  const lay = (ind) => ({ ty: 4, ind, nm: 'L' + ind, ks: {}, hasMask: true, masksProperties: [{ pt: { a: 0, k: P2(3) } }],
    shapes: [{ ty: 'gr', it: [{ ty: 'sh', ks: { a: 0, k: P2(1) } }, { ty: 'sh', ks: { a: 1, k: [{ t: 0, s: [P2(2)], e: [P2(4)] }, { t: 9, s: [P2(5)] }] } }, { ty: 'tr' }] }] });
  const orig = { v: '5.9.0', fr: 30, ip: 0, op: 60, w: 100, h: 100, nm: 'r', assets: [{ id: 'c0', layers: [lay(1)] }], layers: [{ ty: 0, ind: 1, refId: 'c0', ks: {} }, lay(2)] };
  const snap = JSON.stringify(orig);
  // simulate lottie-web completeData
  const done = JSON.parse(snap);
  const abs = (p) => p.v.forEach((v, n) => { p.i[n][0] += v[0]; p.i[n][1] += v[1]; p.o[n][0] += v[0]; p.o[n][1] += v[1]; });
  const prop = (k) => (k.i ? abs(k) : k.forEach((kf) => { if (kf.s) abs(kf.s[0]); if (kf.e) abs(kf.e[0]); }));
  const shp = (arr) => arr.forEach((s) => (s.ty === 'sh' ? prop(s.ks.k) : s.ty === 'gr' && shp(s.it)));
  const comp = (ls) => ls.forEach((l) => { if (l.completed) return; l.completed = true; l.masksProperties?.forEach((m) => prop(m.pt.k));
    if (l.ty === 0) { l.layers = done.assets[0].layers; comp(l.layers); } else if (l.ty === 4) { shp(l.shapes); l.shapes[0]._render = true; } });
  comp(done.layers); done.__complete = true;
  const corrupted = JSON.stringify(done, X.cleanReplacer);
  ok(corrupted !== snap, 'simulated player data differs from original');
  const back = JSON.parse(JSON.stringify(done, function (k, v) { return k === 'layers' && this.ty === 0 ? undefined : v; }));
  ok(X.restoreLottie(back) === true && JSON.stringify(back) === snap, 'restoreLottie reproduces the original byte-for-byte');
  const clean = JSON.parse(snap);
  ok(X.restoreLottie(clean) === false && JSON.stringify(clean) === snap, 'restoreLottie leaves pristine data untouched');
}
// zip roundtrip
const zw = new Z.ZipWriter(); await zw.add('json/a.json', J); await zw.add('json/ü-name.json', J.repeat(1)); await zw.add('raw.bin', new Uint8Array([1,2,3]), { compress: false });
const blob = zw.finish(); const buf = new Uint8Array(await blob.arrayBuffer()); fs.writeFileSync('t.zip', buf);
ok(execSync('unzip -t t.zip').toString().includes('No errors'), 'unzip -t validates');
const ents = Z.readZip(buf); const back = new TextDecoder().decode(await ents[0].read());
ok(back === J && ents.length === 3, 'readZip roundtrip');
// read a zip made by system zip (deflate)
fs.mkdirSync('dl/animations', { recursive: true }); fs.writeFileSync('dl/animations/one.json', J); fs.writeFileSync('dl/manifest.json', '{"animations":[{"id":"one"}]}');
execSync('rm -f d.lottie && cd dl && zip -qr ../d.lottie .');
const e2 = Z.readZip(fs.readFileSync('d.lottie')); const a2 = e2.find(e => e.name === 'animations/one.json');
ok(new TextDecoder().decode(await a2.read()) === J, 'reads system-zip deflated dotLottie');
fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
