import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ino2cpp, findFunctions } from '../tools/ino2cpp.js';
import { cyrb53, compileControls, BuildCache } from '../viewer/editorState.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = fs.readFileSync(path.join(ROOT, 'examples', 'seven_panel_volume_demo.ino'), 'utf8');

test('prototypes are generated for functions used before they are defined', () => {
  const src = `void setup() { helper(3); }\nvoid loop() { }\nint helper(int x) { return x + 1; }\n`;
  const { cpp, protoCount } = ino2cpp(src, 'a.ino');
  assert.equal(protoCount, 3);
  assert.match(cpp, /int helper\(int x\);/);
  assert.ok(cpp.indexOf('int helper(int x);') < cpp.indexOf('void setup() {'));
  assert.ok(cpp.startsWith('#include <Arduino.h>\n#line 1 "a.ino"\n'));
});

test('#line directives keep diagnostics on the original line numbers', () => {
  const src = `// c\n\nint a = 1;\nvoid setup() {}\nvoid loop() {}\n`;
  const { cpp } = ino2cpp(src, 'a.ino');
  const lines = cpp.split('\n');
  const at = lines.findIndex((l) => l.startsWith('void setup() {}'));
  // find the closest preceding #line and compute the reported line of 'void setup'
  let ln = null;
  for (let i = at - 1; i >= 0; i--) { const m = /^#line (\d+) /.exec(lines[i]); if (m) { ln = +m[1] + (at - i - 1); break; } }
  assert.equal(ln, 4);
});

test('typedefs / function pointers / structs survive and precede the prototypes that use them', () => {
  const { cpp } = ino2cpp(DEMO, 'demo.ino');
  const typedef = cpp.indexOf('typedef void (*SceneFn)();');
  const proto = cpp.indexOf('void show_static(const char *name, SceneFn draw, uint32_t ms);');
  assert.ok(typedef > 0 && proto > typedef);
  assert.match(cpp, /struct Glyph \{ char c; uint8_t col\[5\]; \};/);
});

test('every global function of the real demo gets exactly one prototype', () => {
  const funcs = findFunctions(DEMO).map((f) => f.name);
  for (const n of ['setup', 'loop', 'show_static', 'run_anim', 'send_cmds', 'send_frame', 'push_all', 'plot', 'line3', 'demo_pulse', 'init_panels', 'rnd', 'tri'])
    assert.ok(funcs.includes(n), `missing ${n}`);
  assert.equal(new Set(funcs).size, funcs.length);
  assert.equal(funcs.length, 42);
});

test('functions already declared, templates, struct bodies and initializers are not prototyped', () => {
  const src = `void declared();\nstruct P { int f() { return 1; } };\nconst int t[] = { 1, 2 };\ntemplate <typename T> T id(T v) { return v; }\nvoid declared() {}\nvoid setup() {}\nvoid loop() {}\n`;
  const names = findFunctions(src).map((f) => f.name);
  assert.deepEqual(names.sort(), ['loop', 'setup']);
});

test('braces/keywords inside comments and strings do not confuse the scanner', () => {
  const src = `// void fake() {\nconst char* s = "}{ void nope() {";\n/* int x() { */\nvoid setup() { }\nvoid loop() { }\n`;
  assert.deepEqual(findFunctions(src).map((f) => f.name), ['setup', 'loop']);
});

test('compile button logic: hidden when the box matches the running build', () => {
  const text = 'void setup(){}\nvoid loop(){}\n';
  const h = cyrb53(text);
  let c = compileControls({ text, runningHash: h, building: false });
  assert.deepEqual([c.showButton, c.showUpToDate], [false, true]);
  c = compileControls({ text: text + ' ', runningHash: h, building: false });
  assert.deepEqual([c.showButton, c.showUpToDate], [true, false]);
  c = compileControls({ text: text + ' ', runningHash: h, building: true });
  assert.deepEqual([c.showButton, c.showUpToDate, c.building], [false, false, true]);
  c = compileControls({ text, runningHash: h, building: false });
  assert.equal(c.showButton, false, 'reverting the edit hides the button again');
});

test('client build cache is keyed by source hash', () => {
  const cache = new BuildCache();
  cache.set('abc', { ok: true, hash: 'x' });
  assert.equal(cache.get('abc').hash, 'x');
  assert.equal(cache.get('abd'), undefined);
});
