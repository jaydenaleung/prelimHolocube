// node tools/compile-cli.js path/to/sketch.ino  -> compiles to build/cache/<hash>/sketch.wasm
import fs from 'node:fs';
import path from 'node:path';
import { compileSketch } from './compiler.js';

const file = process.argv[2];
if (!file) { console.error('usage: node tools/compile-cli.js sketch.ino'); process.exit(2); }
try {
  const r = await compileSketch(fs.readFileSync(file, 'utf8'), { name: path.basename(file), sketchDir: path.dirname(path.resolve(file)) });
  for (const w of r.warnings) console.log(`${w.file}:${w.line}:${w.col}: warning: ${w.message}`);
  for (const e of r.errors) console.error(`${e.file}:${e.line}:${e.col}: error: ${e.message}`);
  if (!r.ok) console.error(r.log);
console.log(r.ok ? `OK ${r.cached ? '(cached) ' : ''}${r.ms} ms -> ${r.wasmPath}` : 'BUILD FAILED');
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  console.error(e.message);
  process.exit(e.code === 'NO_COMPILER' ? 3 : 1);
}
