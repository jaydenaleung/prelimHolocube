// Inputs to the firmware: buttons / switches on GPIOs, interrupts, ADC voltages, pulseIn and Serial input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HAVE_ZIG, FIX, runSketch } from './helpers.js';
import { toEvents, parseInputSpec, makeInputChannel, sendInput, sendSerial, drainInputs, CMD, InputSchedule } from '../emulator/inputs.js';

const skip = HAVE_ZIG ? false : 'zig not installed';
const kv = (run) => {
  const out = {};
  for (const { line } of run.serial) for (const m of line.matchAll(/(\w+)=(\[[^\]]*\]|\S+)/g)) out[m[1]] = m[2];
  return out;
};
const codes = (run) => run.warnings.map((w) => w.code);

test('input specs and friendly events normalise to microsecond events', () => {
  assert.deepEqual(parseInputSpec('press:0@1.5+0.2!bounce'), { t: 1.5, press: 0, dur: 0.2, bounce: true });
  assert.deepEqual(parseInputSpec('level:4=z@3'), { t: 3, level: 4, value: null });
  assert.deepEqual(parseInputSpec('analog:34=1650@0.5'), { t: 0.5, analog: 34, mv: 1650 });
  assert.deepEqual(parseInputSpec('serial:hi\\n@2'), { t: 2, serial: 'hi\n' });
  assert.throws(() => parseInputSpec('press:0'), /missing @time/);
  const ev = toEvents([{ t: 1, press: 0, dur: 0.25 }, { t: 2, serial: 'A' }]);
  assert.deepEqual(ev.map((e) => [e.t, e.kind, e.down]), [[1e6, 'press', true], [1.25e6, 'press', false], [2e6, 'serial', undefined]]);
  const s = new InputSchedule(ev.slice().reverse());
  assert.equal(s.nextTime(), 1e6);
  assert.equal(s.takeDue(1.3e6).length, 2);
});

test('the page -> worker command ring keeps order and groups Serial bytes', () => {
  const ch = makeInputChannel();
  sendInput(ch, CMD.PRESS, 0, 1, { bounce: true, active: 'low' });
  sendSerial(ch, 'ok');
  sendInput(ch, CMD.ANALOG, 34, 1200);
  const out = [];
  drainInputs(ch, 77, out);
  assert.deepEqual(out, [
    { t: 77, kind: 'press', pin: 0, down: true, bounce: true, active: 'low' },
    { t: 77, kind: 'serial', bytes: [111, 107] },
    { t: 77, kind: 'analog', pin: 34, mv: 1200 },
  ]);
  const again = []; drainInputs(ch, 78, again);
  assert.equal(again.length, 0, 'drained entries are consumed');
});

test('buttons, switches and interrupts (FALLING, CHANGE with arg, bounce, noInterrupts, detach)', { skip }, async () => {
  const run = await runSketch(FIX('inputs_buttons.ino'), {
    untilS: 4,
    inputs: [
      { t: 0.5, press: 0, dur: 0.2 },
      { t: 1.2, press: 0, dur: 0.1, bounce: true },
      { t: 1.8, level: 4, value: 1 }, { t: 2.2, level: 4, value: null },
      { t: 2.7, press: 0, dur: 0.1 },
      { t: 3.2, press: 0, dur: 0.1 },
    ],
  });
  const r = kv(run);
  assert.ok(run.serial.some((s) => s.line === 'END'), run.serial.map((s) => s.line).join(' | '));
  assert.equal(r.idle, '1,0', 'INPUT_PULLUP reads 1 and INPUT_PULLDOWN reads 0 with nothing connected');
  assert.equal(r.pressed, '0'); assert.equal(r.released, '1');
  assert.equal(r.falls, '1', 'one clean press = one FALLING interrupt');
  // chatter on press (3 falling edges) and on release (2 more) = 5 extra interrupts
  assert.equal(r.bounced, '6');
  assert.equal(r.changes, '2', 'CHANGE fires on the rise and on the fall back to the pull-down level');
  assert.equal(r.pin4, '0');
  assert.equal(r.held, '6', 'no handler runs while interrupts are off');
  assert.equal(r.after, '7', 'the held interrupt runs once interrupts are back on');
  assert.equal(r.detached, '7');
});

test('analogRead resolution / attenuation, analogReadMilliVolts, non-ADC pin and pulseIn', { skip }, async () => {
  const run = await runSketch(FIX('inputs_analog.ino'), {
    untilS: 2,
    inputs: [{ t: 0, analog: 34, mv: 1650 }, { t: 0, analog: 35, mv: 4000 }, { t: 0.1, level: 14, value: 1 }, { t: 0.1003, level: 14, value: 0 }],
  });
  const r = kv(run);
  assert.ok(run.serial.some((s) => s.line === 'END'));
  assert.ok(Math.abs(+r.pulse - 300) <= 3, `pulse width ${r.pulse} us`);
  assert.equal(r.pulse_timeout, '0');
  assert.equal(r.raw12, '2180', '1.65 V at 11 dB (3.1 V full scale), 12 bits');
  assert.equal(r.over, '4095', 'above full scale saturates');
  assert.equal(r.raw10, '545', '10-bit resolution drops the two low bits');
  assert.equal(r.raw0db, '4095', '1.65 V is above the 0 dB range');
  assert.equal(r.mv0db, '1100'); assert.equal(r.mv35, '3100');
  assert.equal(r.notadc, '0');
  assert.ok(codes(run).includes('ANALOG_NOT_ADC'));
});

test('Serial input: parseInt, parseFloat, readStringUntil, find, readBytesUntil, timeouts, echo', { skip }, async () => {
  const run = await runSketch(FIX('inputs_serial.ino'), {
    untilS: 3,
    inputs: [
      { t: 0.1, serial: '  -42 abc\n' }, { t: 0.3, serial: '3.75,x\n' }, { t: 0.5, serial: 'hello world\n' },
      { t: 0.7, serial: 'find>OK<\n' }, { t: 2.5, serial: 'later\n' },
    ],
  });
  const r = kv(run);
  const lines = run.serial.map((s) => s.line);
  assert.ok(lines.includes('END'), lines.join(' | '));
  assert.equal(r.int, '-42');
  assert.equal(r.rest, '[ abc]');
  assert.equal(r.float, '3.75');
  assert.equal(r.line, '[hello world]');
  assert.equal(r.find, '1'); assert.equal(r.bytes, '[OK]');
  assert.equal(r.timeout, '0');
  assert.ok(Math.abs(+r.dt - 500) <= 2, `parseInt gave up after the 500 ms timeout (${r.dt} ms)`);
  assert.equal(r.avail, '0');
  // the int arrived at 0.1 s: parseInt waited for it instead of returning 0 straight away
  const tInt = run.serial.find((s) => s.line.startsWith('int=')).t;
  assert.ok(tInt > 0.1e6 && tInt < 0.11e6, `int printed at ${tInt} us`);
  assert.ok(lines.includes('echo:later'));
});

test('Serial RX buffer: setRxBufferSize, overflow drops bytes and is linted', { skip }, async () => {
  const run = await runSketch(FIX('inputs_rxbuf.ino'), { untilS: 3, inputs: [{ t: 0.1, serial: 'abcdefghijklmnopqrstuvwxyz0123456789ABCD' }] });
  const r = kv(run);
  assert.equal(r.avail, '16');
  assert.equal(r.got, '[abcdefghijklmnop]', 'the first 16 bytes are kept, later ones dropped');
  assert.ok(codes(run).includes('SERIAL_RX_OVERFLOW'));
});
