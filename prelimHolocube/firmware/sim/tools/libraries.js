// Third-party Arduino libraries compiled from their real sources against the shim.
// Currently: U8g2 (olikraus) - the whole library incl. U8x8, MUI and all fonts, built once into an archive.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

export const U8G2_INSTALL_HELP =
  'This sketch includes U8g2lib.h / U8x8lib.h, but the U8g2 library was not found. Either\n' +
  '  * install "U8g2 by oliver" with the Arduino IDE Library Manager (it lands in Documents/Arduino/libraries/U8g2), or\n' +
  '  * set the U8G2_PATH environment variable to the library folder (the one containing src/U8g2lib.h).';

export const U8G2_INCLUDE_RE = /^[ \t]*#[ \t]*include[ \t]*[<"](U8g2lib|U8x8lib|MUIU8g2)\.h[>"]/m;

export function usesU8g2(source) { return U8G2_INCLUDE_RE.test(source); }

/** Locate the U8g2 library folder (the one with src/U8g2lib.h). */
export function findU8g2() {
  const home = os.homedir();
  const candidates = [
    process.env.U8G2_PATH,
    process.env.ARDUINO_LIBRARIES && path.join(process.env.ARDUINO_LIBRARIES, 'U8g2'),
    path.join(home, 'Documents', 'Arduino', 'libraries', 'U8g2'),
    path.join(home, 'OneDrive', 'Documents', 'Arduino', 'libraries', 'U8g2'),
    path.join(home, 'Arduino', 'libraries', 'U8g2'),
    path.join(ROOT, 'vendor', 'U8g2'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'src', 'U8g2lib.h'))) return c;
  }
  return null;
}

export function u8g2Version(dir) {
  try {
    const m = /^version=(.*)$/m.exec(fs.readFileSync(path.join(dir, 'library.properties'), 'utf8'));
    return m ? m[1].trim() : 'unknown';
  } catch { return 'unknown'; }
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

/**
 * Build (or reuse) libu8g2.a.
 * @returns {Promise<{ok:boolean, archive?:string, includeDirs:string[], version:string, log:string, cached:boolean, ms:number}>}
 */
export async function buildU8g2({ zig, run, env, buildDir, shimDir, shimHash, cFlags, cxxFlags, onProgress = () => {} }) {
  const t0 = Date.now();
  const lib = findU8g2();
  if (!lib) return { ok: false, log: U8G2_INSTALL_HELP, includeDirs: [], version: null, cached: false, ms: 0, missing: true };
  const src = path.join(lib, 'src');
  const clib = path.join(src, 'clib');
  const version = u8g2Version(lib);
  const cFiles = fs.readdirSync(clib).filter((f) => f.endsWith('.c')).sort();
  const cppFiles = fs.readdirSync(src).filter((f) => f.endsWith('.cpp')).sort();
  const key = crypto.createHash('sha256').update([lib, version, shimHash, cFlags.join(' '), cxxFlags.join(' '),
    ...cFiles, ...cppFiles, ...cFiles.map((f) => String(fs.statSync(path.join(clib, f)).size))].join('\n')).digest('hex').slice(0, 16);
  const outDir = path.join(buildDir, `lib-u8g2-${key}`);
  const archive = path.join(outDir, 'libu8g2.a');
  const includeDirs = [src];
  if (fs.existsSync(archive)) return { ok: true, archive, includeDirs, version, log: '', cached: true, ms: Date.now() - t0, path: lib };

  // built in a private directory that is renamed into place when complete: parallel builds never see a partial archive
  const work = `${outDir}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  const rmWork = () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ } };
  fs.mkdirSync(work, { recursive: true });
  const jobs = [
    ...cppFiles.map((f) => ({ file: path.join(src, f), obj: path.join(work, f.replace(/\.cpp$/, '.o')), args: [...cxxFlags, '-I', shimDir, '-I', src] })),
    ...cFiles.map((f) => ({ file: path.join(clib, f), obj: path.join(work, f.replace(/\.c$/, '.o')), args: [...cFlags, '-I', clib] })),
  ];
  // the font file is ~30 MB of source: start it first so it overlaps with everything else
  jobs.sort((a, b) => fs.statSync(b.file).size - fs.statSync(a.file).size);
  let done = 0;
  let log = '';
  onProgress(`building U8g2 ${version} (one-time, ${jobs.length} files) ...`);
  const results = await pool(jobs, Math.max(2, Math.min(8, os.cpus().length)), async (j) => {
    const r = await run(zig, ['cc', ...j.args, '-c', j.file, '-o', j.obj], { env, cwd: work });
    done++;
    if (done % 20 === 0 || done === jobs.length) onProgress(`building U8g2: ${done}/${jobs.length}`);
    return { ...j, ...r };
  });
  const failed = results.filter((r) => r.code !== 0);
  for (const f of failed) log += `--- ${path.basename(f.file)}\n${f.out}\n`;
  if (failed.length) { rmWork(); return { ok: false, log: `U8g2 failed to build (${failed.length} files):\n` + log, includeDirs, version, cached: false, ms: Date.now() - t0 }; }
  const ar = await run(zig, ['ar', 'rcs', path.join(work, 'libu8g2.a'), ...results.map((r) => r.obj)], { env, cwd: work });
  if (ar.code !== 0) { rmWork(); return { ok: false, log: ar.out, includeDirs, version, cached: false, ms: Date.now() - t0 }; }
  try { fs.renameSync(work, outDir); } catch (e) {
    if (fs.existsSync(archive)) rmWork();                      // another process finished first: use theirs
    else {                                                     // a stale, incomplete directory from an interrupted build
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.renameSync(work, outDir);
    }
  }
  onProgress(`U8g2 ${version} built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { ok: true, archive, includeDirs, version, log: '', cached: false, ms: Date.now() - t0, path: lib };
}
