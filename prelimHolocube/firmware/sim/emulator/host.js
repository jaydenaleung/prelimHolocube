// Runs a compiled firmware (.wasm) against the bus/panels with a virtual clock.
//
// Why no Asyncify: the firmware runs synchronously inside a Worker. Every time-consuming call
// (delay, SPI, busy-wait on millis) just advances the *virtual* clock; pacing against the wall clock
// (speed control, pause) is done by sleeping inside the host import with Atomics.wait. The page thread
// stays free to render. In headless mode pacing is off and the run is as fast as the CPU allows.
import { HolocubeBus } from './bus.js';
import { Linter } from './lint.js';
import { InputSchedule, drainInputs, toEvents, ADC_PINS, ISR_MODE_NAMES } from './inputs.js';
import { MODE } from './bus.js';

export class StopRun extends Error {
  constructor(reason = 'stopped') { super(reason); this.name = 'StopRun'; this.reason = reason; }
}
export class FirmwareExit extends Error {
  constructor(code) { super(`firmware called exit(${code})`); this.name = 'FirmwareExit'; this.code = code; }
}
export class WatchdogError extends Error {
  constructor(msg, kind = 'watchdog') { super(msg); this.name = 'WatchdogError'; this.kind = kind; }
}

export const DEFAULT_CONFIG = {
  spiMaxHz: 10_000_000,
  watchdogMs: 5000,        // virtual ms without delay()/yield()/SPI/loop() return -> task watchdog
  seed: 1,
  irefKOhm: 1000,
  // virtual cost model (microseconds) - tuned to ESP32 @ 240 MHz Arduino core ballpark
  pinOpUs: 0.4,
  spiCallOverheadUs: 3,    // per transfer()/writeBytes() call, on top of the bytes' wire time
  spiByteExtraUs: 0.0,
  timePollUs: 1,           // advance per millis()/micros() call (accelerates in long busy loops)
  cpuFactor: 40,           // virtual us charged per wall-clock us the WASM spends computing between host calls.
                           // ~40 is a ballpark for ESP32 @240 MHz vs. WASM on a desktop CPU. 0 = deterministic (tests).
  tickMs: 500,             // lint tick period
};

const decoder = new TextDecoder();

export class FirmwareHost {
  /**
   * @param {object} o
   * @param {object} o.config       merged DEFAULT_CONFIG + {pins, ...}
   * @param {object} [o.control]    {ctrl: Int32Array(SharedArrayBuffer)} paused/speed/stop - browser only
   * @param {object} [o.callbacks]  onSnapshot(snap), onSerial(vt,text), onWarning(w), onLog(msg)
   */
  constructor({ config, control = null, callbacks = {}, inputs = [] }) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this.cb = callbacks;
    this.ctrl = control && control.ctrl ? control.ctrl : null;  // [0]=paused [1]=speed*1000 [2]=stop
    this.inputCh = control && control.inputs ? new Int32Array(control.inputs) : null;   // live inputs from the page
    this.schedule = new InputSchedule(toEvents(inputs));                                 // scripted inputs
    this.analogMv = new Map();         // pin -> millivolts on that pin
    this.analogPins = new Set();       // pins the sketch has called analogRead() on
    this.rxQueue = [];                 // {t, b}: Serial bytes still on the wire
    this.rxBuf = [];                   // bytes received, waiting for Serial.read()
    this.rxCap = 256;                  // ESP32 HardwareSerial default RX buffer
    this.baud = 115200;
    this.isr = new Map();              // pin -> {fn, arg, hasArg, mode}
    this.pendingIsr = [];
    this.intEnabled = true;
    this.inIsr = false;
    this.isrCount = 0;
    this.table = null;
    this.vt = 0;                       // virtual time, microseconds
    this.lastFeed = 0;                 // virtual time of last watchdog feed
    this.pollRun = 0;
    this.lastHostExit = 0;             // performance.now() when control last returned to wasm
    this.pace = { w0: 0, v0: 0, on: !!this.ctrl, lastSnap: 0 };
    this.nextTick = this.cfg.tickMs * 1000;
    this.hooks = { afterAdvance: null, onBurstEnd: null, onDelay: null, onSerial: null, onLoop: null };
    this.serialPending = '';
    this.lineBuf = '';
    this.memory = null;
    this.exitCode = null;
    this.lint = new Linter({ now: () => this.vt, spiMaxHz: this.cfg.spiMaxHz,
      onWarning: (w) => this.cb.onWarning && this.cb.onWarning(w) });
    this.bus = new HolocubeBus({ pins: this.cfg.pins, now: () => this.vt, lint: this.lint,
      seed: this.cfg.seed, irefKOhm: this.cfg.irefKOhm, onLog: (m) => this.cb.onLog && this.cb.onLog(m) });
    this.bus.onBurstEnd = (i) => { if (this.hooks.onBurstEnd) this.hooks.onBurstEnd(i, this.vt); };
    this.bus.onLineChange = (pin, prev, v) => this._edge(pin, prev, v);
    this.rngState = 0x1234567;
  }

  // ------------------------------------------------------------- virtual clock
  advance(us, fed = false) {
    this.vt += us;
    this._pollInputs();
    if (fed) this.lastFeed = this.vt;
    else if (this.vt - this.lastFeed > this.cfg.watchdogMs * 1000)
      throw new WatchdogError(
        `Task watchdog: ${this.cfg.watchdogMs} ms of virtual time passed with no delay(), yield(), SPI traffic or loop() return. ` +
        `On a real ESP32 this would trigger a reset (or the firmware is hung in a busy loop).`);
    if (this.vt >= this.nextTick) {
      this.nextTick = this.vt + this.cfg.tickMs * 1000;
      this.lint.tick(this.bus.panels);
    }
    if (this.hooks.afterAdvance) this.hooks.afterAdvance(this.vt);
    if (this.pace.on) this._paceWait();
  }

  feed() { this.lastFeed = this.vt; }

  // ------------------------------------------------------------- inputs
  /** Apply every input that is due by now (scripted ones by timestamp, live ones from the page immediately). */
  _pollInputs() {
    if (this.inputCh) {
      const live = [];
      drainInputs(this.inputCh, this.vt, live);
      for (const e of live) this._applyInput(e);
    }
    if (this.schedule.events.length && this.schedule.events[0].t <= this.vt) {
      for (const e of this.schedule.takeDue(this.vt)) this._applyInput(e);
    }
    while (this.rxQueue.length && this.rxQueue[0].t <= this.vt) {
      const { b } = this.rxQueue.shift();
      if (this.rxBuf.length >= this.rxCap) {
        this.lint.add('warn', 'SERIAL_RX_OVERFLOW', `Serial RX buffer full (${this.rxCap} bytes): incoming bytes were dropped. Read Serial more often, or call Serial.setRxBufferSize() before begin().`);
      } else this.rxBuf.push(b);
    }
  }

  /** Next virtual time something external happens (so waits can stop exactly there). */
  _nextInputTime() {
    return Math.min(this.schedule.nextTime(), this.rxQueue.length ? this.rxQueue[0].t : Infinity);
  }

  _applyInput(e) {
    switch (e.kind) {
      case 'level': this.bus.setExternal(e.pin, e.level); break;
      case 'press': {
        const mode = this.bus.mode.get(e.pin);
        const pulled = mode === MODE.INPUT_PULLUP || mode === MODE.INPUT_PULLDOWN;
        const active = e.active === 'low' ? 0 : e.active === 'high' ? 1 : mode === MODE.INPUT_PULLUP ? 0 : 1;
        const idle = pulled ? null : 1 - active;      // released: the pull-up/-down (or the external resistor) wins
        const target = e.down ? active : idle;
        const other = e.down ? idle : active;
        if (e.bounce) {
          // contact bounce: a few ms of chatter before the contact settles (deterministic pattern)
          const chatter = [0, 180, 420, 900, 1500, 2300];
          chatter.forEach((dt, i) => {
            const lvl = i % 2 === 0 ? target : other;
            if (dt === 0) this.bus.setExternal(e.pin, lvl);
            else this.schedule.push({ t: this.vt + dt, kind: 'level', pin: e.pin, level: i === chatter.length - 1 ? target : lvl });
          });
        } else this.bus.setExternal(e.pin, target);
        break;
      }
      case 'analog': this.analogMv.set(e.pin, Math.max(0, e.mv)); break;
      case 'serial': {
        const byteUs = 10e6 / this.baud;              // start + 8 data + stop bits
        let t = Math.max(this.vt, this.rxQueue.length ? this.rxQueue[this.rxQueue.length - 1].t : 0);
        for (const b of e.bytes) { t += byteUs; this.rxQueue.push({ t, b }); }
        break;
      }
      default:
    }
  }

  // ------------------------------------------------------------- interrupts
  _edge(pin, prev, v) {
    const h = this.isr.get(pin);
    if (!h || prev === undefined || v === undefined) return;
    const m = h.mode;
    const rising = prev === 0 && v === 1, falling = prev === 1 && v === 0;
    const fire = (m === 1 && rising) || (m === 2 && falling) || (m === 3 && (rising || falling)) ||
      ((m === 4 || m === 0x0C) && falling) || ((m === 5 || m === 0x0D) && rising);
    if (fire) this.pendingIsr.push(pin);
  }

  /** Run pending interrupt handlers (between host calls: that is where the simulator can preempt the sketch). */
  _runIsrs() {
    if (!this.intEnabled || this.inIsr || !this.table) return;
    while (this.pendingIsr.length) {
      const pin = this.pendingIsr.shift();
      const h = this.isr.get(pin);
      if (!h) continue;
      this.inIsr = true;
      this.isrCount++;
      try {
        this.vt += 2;                                   // interrupt entry latency on the ESP32 (~2 us)
        const fn = this.table.get(h.fn);
        if (h.hasArg) fn(h.arg); else fn();
      } finally { this.inIsr = false; }
    }
  }

  /** Wait (busy, in virtual time) one step toward `deadline`, stopping exactly at the next input. */
  _waitStep(deadline) {
    if (this.vt >= deadline) return false;
    let step = deadline - this.vt;
    const ne = this._nextInputTime() - this.vt;
    if (ne > 0 && ne < step) step = ne;
    if (this.inputCh || this.pace.on) step = Math.min(step, 1000);   // live inputs: look at the page every 1 ms
    this.advance(Math.max(step, 0.5), true);
    this._runIsrs();
    return true;
  }

  /** Augmented snapshot for the UI: panels + pins + what the inputs panel needs. */
  snapshot() {
    const s = this.bus.snapshot();
    const modeName = { [MODE.INPUT]: 'INPUT', [MODE.INPUT_PULLUP]: 'INPUT_PULLUP', [MODE.INPUT_PULLDOWN]: 'INPUT_PULLDOWN' };
    const inputPins = {};
    for (const [p, m] of this.bus.mode) if (modeName[m] && this.bus.owner.get(p) === 'gpio') inputPins[p] = modeName[m];
    s.inputs = {
      pins: inputPins,
      isr: Object.fromEntries([...this.isr].map(([p, h]) => [p, ISR_MODE_NAMES[h.mode] || String(h.mode)])),
      analog: [...this.analogPins],
      analogMv: Object.fromEntries(this.analogMv),
      ext: Object.fromEntries(this.bus.ext),
      rx: this.rxBuf.length,
      isrCount: this.isrCount,
    };
    return s;
  }

  /** Account for compute time between host calls (optional CPU model). */
  _cpu() {
    if (this.cfg.cpuFactor > 0) {
      const now = performance.now();
      if (this.lastHostExit) {
        const dt = (now - this.lastHostExit) * 1000 * this.cfg.cpuFactor;
        if (dt > 0) { this.vt += dt; }
      }
    }
  }
  _resumeClock() { if (this.cfg.cpuFactor > 0) this.lastHostExit = performance.now(); }

  _speed() { return this.ctrl ? Math.max(0.05, Atomics.load(this.ctrl, 1) / 1000) : 1; }

  _anchor() { this.pace.w0 = performance.now(); this.pace.v0 = this.vt; }

  _paceWait() {
    const c = this.ctrl;
    const p = this.pace;
    if (!p.w0) { this._anchor(); }
    for (;;) {
      if (Atomics.load(c, 2) !== 0) throw new StopRun('stopped');
      const now = performance.now();
      if (Atomics.load(c, 0) !== 0) {            // paused
        this._maybeSnapshot(now, true);
        Atomics.wait(c, 2, 0, 30);
        this._anchor();
        continue;
      }
      const speed = this._speed();
      if (p.speed !== speed) { p.speed = speed; this._anchor(); }
      const virtMs = (this.vt - p.v0) / 1000;
      const wallMs = (now - p.w0) * speed;
      const ahead = virtMs - wallMs;
      this._maybeSnapshot(now, false);
      if (ahead <= 1.5) return;
      if (ahead > 250) { /* far behind pacing after a resume; re-anchor instead of racing */ }
      Atomics.wait(c, 2, 0, Math.min(15, ahead / speed));
    }
  }

  _maybeSnapshot(now, force) {
    if (!this.cb.onSnapshot) return;
    if (force || now - this.pace.lastSnap >= 16) {
      this.pace.lastSnap = now;
      this.flushSerial();
      this.cb.onSnapshot(this.snapshot());
    }
  }

  flushSerial() {
    if (this.serialPending) {
      const text = this.serialPending; this.serialPending = '';
      if (this.cb.onSerial) this.cb.onSerial(this.serialT, text);
    }
  }

  // ------------------------------------------------------------- serial
  _serialWrite(ptr, len) {
    const bytes = new Uint8Array(this.memory.buffer, ptr, len);
    const text = decoder.decode(bytes, { stream: true });
    this._emitText(text);
  }
  _emitText(text) {
    if (!text) return;
    if (!this.serialPending) this.serialT = this.vt;
    this.serialPending += text;
    this.lineBuf += text;
    let nl;
    while ((nl = this.lineBuf.indexOf('\n')) >= 0) {
      const line = this.lineBuf.slice(0, nl).replace(/\r$/, '');
      this.lineBuf = this.lineBuf.slice(nl + 1);
      if (this.hooks.onSerial) this.hooks.onSerial(line, this.vt);
    }
    if (this.serialPending.length > 512) this.flushSerial();
  }

  // ------------------------------------------------------------- imports
  makeImports(module) {
    const self = this;
    const mem = () => self.memory;
    const spiCost = (bytes) => bytes * 8 * 1e6 / Math.max(1, self.bus.spi.hz) + self.cfg.spiCallOverheadUs + bytes * self.cfg.spiByteExtraUs;
    const wrap = (fn, { poll = false } = {}) => (...a) => {
      self._cpu();
      if (!poll) self.pollRun = 0;
      const r = fn(...a);
      if (self.pendingIsr.length) self._runIsrs();
      self._resumeClock();
      return r;
    };
    const serialCost = (n) => n * 10e6 / self.baud;
    const env = {
      hc_pin_mode: wrap((pin, mode) => { self.bus.pinMode(pin, mode); self.advance(self.cfg.pinOpUs); }),
      hc_digital_write: wrap((pin, v) => { self.bus.digitalWrite(pin, v); self.advance(self.cfg.pinOpUs); }),
      // reading inputs is how a sketch waits for the outside world: it feeds the watchdog, and long polling loops
      // speed up like millis() loops do (capped at 20 us per read so button timing stays fine-grained)
      hc_digital_read: wrap((pin) => {
        self.feed();
        self.advance(Math.min(20, self._pollStep() * self.cfg.pinOpUs));
        return self.bus.readForSketch(pin);
      }, { poll: true }),
      hc_analog_read: wrap((pin) => { self.advance(20); return self.analogMv.get(pin) ?? 0; }),
      hc_analog_mv: wrap((pin) => {
        self.feed();
        self.advance(10);                               // one ADC conversion
        if (!ADC_PINS.has(pin)) {
          self.lint.add('warn', 'ANALOG_NOT_ADC', `analogRead(${pin}): GPIO${pin} has no ADC channel on the ESP32 ("Pin ${pin} is not ADC pin!"), it returns 0. ADC pins: 32-39 (ADC1) and 0, 2, 4, 12-15, 25-27 (ADC2).`, `NOT_ADC_${pin}`);
          return -1;
        }
        self.analogPins.add(pin);
        return Math.round(self.analogMv.get(pin) ?? 0);
      }),
      hc_attach_interrupt: wrap((pin, fn, arg, hasArg, mode) => {
        self.isr.set(pin, { fn: fn >>> 0, arg: arg >>> 0, hasArg: !!hasArg, mode });
        self.advance(5);
      }),
      hc_detach_interrupt: wrap((pin) => { self.isr.delete(pin); self.advance(2); }),
      hc_set_interrupts: wrap((on) => { self.intEnabled = !!on; self.advance(0.05); }),
      hc_pulse_in: wrap((pin, state, timeoutUs) => {
        // Arduino semantics: wait for a previous pulse to end, wait for the pulse to start, time it - all within timeout
        state = state ? 1 : 0;
        const deadline = self.vt + (timeoutUs >>> 0);
        const lvl = () => self.bus.readForSketch(pin);
        while (lvl() === state) if (!self._waitStep(deadline)) return 0;
        while (lvl() !== state) if (!self._waitStep(deadline)) return 0;
        const start = self.vt;
        while (lvl() === state) if (!self._waitStep(deadline)) return 0;
        return Math.round(self.vt - start) >>> 0;
      }),
      hc_serial_rx_size: wrap((port, size) => { if (port === 0 && size > 0) self.rxCap = size >>> 0; return size >>> 0; }),
      hc_serial_begin: wrap((port, baud) => { if (port === 0 && baud > 0) self.baud = baud >>> 0; self.advance(10); }),
      hc_serial_available: wrap((port) => { self.feed(); self.advance(self._pollStep() * 0.5); return port === 0 ? self.rxBuf.length : 0; }, { poll: true }),
      hc_serial_read: wrap((port, peek) => {
        self.feed();
        self.advance(0.5);
        if (port !== 0 || !self.rxBuf.length) return -1;
        return peek ? self.rxBuf[0] : self.rxBuf.shift();
      }),
      hc_serial_wait: wrap((port, timeoutMs) => {
        // Stream::timedRead: wait up to the timeout for a byte (virtual time; live input keeps arriving meanwhile)
        if (port !== 0) { self.advance((timeoutMs >>> 0) * 1000, true); return 0; }
        const deadline = self.vt + (timeoutMs >>> 0) * 1000;
        while (!self.rxBuf.length) if (!self._waitStep(deadline)) return 0;
        return 1;
      }),
      hc_delay_us: wrap((us) => {
        us = us >>> 0;
        if (self.inIsr) self.lint.add('error', 'DELAY_IN_ISR', 'delay() inside an interrupt handler: on the ESP32 this blocks the core and the interrupt watchdog resets the chip. Set a flag in the ISR and do the work in loop().');
        if (self.hooks.onDelay) self.hooks.onDelay(us, self.vt);
        // a delay() is a yield: the watchdog is fed for its whole duration. It is cut into slices at every
        // scripted input (so a button press lands at its exact time and its interrupt fires mid-delay), and
        // into 4 ms slices when paced against the wall clock, so the UI clock moves smoothly.
        let left = us;
        while (left > 0) {
          let d = left;
          if (self.pace.on) d = Math.min(d, 4000);
          const ne = self._nextInputTime() - self.vt;
          if (ne > 0 && ne < d) d = ne;
          self.advance(d, true);
          left -= d;
          if (self.pendingIsr.length) self._runIsrs();
        }
      }),
      hc_millis: wrap(() => { self.advance(self._pollStep()); return Math.floor(self.vt / 1000) >>> 0; }, { poll: true }),
      hc_micros: wrap(() => { self.advance(self._pollStep()); return Math.floor(self.vt) >>> 0; }, { poll: true }),
      hc_yield: wrap(() => { self.feed(); self.advance(1); }),
      hc_loop_boundary: wrap(() => { self.feed(); self.advance(1); if (self.hooks.onLoop) self.hooks.onLoop(self.vt); }),
      hc_spi_begin: wrap((sck, miso, mosi, ss) => { self.bus.spiBegin(sck, miso, mosi, ss); self.advance(5); }),
      hc_spi_end: wrap(() => { self.bus.spiEnd(); }),
      hc_spi_begin_tx: wrap((hz, order, mode) => { self.bus.spiBeginTx(hz >>> 0, order, mode); self.advance(1); }),
      hc_spi_end_tx: wrap(() => { self.bus.spiEndTx(); self.advance(1); }),
      hc_spi_set_clock: wrap((hz) => { self.bus.spiSetClock(hz >>> 0); }),
      hc_i2c_begin: wrap((sda, scl, hz) => { self.bus.i2cBegin(sda, scl, hz >>> 0); self.advance(20); }),
      hc_i2c_set_clock: wrap((hz) => { self.bus.i2cSetClock(hz >>> 0); }),
      hc_i2c_end: wrap(() => { self.bus.i2cEnd(); }),
      hc_i2c_write: wrap((addr, ptr, len, stop) => {
        len = len >>> 0;
        const bytes = new Uint8Array(mem().buffer, ptr, len).slice();
        // start + address + data, 9 clocks per byte (8 bits + ACK), plus a small driver overhead
        self.advance(15);
        const r = self.bus.i2cWrite(addr & 0x7F, bytes);
        self.feed();
        self.advance(((len + 1) * 9 + 2) * 1e6 / Math.max(1, self.bus.i2c.hz));
        void stop;
        return r;
      }),
      hc_spi_transfer: wrap((b) => { self.bus.spiByte(b); self.feed(); self.advance(spiCost(1)); return 0xFF; }),
      hc_spi_write: wrap((ptr, len) => {
        len = len >>> 0;
        const buf = new Uint8Array(mem().buffer, ptr, len);
        self.advance(self.cfg.spiCallOverheadUs);
        // deliver in chunks so the wire time of a long burst is spread over virtual time
        const CH = 32;
        const perByte = 8 * 1e6 / Math.max(1, self.bus.spi.hz) + self.cfg.spiByteExtraUs;
        for (let o = 0; o < len; o += CH) {
          const n = Math.min(CH, len - o);
          for (let k = 0; k < n; k++) self.bus.spiByte(buf[o + k]);
          self.feed();
          self.advance(n * perByte);
        }
      }),
      hc_serial_write: wrap((ptr, len) => {
        if (self.inIsr) self.lint.add('warn', 'SERIAL_IN_ISR', 'Serial output inside an interrupt handler: it takes locks and can block on the ESP32. Set a flag and print from loop().');
        self._serialWrite(ptr, len >>> 0);
        self.advance(1 + len * 0.2);
        void serialCost;
      }),
    };
    const wasiFns = this._wasi();
    const wasi = {};
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.module === 'wasi_snapshot_preview1') wasi[imp.name] = wasiFns[imp.name] || (() => 52 /* ENOSYS */);
    }
    return { env, wasi_snapshot_preview1: wasi };
  }

  _pollStep() {
    const n = ++this.pollRun;
    const base = this.cfg.timePollUs;
    return n < 256 ? base : n < 4096 ? base * 10 : base * 100;
  }

  _wasi() {
    const self = this;
    const dv = () => new DataView(self.memory.buffer);
    return {
      proc_exit(code) { throw new FirmwareExit(code); },
      fd_write(fd, iovs, iovsLen, nwrittenPtr) {
        const d = dv(); let total = 0; let text = '';
        for (let i = 0; i < iovsLen; i++) {
          const ptr = d.getUint32(iovs + i * 8, true), len = d.getUint32(iovs + i * 8 + 4, true);
          text += decoder.decode(new Uint8Array(self.memory.buffer, ptr, len), { stream: true });
          total += len;
        }
        if (fd === 1 || fd === 2) self._emitText(text);
        d.setUint32(nwrittenPtr, total, true);
        return 0;
      },
      fd_read(fd, iovs, iovsLen, nreadPtr) { dv().setUint32(nreadPtr, 0, true); return 0; },
      fd_close() { return 0; },
      fd_seek() { return 70; /* ESPIPE */ },
      fd_fdstat_get(fd, ptr) {
        const d = dv();
        d.setUint8(ptr, fd <= 2 ? 2 : 4); d.setUint16(ptr + 2, 0, true);
        d.setBigUint64(ptr + 8, 0x1FFFFFFFn, true); d.setBigUint64(ptr + 16, 0n, true);
        return 0;
      },
      fd_fdstat_set_flags() { return 0; },
      fd_prestat_get() { return 8; /* EBADF -> no preopened dirs */ },
      fd_prestat_dir_name() { return 8; },
      environ_sizes_get(cp, sp) { const d = dv(); d.setUint32(cp, 0, true); d.setUint32(sp, 0, true); return 0; },
      environ_get() { return 0; },
      args_sizes_get(cp, sp) { const d = dv(); d.setUint32(cp, 0, true); d.setUint32(sp, 0, true); return 0; },
      args_get() { return 0; },
      clock_res_get(id, ptr) { dv().setBigUint64(ptr, 1000n, true); return 0; },
      clock_time_get(id, prec, ptr) { dv().setBigUint64(ptr, BigInt(Math.floor(self.vt)) * 1000n, true); return 0; },
      sched_yield() { return 0; },
      random_get(ptr, len) {
        const u = new Uint8Array(self.memory.buffer, ptr, len);
        let s = self.rngState >>> 0;
        for (let i = 0; i < len; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; u[i] = s >>> 24; }
        self.rngState = s; return 0;
      },
      poll_oneoff() { return 52; },
    };
  }

  // ------------------------------------------------------------- run
  /** Instantiate and run until the firmware exits or a StopRun / error is thrown. */
  async run(wasmBytes) {
    const module = await WebAssembly.compile(wasmBytes);
    const imports = this.makeImports(module);
    const instance = await WebAssembly.instantiate(module, imports);
    this.memory = instance.exports.memory;
    this.table = instance.exports.__indirect_function_table || null;   // for calling attachInterrupt handlers
    this.feed();
    this._resumeClock();
    try {
      instance.exports._start();
    } finally {
      this.flushSerial();
      if (this.cb.onSnapshot) this.cb.onSnapshot(this.snapshot());
    }
  }

  /** Classify an exception into a user-facing runtime error record. */
  static describeError(e) {
    if (e instanceof StopRun) return { kind: 'stopped', message: e.reason };
    if (e instanceof FirmwareExit) return { kind: 'exit', message: `Firmware exited with code ${e.code}` };
    if (e instanceof WatchdogError) return { kind: e.kind, message: e.message };
    if (e instanceof WebAssembly.RuntimeError) {
      const m = /unreachable/.test(e.message) ? 'abort()/trap: unreachable executed (assert failed, or a C++ guard tripped)' : e.message;
      return { kind: 'crash', message: `Firmware crashed (WebAssembly trap): ${m}. On a real ESP32 this is a Guru Meditation / panic reset.` };
    }
    if (e instanceof RangeError && /stack/i.test(e.message)) return { kind: 'crash', message: 'Firmware stack overflow (stack size 256 KiB in the simulator; ESP32 loop task has 8 KiB).' };
    return { kind: 'crash', message: String(e && e.stack || e) };
  }
}
