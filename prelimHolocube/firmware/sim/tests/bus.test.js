// Pin/SPI routing: CS selects the panel, DC selects command vs data, RES resets registers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HolocubeBus, DEFAULT_PINS } from '../emulator/bus.js';
import { Linter } from '../emulator/lint.js';

function rig(pins = DEFAULT_PINS) {
  let t = 0;
  const warnings = [];
  const lint = new Linter({ now: () => t, onWarning: (w) => warnings.push(w) });
  const bus = new HolocubeBus({ pins, now: () => t, lint });
  const clock = { tick: (us = 10) => { t += us; }, set: (v) => { t = v; } };
  for (const p of [...pins.cs, pins.dc, pins.rst]) bus.pinMode(p, 3);
  for (const p of pins.cs) bus.digitalWrite(p, 1);
  bus.digitalWrite(pins.rst, 1);
  bus.spiBegin(18, -1, 23, -1);
  return { bus, lint, warnings, clock, pins, codes: () => warnings.map((w) => w.code) };
}
const send = (r, panel, dc, ...bytes) => {
  r.bus.digitalWrite(r.pins.dc, dc);
  r.bus.digitalWrite(r.pins.cs[panel], 0);
  for (const b of bytes) { r.bus.spiByte(b); r.clock.tick(8); }
  r.bus.digitalWrite(r.pins.cs[panel], 1);
};

test('bytes reach only the panel whose CS is low; DC picks command vs data', () => {
  const r = rig();
  r.bus.spiBeginTx(1e6, 1, 0);
  send(r, 2, 0, 0xB1, 0x00, 0x10);
  send(r, 2, 1, 0x11, 0x22);
  r.bus.spiEndTx();
  assert.equal(r.bus.panels[2].ram[128], 0x11);
  assert.equal(r.bus.panels[2].ram[129], 0x22);
  for (const i of [0, 1, 3, 4, 5, 6]) assert.equal(r.bus.panels[i].ramWritten, false, `panel ${i + 1} untouched`);
});

test('two CS low at once: both panels listen, and contention is flagged', () => {
  const r = rig();
  r.bus.spiBeginTx(1e6, 1, 0);
  r.bus.digitalWrite(r.pins.dc, 0);
  r.bus.digitalWrite(r.pins.cs[0], 0);
  r.bus.digitalWrite(r.pins.cs[1], 0);
  r.bus.spiByte(0xAF);
  assert.equal(r.bus.panels[0].displayOn, true);
  assert.equal(r.bus.panels[1].displayOn, true);
  assert.ok(r.codes().includes('CONTENTION'));
});

test('SPI bytes with no CS low go nowhere and raise a warning', () => {
  const r = rig();
  r.bus.spiBeginTx(1e6, 1, 0);
  r.bus.digitalWrite(r.pins.dc, 0);
  r.bus.spiByte(0xAF);
  assert.ok(r.bus.panels.every((p) => !p.displayOn));
  assert.ok(r.codes().includes('NO_CS'));
});

test('RES low resets registers on every panel but leaves GDDRAM', () => {
  const r = rig();
  send(r, 0, 0, 0xAF, 0xB0, 0x00, 0x10);
  send(r, 0, 1, 0x77);
  r.bus.digitalWrite(r.pins.rst, 0);
  assert.equal(r.bus.panels[0].displayOn, false);
  assert.equal(r.bus.panels[0].ram[0], 0x77);
  r.bus.digitalWrite(r.pins.rst, 1);
  assert.ok(r.codes().includes('RES_AFTER_ON'));
});

test('bytes sent while RES is held low are ignored', () => {
  const r = rig();
  r.bus.digitalWrite(r.pins.rst, 0);
  send(r, 0, 0, 0xAF);
  r.bus.digitalWrite(r.pins.rst, 1);
  assert.equal(r.bus.panels[0].displayOn, false);
});

test('LSBFIRST bit order is reversed on the wire', () => {
  const r = rig();
  r.bus.spiBeginTx(1e6, 0, 0);          // LSB first
  send(r, 0, 0, 0xF5);                   // reversed: 0xAF
  assert.equal(r.bus.panels[0].displayOn, true);
});

test('frame counter detects display refreshes (panel/page sequence wraps)', () => {
  const r = rig();
  for (let f = 0; f < 3; f++)
    for (const panel of [0, 1]) { send(r, panel, 0, 0xB0, 0x00, 0x10); send(r, panel, 1, 1, 2, 3); }
  assert.equal(r.bus.frames, 2);
});

test('pins.json missing: roles are inferred (CS in first-seen order, DC and RST found)', () => {
  let t = 0;
  const bus = new HolocubeBus({ pins: { auto: true }, now: () => t });
  const cs = [13, 27, 26], dc = 21, rst = 19;
  bus.pinMode(dc, 3); bus.pinMode(rst, 3);
  for (const p of cs) { bus.pinMode(p, 3); bus.digitalWrite(p, 1); }
  bus.digitalWrite(rst, 0); t += 100; bus.digitalWrite(rst, 1);
  bus.spiBegin(18, -1, 23, -1);
  bus.spiBeginTx(1e6, 1, 0);
  bus.digitalWrite(dc, 0); t += 5; bus.digitalWrite(27, 0);   // CS goes low after D/C, as in most sketches
  bus.spiByte(0xAF);
  bus.settleAuto(true);   // a single byte is not enough to watch D/C switch: settle on the simple guess
  assert.deepEqual(bus.pinMap.cs, cs);
  assert.equal(bus.pinMap.dc, dc);
  assert.equal(bus.pinMap.rst, rst);
  assert.equal(bus.panels[1].displayOn, true, 'byte went to the panel on CS GPIO27');
});

test('auto pins: u8g2 order (CS low first, then D/C) is classified by watching D/C switch mid-transfer', () => {
  let t = 0;
  const bus = new HolocubeBus({ pins: { auto: true }, now: () => t });
  const cs = 13, dc = 2, rst = 4;
  for (const p of [cs, dc, rst]) bus.pinMode(p, 3);
  bus.digitalWrite(cs, 1); bus.digitalWrite(rst, 1);
  bus.digitalWrite(rst, 0); t += 100; bus.digitalWrite(rst, 1);
  bus.spiBegin(18, -1, 23, -1);
  // init transaction: CS low first, then D/C low, commands only
  bus.digitalWrite(cs, 0); t += 1; bus.digitalWrite(dc, 0);
  for (const b of [0xAE, 0xAF]) bus.spiByte(b);
  bus.digitalWrite(cs, 1);
  // draw transaction: CS low, page/column commands, D/C high, data
  bus.digitalWrite(cs, 0); bus.digitalWrite(dc, 0);
  for (const b of [0xB0, 0x10, 0x00]) bus.spiByte(b);
  bus.digitalWrite(dc, 1);
  bus.spiByte(0x81);
  bus.digitalWrite(cs, 1);
  assert.deepEqual(bus.pinMap.cs, [cs]);
  assert.equal(bus.pinMap.dc, dc);
  assert.equal(bus.pinMap.rst, rst);
  assert.equal(bus.panels[0].displayOn, true, 'bytes buffered before the decision were replayed as commands');
  assert.equal(bus.panels[0].ram[0], 0x81, 'and the data byte landed in RAM');
});

test('ESP32 core 3.x pin rules: SPI.begin() defaults claim GPIO19; writes to it are then ignored until pinMode()', () => {
  let t = 0;
  const bus = new HolocubeBus({ pins: { cs: [13], dc: 21, rst: 19, sck: 18, mosi: 23 }, now: () => t });
  bus.pinMode(19, 3); bus.digitalWrite(19, 1);
  bus.spiBegin(-1, -1, -1, -1);
  assert.equal(bus.owner.get(19), 'SPI MISO');
  bus.digitalWrite(19, 0);
  assert.equal(bus.panels[0].resetCount, 1, 'no reset: the write was ignored');
  bus.spiBegin(18, -1, 23, -1);
  assert.equal(bus.owner.get(19), 'SPI MISO', 'second SPI.begin() returns early, the first one wins');
  bus.pinMode(19, 3);                                  // core 3.x: pinMode takes the pin back as a GPIO
  bus.digitalWrite(19, 0); bus.digitalWrite(19, 1);
  assert.equal(bus.panels[0].resetCount, 2);
  bus.digitalWrite(5, 1);                              // never pinMode'd
  assert.equal(bus.level.has(5), false, 'digitalWrite before pinMode does nothing');
});

test('I2C: control bytes split commands and data (Co/D-C bits), unmapped address NACKs', () => {
  let t = 0;
  const bus = new HolocubeBus({ pins: { cs: [13], dc: 4, rst: 19, i2c: { 0x3C: 0 } }, now: () => t });
  bus.i2cBegin(-1, -1, 400000);
  assert.equal(bus.owner.get(21), 'I2C SDA');
  assert.equal(bus.i2cWrite(0x3C, Uint8Array.from([0x00, 0xAF, 0xB2, 0x00, 0x10])), 0);   // Co=0, commands
  assert.equal(bus.panels[0].displayOn, true);
  assert.equal(bus.i2cWrite(0x3C, Uint8Array.from([0x40, 0x11, 0x22])), 0);               // Co=0, data
  assert.equal(bus.panels[0].ram[2 * 128 + 0], 0x11);
  assert.equal(bus.i2cWrite(0x3C, Uint8Array.from([0x80, 0xA7, 0xC0, 0x33])), 0);         // Co=1 pairs: cmd, then data
  assert.equal(bus.panels[0].inverse, true);
  assert.equal(bus.panels[0].ram[2 * 128 + 2], 0x33);
  assert.equal(bus.i2cWrite(0x50, Uint8Array.from([0x00])), 2);
});
