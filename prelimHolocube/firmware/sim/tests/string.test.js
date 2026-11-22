// Arduino String in the shim: outputs must match the ESP32 Arduino core 3.x (values derived from its WString and
// stdlib_noniso code: dtostrf rounding and padding, itoa sign handling, substring / lastIndexOf / remove rules).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HAVE_ZIG, FIX, ROOT, runSketch, layerBitmaps, countLit } from './helpers.js';
import { compileSketch } from '../tools/compiler.js';
import { findU8g2 } from '../tools/libraries.js';
import { runHeadless } from '../tools/headless-core.js';

const skip = HAVE_ZIG ? false : 'zig not installed';

const EXPECTED = {
  int: '42', neg_hex: '-7b', hex: 'ff', bin: '101', ulong: '4294967295', llong: '-9000000000', uchar: '200', char: 'x',
  f_default: '3.14', f_4: '3.1416', f_neg: '-0.50', f_round: '2.00',
  f_0dp: ' 3',            // ESP32 quirk: dtostrf width = decimals + 2, so 0 decimals pads the integer part to 2 chars
  f_nan: 'nan', f_ninf: 'inf',
  chain: 'A1c22.50', plus_eq: 'v=7,1.50', concat_null: '0',
  idx_o: '4', idx_o_5: '7', last_o: '7', last_o_5: '4', idx_World: '6', last_l: '9', idx_z: '-1',
  sub_6: 'World', sub_8_3: 'lo Wo', sub_20: '',
  lt: '1', eq_ic: '1', starts: '1', starts_off: '1', ends: '1', eq_cstr: '1',
  charAt: 'e', setCharAt: 'Jello World', oob_read: '0', toCharArray: 'Jello',
  replace_str: 'a+=b+=c', replace_chr: 'x+=b+=c', remove_n: '012789', remove_end: '01278',
  trim: '[hi there]', upper: 'MIXED', lower: 'mixed',
  toInt: '-42', toFloat: '3.25',
  empty_true: '1', empty_len: '0', isEmpty: '1', reserve: '1',
  flash: 'ok',
};

test('Arduino String: every API result matches the ESP32 core', { skip }, async () => {
  const run = await runSketch(FIX('string_test.ino'), { untilS: 2 });
  const lines = run.serial.map((s) => s.line);
  assert.ok(lines.includes('END'), 'the sketch ran to the end');
  const got = {};
  for (const l of lines) { const i = l.indexOf('='); if (i > 0) got[l.slice(0, i)] = l.slice(i + 1); }
  for (const [k, v] of Object.entries(EXPECTED)) assert.equal(got[k], v, `${k}`);
  assert.equal(run.result.reason, 'stopped', run.result.message);
});

test('String works with u8g2 (drawStr(s.c_str()), print(String)) and with Serial', { skip: skip || (!findU8g2() && 'U8g2 not installed') }, async () => {
  const src = `#include <U8g2lib.h>
#include <SPI.h>
U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI u8g2(U8G2_R0, 13, 21, 19);
void setup() {
  Serial.begin(115200);
  SPI.begin(18, -1, 23, -1);
  u8g2.begin();
  String label = "T=" + String(21.5, 1) + "C";
  u8g2.setFont(u8g2_font_6x10_tr);
  u8g2.drawStr(0, 20, label.c_str());
  u8g2.setCursor(0, 40);
  u8g2.print(label);
  u8g2.sendBuffer();
  Serial.println("label=" + label + " width=" + String(u8g2.getStrWidth(label.c_str())));
  delay(300);
}
void loop() { delay(1000); }
`;
  const b = await compileSketch(src, { name: 'string_u8g2.ino', sketchDir: path.join(ROOT, 'build'), onProgress: () => {} });
  assert.equal(b.ok, true, b.errors && b.errors.map((e) => `${e.line}: ${e.message}`).join('\n'));
  const run = await runHeadless({ wasm: fs.readFileSync(b.wasmPath), pins: { cs: [13], dc: 21, rst: 19, sck: 18, mosi: 23 },
    untilS: 2, config: { cpuFactor: 0 } });
  // width from u8g2 itself: 7 glyphs of the 6x10 font, minus the empty column after the last one
  assert.ok(run.serial.some((s) => s.line === 'label=T=21.5C width=41'), run.serial.map((s) => s.line).join(' | '));
  assert.ok(countLit(layerBitmaps(run.snapshot)[0]) > 50, 'both lines of text are on the panel');
});
