// Resolve the pin map: --pins <file|auto>, else pins.json next to the sketch, else the repo default.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './compiler.js';

export function loadPins(sketchPath, pinsArg) {
  if (pinsArg === 'auto') return { pins: { auto: true }, source: 'auto (guessed from firmware behaviour)' };
  const candidates = [];
  if (pinsArg) candidates.push(path.resolve(pinsArg));
  else {
    if (sketchPath) candidates.push(path.join(path.dirname(path.resolve(sketchPath)), 'pins.json'));
    candidates.push(path.join(ROOT, 'pins.json'));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return { pins: parsePins(fs.readFileSync(c, 'utf8'), c), source: c };
  }
  if (pinsArg) throw new Error(`pins file not found: ${pinsArg}`);
  return { pins: { auto: true }, source: 'auto (no pins.json found)' };
}

export function parsePins(text, where = 'pins.json') {
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`${where}: invalid JSON (${e.message})`); }
  if (j.auto === true) return { auto: true };
  if (!Array.isArray(j.cs) || j.cs.some((n) => !Number.isInteger(n))) throw new Error(`${where}: "cs" must be an array of GPIO numbers`);
  for (const k of ['dc', 'rst']) if (!Number.isInteger(j[k])) throw new Error(`${where}: "${k}" must be a GPIO number`);
  const out = { cs: j.cs, dc: j.dc, rst: j.rst, sck: Number.isInteger(j.sck) ? j.sck : null, mosi: Number.isInteger(j.mosi) ? j.mosi : null };
  if (Number.isInteger(j.sda)) out.sda = j.sda;
  if (Number.isInteger(j.scl)) out.scl = j.scl;
  if (j.i2c !== undefined) {      // {"0x3C": 1} -> 7-bit address : display number (1-based)
    if (typeof j.i2c !== 'object' || j.i2c === null) throw new Error(`${where}: "i2c" must map addresses to display numbers, e.g. {"0x3C": 1}`);
    out.i2c = {};
    for (const [k, v] of Object.entries(j.i2c)) {
      const addr = Number(k);
      if (!Number.isInteger(addr) || addr < 0 || addr > 0x7F) throw new Error(`${where}: I2C address ${k} is not a 7-bit address`);
      if (!Number.isInteger(v) || v < 1) throw new Error(`${where}: I2C address ${k} must map to a display number (1, 2, ...)`);
      out.i2c[addr] = v - 1;   // panel index
    }
  }
  return out;
}
