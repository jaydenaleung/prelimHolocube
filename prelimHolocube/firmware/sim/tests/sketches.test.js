// Sketch-level tests: hardware lint on a deliberately bad sketch, build errors, hangs and watchdogs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HAVE_ZIG, FIX, build, runSketch, PINS } from './helpers.js';
import { runHeadless } from '../tools/headless-core.js';
import { main as headlessMain } from '../tools/headless.js';

const skip = HAVE_ZIG ? false : 'zig not installed';

test('bad_bus.ino triggers every hardware lint rule that a sketch can trigger', { skip }, async () => {
  const run = await runSketch(FIX('bad_bus.ino'), { untilS: 3 });
  const codes = new Set(run.warnings.map((w) => w.code));
  for (const c of ['SPI_FAST', 'NO_CS', 'CS_NOT_IDLE', 'RES_SHORT', 'CONTENTION', 'ON_BEFORE_RAM', 'NO_EXT_VPP', 'ON_TOO_SOON', 'ALL_ON',
    'CONTRAST_LOW', 'UNKNOWN_CMD', 'RES_AFTER_ON', 'PIN_STRAPPING', 'PIN_INPUT_ONLY', 'PIN_FLASH'])
    assert.ok(codes.has(c), `expected ${c}; got ${[...codes].join(', ')}`);
  // virtual timestamps: the late RES pulse is detected after the 700 ms settle delay
  const late = run.warnings.find((w) => w.code === 'RES_AFTER_ON');
  assert.ok(late.t > 700_000, `RES_AFTER_ON stamped at ${late.t} us`);
  const early = run.warnings.find((w) => w.code === 'SPI_FAST');
  assert.ok(early.t < late.t);
});

test('DC pin equal to a CS pin is flagged from pins.json alone (the GPIO16 bug)', { skip }, async () => {
  const run = await runSketch(FIX('bad_bus.ino'), { untilS: 1, pins: { ...PINS, dc: 16 } });
  const w = run.warnings.find((x) => x.code === 'DC_EQ_CS');
  assert.ok(w); assert.equal(w.t, 0);
});

test('syntax error: build fails with the right file:line:col and message', { skip }, async () => {
  const r = await build(FIX('syntax_error.ino'));
  assert.equal(r.ok, false);
  const e = r.errors[0];
  assert.equal(e.file, 'syntax_error.ino');
  assert.equal(e.line, 3, 'the line of the missing semicolon in the .ino, not in the generated .cpp');
  assert.match(e.message, /expected ';'/);
  assert.equal(e.inSketch, true);
  assert.ok(r.log.includes('syntax_error.ino:3:'));
});

test('undefined symbol is reported against the sketch line', { skip }, async () => {
  const r = await build(FIX('undefined_symbol.ino'));
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].line, 1);
  assert.match(r.errors[0].message, /thisDoesNotExist/);
});

test('compiler warnings are separate from errors and do not fail the build', { skip }, async () => {
  const r = await build(FIX('warn_only.ino'));
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.some((w) => /non-void function does not return a value/.test(w.message) && w.line === 1));
});

test('builds are cached by source hash (reverting an edit is instant)', { skip }, async () => {
  const a = await build(FIX('warn_only.ino'));
  const t0 = Date.now();
  const b = await build(FIX('warn_only.ino'));
  assert.equal(b.cached, true);
  assert.equal(b.hash, a.hash);
  assert.ok(Date.now() - t0 < 300);
});

test('virtual watchdog: busy loop that polls millis() but never yields is stopped, with Serial output', { skip }, async () => {
  const run = await runSketch(FIX('spin_millis.ino'), { untilS: 60 });
  assert.equal(run.result.reason, 'watchdog');
  assert.match(run.result.message, /5000 ms of virtual time/);
  assert.ok(run.serial.some((s) => s.line === 'spinning on millis()'), 'Serial output up to that point is preserved');
  assert.ok(run.vt > 5e6 && run.vt < 6e6, `stopped at ${run.vt / 1e6} s virtual`);
});

test('the watchdog threshold is configurable', { skip }, async () => {
  const run = await runSketch(FIX('spin_millis.ino'), { untilS: 60, config: { watchdogMs: 1000 } });
  assert.equal(run.result.reason, 'watchdog');
  assert.ok(run.vt < 2e6);
});

test('tight loop that never calls the simulator is killed by the wall-clock watchdog (CLI)', { skip }, async () => {
  const out = fs.mkdtempSync(path.join(path.dirname(FIX('x')), '..', '..', 'build', 'hang-'));
  const code = await headlessMain([FIX('hang.ino'), '--until', '5', '--out', out, '--wall-timeout', '3', '--quiet']);
  assert.equal(code, 1);
  const j = JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8'));
  assert.equal(j.result.reason, 'hang');
  assert.match(j.result.message, /did not return control/);
});

test('firmware that calls exit() is reported, not treated as a hang', { skip }, async () => {
  const src = 'void setup(){ Serial.println("bye"); }\nvoid loop(){ ESP.restart(); }\n';
  const f = path.join(path.dirname(FIX('x')), '..', '..', 'build', 'exit_test.ino');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, src);
  const run = await runSketch(f, { untilS: 5 });
  assert.equal(run.result.reason, 'exit');
});

test('out-of-bounds firmware bug becomes a crash report, not a simulator failure', { skip }, async () => {
  const src = 'void setup(){ Serial.println("go"); }\nvoid loop(){ volatile char *p = (char*)0x7fffff00; *p = 1; delay(1); }\n';
  const f = path.join(path.dirname(FIX('x')), '..', '..', 'build', 'oob_test.ino');
  fs.writeFileSync(f, src);
  const run = await runSketch(f, { untilS: 5 });
  assert.equal(run.result.reason, 'crash');
  assert.match(run.result.message, /Guru Meditation|trap/);
});
