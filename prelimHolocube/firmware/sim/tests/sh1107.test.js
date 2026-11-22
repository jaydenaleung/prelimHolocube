// Unit tests: feed known command/data streams to the SH1107 emulator and check the resulting GDDRAM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SH1107, WIDTH, HEIGHT, RAM_SIZE, INTENSITY_MAX } from '../emulator/sh1107.js';

const cmds = (p, ...bytes) => bytes.forEach((b) => p.command(b));
const data = (p, ...bytes) => bytes.forEach((b) => p.data(b));
const fresh = () => { const p = new SH1107({ seed: 42 }); p.ram.fill(0); return p; };
const frame = (p) => p.renderIntensity(new Uint8Array(WIDTH * HEIGHT));
const px = (f, x, y) => f[y * WIDTH + x];

test('page + column addressing writes the right GDDRAM bytes', () => {
  const p = fresh();
  cmds(p, 0xB3, 0x05, 0x12);            // page 3, column = (2<<4)|5 = 37
  data(p, 0xAA, 0x55, 0xFF);
  assert.equal(p.ram[3 * 128 + 37], 0xAA);
  assert.equal(p.ram[3 * 128 + 38], 0x55);
  assert.equal(p.ram[3 * 128 + 39], 0xFF);
  assert.equal(p.ram[3 * 128 + 40], 0x00);
  assert.equal(p.ramWritten, true);
});

test('column auto-increments in page mode and does not leak into the next page', () => {
  const p = fresh();
  cmds(p, 0xB0, 0x00, 0x10);
  for (let i = 0; i < 128; i++) data(p, 1);
  for (let c = 0; c < 128; c++) assert.equal(p.ram[c], 1);
  assert.equal(p.ram[128], 0, 'page 1 untouched');
});

test('bit0 is the top pixel of each page byte', () => {
  const p = fresh();
  cmds(p, 0xB0, 0x00, 0x10);
  data(p, 0x01, 0x80);
  cmds(p, 0xAF);
  const f = frame(p);
  assert.ok(px(f, 0, 0) > 0, 'bit0 -> y=0');
  assert.equal(px(f, 0, 7), 0);
  assert.ok(px(f, 1, 7) > 0, 'bit7 -> y=7');
  assert.equal(px(f, 1, 0), 0);
});

test('two-byte commands consume their argument (argument is NOT executed as a command)', () => {
  const p = fresh();
  const unknown = [];
  p.onUnknown = (m) => unknown.push(m);
  cmds(p, 0xAF);
  cmds(p, 0x81, 0xA5);                  // contrast = 0xA5, must not enable "entire display on"
  assert.equal(p.contrast, 0xA5);
  assert.equal(p.allOn, false);
  cmds(p, 0xAD, 0x8A);                  // DC-DC off = external VPP; 0x8A is not a standalone command
  assert.equal(p.dcdc, 0x8A);
  cmds(p, 0xA8, 0x7F, 0xD3, 0x00, 0xD5, 0x51, 0xD9, 0x22, 0xDB, 0x35, 0xDC, 0x00);
  assert.equal(p.mux, 127);
  assert.deepEqual(unknown, []);
  assert.equal(p.pending, null);
});

test('start line: 0xDC + byte and the single-byte 0x40..0x7F form', () => {
  const p = fresh();
  cmds(p, 0xDC, 0x10); assert.equal(p.startLine, 0x10);
  cmds(p, 0x45); assert.equal(p.startLine, 5);
});

test('unknown commands are reported, not silently ignored', () => {
  const p = fresh();
  const seen = [];
  p.onUnknown = (m, b) => seen.push(b);
  cmds(p, 0x9A, 0xE1);
  assert.deepEqual(seen, [0x9A, 0xE1]);
});

test('vertical addressing mode walks pages then columns', () => {
  const p = fresh();
  cmds(p, 0x21, 0xB0, 0x00, 0x10);
  for (let i = 0; i < 17; i++) data(p, i + 1);
  assert.equal(p.ram[0 * 128 + 0], 1);
  assert.equal(p.ram[15 * 128 + 0], 16);
  assert.equal(p.ram[0 * 128 + 1], 17, 'wrapped to column 1, page 0');
});

test('RES resets registers but NOT the GDDRAM', () => {
  const p = fresh();
  cmds(p, 0xAF, 0xAD, 0x8A, 0x81, 0x10, 0xA1, 0xC8, 0xA7);
  cmds(p, 0xB2, 0x00, 0x10); data(p, 0xDE, 0xAD);
  p.reset();
  assert.equal(p.displayOn, false);
  assert.equal(p.contrast, 0x80);
  assert.equal(p.segRemap, false);
  assert.equal(p.comReverse, false);
  assert.equal(p.inverse, false);
  assert.equal(p.dcdc, 0x8B);
  assert.equal(p.ram[2 * 128], 0xDE, 'RAM survives reset');
  assert.equal(p.ram[2 * 128 + 1], 0xAD);
});

test('power-up RAM is random garbage (speckle), deterministic per seed', () => {
  const a = new SH1107({ seed: 7 }), b = new SH1107({ seed: 7 }), c = new SH1107({ seed: 8 });
  assert.deepEqual(a.ram, b.ram);
  assert.notDeepEqual(a.ram, c.ram);
  let ones = 0;
  for (const v of a.ram) for (let i = 0; i < 8; i++) ones += (v >> i) & 1;
  const frac = ones / (RAM_SIZE * 8);
  assert.ok(frac > 0.45 && frac < 0.55, `about half the bits set, got ${frac}`);
  a.command(0xAF);
  const f = frame(a);
  const lit = f.filter((v) => v > 0).length;
  assert.ok(lit > 7000 && lit < 9500, `speckle visible when switched on before RAM is written (${lit} px)`);
  assert.equal(a.ramWritten, false);
});

test('segment remap (0xA1) flips x, COM scan (0xC8) flips y', () => {
  const p = fresh();
  cmds(p, 0xB0, 0x00, 0x10); data(p, 0x01);        // pixel (0,0)
  cmds(p, 0xAF);
  assert.ok(px(frame(p), 0, 0) > 0);
  cmds(p, 0xA1);
  let f = frame(p);
  assert.ok(px(f, 127, 0) > 0 && px(f, 0, 0) === 0, 'x flipped');
  cmds(p, 0xC8);
  f = frame(p);
  assert.ok(px(f, 127, 127) > 0 && px(f, 127, 0) === 0, 'x and y flipped');
  cmds(p, 0xA0, 0xC0);
  assert.ok(px(frame(p), 0, 0) > 0, 'back to normal');
});

test('inverse, entire-display-on and display-off', () => {
  const p = fresh();
  cmds(p, 0xB0, 0x00, 0x10); data(p, 0x01);
  assert.equal(frame(p).filter(Boolean).length, 0, 'display off shows nothing');
  cmds(p, 0xAF, 0xA7);
  assert.equal(frame(p).filter(Boolean).length, WIDTH * HEIGHT - 1, 'inverse');
  cmds(p, 0xA6, 0xA5);
  assert.equal(frame(p).filter(Boolean).length, WIDTH * HEIGHT, 'all on ignores RAM');
  cmds(p, 0xA4, 0xAE);
  assert.equal(frame(p).filter(Boolean).length, 0);
});

test('brightness follows contrast and the IREF resistor', () => {
  const lo = new SH1107({ seed: 1 }), hi = new SH1107({ seed: 1 }), boost = new SH1107({ seed: 1, irefKOhm: 750 });
  for (const p of [lo, hi, boost]) { p.ram.fill(0xFF); p.command(0xAF); }
  lo.command(0x81); lo.command(0x20);
  hi.command(0x81); hi.command(0xFF);
  boost.command(0x81); boost.command(0xFF);
  const v = (p) => px(frame(p), 3, 3);
  assert.ok(v(lo) < v(hi));
  assert.ok(v(boost) > v(hi));
  assert.ok(Math.abs(boost.brightness() / hi.brightness() - 1000 / 750) < 1e-9);
  assert.ok(boost.brightness() <= INTENSITY_MAX);
});
