// Inputs to the firmware: buttons / levels on GPIOs, voltages on ADC pins, bytes arriving on Serial.
//
// Two sources feed the same queue, both in virtual time:
//   * a schedule (headless runs and tests): events with exact virtual timestamps
//   * the page (live): a SharedArrayBuffer command ring the UI writes and the firmware worker drains whenever the
//     firmware calls into the simulator; those events happen "now" in virtual time
//
// Event shapes (t in microseconds of virtual time):
//   { t, kind: 'level',  pin, level }            level 0/1, or null = stop driving (pull resistor decides)
//   { t, kind: 'press',  pin, down, bounce, active }   a push button; active = 'low' | 'high' | undefined (from pin mode)
//   { t, kind: 'analog', pin, mv }               voltage on an ADC pin
//   { t, kind: 'serial', bytes }                 bytes arriving on Serial (UART0), paced at the baud rate

export const CMD = { LEVEL: 1, PRESS: 2, ANALOG: 3, SERIAL: 4 };
export const CMD_CAP = 4096;
const FLAG_BOUNCE = 1, FLAG_ACTIVE_LOW = 2, FLAG_ACTIVE_HIGH = 4;

// ---------------------------------------------------------------- shared command ring (page -> worker)
export function makeInputChannel() {
  return new Int32Array(new SharedArrayBuffer(4 * (2 + 4 * CMD_CAP)));   // [written, read, entries...]
}

/** Page side. Returns false if the ring is full (the worker is paused or far behind). */
export function sendInput(ch, type, pin = 0, value = 0, { bounce = false, active } = {}) {
  const w = Atomics.load(ch, 0), r = Atomics.load(ch, 1);
  if (w - r >= CMD_CAP) return false;
  const o = 2 + 4 * (w % CMD_CAP);
  ch[o] = type; ch[o + 1] = pin; ch[o + 2] = value;
  ch[o + 3] = (bounce ? FLAG_BOUNCE : 0) | (active === 'low' ? FLAG_ACTIVE_LOW : active === 'high' ? FLAG_ACTIVE_HIGH : 0);
  Atomics.store(ch, 0, w + 1);
  return true;
}

/** Page side: a whole string for Serial (one command per byte, UTF-8). */
export function sendSerial(ch, text) {
  for (const b of new TextEncoder().encode(text)) if (!sendInput(ch, CMD.SERIAL, 0, b)) return false;
  return true;
}

/** Worker side: drain the ring into events stamped with virtual time `t`. */
export function drainInputs(ch, t, out) {
  let r = Atomics.load(ch, 1);
  const w = Atomics.load(ch, 0);
  if (r === w) return;
  let serial = null;
  while (r < w) {
    const o = 2 + 4 * (r % CMD_CAP);
    const type = ch[o], pin = ch[o + 1], value = ch[o + 2], flags = ch[o + 3];
    r++;
    if (type === CMD.SERIAL) { (serial || (serial = [])).push(value & 0xFF); continue; }
    if (serial) { out.push({ t, kind: 'serial', bytes: serial }); serial = null; }
    const active = flags & FLAG_ACTIVE_LOW ? 'low' : flags & FLAG_ACTIVE_HIGH ? 'high' : undefined;
    if (type === CMD.LEVEL) out.push({ t, kind: 'level', pin, level: value < 0 ? null : value ? 1 : 0 });
    else if (type === CMD.PRESS) out.push({ t, kind: 'press', pin, down: value !== 0, bounce: !!(flags & FLAG_BOUNCE), active });
    else if (type === CMD.ANALOG) out.push({ t, kind: 'analog', pin, mv: value });
  }
  if (serial) out.push({ t, kind: 'serial', bytes: serial });
  Atomics.store(ch, 1, r);
}

// ---------------------------------------------------------------- schedule (headless / tests)
export class InputSchedule {
  constructor(events = []) { this.events = []; for (const e of events) this.push(e); }
  push(e) {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].t > e.t) i--;
    this.events.splice(i, 0, e);
  }
  nextTime() { return this.events.length ? this.events[0].t : Infinity; }
  takeDue(vt) {
    let n = 0;
    while (n < this.events.length && this.events[n].t <= vt) n++;
    return n ? this.events.splice(0, n) : null;
  }
}

/**
 * Normalise friendly input descriptions (seconds) into events (microseconds).
 *   { t: 1.5, press: 0, dur: 0.2, bounce: true }     press GPIO0 at 1.5 s for 200 ms
 *   { t: 2,   level: 4, value: 1 }                    drive GPIO4 high (value null = release)
 *   { t: 0.5, analog: 34, mv: 1650 }                  1.65 V on GPIO34
 *   { t: 3,   serial: "hello\n" }                      text on Serial
 */
export function toEvents(list) {
  const out = [];
  const us = (s) => Math.round(Number(s) * 1e6);
  for (const e of list) {
    if (e.kind) { out.push(e); continue; }            // already an event
    if (e.press !== undefined) {
      const dur = e.dur ?? 0.1;
      out.push({ t: us(e.t), kind: 'press', pin: e.press, down: true, bounce: !!e.bounce, active: e.active });
      if (dur > 0) out.push({ t: us(e.t + dur), kind: 'press', pin: e.press, down: false, bounce: !!e.bounce, active: e.active });
    } else if (e.level !== undefined) out.push({ t: us(e.t), kind: 'level', pin: e.level, level: e.value === null || e.value === 'z' ? null : e.value ? 1 : 0 });
    else if (e.analog !== undefined) out.push({ t: us(e.t), kind: 'analog', pin: e.analog, mv: Number(e.mv) });
    else if (e.serial !== undefined) out.push({ t: us(e.t), kind: 'serial', bytes: [...new TextEncoder().encode(String(e.serial))] });
    else throw new Error(`unknown input ${JSON.stringify(e)}`);
  }
  return out;
}

/**
 * Command-line spec (headless --input):
 *   press:0@1.5[+0.2][!bounce]   level:4=1@2   level:4=z@3   analog:34=1650@0.5   serial:hello\n@3
 */
export function parseInputSpec(spec) {
  const at = spec.lastIndexOf('@');
  if (at < 0) throw new Error(`input "${spec}": missing @time`);
  const head = spec.slice(0, at), tail = spec.slice(at + 1);
  const [kind, rest] = [head.slice(0, head.indexOf(':')), head.slice(head.indexOf(':') + 1)];
  const bounce = /!bounce$/.test(tail);
  const timePart = tail.replace(/!bounce$/, '');
  const [tStr, durStr] = timePart.split('+');
  const t = Number(tStr);
  if (!Number.isFinite(t)) throw new Error(`input "${spec}": bad time`);
  if (kind === 'press') return { t, press: Number(rest), dur: durStr !== undefined ? Number(durStr) : 0.1, bounce };
  if (kind === 'level') { const [p, v] = rest.split('='); return { t, level: Number(p), value: v === 'z' ? null : Number(v) }; }
  if (kind === 'analog') { const [p, v] = rest.split('='); return { t, analog: Number(p), mv: Number(v) }; }
  if (kind === 'serial') return { t, serial: rest.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t') };
  throw new Error(`input "${spec}": unknown kind "${kind}" (press, level, analog, serial)`);
}

// ESP32 pins that have an ADC channel (ADC1: 32-39, ADC2: 0, 2, 4, 12-15, 25-27)
export const ADC_PINS = new Set([0, 2, 4, 12, 13, 14, 15, 25, 26, 27, 32, 33, 34, 35, 36, 37, 38, 39]);
export const ISR_MODE_NAMES = { 1: 'RISING', 2: 'FALLING', 3: 'CHANGE', 4: 'ONLOW', 5: 'ONHIGH', 0x0C: 'ONLOW_WE', 0x0D: 'ONHIGH_WE' };
