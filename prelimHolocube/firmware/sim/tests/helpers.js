import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compileSketch, findZig } from '../tools/compiler.js';
import { runHeadless } from '../tools/headless-core.js';
import { intensityFromState, WIDTH, HEIGHT } from '../emulator/sh1107.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO = path.join(ROOT, 'examples', 'seven_panel_volume_demo.ino');
export const FIX = (n) => path.join(ROOT, 'tests', 'fixtures', n);
export const HAVE_ZIG = !!findZig();
export const PINS = { cs: [13, 27, 26, 25, 33, 32, 16], dc: 21, rst: 19, sck: 18, mosi: 23 };

export async function build(file) {
  const r = await compileSketch(fs.readFileSync(file, 'utf8'), { name: path.basename(file), sketchDir: path.dirname(path.resolve(file)) });
  return r;
}

/** Compile + run a sketch headless (deterministic: CPU cost model off). */
export async function runSketch(file, opts = {}) {
  const b = await build(file);
  if (!b.ok) throw new Error('build failed: ' + JSON.stringify(b.errors));
  return runHeadless({ wasm: fs.readFileSync(b.wasmPath), pins: PINS, config: { cpuFactor: 0, ...(opts.config || {}) }, ...opts });
}

export const layerBitmaps = (snap) => snap.panels.map((p) => intensityFromState(p.ram, p.state, new Uint8Array(WIDTH * HEIGHT)));
export const lit = (bm, x, y) => bm[y * WIDTH + x] > 0;
export const countLit = (bm) => bm.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
export function bbox(bm) {
  let x0 = 999, y0 = 999, x1 = -1, y1 = -1;
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) if (bm[y * WIDTH + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** sha256 over everything that defines what the stack shows: per-layer intensity + display registers. */
export function frameHash(snap) {
  const h = crypto.createHash('sha256');
  snap.panels.forEach((p) => {
    h.update(intensityFromState(p.ram, p.state, new Uint8Array(WIDTH * HEIGHT)));
    const s = p.state;
    h.update(JSON.stringify([s.on, s.contrast, s.dcdc, s.allOn, s.inverse, s.segRemap, s.comReverse, s.startLine, s.offset]));
  });
  return h.digest('hex');
}

let demoRunPromise = null;
/** The whole slideshow, run once and shared between tests. */
export function demoRun() {
  if (!demoRunPromise) {
    demoRunPromise = runSketch(DEMO, {
      untilS: 165,
      shots: [{ name: 'text', atS: 9 }, { name: 'axes', atS: 19 }, { name: 'sphere', atS: 29 }],
      serialShots: [{ re: /^Demo:/, offsetMs: 4000 }],
    });
  }
  return demoRunPromise;
}

// ---- tiny PNG decoder (8-bit RGB, our own encoder's output) ----
export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w * 3 + 1)] !== 0) throw new Error('unexpected PNG filter');
    raw.copy(rgb, y * w * 3, y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1));
  }
  return { w, h, rgb };
}
