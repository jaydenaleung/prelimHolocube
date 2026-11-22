// Software renderer used by headless mode: turns panel snapshots into PNGs.
// Same geometry as the browser viewer: x = column, y = up (row 0 on top), z = layer * pitch, origin at the
// centre of display 4, camera for the "front" view sits on the display-7 side looking toward display 1.
import zlib from 'node:zlib';
import { intensityFromState, INTENSITY_MAX, WIDTH, HEIGHT } from '../emulator/sh1107.js';

export const PX_PITCH_MM = 20.14 / 128;     // 0.1573 mm
export const GEOMETRY = { pxPitch: PX_PITCH_MM, layerPitch: 2.5, midLayer: 3 };

// ---------------------------------------------------------------- PNG
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** rgb: Uint8Array w*h*3 */
export function encodePNG(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- helpers
/** Per-layer intensity buffers (Uint8Array 128*128 each) from a bus snapshot. */
export function layerIntensities(snap) {
  return snap.panels.map((p) => intensityFromState(p.ram, p.state, new Uint8Array(WIDTH * HEIGHT)));
}

const COLOR = [0.78, 0.92, 1.0];

class Canvas {
  constructor(w, h) { this.w = w; this.h = h; this.buf = new Float32Array(w * h * 3); }
  splat(cx, cy, amp, sigma) {
    const r = Math.ceil(sigma * 2.6);
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(this.w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    const inv = 1 / (2 * sigma * sigma);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const g = amp * Math.exp(-(dx * dx + dy * dy) * inv);
        const i = (y * this.w + x) * 3;
        this.buf[i] += g * COLOR[0]; this.buf[i + 1] += g * COLOR[1]; this.buf[i + 2] += g * COLOR[2];
      }
    }
  }
  toRGB(bg = [6, 8, 14], exposure = 1.0) {
    const out = new Uint8Array(this.w * this.h * 3);
    for (let i = 0; i < out.length; i++) {
      const v = 1 - Math.exp(-this.buf[i] * exposure);
      out[i] = Math.min(255, Math.round(bg[i % 3] + (255 - bg[i % 3]) * v));
    }
    return out;
  }
}

function forEachDot(snap, fn) {
  const layers = layerIntensities(snap);
  layers.forEach((inten, k) => {
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const v = inten[y * WIDTH + x];
      if (v) fn(k, x, y, (v / 255) * INTENSITY_MAX);
    }
  });
}

const worldOf = (k, x, y, G) => [(x - 63.5) * G.pxPitch, (63.5 - y) * G.pxPitch, (k - G.midLayer) * G.layerPitch];

// ---------------------------------------------------------------- views
/** Looking straight along -z from the display-7 side, perspective, like a person looking at the stack. */
export function renderFront(snap, { size = 640, G = GEOMETRY, camDist = 90 } = {}) {
  const c = new Canvas(size, size);
  const scale = (size * 0.86) / 20.14;          // px per mm on the z=0 plane
  const f = camDist * scale;                     // focal length in px
  forEachDot(snap, (k, x, y, a) => {
    const [wx, wy, wz] = worldOf(k, x, y, G);
    const d = camDist - wz;
    const sx = size / 2 + (wx * f) / d, sy = size / 2 - (wy * f) / d;
    const pxs = (G.pxPitch * f) / d;             // on-screen size of one OLED pixel
    c.splat(sx, sy, 1.1 * a * (pxs >= 2.5 ? 1 : (pxs / 2.5) ** 2), Math.max(0.6, pxs * 0.30));
  });
  return { w: size, h: size, rgb: c.toRGB() };
}

/** Orbit-style oblique view (orthographic) to see the depth stack. */
export function renderOblique(snap, { size = 640, yaw = 38, pitch = 22, G = GEOMETRY } = {}) {
  const c = new Canvas(size, size);
  const cy = Math.cos((yaw * Math.PI) / 180), sy_ = Math.sin((yaw * Math.PI) / 180);
  const cp = Math.cos((pitch * Math.PI) / 180), sp = Math.sin((pitch * Math.PI) / 180);
  const scale = (size * 0.62) / 20.14;
  const sigma = Math.max(0.6, G.pxPitch * scale * 0.4);
  forEachDot(snap, (k, x, y, a) => {
    const [wx, wy, wz] = worldOf(k, x, y, G);
    const x1 = wx * cy - wz * sy_, z1 = wx * sy_ + wz * cy;
    const y2 = wy * cp - z1 * sp;
    c.splat(size / 2 + x1 * scale, size / 2 - y2 * scale, 0.9 * a, sigma);
  });
  return { w: size, h: size, rgb: c.toRGB() };
}

/** Contact sheet: all layers side by side at integer scale, with a faint pixel grid. Exact for inspection. */
export function renderLayers(snap, { scale = 2, gap = 6 } = {}) {
  const n = snap.panels.length;
  const cell = WIDTH * scale;
  const w = n * cell + (n + 1) * gap, h = cell + 2 * gap;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = 20; rgb[i * 3 + 1] = 22; rgb[i * 3 + 2] = 30; }
  const layers = layerIntensities(snap);
  layers.forEach((inten, k) => {
    const ox = gap + k * (cell + gap), oy = gap;
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
      const v = inten[((y / scale) | 0) * WIDTH + ((x / scale) | 0)];
      const i = ((oy + y) * w + ox + x) * 3;
      rgb[i] = 0; rgb[i + 1] = 0; rgb[i + 2] = 0;
      if (v) { const f = Math.min(1, (v / 255) * INTENSITY_MAX); rgb[i] = 200 * f + 55 * f; rgb[i + 1] = 235 * f + 20 * f; rgb[i + 2] = 255 * f; }
    }
  });
  return { w, h, rgb };
}

export function savePNG(fs, file, img) { fs.writeFileSync(file, encodePNG(img.w, img.h, img.rgb)); }
