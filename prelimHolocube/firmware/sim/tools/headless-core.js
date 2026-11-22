// Headless simulation: run a compiled sketch for N virtual seconds and capture panel snapshots.
import fs from 'node:fs';
import { FirmwareHost, StopRun } from '../emulator/host.js';

/**
 * @param {object} o
 * @param {Uint8Array|Buffer} o.wasm
 * @param {object} o.pins
 * @param {number} [o.untilS]            stop after this many virtual seconds (default 60)
 * @param {Array<{name:string, atS:number}>} [o.shots]       capture at virtual times
 * @param {Array<{name?:string, re:RegExp, offsetMs:number}>} [o.serialShots]  capture after a serial line matches
 * @param {object} [o.config]            extra host config (layer pitch is a viewer concern, not needed here)
 */
export async function runHeadless({ wasm, pins, untilS = 60, shots = [], serialShots = [], config = {}, stopAfterShots = false, inputs = [] }) {
  const serial = [];     // {t (virtual us), line}
  const warnings = [];
  const captures = [];
  const pending = [];    // {name, targetVt, ready}
  for (const s of shots) pending.push({ name: s.name, targetVt: s.atS * 1e6 });
  let maxPanel = -1;
  let inDelay = false;
  let result = { reason: 'timeout' };

  const host = new FirmwareHost({
    config: { pins, ...config },
    inputs,              // scripted button presses, levels, voltages and Serial text (see emulator/inputs.js)
    callbacks: { onWarning: (w) => warnings.push(w), onSerial: () => {} },
  });

  const fire = (item) => {
    captures.push({ name: item.name, targetVt: item.targetVt, vt: host.vt, snap: host.bus.snapshot() });
    pending.splice(pending.indexOf(item), 1);
    if (stopAfterShots && !pending.length && !serialShots.length) throw new StopRun('all captures done');
  };
  host.hooks.onSerial = (line, vt) => {
    serial.push({ t: vt, line });
    serialShots.forEach((s, i) => {
      if (s.re.test(line)) pending.push({ name: (s.name || line).replace(/[^\w.-]+/g, '_'), targetVt: vt + s.offsetMs * 1000 });
    });
  };
  host.hooks.onBurstEnd = (i, vt) => {
    if (i > maxPanel) maxPanel = i;
    if (i === maxPanel) for (const it of pending.slice()) if (it.targetVt <= vt) fire(it);
  };
  host.hooks.onDelay = () => { inDelay = true; };
  host.hooks.afterAdvance = (vt) => {
    if (inDelay) {
      inDelay = false;
      for (const it of pending.slice()) if (it.targetVt <= vt) fire(it);
    }
    if (vt > untilS * 1e6) throw new StopRun('time limit');
  };

  try {
    await host.run(wasm);
    result = { reason: 'exit' };
  } catch (e) {
    const d = FirmwareHost.describeError(e);
    result = { reason: d.kind, message: d.message };
  }
  host.bus.settleAuto(true);
  return { result, serial, warnings, captures, vt: host.vt, host, snapshot: host.bus.snapshot() };
}
