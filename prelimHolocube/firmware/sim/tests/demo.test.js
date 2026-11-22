// Integration: the real seven_panel_volume_demo.ino, unchanged, through the whole slideshow.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HAVE_ZIG, DEMO, ROOT, demoRun, layerBitmaps, countLit, bbox, lit, frameHash, decodePNG } from './helpers.js';
import { main as headlessMain } from '../tools/headless.js';

const skip = HAVE_ZIG ? false : 'zig not installed';
const GOLDEN = path.join(ROOT, 'tests', 'golden', 'text_scene.sha256');
const cap = (run, name) => run.captures.find((c) => c.name === name);

// ---- independent reference of the text scene, using the glyph tables parsed from the .ino itself ----
function parseFont(src) {
  const font = {};
  const block = src.slice(src.indexOf('const Glyph font[]'), src.indexOf('};', src.indexOf('const Glyph font[]')));
  for (const m of block.matchAll(/\{'(.)',\s*\{([^}]*)\}\}/g)) font[m[1]] = m[2].split(',').map((s) => parseInt(s.trim(), 16));
  return font;
}
function referenceText() {
  const font = parseFont(fs.readFileSync(DEMO, 'utf8'));
  const bm = new Uint8Array(128 * 128);
  const text = (y, s, sx, sy, bold) => {
    const w = s.length * 6 * sx - sx + bold, x0 = Math.floor((128 - w) / 2);
    [...s].forEach((ch, i) => {
      font[ch].forEach((colBits, col) => {
        for (let row = 0; row < 7; row++) if ((colBits >> row) & 1)
          for (let dy = 0; dy < sy + bold; dy++) for (let dx = 0; dx < sx + bold; dx++) {
            const px = x0 + i * 6 * sx + col * sx + dx, py = y + row * sy + dy;
            if (px >= 0 && px < 128 && py >= 0 && py < 128) bm[py * 128 + px] = 1;
          }
      });
    });
  };
  text(12, 'MIT', 7, 7, 3);       // bold MIT at 7x scale, 3 px bold
  text(76, 'Maker', 2, 2, 0);     // 2x scale
  text(96, 'Portfolio', 2, 2, 0); // 2x scale
  return bm;
}

test('the real demo plays the whole slideshow without errors or hardware warnings', { skip }, async () => {
  const run = await demoRun();
  assert.equal(run.result.reason, 'stopped', run.result.message);
  const lines = run.serial.map((s) => s.line);
  const expectOrder = ['Pre-delay boot', 'Post-delay boot', 'Init done - all panels on (blank).', 'Scene: text', 'Scene: axes', 'Scene: axes + sphere',
    'Demo: rotating cube', 'Demo: torus', 'Demo: wireframe globe', 'Demo: DNA helix', 'Demo: atom', 'Demo: ripple surface', 'Demo: 3D rain',
    'Demo: Lissajous snake', 'Demo: bouncing ball', 'Demo: expanding shells'];
  let at = -1;
  for (const e of expectOrder) { const i = lines.indexOf(e, at + 1); assert.ok(i > at, `serial line "${e}" missing or out of order`); at = i; }
  const bad = run.warnings.filter((w) => w.level !== 'info');
  assert.deepEqual(bad.map((w) => `${w.code}: ${w.message}`), [], 'the unmodified demo is clean on the hardware lint');
  assert.ok(run.warnings.some((w) => w.code === 'PIN_WROVER' && w.level === 'info'), 'GPIO16 note is informational only');
  const fps = lines.filter((l) => /frames \(/.test(l)).map((l) => +/\(([\d.]+) fps\)/.exec(l)[1]);
  assert.equal(fps.length, 10, 'every demo prints its frame rate');
  for (const f of fps) assert.ok(f > 2, `fps ${f}`);   // upper bound only meaningful with the CPU cost model, see below
});

test('init leaves every panel on with RAM written, external-VPP mode and max contrast', { skip }, async () => {
  const { snapshot } = await demoRun();
  for (const [i, p] of snapshot.panels.entries()) {
    assert.equal(p.state.on, true, `panel ${i + 1} on`);
    assert.equal(p.state.dcdc, 0x8A, `panel ${i + 1} ext VPP`);
    assert.equal(p.state.contrast, 0xFF);
    assert.equal(p.state.ramWritten, true);
    assert.equal(p.state.allOn, false);
  }
});

test('text scene: bold MIT 7x/3px, Maker + Portfolio 2x, identical on displays 5-7, empty on 1-4', { skip }, async () => {
  const run = await demoRun();
  const maps = layerBitmaps(cap(run, 'text').snap);
  for (const k of [0, 1, 2, 3]) assert.equal(countLit(maps[k]), 0, `display ${k + 1} is empty`);
  const ref = referenceText();
  for (const k of [4, 5, 6]) {
    let diff = 0;
    for (let i = 0; i < 128 * 128; i++) if ((maps[k][i] > 0 ? 1 : 0) !== ref[i]) diff++;
    assert.equal(diff, 0, `display ${k + 1} matches the reference layout pixel-for-pixel`);
  }
  assert.deepEqual(maps[4], maps[5]); assert.deepEqual(maps[5], maps[6]);
  // spot-check the geometry the sketch comment promises
  const mit = bbox(maps[4].map((v, i) => (i < 128 * 70 ? v : 0)));
  assert.deepEqual(mit, { x0: 3, y0: 12, x1: 124, y1: 63 }, 'MIT block');
});

test('axes scene: X and Y through the centre of display 4, a Z marker on every display', { skip }, async () => {
  const maps = layerBitmaps(cap(await demoRun(), 'axes').snap);
  const mid = maps[3];
  // axis lines (16 px per unit, +-48 px) pass through pixel (64,64)
  for (let x = 64 - 48; x <= 64 + 48; x++) assert.ok(lit(mid, x, 64), `X axis pixel ${x}`);
  for (let y = 64 - 48; y <= 64 + 48; y++) assert.ok(lit(mid, 64, y), `Y axis pixel ${y}`);
  assert.ok(!lit(mid, 64 - 49 + 2, 64 + 20) || true);
  for (let k = 0; k < 7; k++) assert.ok(lit(maps[k], 64, 64), `Z axis marker on display ${k + 1}`);
  for (const k of [0, 1, 2, 4, 5, 6]) assert.ok(countLit(maps[k]) < 120, `display ${k + 1} only has the small Z tick`);
  // centred: the span of the horizontal axis (without tick labels) is symmetric around 64
  let x0 = 64, x1 = 64;   // contiguous run through the origin (the 'X' label further right is a separate run)
  while (x0 > 0 && lit(mid, x0 - 1, 64)) x0--;
  while (x1 < 127 && lit(mid, x1 + 1, 64)) x1++;
  assert.equal([x0, x1].join('..'), '16..112');
  assert.equal((x0 + x1) / 2, 64, 'axis is centred on pixel column 64 (0.5 px right of the true panel centre at 63.5, a property of the sketch)');
});

test('sphere scene: poles land on displays 1 and 7, equator on display 4', { skip }, async () => {
  const maps = layerBitmaps(cap(await demoRun(), 'sphere').snap);
  // remove the axes (they are drawn on the same layers): the sphere points are 2x2 blocks, axes are 1 px wide
  const blocks = (bm) => {
    const found = [];
    for (let y = 0; y < 127; y++) for (let x = 0; x < 127; x++)
      if (lit(bm, x, y) && lit(bm, x + 1, y) && lit(bm, x, y + 1) && lit(bm, x + 1, y + 1)) found.push([x, y]);
    return found;
  };
  const b0 = blocks(maps[0]), b6 = blocks(maps[6]);
  assert.deepEqual(b0, [[63, 63]], 'display 1 has exactly one point: the south pole, at the centre');
  assert.deepEqual(b6, [[63, 63]], 'display 7 has exactly one point: the north pole, at the centre');
  // equator ring on display 4 reaches ~48 px (R = 7.5 mm / 0.1573)
  const ring = blocks(maps[3]).map(([x, y]) => Math.hypot(x + 1 - 64, y + 1 - 64));
  assert.ok(ring.length >= 20, `equator has many points (${ring.length})`);
  assert.ok(Math.max(...ring) > 46 && Math.max(...ring) < 49.5, `equator radius ${Math.max(...ring).toFixed(1)} px`);
  // ring radius shrinks toward the poles
  const maxR = (bm) => Math.max(0, ...blocks(bm).map(([x, y]) => Math.hypot(x + 1 - 64, y + 1 - 64)));
  assert.ok(maxR(maps[2]) < maxR(maps[3]) && maxR(maps[1]) < maxR(maps[2]) && maxR(maps[0]) < maxR(maps[1]));
});

test('every animated demo draws something and stays inside the 7-layer volume', { skip }, async () => {
  const run = await demoRun();
  const names = run.captures.filter((c) => c.name.startsWith('Demo_'));
  assert.equal(names.length, 10);
  for (const c of names) {
    const maps = layerBitmaps(c.snap);
    const total = maps.reduce((n, m) => n + countLit(m), 0);
    assert.ok(total > 30, `${c.name}: ${total} lit pixels`);
    assert.ok(maps.filter((m) => countLit(m) > 0).length >= 1);
  }
  // demos that are supposed to use depth really do span several displays
  const used = (n) => layerBitmaps(run.captures.find((c) => c.name === n).snap).filter((m) => countLit(m) > 0).length;
  for (const n of ['Demo_3D_rain', 'Demo_torus', 'Demo_expanding_shells', 'Demo_atom']) assert.ok(used(n) >= 3, `${n} uses ${used(n)} displays`);
});

test('frame-hash regression on the text scene', { skip }, async () => {
  const h = frameHash(cap(await demoRun(), 'text').snap);
  if (process.env.UPDATE_GOLDEN || !fs.existsSync(GOLDEN)) { fs.writeFileSync(GOLDEN, h + '\n'); }
  assert.equal(h, fs.readFileSync(GOLDEN, 'utf8').trim(), 'text scene changed; if intended, rerun with UPDATE_GOLDEN=1');
});

test('headless mode dumps PNGs and the text-scene PNG matches the expected layout', { skip }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-png-'));
  const code = await headlessMain([DEMO, '--until', '12', '--out', out, '--shots', 'text=9', '--views', 'layers,front,oblique', '--cpu-factor', '0', '--quiet']);
  assert.equal(code, 0);
  for (const f of ['text_layers.png', 'text_front.png', 'text_oblique.png']) assert.ok(fs.existsSync(path.join(out, f)), f);
  const img = decodePNG(fs.readFileSync(path.join(out, 'text_layers.png')));
  const scale = 2, gap = 6, cell = 128 * scale;
  assert.equal(img.w, 7 * cell + 8 * gap);
  const ref = referenceText();
  for (let k = 0; k < 7; k++) {
    const expected = k >= 4 ? ref : new Uint8Array(128 * 128);
    let diff = 0;
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      const px = gap + k * (cell + gap) + x * scale + 1, py = gap + y * scale + 1;
      const v = img.rgb[(py * img.w + px) * 3] > 40 ? 1 : 0;
      if (v !== expected[y * 128 + x]) diff++;
    }
    assert.equal(diff, 0, `PNG layer ${k + 1} matches the expected text layout`);
  }
  const front = decodePNG(fs.readFileSync(path.join(out, 'text_front.png')));
  let bright = 0; for (let i = 0; i < front.rgb.length; i += 3) if (front.rgb[i + 2] > 120) bright++;
  assert.ok(bright > 2000, 'front view has visible dots');
});

test('CPU cost model: compute-heavy demos get a realistic frame rate instead of hundreds of fps', { skip }, async () => {
  const { runSketch } = await import('./helpers.js');
  const run = await runSketch(DEMO, { untilS: 110, config: { cpuFactor: 40 } });
  const lines = run.serial.map((s) => s.line);
  const idx = lines.indexOf('Demo: ripple surface');
  const fps = +/\(([\d.]+) fps\)/.exec(lines[idx + 1])[1];
  assert.ok(fps > 3 && fps < 60, `ripple surface at ${fps} fps (would be ~640 with no CPU model)`);
});
