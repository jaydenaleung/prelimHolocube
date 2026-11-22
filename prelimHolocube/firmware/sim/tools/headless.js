// Headless runner: compile (or reuse the cache), run for N virtual seconds, dump PNGs + log.
//   node tools/headless.js sketch.ino --until 120 --out out/ --on-serial "^(Scene|Demo):=3000"
//   options: --pins file|auto   --shots name=sec,name=sec   --views layers,front,oblique
//            --input "press:0@1.5+0.2!bounce" | "level:4=1@2" | "analog:34=1650@0.5" | "serial:42\n@1" (repeatable)
//            --cpu-factor <n> (0 = deterministic)   --on-serial "<regex>=<offset ms>" (repeatable)   --wall-timeout <sec>   --layer-pitch <mm>
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { compileSketch } from './compiler.js';
import { loadPins } from './pins.js';
import { parseInputSpec } from '../emulator/inputs.js';
import { GEOMETRY, renderFront, renderLayers, renderOblique, savePNG } from './render.js';
import { INTENSITY_MAX } from '../emulator/sh1107.js';

function parseArgs(argv) {
  const o = { sketch: null, pins: null, until: 60, out: 'out', shots: [], serial: [], inputs: [], views: ['layers', 'front', 'oblique'],
    wall: 180, pitch: 2.5, quiet: false, cpu: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--pins') o.pins = next();
    else if (a === '--until') o.until = +next();
    else if (a === '--out') o.out = next();
    else if (a === '--shots') o.shots.push(...next().split(',').map((s) => { const [name, at] = s.split('='); return { name, atS: +at }; }));
    else if (a === '--on-serial') { const v = next(); const k = v.lastIndexOf('='); o.serial.push({ re: v.slice(0, k), offsetMs: +v.slice(k + 1) || 0 }); }
    else if (a === '--views') o.views = next().split(',');
    else if (a === '--wall-timeout') o.wall = +next();
    else if (a === '--layer-pitch') o.pitch = +next();
    else if (a === '--cpu-factor') o.cpu = +next();
    else if (a === '--input') o.inputs.push(parseInputSpec(next()));
    else if (a === '--quiet') o.quiet = true;
    else if (!a.startsWith('--') && !o.sketch) o.sketch = a;
    else { console.error(`unknown argument ${a}`); process.exit(2); }
  }
  return o;
}

export async function main(argv) {
  const o = parseArgs(argv);
  if (!o.sketch) { console.error('usage: node tools/headless.js sketch.ino [options]'); return 2; }
  const src = fs.readFileSync(o.sketch, 'utf8');
  const b = await compileSketch(src, { name: path.basename(o.sketch), sketchDir: path.dirname(path.resolve(o.sketch)), onProgress: (m) => { if (!o.quiet) console.log(m); } });
  for (const w of b.warnings) console.log(`${w.file}:${w.line}:${w.col}: warning: ${w.message}`);
  if (!b.ok) { for (const e of b.errors) console.error(`${e.file}:${e.line}:${e.col}: error: ${e.message}`); return 1; }
  const { pins, source } = loadPins(o.sketch, o.pins);
  if (!o.quiet) console.log(`build ${b.cached ? 'cached' : `${b.ms} ms`}, pins: ${source}`);
  const wasm = fs.readFileSync(b.wasmPath);
  if (!o.shots.length && !o.serial.length) o.shots.push({ name: 'end', atS: o.until - 0.001 });

  const res = await new Promise((resolve) => {
    const w = new Worker(fileURLToPath(new URL('./headless-worker.js', import.meta.url)), {
      workerData: { wasm, pins, inputs: o.inputs, untilS: o.until, shots: o.shots, serialShots: o.serial, stopAfterShots: false,
        config: o.cpu === undefined ? {} : { cpuFactor: o.cpu } },
    });
    const timer = setTimeout(() => { w.terminate(); resolve({ result: { reason: 'hang', message: `Firmware did not return control to the simulator for ${o.wall} s of wall-clock time (tight loop with no delay(), SPI or time call?).` }, serial: [], warnings: [], captures: [], vt: 0 }); }, o.wall * 1000);
    w.on('message', (m) => { clearTimeout(timer); resolve(m); });
    w.on('error', (e) => { clearTimeout(timer); resolve({ result: { reason: 'crash', message: String(e.stack || e) }, serial: [], warnings: [], captures: [], vt: 0 }); });
  });

  fs.mkdirSync(o.out, { recursive: true });
  const G = { ...GEOMETRY, layerPitch: o.pitch };
  for (const c of res.captures) {
    const base = path.join(o.out, c.name);
    for (const v of o.views) {
      if (v === 'layers') savePNG(fs, `${base}_layers.png`, renderLayers(c.snap));
      if (v === 'front') savePNG(fs, `${base}_front.png`, renderFront(c.snap, { G }));
      if (v === 'oblique') savePNG(fs, `${base}_oblique.png`, renderOblique(c.snap, { G }));
    }
    if (!o.quiet) console.log(`captured ${c.name} @ ${(c.targetVt / 1e6).toFixed(2)} s virtual`);
  }
  if (!o.quiet) {
    console.log('--- serial ---');
    for (const s of res.serial) console.log(`[${(s.t / 1e6).toFixed(3)}] ${s.line}`);
    console.log('--- lint warnings ---');
    for (const w of res.warnings) console.log(`[${(w.t / 1e6).toFixed(3)}] ${w.level.toUpperCase()} ${w.code}: ${w.message}`);
    console.log(`--- ended: ${res.result.reason}${res.result.message ? ' - ' + res.result.message : ''} at ${(res.vt / 1e6).toFixed(2)} s virtual`);
  }
  fs.writeFileSync(path.join(o.out, 'run.json'), JSON.stringify({ result: res.result, serial: res.serial, warnings: res.warnings, vt: res.vt,
    captures: res.captures.map((c) => ({ name: c.name, targetVt: c.targetVt, vt: c.vt })) }, null, 1));
  void INTENSITY_MAX;
  return ['crash', 'hang', 'watchdog'].includes(res.result.reason) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
