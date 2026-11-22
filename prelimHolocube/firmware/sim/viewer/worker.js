// Firmware worker: runs the compiled sketch against the emulator, paced by the control buffer.
import { FirmwareHost } from '/emulator/host.js';

let host = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type !== 'start') return;
  try {
    const bytes = await (await fetch(m.wasmUrl)).arrayBuffer();
    host = new FirmwareHost({
      config: m.config,
      control: { ctrl: new Int32Array(m.ctrl), inputs: m.inputs },
      callbacks: {
        onSnapshot: (snap) => self.postMessage({ type: 'snapshot', snap }),
        onSerial: (t, text) => self.postMessage({ type: 'serial', t, text }),
        onWarning: (w) => self.postMessage({ type: 'warning', w }),
        onLog: (msg) => self.postMessage({ type: 'log', msg }),
      },
    });
    self.postMessage({ type: 'started' });
    let result;
    try {
      await host.run(bytes);
      result = { kind: 'exit', message: 'Firmware returned from main()' };
    } catch (err) {
      result = FirmwareHost.describeError(err);
    }
    self.postMessage({ type: 'ended', result, vt: host.vt });
  } catch (err) {
    self.postMessage({ type: 'ended', result: { kind: 'crash', message: String(err && err.stack || err) }, vt: 0 });
  }
};
