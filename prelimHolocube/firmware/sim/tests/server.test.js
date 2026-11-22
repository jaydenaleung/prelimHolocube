// Dev-server tests: the /api/compile contract the in-browser editor relies on, plus static serving + isolation headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HAVE_ZIG, DEMO, ROOT, PINS } from './helpers.js';
import { startServer } from '../tools/server.js';
import { runHeadless } from '../tools/headless-core.js';

const skip = HAVE_ZIG ? false : 'zig not installed';
let srv;
const api = async (p, init) => (await fetch(srv.url.slice(0, -1) + p, init));
const compile = async (source, name = 'demo.ino') => (await api('/api/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, name }) })).json();

test('server starts and serves the viewer with cross-origin isolation headers', { skip }, async () => {
  srv = await startServer({ sketchPath: DEMO, pins: PINS, pinsSource: 'test', pinsFile: null, layerPitch: 2.5, port: 0 });
  const r = await api('/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(r.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.match(await r.text(), /Holocube/);
  for (const p of ['/viewer/main.js', '/viewer/worker.js', '/emulator/host.js', '/vendor/three/build/three.module.js', '/vendor/three/examples/jsm/controls/OrbitControls.js'])
    assert.equal((await api(p)).status, 200, p);
  assert.equal((await api('/viewer/../package.json')).status, 404, 'no path traversal');
  const cfg = await (await api('/api/config')).json();
  assert.equal(cfg.sketchName, 'seven_panel_volume_demo.ino');
  assert.deepEqual(cfg.pins.cs, PINS.cs);
  assert.ok(cfg.source.includes('Holocube') || cfg.source.includes('Surenoo'));
});

test('edit cycle: syntax error -> structured error with line; fix -> new build with new behaviour', { skip }, async () => {
  const src = 'void setup() { Serial.println("v1"); }\nvoid loop() { delay(10); }\n';
  const v1 = await compile(src);
  assert.equal(v1.ok, true);

  const broken = src.replace('"v1"); }', '"v1") }');
  const bad = await compile(broken);
  assert.equal(bad.ok, false);
  assert.equal(bad.wasmUrl, null, 'no artefact for a failed build, so the page keeps the last good one');
  assert.equal(bad.errors[0].line, 1);
  assert.match(bad.errors[0].message, /expected ';'/);
  assert.equal(bad.errors[0].file, 'demo.ino');
  const log = await (await api(bad.logUrl)).text();
  assert.match(log, /demo\.ino:1:/);

  // the previously good build is still servable (the running firmware is not disturbed)
  assert.equal((await api(v1.wasmUrl)).status, 200);

  const v2 = await compile(src.replace('"v1"', '"v2 edited"'));
  assert.equal(v2.ok, true);
  assert.notEqual(v2.hash, v1.hash);
  const run = async (u) => (await runHeadless({ wasm: new Uint8Array(await (await api(u)).arrayBuffer()), pins: PINS, untilS: 1, config: { cpuFactor: 0 } })).serial.map((s) => s.line);
  assert.deepEqual((await run(v1.wasmUrl))[0], 'v1');
  assert.deepEqual((await run(v2.wasmUrl))[0], 'v2 edited');

  const back = await compile(src);               // revert: served from the build cache
  assert.equal(back.cached, true);
  assert.equal(back.hash, v1.hash);
});

test('pins can be updated through the API (no recompile needed)', { skip }, async () => {
  const r = await api('/api/pins', { method: 'PUT', body: JSON.stringify({ cs: [1, 2], dc: 3, rst: 4, sck: 5, mosi: 6 }) });
  assert.equal(r.status, 200);
  assert.deepEqual((await (await api('/api/pins')).json()).pins.cs, [1, 2]);
  const bad = await api('/api/pins', { method: 'PUT', body: '{"cs": "nope"}' });
  assert.equal(bad.status, 500);
  srv.server.close();
});
