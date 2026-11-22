// Page controller: editor <-> compile endpoint <-> firmware worker <-> 3D scene + side panels.
import { HoloScene } from '/viewer/scene.js';
import { Editor } from '/viewer/editor.js';
import { cyrb53, compileControls, BuildCache } from '/viewer/editorState.js';
import { GLASS_DEFAULTS, summary, buildStack } from '/viewer/glassModel.js';
import { makeInputChannel, sendInput, sendSerial, CMD, ADC_PINS } from '/emulator/inputs.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex = (v, w = 2) => '0x' + v.toString(16).toUpperCase().padStart(w, '0');
const fmtT = (us) => (us / 1e6).toFixed(3);

const S = {
  cfg: null, name: 'sketch.ino', original: '',
  runningHash: null, runningText: null, building: false, lastGood: null,
  worker: null, ctrl: null, paused: false, speed: 1, lastMsg: 0, ended: false,
  snap: null, sceneDirty: false, serialPartial: '', pins: null, selected: -1,
  buildCache: new BuildCache(), lastBuild: null, runtimeErrors: [], lintCount: 0,
};
window.__holo = S; // handy for debugging / automated checks

// ------------------------------------------------------------------ editor
const editor = new Editor($('editor'), { onChange: () => updateControls(), onRun: () => compileAndRun() });
editor.onFile = (name, text) => { S.name = name; $('sketchName').textContent = name; editor.value = text; editor.setMarks([]); updateControls(); };
S.editor = editor;

function updateControls() {
  const c = compileControls({ text: editor.value, runningHash: S.runningHash, building: S.building });
  $('compileBtn').hidden = !c.showButton;
  $('upToDate').hidden = !c.showUpToDate;
  $('compilingLabel').hidden = !c.building;
}

function setStatus(state, text) {
  const el = $('statusChip');
  el.dataset.state = state; el.textContent = text;
}

function banner(text, kind = '') {
  const b = $('banner');
  b.hidden = !text; b.textContent = text || ''; b.className = 'banner ' + kind;
}

// ------------------------------------------------------------------ errors panel
function renderMessages() {
  const list = $('errorList');
  const items = [];
  const b = S.lastBuild;
  if (b && !b.ok) {
    for (const e of b.errors) items.push({ kind: 'error', ...e });
  }
  for (const r of S.runtimeErrors) items.push({ kind: 'runtime', message: r.message, label: r.label, serial: r.serial });
  if (!items.length) list.innerHTML = '<div class="empty">No errors.</div>';
  else list.innerHTML = items.map((e, i) => {
    if (e.kind === 'runtime') {
      return `<button class="err-item runtime" data-i="${i}"><span class="loc">runtime (${esc(e.label)})</span>: ${esc(e.message)}` +
        (e.serial ? `<span class="note">Serial output up to that point:\n${esc(e.serial)}</span>` : '') + '</button>';
    }
    const loc = e.inSketch ? `${esc(e.file)}:${e.line}:${e.col}` : (e.file ? `${esc(e.file)}:${e.line}:${e.col}` : 'build');
    return `<button class="err-item" data-i="${i}" ${e.inSketch ? '' : 'data-nojump="1"'}><span class="loc">${loc}</span>: ${esc(e.message)}` +
      (e.notes || []).map((n) => `<span class="note">${n.file ? esc(n.file) + ':' + n.line + ': ' : ''}${esc(n.message)}</span>`).join('') + '</button>';
  }).join('');
  list.querySelectorAll('.err-item').forEach((el) => el.addEventListener('click', () => {
    const e = items[+el.dataset.i];
    if (e && e.kind === 'error' && e.inSketch) editor.gotoLine(e.line, e.col);
  }));
  const warns = b ? b.warnings : [];
  $('warnDetails').hidden = !warns.length;
  $('warnSummary').textContent = `Compiler warnings (${warns.length})`;
  $('warnList').innerHTML = warns.map((w, i) => `<button class="err-item warning" data-w="${i}"><span class="loc">${esc(w.file)}:${w.line}:${w.col}</span>: ${esc(w.message)}</button>`).join('');
  $('warnList').querySelectorAll('.err-item').forEach((el) => el.addEventListener('click', () => {
    const w = warns[+el.dataset.w]; if (w && w.inSketch) editor.gotoLine(w.line, w.col);
  }));
  const marks = [];
  if (b && !b.ok) for (const e of b.errors) if (e.inSketch) marks.push({ line: e.line, col: e.col, sev: 'error' });
  for (const w of warns) if (w.inSketch) marks.push({ line: w.line, col: w.col, sev: 'warning' });
  editor.setMarks(marks);
  $('errorsTitle').textContent = `Build & runtime messages${items.length ? ` (${items.length})` : ''}`;
}

// ------------------------------------------------------------------ compile
async function compileAndRun() {
  if (S.building) return;
  const text = editor.value;
  const c = compileControls({ text, runningHash: S.runningHash, building: false });
  if (!c.dirty) return;
  S.building = true; updateControls(); setStatus('compiling', 'Compiling…');
  const hash = cyrb53(text);
  let res = S.buildCache.get(text);
  if (!res) {
    try {
      const r = await fetch('/api/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: text, name: S.name }) });
      res = await r.json();
      if (!r.ok) throw new Error(res.error || r.statusText);
    } catch (e) {
      res = { ok: false, setup: false, errors: [{ file: '', line: 0, col: 0, message: `Could not reach the dev server: ${e.message}`, inSketch: false, notes: [] }], warnings: [] };
    }
    if (res.ok) S.buildCache.set(text, res);
  }
  S.building = false;
  S.lastBuild = res;
  if (res.setup) {
    banner(res.message, 'err');
    setStatus('failed', 'Compiler missing');
  } else if (res.ok) {
    banner('');
    S.runningHash = hash; S.runningText = text; S.lastGood = res;
    S.runtimeErrors = [];
    $('buildInfo').textContent = `built in ${res.cached ? 'cache (instant)' : res.ms + ' ms'}`;
    startRun(res.wasmUrl);
  } else {
    $('buildInfo').textContent = `build failed in ${res.ms ?? '?'} ms`;
    setStatus('failed', S.worker && !S.ended ? 'Build failed · previous build still running' : 'Build failed');
  }
  if (res.logUrl) { const a = $('rawLog'); a.href = res.logUrl; a.hidden = false; }
  renderMessages();
  updateControls();
}
$('compileBtn').addEventListener('click', compileAndRun);
window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); compileAndRun(); } });

// ------------------------------------------------------------------ firmware worker
function settings() {
  return {
    spiMaxHz: Math.max(1, +$('setSpiMax').value || 10) * 1e6,
    watchdogMs: Math.max(100, +$('setWdt').value || 5000),
    cpuFactor: Math.max(0, +$('setCpu').value || 0),
    irefKOhm: Math.max(100, +$('setIref').value || 1000),
    seed: Math.floor(+$('setSeed').value || 1),
  };
}

function stopRun() {
  if (S.worker) { S.worker.terminate(); S.worker = null; }
}

function startRun(wasmUrl) {
  if (!wasmUrl) wasmUrl = S.lastGood && S.lastGood.wasmUrl;
  if (!wasmUrl) return;
  stopRun();
  S.ended = false; S.runtimeErrors = S.runtimeErrors.filter((r) => false);
  S.lastWasm = wasmUrl;
  if (!window.crossOriginIsolated) banner('This page is not cross-origin isolated, so pause/speed control is unavailable. Open it through the simulator server (npm run sim).', 'err');
  S.ctrl = new Int32Array(new SharedArrayBuffer(16));
  S.inCh = makeInputChannel();
  replayInputs();                    // buttons held down / voltages set in the UI carry over into the new run
  S.ctrl[0] = S.paused ? 1 : 0; S.ctrl[1] = Math.round(S.speed * 1000); S.ctrl[2] = 0;
  const w = new Worker('/viewer/worker.js', { type: 'module' });
  S.worker = w; S.lastMsg = performance.now();
  S.lintList = []; renderLint();
  S.runSerialStart = S.serialLines.length + 1;   // lines belonging to this run (after the marker)
  addSerialSys(`— run started (${new Date().toLocaleTimeString()}) —`);
  w.onmessage = (e) => onWorker(e.data);
  w.onerror = (e) => runtimeError('crash', `Worker error: ${e.message}`);
  w.postMessage({ type: 'start', wasmUrl, ctrl: S.ctrl.buffer, inputs: S.inCh.buffer, config: { pins: S.pins, ...settings() } });
  setStatus(S.paused ? 'paused' : 'running', S.paused ? 'Paused' : 'Running');
  renderMessages();
}

function runtimeError(kind, message) {
  stopRun();
  S.ended = true;
  flushPartial();
  const tail = S.serialLines.slice(Math.max(S.runSerialStart || 0, S.serialLines.length - 12)).join('\n');
  S.runtimeErrors.push({ label: kind, message, serial: tail });
  setStatus('crashed', kind === 'hang' ? 'Stopped · firmware hung' : kind === 'watchdog' ? 'Stopped · watchdog' : 'Stopped · crashed');
  renderMessages();
}

function onWorker(m) {
  S.lastMsg = performance.now();
  switch (m.type) {
    case 'snapshot': S.snap = m.snap; S.sceneDirty = true; break;
    case 'serial': addSerial(m.t, m.text); break;
    case 'warning': S.lintList.push(m.w); renderLint(); break;
    case 'log': addSerialSys(m.msg); break;
    case 'ended': {
      stopRun(); S.ended = true; flushPartial();
      const r = m.result;
      if (r.kind === 'exit') {
        setStatus('idle', 'Firmware exited');
        S.runtimeErrors.push({ label: 'exit', message: r.message, serial: '' });
      } else if (r.kind !== 'stopped') {
        const tail = S.serialLines.slice(Math.max(S.runSerialStart || 0, S.serialLines.length - 12)).join('\n');
        S.runtimeErrors.push({ label: r.kind, message: r.message, serial: tail });
        setStatus('crashed', r.kind === 'watchdog' ? 'Stopped · watchdog' : 'Stopped · crashed');
      }
      renderMessages();
      break;
    }
    default:
  }
}

setInterval(() => {   // wall-clock hang detector: firmware stuck in a loop that never calls into the simulator
  if (S.worker && !S.ended && !S.paused && performance.now() - S.lastMsg > 4000)
    runtimeError('hang', 'Firmware stopped responding: it spent more than 4 s of wall-clock time in a loop that never calls delay(), SPI, millis() or returns from loop(). On a real ESP32 this would trip the watchdog.');
}, 500);

// ------------------------------------------------------------------ serial console
S.serialLines = [];
const serialEl = $('serial');
function appendLine(html, plain) {
  const atBottom = serialEl.scrollTop + serialEl.clientHeight >= serialEl.scrollHeight - 8;
  const d = document.createElement('div'); d.innerHTML = html; serialEl.appendChild(d);
  S.serialLines.push(plain);
  if (S.serialLines.length > 1500) { S.serialLines.shift(); serialEl.removeChild(serialEl.firstChild); }
  if (atBottom) serialEl.scrollTop = serialEl.scrollHeight;
}
function addSerial(t, text) {
  S.serialPartial += text;
  let nl;
  while ((nl = S.serialPartial.indexOf('\n')) >= 0) {
    const line = S.serialPartial.slice(0, nl).replace(/\r$/, '');
    S.serialPartial = S.serialPartial.slice(nl + 1);
    appendLine(`<span class="t">${fmtT(t)}</span>${esc(line)}`, `[${fmtT(t)}] ${line}`);
  }
}
function flushPartial() {
  if (S.serialPartial) { appendLine(esc(S.serialPartial), S.serialPartial); S.serialPartial = ''; }
}
function addSerialSys(text) { appendLine(`<span class="sys">${esc(text)}</span>`, text); }

// ------------------------------------------------------------------ serial input (what you type goes to Serial / UART0)
S.txHistory = []; let txPos = 0;
$('serialForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('serialIn').value, eol = { nl: '\n', cr: '\r', crlf: '\r\n' }[$('serialEol').value] || '';
  if (!text && !eol) return;
  if (!S.worker || S.ended) { addSerialSys('— not sent: the firmware is not running —'); return; }
  sendSerial(S.inCh, text + eol);
  const shown = (text + eol).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  appendLine(`<span class="tx">→ ${esc(shown)}</span>`, `→ ${shown}`);
  if (text) { S.txHistory.push(text); txPos = S.txHistory.length; }
  $('serialIn').value = '';
});
$('serialIn').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' || !S.txHistory.length) return;
  e.preventDefault();
  txPos = Math.max(0, Math.min(S.txHistory.length, txPos + (e.key === 'ArrowUp' ? -1 : 1)));
  $('serialIn').value = S.txHistory[txPos] ?? '';
});

// ------------------------------------------------------------------ inputs panel: buttons / switches / voltages
// Pins show up by themselves when the sketch configures them as inputs, attaches an interrupt or calls analogRead();
// any other GPIO can be added by hand. Held buttons and voltages are kept across restarts.
S.held = new Map();       // pin -> { bounce } for buttons latched down
S.analogSet = new Map();  // pin -> mV
S.manual = new Map();     // pin -> 'button' | 'analog'
S.lastModes = {};         // pin -> pin mode from the last snapshot (to replay presses with the right active level)
let inKey = '';

const activeFor = (pin) => {
  const m = S.lastModes[pin];
  return m === 'INPUT_PULLUP' ? 'low' : m === 'INPUT_PULLDOWN' ? 'high' : undefined;
};
function press(pin, down, bounce) {
  if (!S.inCh) return;
  // while running the firmware side knows the live pin mode best; replays use the remembered one
  sendInput(S.inCh, CMD.PRESS, pin, down ? 1 : 0, { bounce });
}
function replayInputs() {
  for (const [pin, h] of S.held) sendInput(S.inCh, CMD.PRESS, pin, 1, { bounce: false, active: activeFor(pin) });
  for (const [pin, mv] of S.analogSet) sendInput(S.inCh, CMD.ANALOG, pin, mv);
}

function inputLists(inp) {
  const dig = new Set([...Object.keys(inp.pins || {}), ...Object.keys(inp.isr || {})].map(Number));
  const ana = new Set((inp.analog || []).map(Number));
  for (const [p, k] of S.manual) (k === 'analog' ? ana : dig).add(p);
  for (const p of S.analogSet.keys()) ana.add(p);
  for (const p of S.held.keys()) dig.add(p);
  return { dig: [...dig].sort((a, b) => a - b), ana: [...ana].sort((a, b) => a - b) };
}

function buildInputs(dig, ana) {
  const el = $('inputs');
  if (!dig.length && !ana.length) {
    el.innerHTML = '<div class="empty">No inputs yet. Pins appear here when the sketch sets them to INPUT / INPUT_PULLUP, attaches an interrupt or calls analogRead(). Add any other GPIO below.</div>';
    return;
  }
  el.innerHTML = dig.map((p) => `<div class="inrow" data-pin="${p}" data-kind="d">
      <span class="pn">GPIO${p}<i class="lv"></i></span><span class="md"></span>
      <div class="act"><button type="button" class="ghost mini press" title="Hold to press (Space/Enter work too)">press</button>
        <label title="Keep the button pressed (a switch)"><input type="checkbox" class="latch"${S.held.has(p) ? ' checked' : ''}>hold</label>
        <label title="Contact bounce: ~2.3 ms of chatter on every press and release"><input type="checkbox" class="bounce">bounce</label></div></div>`).join('') +
    ana.map((p) => `<div class="inrow" data-pin="${p}" data-kind="a">
      <span class="pn">GPIO${p}</span><span class="md">${ADC_PINS.has(p) ? (p >= 32 ? 'ADC1' : 'ADC2') : 'no ADC on this pin'}</span>
      <div class="act"><input type="range" min="0" max="3300" step="10" value="${S.analogSet.get(p) ?? 0}" aria-label="Voltage on GPIO${p}">
        <b class="mv">${S.analogSet.get(p) ?? 0} mV</b></div></div>`).join('');
  el.querySelectorAll('.inrow[data-kind="d"]').forEach((row) => {
    const pin = +row.dataset.pin, btn = row.querySelector('.press'), latch = row.querySelector('.latch'), bounce = row.querySelector('.bounce');
    let down = false;
    const set = (d) => {
      if (d === down) return;
      down = d; btn.classList.toggle('down', d);
      if (!latch.checked) press(pin, d, bounce.checked);
    };
    btn.addEventListener('pointerdown', (e) => { btn.setPointerCapture(e.pointerId); set(true); });
    btn.addEventListener('pointerup', () => set(false));
    btn.addEventListener('pointercancel', () => set(false));
    btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); set(true); } });
    btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); set(false); } });
    btn.addEventListener('blur', () => set(false));
    latch.addEventListener('change', () => {
      if (latch.checked) S.held.set(pin, {}); else S.held.delete(pin);
      press(pin, latch.checked, bounce.checked);
    });
  });
  el.querySelectorAll('.inrow[data-kind="a"]').forEach((row) => {
    const pin = +row.dataset.pin, r = row.querySelector('input'), lbl = row.querySelector('.mv');
    r.addEventListener('input', () => {
      const mv = +r.value; S.analogSet.set(pin, mv); lbl.textContent = `${mv} mV`;
      if (S.inCh) sendInput(S.inCh, CMD.ANALOG, pin, mv);
    });
  });
}

function renderInputs(snap) {
  const inp = snap.inputs || {};
  Object.assign(S.lastModes, inp.pins || {});
  const { dig, ana } = inputLists(inp);
  const key = dig.join(',') + '|' + ana.join(',');
  if (key !== inKey) { inKey = key; buildInputs(dig, ana); }
  const lv = snap.levels || {};
  $('inputs').querySelectorAll('.inrow[data-kind="d"]').forEach((row) => {
    const p = row.dataset.pin;
    const parts = [inp.pins && inp.pins[p] ? inp.pins[p] : (S.lastModes[p] ? S.lastModes[p] : 'not an input yet')];
    if (inp.isr && inp.isr[p]) parts.push('ISR ' + inp.isr[p]);
    row.querySelector('.md').textContent = parts.join(' · ');
    row.querySelector('.lv').className = 'lv ' + (lv[p] === 1 ? 'hi' : lv[p] === 0 ? 'lo' : '');
  });
  $('isrCount').textContent = `${inp.isrCount || 0} ISR`;
}
$('inAddForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const pin = Math.floor(+$('inPin').value);
  if (!($('inPin').value !== '' && pin >= 0 && pin <= 39)) return;
  S.manual.set(pin, $('inKind').value);
  $('inPin').value = '';
  inKey = ''; if (S.snap) renderInputs(S.snap); else buildInputs(...Object.values(inputLists({})));
});
buildInputs([], []);
$('clearSerial').addEventListener('click', () => { serialEl.innerHTML = ''; S.serialLines = []; });

// ------------------------------------------------------------------ lint panel
function renderLint() {
  const l = S.lintList || [];
  $('warnCount').textContent = l.length;
  $('lint').innerHTML = l.length ? l.map((w) => `<div class="w ${w.level}"><span class="t">${fmtT(w.t)}s</span><span><span class="c">${esc(w.code)}</span> ${esc(w.message)}</span></div>`).join('')
    : '<div class="empty">No hardware warnings.</div>';
}

// ------------------------------------------------------------------ side panels
function renderCards(snap) {
  const el = $('cards');
  const pins = snap.pins;
  if (el.children.length !== snap.panels.length) {
    el.innerHTML = snap.panels.map((_, i) => `<div class="card" data-i="${i}"></div>`).join('');
    el.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => { S.selected = S.selected === +c.dataset.i ? -1 : +c.dataset.i; }));
  }
  snap.panels.forEach((p, i) => {
    const s = p.state, c = el.children[i];
    c.className = 'card' + (s.on ? ' on' : '') + (S.selected === i ? ' selected' : '');
    const cs = pins.cs[i];
    c.innerHTML = `<div class="h"><span><i class="dot"></i>${i + 1}</span><span class="cs">${cs != null ? 'CS GPIO' + cs : ''}</span></div>` +
      `<div class="row"><span>display</span><b>${s.on ? 'ON' : 'off'}${s.allOn ? ' · ALL' : ''}${s.inverse ? ' · inv' : ''}</b></div>` +
      `<div class="row"><span>contrast</span><b>${hex(s.contrast)}</b></div>` +
      `<div class="row"><span>DC-DC</span><b class="${s.dcdc === 0x8A ? '' : 'bad'}">${s.dcdc === 0x8A ? 'ext VPP' : 'internal'}</b></div>` +
      `<div class="row"><span>remap</span><b>${s.segRemap ? 'A1' : 'A0'} ${s.comReverse ? 'C8' : 'C0'}</b></div>` +
      `<div class="row"><span>RAM</span><b class="${s.ramWritten ? '' : 'bad'}">${s.ramWritten ? 'written' : 'garbage'}</b></div>`;
  });
}

function renderPins(snap) {
  const p = snap.pins, lv = snap.levels || {};
  const dot = (pin) => pin == null ? '' : `<i class="lv ${lv[pin] === 1 ? 'hi' : lv[pin] === 0 ? 'lo' : ''}"></i>`;
  let h = '';
  const owners = snap.owners || {};
  // a pin taken over by SPI/I2C no longer follows digitalWrite (ESP32 core 3.x): say so next to it
  const own = (pin) => (pin != null && owners[pin] ? ` <em class="own">→ ${esc(owners[pin])}</em>` : '');
  const row = (k, pin) => { h += `<span class="k">${k}</span><span>${pin == null ? '–' : 'GPIO' + pin}${dot(pin)}${own(pin)}</span>`; };
  row('SCK', p.sck); row('MOSI', p.mosi); row('DC', p.dc); row('RST', p.rst);
  p.cs.forEach((c, i) => row(`CS${i + 1}`, c));
  const usesI2c = Object.values(owners).some((o) => o.startsWith('I2C'));
  if (usesI2c || p.sda !== 21 || p.scl !== 22) { row('SDA', p.sda); row('SCL', p.scl); }
  if (p.i2c && Object.keys(p.i2c).length)
    h += `<span class="k">I2C</span><span>${Object.entries(p.i2c).map(([a, d]) => `${esc(a)} → display ${d}`).join(', ')}</span>`;
  if (p.guessed) h += '<span class="note">No pins.json: these roles were guessed from what the firmware did. Add a pins.json to pin them down.</span>';
  $('pinTable').innerHTML = h;
}

let lastUi = 0;
function uiTick(now) {
  if (S.snap && now - lastUi > 100) {
    lastUi = now;
    const snap = S.snap;
    $('vclock').textContent = fmtT(snap.vt);
    $('fps').textContent = snap.fps ? snap.fps.toFixed(1) + ' fps' : '–';
    renderCards(snap); renderPins(snap); renderInputs(snap);
    $('hud').textContent = `${snap.panels.filter((p) => p.state.on).length}/${snap.panels.length} panels on · pitch ${scene.layerPitch} mm`;
  }
  if (S.sceneDirty && S.snap) { scene.update(S.snap); S.sceneDirty = false; }
  requestAnimationFrame(uiTick);
}

// ------------------------------------------------------------------ 3D toolbar
const scene = new HoloScene($('gl'), { layerPitch: 2.5 });
S.scene = scene;
const chips = $('layerChips');
for (let k = 0; k < 8; k++) {
  const l = document.createElement('label');
  l.title = `Show/hide display ${k + 1}${k === 7 ? " (spare, not driven)" : ""}`;
  l.innerHTML = `<input type="checkbox" checked data-k="${k}"><span>${k + 1}</span>`;
  chips.appendChild(l);
}
chips.addEventListener('change', (e) => scene.setLayerVisible(+e.target.dataset.k, e.target.checked));
const viewBtns = { front: $('viewFront'), orbit: $('viewOrbit') };
function setView(k) { scene.setView(k); Object.entries(viewBtns).forEach(([n, b]) => b.classList.toggle('on', n === k)); }
viewBtns.front.addEventListener('click', () => setView('front'));
viewBtns.orbit.addEventListener('click', () => setView('orbit'));
$('orthoChk').addEventListener('change', (e) => scene.setOrtho(e.target.checked));
$('outlineChk').addEventListener('change', (e) => scene.setOutlines(e.target.checked));
$('axesChk').addEventListener('change', (e) => scene.setWorldAxes(e.target.checked));
$('gizmoChk').addEventListener('change', (e) => scene.setGizmo(e.target.checked));
$('gain').addEventListener('input', (e) => scene.setGain(+e.target.value));
$('setPitch').addEventListener('input', (e) => { const v = +e.target.value; if (v > 0) { scene.setLayerPitch(v); renderGlass(); } });


// ------------------------------------------------------------------ glass stack: mode swap, side, parameters
S.glassParams = { ...GLASS_DEFAULTS };
function readGlassInputs() {
  const pct = (id) => Math.min(1, Math.max(0.01, (+$(id).value || 0) / 100));
  const num = (id, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(+$(id).value) && $(id).value !== '' ? +$(id).value : d));
  S.glassParams = {
    ...S.glassParams,
    screenT: pct('gScreenT'), acrylicT: pct('gAcrT'), glassT: pct('gGlassT'),
    screenThk: num('gScreenThk', 0.2, 2.4, 1.0), glassThk: num('gGlassThk', 0.2, 5, 1.5),
    roomBrightness: num('gRoom', 0, 1, 0.3), roomLight: num('gAmb', 0, 1, 0.4),
  };
}
const pctStr = (v) => (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%';
function renderGlass() {
  const side = scene.viewSide;
  const angle = Math.min(80, Math.max(0, +$('gAngle').value || 0));
  const sm = summary(S.glassParams, scene.layerPitch, side, angle);
  const order = side > 0 ? sm.rows : sm.rows.slice().reverse();      // nearest-to-viewer first
  const best = Math.max(...sm.rows.map((r) => r.onAxis));
  let h = `<tr><th>Display</th><th>head-on</th><th>${angle}° off</th></tr>`;
  for (const r of order) {
    const lit = r.screen < 7;
    h += `<tr class="${lit ? '' : 'dim'}"><td>${r.screen + 1}${lit ? '' : ' (unlit)'}</td>` +
      `<td><span class="bar" style="width:${Math.round((r.onAxis / best) * 54)}px"></span>${pctStr(r.onAxis)}</td><td>${pctStr(r.offAxis)}</td></tr>`;
  }
  h += `<tr class="bg"><td>room behind</td><td>${pctStr(sm.background)}</td><td>${pctStr(sm.backgroundOff)}</td></tr>`;
  $('gtable').innerHTML = h;
  const d7 = sm.rows[6].onAxis, d1 = sm.rows[0].onAxis;
  const near = side > 0 ? sm.rows[0] : sm.rows[6], far = side > 0 ? sm.rows[6] : sm.rows[0];
  $('gnote').textContent =
    `Share of each display's light that reaches you. From the display-${side > 0 ? 1 : 7} side, display ${far.screen + 1} ` +
    `arrives at ${Math.round((far.onAxis / near.onAxis) * 100)}% of display ${near.screen + 1}; the room behind is dimmed to ${pctStr(sm.background)}. ` +
    `Layers look ${(sm.rows[3].depth / sm.rows[3].apparent).toFixed(2)}× closer together than they are (refraction).`;
  void d1; void d7;
  // stack diagram, nearest-to-viewer on the left
  const slabs = buildStack(S.glassParams, scene.layerPitch).slabs;
  const seq = side > 0 ? slabs : slabs.slice().reverse();
  $('gstackDiagram').innerHTML = seq.map((s) => {
    const cls = s.kind === 'glass' ? 'g' : s.kind === 'acrylic' ? 'a' : (s.screen < 7 ? 's lit' : 's');
    const name = s.kind === 'screen' ? `screen ${s.screen + 1}${s.screen === 7 ? ' (unlit)' : ''}` : s.kind === 'acrylic' ? 'acrylic' : 'cover glass';
    return `<i class="${cls}" style="flex:${s.t.toFixed(2)}" title="${name} · ${s.t.toFixed(2)} mm · ${pctStr(s.T)} transparent"></i>`;
  }).join('');
}
function applyGlass() { readGlassInputs(); scene.setGlassParams(S.glassParams); renderGlass(); }
for (const id of ['gScreenT', 'gAcrT', 'gGlassT', 'gScreenThk', 'gGlassThk', 'gRoom', 'gAmb', 'gAngle']) $(id).addEventListener('input', applyGlass);

function setMode(mode) {
  scene.setMode(mode);
  const glass = mode === 'glass';
  $('modeBtn').setAttribute('aria-pressed', String(glass));
  $('modeLbl').textContent = glass ? 'Glass stack' : 'Light points only';
  $('outlineChk').disabled = glass;
  S.mode = mode;
}
$('modeBtn').addEventListener('click', () => setMode(scene.mode === 'glass' ? 'points' : 'glass'));
function setSide(side) {
  scene.setViewSide(side);
  $('sideFront').classList.toggle('on', side > 0);
  $('sideBack').classList.toggle('on', side < 0);
  renderGlass();
}
$('sideFront').addEventListener('click', () => setSide(1));
$('sideBack').addEventListener('click', () => setSide(-1));
renderGlass();

// ------------------------------------------------------------------ run controls
$('pauseBtn').addEventListener('click', () => {
  S.paused = !S.paused;
  if (S.ctrl) S.ctrl[0] = S.paused ? 1 : 0;
  $('pauseBtn').textContent = S.paused ? 'Resume' : 'Pause';
  if (S.worker && !S.ended) setStatus(S.paused ? 'paused' : 'running', S.paused ? 'Paused' : 'Running');
  S.lastMsg = performance.now();
});
$('restartBtn').addEventListener('click', () => { S.runtimeErrors = []; renderMessages(); startRun(); });
$('speed').addEventListener('input', (e) => {
  S.speed = Math.pow(10, +e.target.value);
  $('speedLbl').textContent = (S.speed < 1 ? S.speed.toFixed(2) : S.speed.toFixed(1)) + '×';
  if (S.ctrl) S.ctrl[1] = Math.round(S.speed * 1000);
});
for (const id of ['setSpiMax', 'setWdt', 'setCpu', 'setIref', 'setSeed']) $(id).addEventListener('change', () => startRun());

$('pinsApply').addEventListener('click', async () => {
  const msg = $('pinsMsg');
  try {
    const r = await fetch('/api/pins', { method: 'PUT', body: $('pinsText').value });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    S.pins = j.pins; msg.textContent = S.cfg.pinsEditable ? 'saved to pins.json' : 'applied (in memory)';
    startRun();
  } catch (e) { msg.textContent = String(e.message || e); }
});

// ------------------------------------------------------------------ file actions
$('openBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  editor.onFile(f.name, await f.text()); e.target.value = '';
});
$('resetBtn').addEventListener('click', async () => {
  S.name = S.cfg.sketchName; $('sketchName').textContent = S.name;
  editor.value = S.original; updateControls();
  if (cyrb53(S.original) !== S.runningHash) compileAndRun();
});
$('downloadBtn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([editor.value], { type: 'text/plain' }));
  a.download = S.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ------------------------------------------------------------------ boot
(async function boot() {
  const cfg = await (await fetch('/api/config')).json();
  S.cfg = cfg; S.name = cfg.sketchName; S.original = cfg.source; S.pins = cfg.pins;
  $('sketchName').textContent = cfg.sketchName;
  editor.value = cfg.source;
  $('pinsText').value = JSON.stringify(cfg.pins.auto ? { auto: true } : cfg.pins, null, 2);
  $('setPitch').value = cfg.layerPitch; scene.setLayerPitch(cfg.layerPitch);
  if (cfg.installHelp) banner(cfg.installHelp, 'err');
  setView('front');
  requestAnimationFrame(uiTick);
  updateControls();
  if (cfg.pins.auto) {
    // auto mode is not editable as JSON; show hint
    $('pinsText').value = '// pins.json not used: roles guessed from firmware behaviour.\n{ "cs": [13, 27, 26, 25, 33, 32, 16], "dc": 21, "rst": 19, "sck": 18, "mosi": 23 }';
  }
  await compileAndRun();
})();
