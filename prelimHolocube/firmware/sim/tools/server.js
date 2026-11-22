// Dev server: static files + /api/compile. Started by `npm run sim`.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, compileSketch, findZig, zigVersion, INSTALL_HELP, BUILD_DIR } from './compiler.js';
import { parsePins } from './pins.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.ino': 'text/plain; charset=utf-8',
};

const STATIC_ROOTS = [
  ['/viewer/', path.join(ROOT, 'viewer')],
  ['/emulator/', path.join(ROOT, 'emulator')],
  ['/vendor/three/', path.join(ROOT, 'node_modules', 'three')],
];

/**
 * @param {object} o
 * @param {string} o.sketchPath         original .ino on disk
 * @param {object} o.pins               parsed pins object (or {auto:true})
 * @param {string} o.pinsSource         human readable origin of the pins
 * @param {string|null} o.pinsFile      file to write pin edits back to (null = in-memory only)
 * @param {number} o.layerPitch
 */
export async function startServer({ sketchPath, pins, pinsSource, pinsFile, layerPitch, port = 5173, host = '127.0.0.1' }) {
  const state = { pins, pinsSource, pinsFile, layerPitch };
  const sketchName = path.basename(sketchPath);
  const send = (res, code, body, type = 'application/json', extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store',
      // SharedArrayBuffer (used for pause/speed control of the firmware worker) needs cross-origin isolation
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', ...extra });
    res.end(body);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 4e6) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  const zig = findZig();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = decodeURIComponent(url.pathname);

      if (p === '/' || p === '/index.html') return send(res, 200, fs.readFileSync(path.join(ROOT, 'viewer', 'index.html')), MIME['.html']);

      if (p === '/api/config') {
        return send(res, 200, JSON.stringify({
          sketchName, source: fs.readFileSync(sketchPath, 'utf8'),
          pins: state.pins, pinsSource: state.pinsSource, pinsEditable: !!state.pinsFile, layerPitch: state.layerPitch,
          compiler: zig ? { path: zig, version: zigVersion() } : null, installHelp: zig ? null : INSTALL_HELP,
        }));
      }

      if (p === '/api/original') return send(res, 200, fs.readFileSync(sketchPath, 'utf8'), MIME['.txt']);

      if (p === '/api/compile' && req.method === 'POST') {
        const { source, name } = JSON.parse(await readBody(req));
        try {
          const r = await compileSketch(String(source), { name: path.basename(name || sketchName), sketchDir: path.dirname(sketchPath) });
          return send(res, 200, JSON.stringify({
            ok: r.ok, hash: r.hash, ms: r.ms, cached: r.cached, errors: r.errors, warnings: r.warnings,
            wasmUrl: r.ok ? `/api/wasm/${r.hash}` : null, logUrl: `/api/log/${r.hash}`,
          }));
        } catch (e) {
          if (e.code === 'NO_COMPILER') return send(res, 200, JSON.stringify({ ok: false, setup: true, message: e.message, errors: [], warnings: [] }));
          throw e;
        }
      }

      let m;
      if ((m = /^\/api\/wasm\/([0-9a-f]{8,64})$/.exec(p))) {
        const f = path.join(BUILD_DIR, 'cache', m[1], 'sketch.wasm');
        if (!fs.existsSync(f)) return send(res, 404, 'no such build', MIME['.txt']);
        return send(res, 200, fs.readFileSync(f), MIME['.wasm']);
      }
      if ((m = /^\/api\/log\/([0-9a-f]{8,64})$/.exec(p))) {
        const f = path.join(BUILD_DIR, 'cache', m[1], 'build.log');
        return send(res, fs.existsSync(f) ? 200 : 404, fs.existsSync(f) ? fs.readFileSync(f) : 'no log', MIME['.txt']);
      }

      // Dev/testing aid (HOLO_DEV=1 only): let the page save a canvas capture so it can be inspected from disk.
      if (p === '/api/dev/shot' && req.method === 'POST' && process.env.HOLO_DEV) {
        const name = (url.searchParams.get('name') || 'shot').replace(/[^\w.-]+/g, '_');
        const dir = path.join(BUILD_DIR, 'browser-shots');
        fs.mkdirSync(dir, { recursive: true });
        const body = await readBody(req);
        fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from(body.replace(/^data:image\/png;base64,/, ''), 'base64'));
        return send(res, 200, '{"ok":true}');
      }

      if (p === '/api/pins' && req.method === 'PUT') {
        const text = await readBody(req);
        const parsed = parsePins(text, 'pins');
        state.pins = parsed;
        if (state.pinsFile) {
          let prev = {};
          try { prev = JSON.parse(fs.readFileSync(state.pinsFile, 'utf8')); } catch { /* new file */ }
          fs.writeFileSync(state.pinsFile, JSON.stringify({ ...(prev._comment ? { _comment: prev._comment } : {}), ...parsed }, null, 2) + '\n');
        }
        return send(res, 200, JSON.stringify({ ok: true, pins: parsed }));
      }
      if (p === '/api/pins' && req.method === 'GET') {
        if (state.pinsFile) {
          try { state.pins = parsePins(fs.readFileSync(state.pinsFile, 'utf8'), state.pinsFile); } catch (e) { return send(res, 400, JSON.stringify({ error: e.message })); }
        }
        return send(res, 200, JSON.stringify({ pins: state.pins }));
      }

      for (const [prefix, dir] of STATIC_ROOTS) {
        if (p.startsWith(prefix)) {
          const rel = path.normalize(p.slice(prefix.length));
          const f = path.join(dir, rel);
          if (!f.startsWith(dir) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, 'not found', MIME['.txt']);
          return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
        }
      }
      return send(res, 404, 'not found', MIME['.txt']);
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: String(e && e.message || e) }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { server, url: `http://${host}:${server.address().port}/`, state };
}
