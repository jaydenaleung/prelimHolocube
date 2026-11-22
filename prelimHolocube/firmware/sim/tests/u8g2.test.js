// u8g2 support: the real library (installed Arduino copy) compiled against the shim. Every test compares what the
// emulated SH1107 displays with u8g2's OWN framebuffer, printed by the sketch, bit for bit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HAVE_ZIG, FIX, ROOT, PINS, build, layerBitmaps, countLit } from './helpers.js';
import { compileSketch } from '../tools/compiler.js';
import { findU8g2 } from '../tools/libraries.js';
import { runHeadless } from '../tools/headless-core.js';

const LIB = findU8g2();
const skip = !HAVE_ZIG ? 'zig not installed' : !LIB ? 'U8g2 library not installed' : false;
const U = (n) => FIX(path.join('u8g2', n));
const SHOWCASE = path.join(ROOT, 'examples', 'u8g2_showcase', 'u8g2_showcase.ino');
// I2C fixtures put SDA on GPIO21, so D/C moves to GPIO4 for them
const PINS_I2C = { cs: [13, 27, 26, 25, 33, 32, 16], dc: 4, rst: 19, sck: 18, mosi: 23, sda: 21, scl: 22, i2c: { 0x3C: 0 } };

async function runU8(file, { pins = PINS, untilS = 6, source = null } = {}) {
  const b = source
    ? await compileSketch(source, { name: path.basename(file), sketchDir: path.dirname(file), onProgress: () => {} })
    : await build(file);
  if (!b.ok) throw new Error('build failed:\n' + b.errors.map((e) => `${e.file}:${e.line}: ${e.message}`).join('\n'));
  const run = await runHeadless({ wasm: fs.readFileSync(b.wasmPath), pins, untilS, config: { cpuFactor: 0 },
    serialShots: [{ re: /^BUF /, offsetMs: 0, name: 'buf' }, { re: /^TEXT done|^drawn/, offsetMs: 0, name: 'done' }] });
  const bufs = run.serial.filter((s) => s.line.startsWith('BUF ')).map((s) => {
    const [, tag, hex] = s.line.split(' ');
    return { tag, bytes: Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16))) };
  });
  return { run, bufs, build: b, lines: run.serial.map((s) => s.line) };
}

/** u8g2 full buffer (vertical, top = LSB, 128 px wide) -> 128x128 bitmap */
function bufBitmap(bytes) {
  const bm = new Uint8Array(128 * 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) bm[y * 128 + x] = (bytes[(y >> 3) * 128 + x] >> (y & 7)) & 1;
  return bm;
}
const lit = (bm) => bm.map((v) => (v > 0 ? 1 : 0));
const rot180 = (bm) => { const r = new Uint8Array(bm.length); for (let i = 0; i < bm.length; i++) r[i] = bm[bm.length - 1 - i]; return r; };
function diff(a, b) { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; }

test('the installed U8g2 library is found, built once and cached', { skip }, async () => {
  const a = await build(U('hw_spi_full.ino'));
  assert.equal(a.ok, true, a.errors && a.errors.map((e) => e.message).join('\n'));
  assert.equal(a.libs[0].name, 'U8g2');
  assert.match(a.libs[0].version, /^\d+\.\d+/);
  const b = await build(U('hw_spi_full.ino'));
  assert.equal(b.cached, true);
  const size = fs.statSync(a.wasmPath).size;
  assert.ok(size < 3e6, `unused fonts and drivers are dropped by the linker (${(size / 1e6).toFixed(2)} MB)`);
});

test('HW SPI, full buffer: the panel shows exactly u8g2\'s framebuffer; setFlipMode(0) rotates it 180 deg', { skip }, async () => {
  const { run, bufs } = await runU8(U('hw_spi_full.ino'));
  assert.deepEqual(bufs.map((b) => b.tag), ['full', 'flip1', 'flip0']);
  const shots = run.captures.filter((c) => c.name === 'buf');
  assert.equal(shots.length, 3);
  const ref = bufBitmap(bufs[0].bytes);
  assert.ok(countLit(ref) > 700, `the scene really draws something (${countLit(ref)} px)`);
  assert.equal(diff(lit(layerBitmaps(shots[0].snap)[0]), ref), 0, 'begin() orientation (0xA0/0xC0): display == buffer');
  assert.equal(diff(lit(layerBitmaps(shots[1].snap)[0]), ref), 0, 'flip mode 1 (0xA0/0xC0): display == buffer');
  assert.equal(diff(lit(layerBitmaps(shots[2].snap)[0]), rot180(ref)), 0, 'flip mode 0 (0xA1/0xC8): display == buffer rotated 180');
  const st = shots[2].snap.panels[0].state;
  assert.equal(st.segRemap, true); assert.equal(st.comReverse, true);
  assert.equal(shots[0].snap.panels[0].state.contrast, 0x2F, 'u8g2\'s SH1107 init contrast');
  assert.ok(run.warnings.some((w) => w.code === 'FOREIGN_CMD'), 'the 0xDA from u8g2\'s init is explained, not hidden');
  assert.ok(!run.warnings.some((w) => w.code === 'UNKNOWN_CMD'));
  assert.ok(!run.warnings.some((w) => w.code === 'PIN_CLAIMED'), 'SPI.begin(18,-1,23,-1) first: RST stays a GPIO');
});

test('page-buffer mode (_1_, firstPage/nextPage) builds the same image as the full buffer', { skip }, async () => {
  const { run, bufs, lines } = await runU8(U('page_mode.ino'));
  assert.ok(lines.includes('PAGES 16'), '128 px / 8 px pages');
  const ref = bufBitmap(bufs[0].bytes);
  const snap = run.captures.find((c) => c.name === 'buf').snap;
  const maps = layerBitmaps(snap);
  assert.equal(diff(lit(maps[0]), ref), 0, 'display 1 (page mode) == reference buffer');
  assert.equal(diff(lit(maps[1]), ref), 0, 'display 2 (full buffer) == reference buffer');
});

test('HW I2C (Wire): SH1107 control bytes are decoded; unmapped addresses NACK', { skip }, async () => {
  const { run, bufs, lines } = await runU8(U('hw_i2c.ino'), { pins: PINS_I2C });
  const snap = run.captures.find((c) => c.name === 'buf').snap;
  assert.equal(diff(lit(layerBitmaps(snap)[0]), bufBitmap(bufs[0].bytes)), 0, 'display 1 (I2C 0x3C) == buffer');
  assert.ok(lines.includes('ACK 0'), 'Wire.endTransmission() to a mapped panel returns 0');
  assert.ok(lines.includes('NACK 2'), 'unmapped address returns 2 (address NACK), like the real Wire');
  assert.ok(run.warnings.some((w) => w.code === 'I2C_NACK' && /0x50/.test(w.message)));
});

test('software SPI (bit-banged clock/data) is decoded from the pin edges', { skip }, async () => {
  const { run, bufs } = await runU8(U('sw_spi.ino'), { untilS: 15 });
  const snap = run.captures.find((c) => c.name === 'buf').snap;
  assert.equal(diff(lit(layerBitmaps(snap)[0]), bufBitmap(bufs[0].bytes)), 0);
  assert.ok(run.warnings.some((w) => w.code === 'SW_SPI'));
});

test('software I2C (bit-banged SDA/SCL) is decoded: START, 9-clock bytes, STOP', { skip }, async () => {
  const { run, bufs } = await runU8(U('sw_i2c.ino'), { pins: PINS_I2C, untilS: 30 });
  const snap = run.captures.find((c) => c.name === 'buf').snap;
  assert.equal(diff(lit(layerBitmaps(snap)[0]), bufBitmap(bufs[0].bytes)), 0);
  assert.ok(run.warnings.some((w) => w.code === 'SW_I2C'));
});

test('U8x8 tile text: normal, inverse and 2x2 strings land in the right tiles', { skip }, async () => {
  const { run } = await runU8(U('u8x8_text.ino'));
  const bm = lit(layerBitmaps(run.captures.find((c) => c.name === 'done').snap)[0]);
  const tileLit = (tx, ty, tw = 1, th = 1) => {
    let n = 0; for (let y = ty * 8; y < (ty + th) * 8; y++) for (let x = tx * 8; x < (tx + tw) * 8; x++) n += bm[y * 128 + x];
    return n / (tw * th * 64);
  };
  for (let i = 0; i < 5; i++) assert.ok(tileLit(i, 0) > 0.1 && tileLit(i, 0) < 0.7, `"HELLO" char ${i}`);
  for (let i = 0; i < 3; i++) assert.ok(tileLit(i, 2) > 0.5, `inverse char ${i} is mostly lit`);
  assert.ok(tileLit(0, 5, 4, 2) > 0.1, '2x2 string');
  assert.equal(tileLit(6, 0, 10, 2), 0, 'nothing right of "HELLO"');
  assert.equal(tileLit(0, 9, 16, 7), 0, 'nothing below');
});

test('the RST-on-GPIO19 trap: u8g2.begin() without SPI.begin(pins) claims MISO=19, reset never pulses', { skip }, async () => {
  const { run } = await runU8(U('misordered_spi.ino'));
  const codes = run.warnings.map((w) => w.code);
  const claim = run.warnings.find((w) => w.code === 'PIN_CLAIMED');
  assert.ok(claim && claim.level === 'error' && /GPIO19/.test(claim.message) && /RST/.test(claim.message));
  assert.ok(codes.includes('WRITE_IGNORED'));
  assert.ok(codes.includes('NO_RESET'), 'the panel was initialised without ever seeing RES');
  assert.ok(run.snapshot.panels[0].state.resets <= 1, 'no reset pulse reached the panel after power-up');
  assert.ok(countLit(layerBitmaps(run.captures.find((c) => c.name === 'done').snap)[0]) > 100, 'it still draws (the init commands get through)');
});

test('showcase: every drawing page on all 7 displays matches u8g2\'s framebuffers, lint clean', { skip }, async () => {
  const src = fs.readFileSync(SHOWCASE, 'utf8').replace('#define DUMP_BUFFERS 0', '#define DUMP_BUFFERS 1');
  const { run, bufs, lines } = await runU8(SHOWCASE, { source: src, untilS: 8 });
  assert.ok(lines.includes('u8g2 showcase: 7 panels ready'));
  assert.equal(bufs.length, 7);
  const shots = run.captures.filter((c) => c.name === 'buf');
  const last = shots[shots.length - 1].snap;        // after all 7 pages have been sent
  const maps = layerBitmaps(last);
  bufs.forEach((b, i) => {
    assert.equal(b.tag, String(i + 1));
    const ref = bufBitmap(b.bytes);
    assert.ok(countLit(ref) > 400, `page ${i + 1} draws`);
    assert.equal(diff(lit(maps[i]), ref), 0, `display ${i + 1} == its u8g2 framebuffer`);
  });
  const bad = run.warnings.filter((w) => w.level !== 'info');
  assert.deepEqual(bad.map((w) => `${w.code}: ${w.message}`), [], 'the showcase power-up order is clean on the hardware lint');
  for (const p of last.panels) { assert.equal(p.state.on, true); assert.equal(p.state.dcdc, 0x8A); assert.equal(p.state.contrast, 0xFF); }
});

test('showcase with no pins.json: roles are worked out from the u8g2 traffic and every page still matches', { skip }, async () => {
  const src = fs.readFileSync(SHOWCASE, 'utf8').replace('#define DUMP_BUFFERS 0', '#define DUMP_BUFFERS 1');
  const { run, bufs } = await runU8(SHOWCASE, { source: src, untilS: 8, pins: { auto: true } });
  const shots = run.captures.filter((c) => c.name === 'buf');
  const last = shots[shots.length - 1].snap;
  assert.deepEqual(last.pins.cs, [13, 27, 26, 25, 33, 32, 16]);
  assert.equal(last.pins.dc, 21);
  assert.equal(last.pins.rst, 19);
  const maps = layerBitmaps(last);
  bufs.forEach((b, i) => assert.equal(diff(lit(maps[i]), bufBitmap(b.bytes)), 0, `display ${i + 1}`));
});
