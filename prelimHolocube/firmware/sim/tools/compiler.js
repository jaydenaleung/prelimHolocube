// Sketch -> WASM build driver (ino2cpp + zig cc), with a source-hash build cache and parsed diagnostics.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ino2cpp } from './ino2cpp.js';
import { usesU8g2, buildU8g2, U8G2_INSTALL_HELP } from './libraries.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUILD_DIR = process.env.HOLO_BUILD_DIR ? path.resolve(process.env.HOLO_BUILD_DIR) : path.join(ROOT, 'build');   // override: e.g. a cold-cache test run
const SHIM_DIR = path.join(ROOT, 'shim');

export const INSTALL_HELP =
  'No C++ -> WebAssembly compiler found. Install Zig (single ~75 MB download, no admin rights needed):\n' +
  '  1. Download https://ziglang.org/download/ (zig-windows-x86_64-0.13.0.zip, or the build for your OS)\n' +
  '  2. Unzip it anywhere, e.g. C:\\Users\\<you>\\zig\n' +
  '  3. Either add that folder to PATH, or set the ZIG environment variable to the zig executable.\n' +
  'Then run the command again. (Node.js >= 20 is also required; you are running it, so that part is fine.)';

/** Locate the zig executable. */
export function findZig() {
  const exe = process.platform === 'win32' ? 'zig.exe' : 'zig';
  const candidates = [];
  if (process.env.ZIG) candidates.push(process.env.ZIG);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, exe));
  const home = os.homedir();
  for (const base of [path.join(home, 'zig'), path.join(home, 'tools', 'zig'), 'C:\\zig', '/opt/zig', '/usr/local/zig']) {
    candidates.push(path.join(base, exe));
    try {
      for (const d of fs.readdirSync(base)) if (/^zig-/.test(d)) candidates.push(path.join(base, d, exe));
    } catch { /* not there */ }
  }
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

const sha = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex');
};

function shimHash() {
  const files = fs.readdirSync(SHIM_DIR).sort();
  return sha(...files.map((f) => fs.readFileSync(path.join(SHIM_DIR, f))));
}

/** Parse clang/wasm-ld output into structured diagnostics. */
export function parseDiagnostics(text, sketchName) {
  const errors = [], warnings = [];
  const re = /^(?<file>(?:[A-Za-z]:)?[^:\n]*?):(?<line>\d+):(?<col>\d+): (?<sev>fatal error|error|warning|note): (?<msg>.*)$/;
  let last = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = re.exec(raw);
    if (m) {
      const g = m.groups;
      const file = g.file.replace(/\\/g, '/');
      const entry = {
        file: path.basename(file) === sketchName ? sketchName : file,
        line: +g.line, col: +g.col, message: g.msg, sev: g.sev === 'fatal error' ? 'error' : g.sev,
        inSketch: path.basename(file) === sketchName, notes: [],
      };
      if (entry.sev === 'note') { if (last) last.notes.push({ file: entry.file, line: entry.line, col: entry.col, message: entry.message }); continue; }
      (entry.sev === 'error' ? errors : warnings).push(entry);
      last = entry;
      continue;
    }
    const ld = /^wasm-ld: (error|warning): (.*)$/.exec(raw);
    if (ld) {
      const entry = { file: '', line: 0, col: 0, message: ld[2], sev: ld[1], inSketch: false, notes: [] };
      (ld[1] === 'error' ? errors : warnings).push(entry);
      last = entry;
    } else if (last && /^\s+(?:in function|>>>)/.test(raw)) last.notes.push({ message: raw.trim() });
  }
  return { errors, warnings };
}

let queue = Promise.resolve();

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({ code: -1, out: out + String(e) }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

// What the Arduino-ESP32 build defines, so sketches and libraries take their ESP32 code paths
export const ARDUINO_DEFINES = ['-DARDUINO=10819', '-DESP32', '-DARDUINO_ARCH_ESP32', '-DESP_PLATFORM', '-DARDUINO_ESP32_DEV',
  '-DARDUINO_BOARD="ESP32_DEV"', '-DF_CPU=240000000L', '-DHOLOCUBE_SIM=1'];
const CXXFLAGS = ['-x', 'c++', '-std=gnu++17', '-target', 'wasm32-wasi', '-O2', '-fno-exceptions', '-fno-rtti',
  '-fno-threadsafe-statics', '-Wall', '-Wno-unused-variable', ...ARDUINO_DEFINES];
// third-party library sources: no warnings (they are not the user's code), one section per symbol so the
// linker drops every font / display driver the sketch does not use
const LIB_CXXFLAGS = [...CXXFLAGS, '-w', '-ffunction-sections', '-fdata-sections'];
const LIB_CFLAGS = ['-x', 'c', '-std=gnu11', '-target', 'wasm32-wasi', '-O2', '-w', '-ffunction-sections', '-fdata-sections', ...ARDUINO_DEFINES];

/**
 * Compile sketch source. Never throws for build failures (returns ok:false with diagnostics); throws
 * only when no compiler is installed (err.code === 'NO_COMPILER').
 */
export function compileSketch(source, { name = 'sketch.ino', sketchDir = null, onProgress = null } = {}) {
  const job = queue.then(() => doCompile(source, name, sketchDir, onProgress || ((m) => console.log(m))));
  queue = job.catch(() => {});
  return job;
}

/** Files next to the sketch that the build can see (#include "x.h", extra .c/.cpp like the Arduino IDE compiles). */
function sketchSiblings(sketchDir, name) {
  if (!sketchDir || !fs.existsSync(sketchDir)) return { headers: [], sources: [] };
  const files = fs.readdirSync(sketchDir).filter((f) => f !== name && fs.statSync(path.join(sketchDir, f)).isFile());
  // Arduino convention: a sketch lives in a folder of the same name, and only then are the other .c/.cpp files in
  // that folder part of the sketch. A loose .ino somewhere else only gets #include access to its neighbours.
  const isSketchFolder = path.basename(sketchDir) === name.replace(/\.ino$/i, '');
  return {
    headers: files.filter((f) => /\.(h|hpp|hh)$/i.test(f)).sort(),
    sources: isSketchFolder ? files.filter((f) => /\.(c|cpp|cc)$/i.test(f)).sort() : [],
  };
}

async function doCompile(source, name, sketchDir, onProgress) {
  const t0 = Date.now();
  const zig = findZig();
  if (!zig) { const e = new Error(INSTALL_HELP); e.code = 'NO_COMPILER'; throw e; }
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const sh = shimHash();
  const sib = sketchSiblings(sketchDir, name);
  const sibContent = [...sib.headers, ...sib.sources].map((f) => f + ':' + sha(fs.readFileSync(path.join(sketchDir, f))));
  const wantsU8g2 = usesU8g2(source);
  const hash = sha(source, name, sh, wantsU8g2 ? 'u8g2' : '', ...sibContent).slice(0, 32);
  const dir = path.join(BUILD_DIR, 'cache', hash);
  const wasm = path.join(dir, 'sketch.wasm');
  const logFile = path.join(dir, 'build.log');
  if (fs.existsSync(wasm)) {
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    let libs = [];
    try { libs = JSON.parse(fs.readFileSync(path.join(dir, 'libs.json'), 'utf8')); } catch { /* none */ }
    return { ok: true, hash, wasmPath: wasm, log, cached: true, ms: Date.now() - t0, libs, ...parseDiagnostics(log, name) };
  }
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, ZIG_LOCAL_CACHE_DIR: path.join(BUILD_DIR, 'zigcache') };

  // 1. shim object (cached by shim content)
  // every .cpp in shim/ (shim.cpp, WString.cpp, ...), one object each, cached by the shim's content hash
  let log = '';
  const shimObjs = [];
  for (const f of fs.readdirSync(SHIM_DIR).filter((x) => x.endsWith('.cpp')).sort()) {
    const obj = path.join(BUILD_DIR, `shim-${sh.slice(0, 16)}-${f.replace(/\.cpp$/, '')}.o`);
    if (!fs.existsSync(obj)) {
      const tmp = `${obj}.${tmpTag()}.tmp`;
      const r = await run(zig, ['cc', ...CXXFLAGS, '-I', SHIM_DIR, '-c', path.join(SHIM_DIR, f), '-o', tmp], { env, cwd: BUILD_DIR });
      log += r.out;
      if (r.code !== 0) { rmQuiet(tmp); return fail(hash, log, name, t0, `shim/${f} failed to build`); }
      publish(tmp, obj);
    }
    shimObjs.push(obj);
  }

  // 2. libraries the sketch includes (built once, cached)
  const includeDirs = [SHIM_DIR];
  const archives = [];
  let libInfo = null;
  if (wantsU8g2) {
    const lib = await buildU8g2({ zig, run, env, buildDir: BUILD_DIR, shimDir: SHIM_DIR, shimHash: sh,
      cFlags: LIB_CFLAGS, cxxFlags: LIB_CXXFLAGS, onProgress });
    if (!lib.ok) { log += lib.log; return fail(hash, log, name, t0, lib.missing ? U8G2_INSTALL_HELP : 'the U8g2 library failed to build (see the raw log)'); }
    includeDirs.push(...lib.includeDirs);
    archives.push(lib.archive);
    libInfo = { name: 'U8g2', version: lib.version, path: lib.path, builtMs: lib.cached ? 0 : lib.ms };
  }
  if (sketchDir) includeDirs.push(sketchDir);
  const incArgs = includeDirs.flatMap((d) => ['-I', d]);

  // 3. sketch (+ any .c/.cpp next to it, like the Arduino IDE)
  // Everything is built in a private work dir and only sketch.wasm is published into the cache entry, atomically, so a
  // second process compiling the same source at the same time (parallel tests, two browser tabs) never sees half a file.
  const work = path.join(dir, `work-${tmpTag()}`);
  fs.mkdirSync(work, { recursive: true });
  const fail2 = (...a) => { rmQuiet(work); return fail(...a); };
  const cppPath = path.join(work, 'sketch.cpp');
  const { cpp } = ino2cpp(source, name);
  fs.writeFileSync(cppPath, cpp);
  const objPath = path.join(work, 'sketch.o');
  const c = await run(zig, ['cc', ...CXXFLAGS, ...incArgs, '-c', 'sketch.cpp', '-o', 'sketch.o'], { env, cwd: work });
  log += c.out;
  if (c.code !== 0) return fail2(hash, log, name, t0);
  const extraObjs = [];
  for (const f of sib.sources) {
    const obj = path.join(work, `sib-${f.replace(/[^\w.-]/g, '_')}.o`);
    const isC = /\.c$/i.test(f);
    const flags = isC ? ['-x', 'c', '-std=gnu11', '-target', 'wasm32-wasi', '-O2', '-Wall', ...ARDUINO_DEFINES] : CXXFLAGS;
    const r = await run(zig, ['cc', ...flags, ...incArgs, '-c', path.join(sketchDir, f), '-o', obj], { env, cwd: work });
    log += r.out;
    if (r.code !== 0) return fail2(hash, log, name, t0);
    extraObjs.push(obj);
  }

  // 4. link (archives last; unused library code and fonts are dropped)
  const l = await run(zig, ['cc', '-target', 'wasm32-wasi', ...shimObjs, objPath, ...extraObjs, ...archives, '-o', 'sketch.wasm',
    '-Wl,-z,stack-size=262144', '-Wl,--gc-sections', '-Wl,--export-table'], { env, cwd: work });   // table: interrupt handlers
  log += l.out;
  if (l.code !== 0) return fail2(hash, log, name, t0);

  fs.writeFileSync(path.join(work, 'build.log'), log);
  publish(path.join(work, 'build.log'), logFile);
  if (libInfo) { fs.writeFileSync(path.join(work, 'libs.json'), JSON.stringify([libInfo])); publish(path.join(work, 'libs.json'), path.join(dir, 'libs.json')); }
  publish(path.join(work, 'sketch.wasm'), wasm);
  rmQuiet(work);
  return { ok: true, hash, wasmPath: wasm, log, cached: false, ms: Date.now() - t0, libs: libInfo ? [libInfo] : [], ...parseDiagnostics(log, name) };
}

// ---- cache files are written under a private name and renamed into place (rename is atomic on one volume)
export function tmpTag() { return `${process.pid}-${Math.random().toString(36).slice(2, 8)}`; }
export function rmQuiet(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
/** Move `tmp` to `dest`. If another process published `dest` first, keep theirs (same inputs, same content). */
export function publish(tmp, dest) {
  try { fs.renameSync(tmp, dest); } catch (e) {
    if (!fs.existsSync(dest)) throw e;
    rmQuiet(tmp);
  }
}

function fail(hash, log, name, t0, headline) {
  const dir = path.join(BUILD_DIR, 'cache', hash);
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'build.log'), log); } catch { /* ignore */ }
  const d = parseDiagnostics(log, name);
  if (!d.errors.length) d.errors.push({ file: '', line: 0, col: 0, message: headline || 'build failed (see the raw log)', sev: 'error', inSketch: false, notes: [] });
  return { ok: false, hash, log, ms: Date.now() - t0, cached: false, ...d };
}

export function zigVersion() {
  const z = findZig();
  if (!z) return null;
  const r = spawnSync(z, ['version'], { encoding: 'utf8' });
  return r.stdout ? r.stdout.trim() : null;
}
