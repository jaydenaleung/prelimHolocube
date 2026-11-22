// Pin + SPI + I2C model. The firmware only talks to pins and the SPI / I2C peripherals; this module turns that into
// bytes delivered to the SH1107s:
//   * hardware SPI (SPI.transfer...), and bit-banged software SPI decoded from the clock/data pin edges:
//     the panel whose CS is low gets the byte, as a command if DC is low and as data if DC is high
//   * hardware I2C (Wire...) and bit-banged software I2C decoded from SDA/SCL edges: the panel mapped to the
//     7-bit address gets the stream, split by the SH1107 control bytes (0x00/0x80 command, 0x40/0xC0 data)
//
// Pin semantics follow the ESP32 Arduino core 3.x (the installed core is 3.3.3):
//   * every pin has one owner. pinMode() makes it a GPIO; SPI.begin()/Wire.begin() attach it to the peripheral
//   * digitalWrite() on a pin that is not a GPIO is ignored (the core logs "IO n is not set as GPIO")
//   * SPI.begin() with no arguments claims SCK 18, MISO 19, MOSI 23; only the first SPI.begin() counts
//   * the level of a line follows its mode: OUTPUT -> the written value, INPUT_PULLUP -> high, INPUT -> floating
import { SH1107 } from './sh1107.js';

export const DEFAULT_PINS = {
  cs: [13, 27, 26, 25, 33, 32, 16], dc: 21, rst: 19, sck: 18, mosi: 23,
};
export const ESP32_DEFAULTS = { sck: 18, miso: 19, mosi: 23, ss: 5, sda: 21, scl: 22 };
export const DEFAULT_I2C = { 0x3C: 0 };   // 7-bit address -> panel index (display 1)

export const MODE = { INPUT: 0x01, OUTPUT: 0x03, INPUT_PULLUP: 0x05, INPUT_PULLDOWN: 0x09 };

const reverseBits = (b) => {
  let r = 0;
  for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 1 << (7 - i);
  return r;
};
const hex2 = (v) => '0x' + v.toString(16).toUpperCase().padStart(2, '0');

export class HolocubeBus {
  /**
   * @param {object} o
   * @param {object} o.pins           {cs:[], dc, rst, sck, mosi, sda?, scl?, i2c?} or {auto:true} to guess roles
   * @param {()=>number} o.now        virtual time, microseconds
   * @param {import('./lint.js').Linter} [o.lint]
   * @param {number} [o.seed]
   * @param {number} [o.irefKOhm]
   * @param {number} [o.numPanels]    default 7
   * @param {(msg:string)=>void} [o.onLog]  low-level log (unknown commands, ...)
   */
  constructor({ pins = DEFAULT_PINS, now, lint = null, seed = 1, irefKOhm = 1000, numPanels = 7, onLog = null }) {
    this.now = now;
    this.lint = lint;
    this.onLog = onLog || (() => {});
    this.auto = !!pins.auto;
    this.pinMap = { cs: [], dc: null, rst: null, sck: null, mosi: null };
    this.numPanels = numPanels;
    if (!this.auto) {
      this.pinMap = { cs: pins.cs.slice(), dc: pins.dc, rst: pins.rst, sck: pins.sck ?? null, mosi: pins.mosi ?? null };
      this.numPanels = pins.cs.length;
      if (lint) lint.checkConfig(this.pinMap);
    }
    this.pinMap.sda = pins.sda ?? ESP32_DEFAULTS.sda;
    this.pinMap.scl = pins.scl ?? ESP32_DEFAULTS.scl;
    this.i2cMap = new Map(Object.entries(pins.i2c || DEFAULT_I2C).map(([a, idx]) => [Number(a), Number(idx)]));
    this.numPanels = Math.max(this.numPanels, ...[...this.i2cMap.values()].map((i) => i + 1), 1);
    this.pinMap.i2c = Object.fromEntries([...this.i2cMap.entries()].map(([a, i]) => [hex2(a), i + 1]));
    this.irefKOhm = irefKOhm;
    this.seed = seed;
    this.panels = [];
    this._ensurePanels(this.numPanels);
    this.level = new Map();     // pin -> line level 0/1 (absent = floating / not driven by a GPIO)
    this.latch = new Map();     // pin -> output register written by digitalWrite
    this.mode = new Map();      // pin -> pinMode value
    this.owner = new Map();     // pin -> 'gpio' | 'SPI SCK' | 'SPI MISO' | 'SPI MOSI' | 'I2C SDA' | 'I2C SCL'
    this.ext = new Map();       // pin -> level driven from outside (a button, a switch, another chip)
    this.onLineChange = null;   // (pin, prev, now) => void, used for attachInterrupt
    this.fell = new Map();      // pin -> time of last falling edge
    this.lastWrite = new Map(); // pin -> time of last write
    this.firstSeenOutputs = [];
    this.fallsBeforeFirstByte = new Map();
    this.spi = { begun: false, hz: 1_000_000, bitOrder: 1, mode: 0, inTx: false, pins: null };
    this.i2c = { begun: false, hz: 100_000, pins: null };
    this.swspi = { bits: 0, val: 0, bytes: 0 };
    this.swi2c = { active: false, bits: 0, val: 0, buf: [], bytes: 0 };
    this.sawFirstByte = false;
    this.rolesKnown = !this.auto;
    this.autoPending = null;
    this.busUsed = false;
    this.rstFellAt = null;
    this.csLow = new Set();     // panel indices whose CS is currently low
    this.bytesDelivered = 0;
    this.lastBurstKey = -1;
    this.frames = 0;
    this.frameTimes = [];       // virtual times (us) of recent frame boundaries
    this.burstPanel = -1;       // panel that has an open CS-low data burst
    this.burstHadData = false;
    this.onBurstEnd = null;     // (panelIdx) => void  (hook for the host / headless captures)
    this.unknownCmds = 0;
  }

  _ensurePanels(n) {
    while (this.panels.length < n) {
      const i = this.panels.length;
      this.panels.push(new SH1107({ seed: this.seed * 7919 + i * 104729, irefKOhm: this.irefKOhm,
        onUnknown: (m, b, level) => this._unknown(i, m, level) }));
    }
  }

  _unknown(i, msg, level = 'warn') {
    this.unknownCmds++;
    this.onLog(`panel ${i + 1}: ${msg}`);
    if (this.lint) this.lint.add(level, level === 'info' ? 'FOREIGN_CMD' : 'UNKNOWN_CMD',
      level === 'info' ? `Panel ${i + 1}: ${msg}` : `Panel ${i + 1}: ${msg} (ignored by the emulator).`, `UNKNOWN_${msg}`);
  }

  panelIndexOfCs(pin) { return this.pinMap.cs.indexOf(pin); }
  isCs(pin) { return this.pinMap.cs.includes(pin); }
  roleOf(pin) {
    const p = this.pinMap;
    if (pin === p.rst) return 'RST';
    if (pin === p.dc) return 'DC';
    if (this.isCs(pin)) return `CS${this.panelIndexOfCs(pin) + 1}`;
    return null;
  }

  // ------------------------------------------------------------- pins
  /** Level of the line as the rest of the circuit sees it. */
  _lineLevel(pin) {
    const owner = this.owner.get(pin);
    if (owner && owner !== 'gpio') return undefined;    // a peripheral owns it
    const m = this.mode.get(pin);
    if (owner === 'gpio' && m === MODE.OUTPUT) return this.latch.get(pin);
    if (this.ext.has(pin)) return this.ext.get(pin);    // something outside drives the input
    if (owner !== 'gpio') return undefined;
    if (m === MODE.INPUT_PULLUP) return 1;
    if (m === MODE.INPUT_PULLDOWN) return 0;
    if (m === MODE.INPUT && (pin === this.pinMap.sda || pin === this.pinMap.scl)) return 1;   // I2C pull-ups
    return undefined;
  }

  pinMode(pin, mode) {
    const wasOwner = this.owner.get(pin);
    if (wasOwner && wasOwner !== 'gpio') this._releaseClaim(pin);
    this.owner.set(pin, 'gpio');
    this.mode.set(pin, mode);
    const out = mode === MODE.OUTPUT;
    if (out && !this.firstSeenOutputs.includes(pin)) this.firstSeenOutputs.push(pin);
    if (this.lint) this.lint.checkPinUse(pin, out ? 'out' : 'in', out);
    this._updateLine(pin);
  }

  /** Internal level for routing (D/C, MOSI): undriven reads as high. */
  digitalRead(pin) {
    const v = this._lineLevel(pin);
    return v === undefined ? 1 : v;
  }

  /** What the sketch's digitalRead() returns. */
  readForSketch(pin) {
    const v = this._lineLevel(pin);
    if (v !== undefined) {
      if (this.lint && this.owner.get(pin) !== 'gpio')
        this.lint.add('warn', 'READ_NOT_GPIO', `digitalRead(${pin}) on a pin never set with pinMode(): the ESP32 core warns "IO ${pin} is not set as GPIO. digitalRead() may return an inconsistent value." Call pinMode(${pin}, INPUT...) first.`, `READ_NOT_GPIO_${pin}`);
      return v;
    }
    if (this.lint) {
      if (this.owner.get(pin) === 'gpio')
        this.lint.add('info', 'FLOATING_INPUT', `digitalRead(${pin}): GPIO${pin} is a plain INPUT with nothing connected in the simulator, so it floats (read as LOW here; random on real hardware). Use INPUT_PULLUP, or drive it from the Inputs panel.`, `FLOATING_${pin}`);
      else if (!this.owner.has(pin))
        this.lint.add('warn', 'READ_NOT_GPIO', `digitalRead(${pin}) on a pin never set with pinMode(): the ESP32 core warns "IO ${pin} is not set as GPIO" and the value is not reliable.`, `READ_NOT_GPIO_${pin}`);
    }
    return 0;
  }

  /** Drive (0/1) or release (null) a pin from outside the ESP32. */
  setExternal(pin, level) {
    if (level === null || level === undefined) this.ext.delete(pin); else this.ext.set(pin, level ? 1 : 0);
    this._updateLine(pin);
  }

  digitalWrite(pin, v) {
    v = v ? 1 : 0;
    const owner = this.owner.get(pin);
    if (owner !== 'gpio') {
      if (this.lint) this.lint.writeIgnored(pin, owner, this.roleOf(pin));
      return;                                           // ESP32 core 3.x: "IO n is not set as GPIO", nothing happens
    }
    this.latch.set(pin, v);
    this.lastWrite.set(pin, this.now());
    this._updateLine(pin);
  }

  /** Recompute a pin's line level and react to the edge, if any. */
  _updateLine(pin) {
    const t = this.now();
    const prev = this.level.has(pin) ? this.level.get(pin) : undefined;
    const v = this._lineLevel(pin);
    if (v !== undefined && v === 0 && !this.busUsed && !this.auto && this.isCs(pin)) this._firstBusUse();   // before it lands
    if (v === undefined) this.level.delete(pin); else this.level.set(pin, v);
    if (prev === v) return;
    if (this.onLineChange) this.onLineChange(pin, prev, v);
    if (prev !== 0 && v === 0) {
      this.fell.set(pin, t);
      if (!this.sawFirstByte) this.fallsBeforeFirstByte.set(pin, (this.fallsBeforeFirstByte.get(pin) || 0) + 1);
    }
    if (pin === this.pinMap.sda || pin === this.pinMap.scl) this._swI2cEdge(pin, prev, v);
    if (this.auto && !this.rolesKnown) {
      if (this.autoPending) this._autoEdge(pin, prev, v);
      if (pin === this.pinMap.sck && prev === 0 && v === 1) this._swSpiClock();
      return;                                           // roles are not known yet
    }
    if (pin === this.pinMap.rst) {
      if (v === 0) this._resFall(t);
      else if (prev === 0) this._resRise(t);
    } else if (this.isCs(pin)) {
      const i = this.panelIndexOfCs(pin);
      this.swspi.bits = 0; this.swspi.val = 0;          // CS edges frame software-SPI bytes
      if (v === 0) {
        this.csLow.add(i);
        if (this.lint) this.lint.csFell(i, [...this.csLow]);
        this.burstPanel = i; this.burstHadData = false;
      } else if (prev === 0) {
        this.csLow.delete(i);
        if (this.lint) this.lint.csRose(i);
        if (this.burstPanel === i && this.burstHadData && this.onBurstEnd) this.onBurstEnd(i);
        if (this.burstPanel === i) this.burstPanel = -1;
      }
    }
    if (pin === this.pinMap.sck && prev === 0 && v === 1) this._swSpiClock();
  }

  _resFall(t) {
    this.rstFellAt = t;
    if (this.lint) this.lint.rstFell(this.panels);
    for (const p of this.panels) p.reset();   // GDDRAM is intentionally NOT cleared
  }
  _resRise(t) {
    if (this.rstFellAt !== null) {
      if (this.lint) this.lint.rstRose(t - this.rstFellAt);
      this.rstFellAt = null;
    }
  }

  /** A peripheral takes a pin over (SPI.begin / Wire.begin). */
  _claim(pin, what) {
    if (pin == null || pin < 0) return;
    const before = this.owner.get(pin);
    if (this.lint) this.lint.pinClaimed(pin, what, this.roleOf(pin), before === 'gpio' && this.mode.get(pin) === MODE.OUTPUT);
    this.owner.set(pin, what);
    this._updateLine(pin);
  }
  _releaseClaim(pin) { this.owner.delete(pin); }

  // ------------------------------------------------------------- hardware SPI
  spiBegin(sck, miso, mosi, ss) {
    if (this.spi.begun) return;                         // core 3.x: begin() returns early once the bus is up
    if (sck < 0 && miso < 0 && mosi < 0 && ss < 0) {     // no arguments: VSPI defaults (pins_arduino.h)
      sck = ESP32_DEFAULTS.sck; miso = ESP32_DEFAULTS.miso; mosi = ESP32_DEFAULTS.mosi;
      if (this.lint) this.lint.spiDefaults();
    }
    this.spi.begun = true;
    this.spi.pins = { sck, miso, mosi };
    if (this.auto) { if (sck >= 0) this.pinMap.sck = sck; if (mosi >= 0) this.pinMap.mosi = mosi; }
    if (this.lint) {
      if (sck >= 0) this.lint.checkPinUse(sck, 'out', true);
      if (mosi >= 0) this.lint.checkPinUse(mosi, 'out', true);
      if (miso >= 0) this.lint.checkPinUse(miso, 'in', false);
    }
    this._claim(sck, 'SPI SCK'); this._claim(miso, 'SPI MISO'); this._claim(mosi, 'SPI MOSI');
  }
  spiEnd() {
    if (this.spi.pins) for (const p of Object.values(this.spi.pins)) if (p >= 0 && this.owner.get(p)?.startsWith('SPI')) this._releaseClaim(p);
    this.spi.begun = false; this.spi.pins = null;
  }
  spiBeginTx(hz, bitOrder, mode) {
    this.spi.hz = hz; this.spi.bitOrder = bitOrder; this.spi.mode = mode; this.spi.inTx = true;
    if (this.lint) this.lint.spiBeginTx(hz);
  }
  spiEndTx() { this.spi.inTx = false; if (this.lint) this.lint.spiEndTx(); }
  spiSetClock(hz) { this.spi.hz = hz; }

  /** Hardware SPI byte. */
  spiByte(b) {
    b &= 0xFF;
    if (this.lint && !this.spi.begun) this.lint.spiNotBegun();
    this._deliverSpi(this.spi.bitOrder === 0 ? reverseBits(b) : b);
  }

  /** Deliver one byte (as it appears on MOSI, MSB first) to every panel whose CS is low. */
  _deliverSpi(wire) {
    if (!this.sawFirstByte) this._firstByte();
    if (this.auto && !this.rolesKnown) { this._autoByte(wire); return; }
    const dcLevel = this.pinMap.dc == null ? 1 : this.digitalRead(this.pinMap.dc);
    if (this.csLow.size === 0) {
      if (this.lint) this.lint.byteWithNoCs();
      return;
    }
    for (const i of this.csLow) this._toPanel(i, wire, dcLevel === 0);
  }

  _toPanel(i, byte, isCommand) {
    if (this.rstFellAt !== null) return;                // RES held low: chip is in reset, ignores the bus
    const p = this.panels[i];
    if (!p) return;
    if (this.lint) this.lint.panelActivity(i);
    if (isCommand) {
      if (this.lint && !p.initialized) this.lint.firstCommand(i);
      p.command(byte);
      if (this.lint) this.lint.panelCommand(i, byte, p);
    } else {
      p.data(byte);
      this.burstHadData = true;
      this.burstPanel = i;
      this._trackFrame(i, p);
    }
    this.bytesDelivered++;
  }

  // ------------------------------------------------------------- software SPI (bit-banged)
  _swSpiClock() {
    if (this.auto && !this.sawFirstByte && this.firstSeenOutputs.length === 0) return;
    const d = this.digitalRead(this.pinMap.mosi);
    const s = this.swspi;
    s.val = ((s.val << 1) | (d ? 1 : 0)) & 0xFF;
    if (++s.bits === 8) {
      s.bits = 0; s.bytes++;
      if (s.bytes === 1 && this.lint) this.lint.add('info', 'SW_SPI', `Software (bit-banged) SPI detected on SCK GPIO${this.pinMap.sck} / MOSI GPIO${this.pinMap.mosi}. It works, but is much slower than hardware SPI.`);
      this._deliverSpi(s.val);
    }
  }

  // ------------------------------------------------------------- hardware I2C
  i2cBegin(sda, scl, hz) {
    if (sda < 0) sda = ESP32_DEFAULTS.sda;
    if (scl < 0) scl = ESP32_DEFAULTS.scl;
    if (this.i2c.begun && this.i2c.pins && this.i2c.pins.sda === sda && this.i2c.pins.scl === scl) { if (hz) this.i2cSetClock(hz); return; }
    this.i2c.begun = true;
    this.i2c.pins = { sda, scl };
    if (hz) this.i2cSetClock(hz);
    if (this.lint) { this.lint.checkPinUse(sda, 'out', true); this.lint.checkPinUse(scl, 'out', true); }
    this._claim(sda, 'I2C SDA'); this._claim(scl, 'I2C SCL');
  }
  i2cEnd() {
    if (this.i2c.pins) for (const p of Object.values(this.i2c.pins)) if (this.owner.get(p)?.startsWith('I2C')) this._releaseClaim(p);
    this.i2c.begun = false; this.i2c.pins = null;
  }
  i2cSetClock(hz) {
    this.i2c.hz = hz;
    if (this.lint) this.lint.i2cClock(hz);
  }

  /** One Wire transaction. Returns the Wire.endTransmission() code: 0 ok, 2 address NACK, 4 bus not started. */
  i2cWrite(addr7, bytes) {
    if (!this.i2c.begun) { if (this.lint) this.lint.add('error', 'I2C_NOT_BEGUN', 'Wire.endTransmission() before Wire.begin(): nothing is sent.'); return 4; }
    return this._i2cDeliver(addr7, bytes) ? 0 : 2;
  }

  /** Route an I2C write to the mapped SH1107: [control byte, data...] per the SH1107 I2C protocol. */
  _i2cDeliver(addr7, bytes) {
    const idx = this.i2cMap.get(addr7);
    if (idx === undefined) {
      // one warning for all unmapped addresses (an I2C scanner probes ~120 of them); the count shows how many writes
      if (this.lint) this.lint.add('warn', 'I2C_NACK', `I2C write to address ${hex2(addr7)} was not acknowledged: no panel is mapped to it. Expected for an I2C scanner; otherwise map it in pins.json, e.g. "i2c": {"${hex2(addr7)}": 1}.`, 'I2C_NACK');
      return false;
    }
    if (!this.sawFirstByte) this._firstByte();
    let i = 0;
    while (i < bytes.length) {
      const ctrl = bytes[i++];
      const isData = (ctrl & 0x40) !== 0;
      if ((ctrl & 0x80) === 0) {                         // Co = 0: everything that follows has the same D/C
        while (i < bytes.length) this._toPanel(idx, bytes[i++], !isData);
      } else if (i < bytes.length) {                     // Co = 1: one byte, then another control byte
        this._toPanel(idx, bytes[i++], !isData);
      }
    }
    if (this.onBurstEnd && this.burstHadData) { this.onBurstEnd(idx); this.burstHadData = false; }
    return true;
  }

  // ------------------------------------------------------------- software I2C (bit-banged)
  _swI2cEdge(pin, prev, v) {
    const sda = this.pinMap.sda, scl = this.pinMap.scl;
    if (this.owner.get(sda) !== 'gpio' || this.owner.get(scl) !== 'gpio') return;
    const s = this.swi2c;
    const sclHigh = this.level.get(scl) === 1;
    if (pin === sda && sclHigh && prev !== undefined && v !== undefined) {
      if (prev === 1 && v === 0) {                       // START (or repeated START)
        if (s.active && s.buf.length) this._swI2cFinish();
        s.active = true; s.bits = 0; s.val = 0; s.buf = [];
      } else if (prev === 0 && v === 1 && s.active) {    // STOP
        this._swI2cFinish();
        s.active = false;
      }
      return;
    }
    if (pin === scl && prev === 0 && v === 1 && s.active) {   // data valid on the rising clock edge
      const bit = this.level.get(sda) === 0 ? 0 : 1;
      if (s.bits < 8) { s.val = (s.val << 1) | bit; s.bits++; }
      else { s.buf.push(s.val & 0xFF); s.bits = 0; s.val = 0; }   // 9th clock = ACK slot
    }
  }
  _swI2cFinish() {
    const s = this.swi2c;
    if (!s.buf.length) return;
    const [addrRw, ...payload] = s.buf;
    s.buf = [];
    if (addrRw & 1) return;                              // read transaction: nothing to emulate
    if (++s.bytes === 1 && this.lint) this.lint.add('info', 'SW_I2C', `Software (bit-banged) I2C detected on SDA GPIO${this.pinMap.sda} / SCL GPIO${this.pinMap.scl}.`);
    this._i2cDeliver(addrRw >> 1, payload);
  }

  // ------------------------------------------------------------- bookkeeping
  _trackFrame(i, p) {
    const key = i * 16 + p.page;
    if (key < this.lastBurstKey) {
      this.frames++;
      this.frameTimes.push(this.now());
      if (this.frameTimes.length > 64) this.frameTimes.shift();
    }
    this.lastBurstKey = key;
  }

  /** Frames per virtual second over the last `windowUs`. */
  fps(windowUs = 1_000_000) {
    const now = this.now();
    const n = this.frameTimes.filter((t) => now - t <= windowUs).length;
    return n * 1_000_000 / windowUs;
  }

  _firstBusUse() {
    if (this.busUsed) return;
    this.busUsed = true;
    if (!this.lint) return;
    this.lint.firstBusUse(this.pinMap.cs.map((pin, index) => ({
      pin, index, driven: this.mode.get(pin) === MODE.OUTPUT || this.level.has(pin),
      level: this.level.get(pin), skipLevel: this.auto && this.level.get(pin) === 0 })));
  }

  _firstByte() {
    this.sawFirstByte = true;
    if (this.auto) this._autoBegin();
    else this._firstBusUse();
  }

  // ---- pins.json missing: work out CS / DC / RST from what the firmware does -------------------------------
  // RES = an output pulsed low before any SPI traffic. Of the outputs that are LOW when the first byte goes out,
  // one is a CS and one is D/C. D/C is the one that changes level while bytes keep flowing and the other stays low
  // (command -> data). If instead a candidate rises and drops again before the next byte, that one framed a
  // transaction: it is the CS. Bytes seen before the decision are buffered with the pin levels and replayed.
  _autoOutputs() {
    const sck = this.pinMap.sck, mosi = this.pinMap.mosi;
    const i2cPins = this.i2c.pins ? [this.i2c.pins.sda, this.i2c.pins.scl] : [];
    const outs = this.firstSeenOutputs.filter((p) => p !== sck && p !== mosi && !i2cPins.includes(p));
    const rst = outs.find((p) => (this.fallsBeforeFirstByte.get(p) || 0) > 0 && this.level.get(p) === 1) ?? null;
    return { outs, rst };
  }
  _autoBegin() {
    const { outs, rst } = this._autoOutputs();
    const cands = outs.filter((p) => p !== rst && this.level.get(p) === 0);
    if (cands.length < 2) { this._autoAssign(null); return; }
    this.autoPending = { cands, rst, buf: [], risen: null, risenDropped: false, otherFell: false, since: this.now() };
  }
  _autoEdge(pin, prev, v) {
    const P = this.autoPending;
    if (!P.cands.includes(pin)) {
      // another output selected (e.g. the next panel's CS) after a candidate rose: that candidate ended a transaction
      if (P.risen !== null && prev === 1 && v === 0 && pin !== P.rst && this.mode.get(pin) === MODE.OUTPUT) P.otherFell = true;
      return;
    }
    if (prev === 0 && v === 1) { P.risen = pin; P.risenDropped = false; P.otherFell = false; }
    else if (v === 0 && pin === P.risen) P.risenDropped = true;
  }
  _autoByte(wire) {
    const P = this.autoPending;
    if (P && P.risen !== null) {
      const others = P.cands.filter((c) => c !== P.risen);
      if (P.risenDropped || P.otherFell) {
        this._autoAssign(others[0]);                    // it framed a transaction: CS, so the other one is D/C
      } else if (this.level.get(P.risen) === 1 && others.some((o) => this.level.get(o) === 0)) {
        this._autoAssign(P.risen);                      // it switched while the transfer went on: D/C
      }
      if (this.rolesKnown) { this._deliverSpi(wire); return; }
    }
    if (!P) return;
    P.buf.push({ wire, levels: new Map(P.cands.map((c) => [c, this.level.get(c)])) });
    if (P.buf.length > 4096) this._autoAssign(null);     // never decided: fall back to the simple guess
  }

  /** pins.json missing: guess roles from what the sketch did before its first SPI byte. */
  _autoAssign(knownDc) {
    const sck = this.pinMap.sck, mosi = this.pinMap.mosi;
    const P = this.autoPending;
    const { outs, rst } = this._autoOutputs();
    // levels as they were at the first byte (the buffered bytes carry them)
    const lvl0 = (p) => (P && P.buf.length && P.buf[0].levels.has(p) ? P.buf[0].levels.get(p) : this.level.get(p));
    const low = outs.filter((p) => p !== rst && lvl0(p) === 0);
    let dc = null; const csSet = new Set();
    if (knownDc != null) { dc = knownDc; for (const p of low) if (p !== dc) csSet.add(p); }
    else if (low.length === 1) csSet.add(low[0]);
    else if (low.length >= 2) {
      // The most recently driven low pin is assumed to be CS, the other one D/C.
      const sorted = low.slice().sort((a, b) => (this.lastWrite.get(b) || 0) - (this.lastWrite.get(a) || 0));
      csSet.add(sorted[0]);
      dc = sorted[1];
    }
    for (const p of outs) {                             // idle-high outputs that are not RES/DC -> CS
      if (p === rst || p === dc) continue;
      if (this.level.get(p) === 1 || csSet.has(p)) csSet.add(p);
    }
    if (dc === null) {                                  // D/C unknown: first output that is not RES/CS
      dc = outs.find((p) => p !== rst && !csSet.has(p)) ?? null;
    }
    const cs = outs.filter((p) => csSet.has(p));
    this.pinMap = { ...this.pinMap, cs, dc, rst, sck, mosi, guessed: true };
    this.numPanels = Math.max(cs.length, this.numPanels);
    if (rst !== null && this.lint) this.lint.resetSeen = true;
    this._ensurePanels(this.numPanels);
    this.rolesKnown = true;
    this.autoPending = null;
    this._firstBusUse();
    // replay what was buffered while the roles were being worked out
    if (P) for (const e of P.buf) {
      const dcLevel = dc == null ? 1 : e.levels.get(dc);
      for (const p of cs) if (e.levels.get(p) === 0) this._toPanel(cs.indexOf(p), e.wire, dcLevel === 0);
    }
    for (const p of cs) if (this.level.get(p) === 0) this.csLow.add(cs.indexOf(p));
    if (this.lint) {
      this.lint.checkConfig(this.pinMap);
      this.lint.add('info', 'PINS_GUESSED',
        `No pins.json: pin roles were guessed from firmware behaviour (CS: ${cs.map((p, i) => `${i + 1}=GPIO${p}`).join(', ')}; DC: ${dc}; RST: ${rst}). Add a pins.json to make this explicit.`);
    }
  }

  /**
   * Auto pins still undecided (too little traffic to tell CS from D/C): commit to the simple guess.
   * Without `force` this only happens after 1 s of virtual time, so a UI snapshot taken in the middle of a
   * transaction never cuts the observation short.
   */
  settleAuto(force = false) {
    if (this.auto && !this.rolesKnown && this.autoPending && (force || this.now() - this.autoPending.since > 1e6)) this._autoAssign(null);
  }

  /** Serializable copy of everything the UI needs. */
  snapshot() {
    this.settleAuto();
    return {
      vt: this.now(),
      panels: this.panels.map((p) => ({ ram: p.ram.slice(), state: p.state() })),
      pins: this.pinMap,
      levels: Object.fromEntries([...this.level.entries()].map(([k, v]) => [k, v])),
      owners: Object.fromEntries([...this.owner.entries()].filter(([, o]) => o !== 'gpio')),
      csLow: [...this.csLow],
      fps: this.fps(),
      frames: this.frames,
    };
  }
}
