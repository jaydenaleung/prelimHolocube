// npm run sim -- path/to/sketch.ino [--pins pins.json|auto] [--layer-pitch 2.5] [--port 5173] [--open]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { compileSketch, findZig, INSTALL_HELP } from './compiler.js';
import { loadPins } from './pins.js';
import { startServer } from './server.js';

const args = process.argv.slice(2);
const o = { sketch: null, pins: null, pitch: 2.5, port: 5173, open: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--pins') o.pins = args[++i];
  else if (a === '--layer-pitch') o.pitch = +args[++i];
  else if (a === '--port') o.port = +args[++i];
  else if (a === '--open') o.open = true;
  else if (!a.startsWith('--') && !o.sketch) o.sketch = a;
  else { console.error(`unknown argument ${a}`); process.exit(2); }
}
if (!o.sketch) {
  console.error('usage: npm run sim -- path/to/sketch.ino [--pins pins.json|auto] [--layer-pitch 2.5] [--port 5173] [--open]');
  process.exit(2);
}
if (!fs.existsSync(o.sketch)) { console.error(`sketch not found: ${o.sketch}`); process.exit(2); }
if (!(o.pitch > 0)) { console.error('--layer-pitch must be a positive number of millimetres'); process.exit(2); }

const { pins, source } = loadPins(o.sketch, o.pins);
let pinsFile = null;
if (source && !source.startsWith('auto') && fs.existsSync(source)) pinsFile = source;

if (!findZig()) console.warn(`\n${INSTALL_HELP}\n(The viewer will still start, but it cannot compile firmware until a compiler is installed.)\n`);
else {
  // warm the build cache so the page comes up running
  process.stdout.write('compiling sketch ... ');
  try {
    const r = await compileSketch(fs.readFileSync(o.sketch, 'utf8'), { name: path.basename(o.sketch), sketchDir: path.dirname(path.resolve(o.sketch)), onProgress: (m) => process.stdout.write('\n  ' + m) });
    console.log(r.ok ? `ok (${r.cached ? 'cached' : r.ms + ' ms'})` : `FAILED (${r.errors.length} error${r.errors.length === 1 ? '' : 's'}; see the viewer)`);
  } catch (e) { console.log('error: ' + e.message); }
}

const { url } = await startServer({ sketchPath: path.resolve(o.sketch), pins, pinsSource: source, pinsFile, layerPitch: o.pitch, port: o.port });
console.log(`Holocube simulator: ${url}\n  sketch: ${path.resolve(o.sketch)}\n  pins:   ${source}\n  layer pitch: ${o.pitch} mm`);
if (o.open) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
}
