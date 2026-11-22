import { parentPort, workerData } from 'node:worker_threads';
import { runHeadless } from './headless-core.js';

const r = await runHeadless({
  ...workerData,
  wasm: workerData.wasm,
  serialShots: workerData.serialShots.map((s) => ({ ...s, re: new RegExp(s.re) })),
});
parentPort.postMessage({
  result: r.result, serial: r.serial, warnings: r.warnings, vt: r.vt, snapshot: r.snapshot,
  captures: r.captures,
});
