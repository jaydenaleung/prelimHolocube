// Hardware lint rules, one test per failure mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HolocubeBus, DEFAULT_PINS } from '../emulator/bus.js';
import { Linter } from '../emulator/lint.js';

function rig(pins = DEFAULT_PINS, { spiMaxHz } = {}) {
  let t = 0;
  const warnings = [];
  const lint = new Linter({ now: () => t, onWarning: (w) => warnings.push(w), spiMaxHz });
  const bus = new HolocubeBus({ pins, now: () => t, lint });
  const r = {
    bus, lint, warnings, pins,
    set: (v) => { t = v; }, now: () => t,
    codes: () => warnings.map((w) => w.code),
    has: (c) => warnings.some((w) => w.code === c),
    init() {
      for (const p of [...pins.cs, pins.dc, pins.rst]) bus.pinMode(p, 3);
      for (const p of pins.cs) bus.digitalWrite(p, 1);
      bus.digitalWrite(pins.rst, 1);
      bus.spiBegin(18, -1, 23, -1);
      bus.spiBeginTx(1e6, 1, 0);
    },
    reset(widthUs = 100) { bus.digitalWrite(pins.rst, 0); t += widthUs; bus.digitalWrite(pins.rst, 1); t += 100; },
    send(panel, dc, ...bytes) {
      bus.digitalWrite(pins.dc, dc);
      bus.digitalWrite(pins.cs[panel], 0);
      for (const b of bytes) { bus.spiByte(b); t += 8; }
      bus.digitalWrite(pins.cs[panel], 1);
    },
  };
  return r;
}

test('a clean init sequence produces no warnings', () => {
  const r = rig();
  r.init(); r.reset();
  r.send(0, 0, 0xAE, 0xAD, 0x8A, 0x81, 0xFF, 0xA4, 0xA6);
  r.send(0, 0, 0xB0, 0x00, 0x10); r.send(0, 1, 0, 0, 0);
  r.send(0, 0, 0xAF);
  r.set(r.now() + 150_000);
  r.send(0, 1, 1, 2, 3);
  r.lint.tick(r.bus.panels);
  const bad = r.warnings.filter((w) => w.level !== 'info');
  assert.deepEqual(bad.map((w) => w.code), []);
});

test('two CS lines low at once -> CONTENTION (error)', () => {
  const r = rig(); r.init(); r.reset();
  r.bus.digitalWrite(r.pins.cs[0], 0); r.bus.digitalWrite(r.pins.cs[3], 0);
  const w = r.warnings.find((x) => x.code === 'CONTENTION');
  assert.ok(w); assert.equal(w.level, 'error'); assert.match(w.message, /1 and 4/);
});

test('SPI byte with no CS low -> NO_CS', () => {
  const r = rig(); r.init(); r.reset();
  r.bus.spiByte(0x12);
  assert.ok(r.has('NO_CS'));
});

test('CS not idle-high before first bus use -> CS_NOT_IDLE', () => {
  const r = rig();
  for (const p of [...r.pins.cs, r.pins.dc, r.pins.rst]) r.bus.pinMode(p, 3);
  for (const p of r.pins.cs.slice(0, 5)) r.bus.digitalWrite(p, 1);   // CS6 and CS7 never raised
  r.bus.digitalWrite(r.pins.rst, 1);
  r.bus.spiBegin(18, -1, 23, -1); r.bus.spiBeginTx(1e6, 1, 0);
  r.reset();
  r.send(0, 0, 0xAE);
  const idle = r.warnings.filter((w) => w.code === 'CS_NOT_IDLE').map((w) => w.message);
  assert.equal(idle.length, 2);
  assert.match(idle.join(' '), /CS6/); assert.match(idle.join(' '), /CS7/);
});

test('RES pulse after a panel is on or initialized -> RES_AFTER_ON / RES_AFTER_INIT', () => {
  const r = rig(); r.init(); r.reset();
  r.send(0, 0, 0xAD, 0x8A);
  r.reset();
  assert.ok(r.has('RES_AFTER_INIT'));
  r.send(0, 0, 0xAF);
  r.reset();
  assert.ok(r.has('RES_AFTER_ON'));
});

test('RES low shorter than 10 us -> RES_SHORT', () => {
  const r = rig(); r.init(); r.reset(3);
  assert.ok(r.has('RES_SHORT'));
  const r2 = rig(); r2.init(); r2.reset(10);
  assert.ok(!r2.has('RES_SHORT'));
});

test('init without any RES pulse -> NO_RESET', () => {
  const r = rig(); r.init();
  r.send(0, 0, 0xAE);
  assert.ok(r.has('NO_RESET'));
});

test('0xAD 0x8A never sent -> NO_EXT_VPP when the panel is switched on', () => {
  const r = rig(); r.init(); r.reset();
  r.send(0, 0, 0xB0, 0x00, 0x10); r.send(0, 1, 0);
  r.send(0, 0, 0xAF);
  assert.ok(r.has('NO_EXT_VPP'));
});

test('display on before RAM written -> ON_BEFORE_RAM (speckle)', () => {
  const r = rig(); r.init(); r.reset();
  r.send(0, 0, 0xAD, 0x8A, 0xAF);
  assert.ok(r.has('ON_BEFORE_RAM'));
  const r2 = rig(); r2.init(); r2.reset();
  r2.send(0, 0, 0xAD, 0x8A, 0xB0, 0, 0x10); r2.send(0, 1, 0xFF); r2.send(0, 0, 0xAF);
  assert.ok(!r2.has('ON_BEFORE_RAM'));
});

test('less than 100 ms between 0xAF and the next activity -> ON_TOO_SOON', () => {
  const r = rig(); r.init(); r.reset();
  r.send(0, 0, 0xAD, 0x8A, 0xB0, 0, 0x10); r.send(0, 1, 0xFF);
  r.send(0, 0, 0xAF);
  r.set(r.now() + 20_000);
  r.send(0, 1, 5);
  assert.ok(r.has('ON_TOO_SOON'));
  const r2 = rig(); r2.init(); r2.reset();
  r2.send(0, 0, 0xAD, 0x8A, 0xB0, 0, 0x10); r2.send(0, 1, 0xFF); r2.send(0, 0, 0xAF);
  r2.set(r2.now() + 120_000);
  r2.send(0, 1, 5);
  assert.ok(!r2.has('ON_TOO_SOON'));
});

test('contrast left low and 0xA5 left active are reported on the periodic tick', () => {
  const r = rig(); r.init(); r.reset();
  r.send(0, 0, 0xAD, 0x8A, 0x81, 0x08, 0xA5, 0xAF);
  r.lint.tick(r.bus.panels);
  assert.ok(r.has('CONTRAST_LOW'));
  assert.ok(r.has('ALL_ON'));
});

test('DC pin number equal to a CS pin -> DC_EQ_CS (the GPIO16 bug)', () => {
  const r = rig({ cs: [13, 27, 26, 25, 33, 32, 16], dc: 16, rst: 19, sck: 18, mosi: 23 });
  const w = r.warnings.find((x) => x.code === 'DC_EQ_CS');
  assert.ok(w); assert.equal(w.level, 'error'); assert.match(w.message, /GPIO16/);
});

test('ESP32 pin hazards: strapping, flash, USB serial, input-only, WROVER PSRAM', () => {
  const r = rig();
  r.bus.pinMode(12, 3);   // strapping
  r.bus.pinMode(6, 3);    // flash
  r.bus.pinMode(1, 3);    // USB serial TX
  r.bus.pinMode(34, 3);   // input-only used as output
  r.bus.pinMode(16, 3);   // PSRAM on WROVER
  r.bus.pinMode(35, 1);   // input-only used as input is fine
  assert.ok(r.has('PIN_STRAPPING'));
  assert.ok(r.has('PIN_FLASH'));
  assert.ok(r.has('PIN_USB'));
  assert.ok(r.has('PIN_INPUT_ONLY'));
  assert.ok(r.has('PIN_WROVER'));
  assert.equal(r.warnings.filter((w) => w.code === 'PIN_INPUT_ONLY').length, 1, 'only the output use is flagged');
  assert.equal(r.warnings.find((w) => w.code === 'PIN_WROVER').level, 'info');
});

test('SPI clock above the configured maximum -> SPI_FAST', () => {
  const r = rig(DEFAULT_PINS, { spiMaxHz: 10_000_000 });
  r.bus.spiBeginTx(10_000_000, 1, 0);
  assert.ok(!r.has('SPI_FAST'));
  r.bus.spiBeginTx(20_000_000, 1, 0);
  assert.ok(r.has('SPI_FAST'));
});

test('warnings are deduplicated and carry virtual timestamps', () => {
  const r = rig(); r.init(); r.reset();
  r.set(12_345);
  r.bus.spiByte(1); r.bus.spiEndTx(); r.bus.spiBeginTx(1e6, 1, 0); r.bus.spiByte(1);
  const w = r.warnings.filter((x) => x.code === 'NO_CS');
  assert.equal(w.length, 1);
  assert.equal(w[0].t, 12_345);
  assert.equal(w[0].count, 2);
});
