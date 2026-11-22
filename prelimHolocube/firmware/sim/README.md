# Holocube firmware simulator

Run an **unmodified Arduino `.ino`** for the 3D stacked transparent OLED ("Holocube v3") and see the result as a
3D space of glowing dots in the browser, before flashing the ESP32.

```
7 x Surenoo SOG128128A_P112 (SH1107G, 128x128, 4-wire SPI, write-only) behind one ESP32 DevKit V1
```

The sketch is compiled against a small Arduino shim to WebAssembly and runs against a pin/SPI/SH1107 emulator on a
**virtual clock** (`delay()` costs no wall time, SPI transfers cost `bytes*8/SPI_HZ`, so the fps the sketch prints
is close to what the hardware would print).

## Quick start

Requirements: Node.js >= 20 and **Zig** (a single ~75 MB download that compiles C++ to WebAssembly).

```bash
npm install                      # three.js for the viewer
npm run sim -- examples/seven_panel_volume_demo.ino
```

then open the printed URL (default <http://127.0.0.1:5173/>). Options:

```
npm run sim -- path/to/sketch.ino [--pins pins.json|auto] [--layer-pitch 2.5] [--port 5173] [--open]
```

Zig is looked up in this order: `ZIG` env var, `PATH`, `~/zig/zig-*/`, `C:\zig`, `/opt/zig`. If it is missing the
page and the CLI print the exact install steps. (Install: download from <https://ziglang.org/download/>, unzip, add
to PATH or set `ZIG`. Tested with Zig 0.13.0.)

### Headless (PNG dumps, CI)

```bash
node tools/headless.js examples/seven_panel_volume_demo.ino --until 165 --out out \
     --on-serial "^(Scene|Demo):=4000" --views layers,front,oblique
```

* `--shots name=sec,...` capture at virtual times, `--on-serial "<regex>=<offset ms>"` capture N ms after a Serial line.
  Captures wait for a coherent moment (a delay, or the end of a panel burst) so you do not get half-drawn frames.
* `layers` = exact contact sheet of the 7 GDDRAMs, `front` = perspective view along -z like a person sees it,
  `oblique` = orthographic view that shows the depth.
* `--cpu-factor 0` makes runs bit-for-bit deterministic (used by the tests). `--wall-timeout` kills a firmware that
  never returns control.
* `--input <spec>` (repeatable) scripts buttons, levels, voltages and Serial text in virtual time, see [Inputs](#inputs).

## Pins: `pins.json`

```json
{ "cs": [13, 27, 26, 25, 33, 32, 16], "dc": 21, "rst": 19, "sck": 18, "mosi": 23 }
```

`cs` is in board order 1..7 (display 1 = layer 0 ... display 7 = layer 6). Lookup order: `--pins <file>`, `pins.json`
next to the sketch, then the one in this folder. Edit it in the page ("Pins -> Edit pins.json") or on disk; **no
recompile**, just restart the run. `--pins auto` (or no file at all) guesses roles from the firmware's behaviour:
RES = the pin pulsed low before the first SPI byte, CS = idle-high outputs plus the pin that fell last, D/C = the other
low pin, CS numbering in first-seen order. It recovers the demo's map exactly, but it is a heuristic and the UI says so.

Optional I2C fields (for `_HW_I2C` / `_SW_I2C` constructors and plain `Wire`):

```json
{ "cs": [...], "dc": 4, "rst": 19, "sda": 21, "scl": 22, "i2c": { "0x3C": 1 } }
```

`i2c` maps a 7-bit address to a display number (default `{"0x3C": 1}`); writes to any other address are NACKed, as
on real hardware. `sda`/`scl` default to the ESP32's 21/22 and are also the pins software I2C is decoded from. Software
SPI is decoded from `sck`/`mosi`. A sketch wired differently from the 7-panel stack (a single-panel test, an I2C test)
should get its own `pins.json` next to it, or `--pins auto`.

`--pins auto` works out CS and D/C by watching the traffic rather than by order: D/C is the pin that changes level while
bytes keep flowing and the other stays low; a pin that rises and falls between bytes (or while another output gets
selected) is a CS. Bytes seen before the decision are buffered and replayed. This gets both the raw-SPI demo
(D/C low, then CS low) and u8g2 (CS low, then D/C) right.

## The page

* **Firmware editor** (left): C++ highlighting, line numbers, drag-and-drop or *Open .ino*, *Reset to original*,
  *Download .ino*. The page tracks a hash of the compiled text: when the box matches the running build you see a quiet
  **Up to date**; the moment it changes a **Compile and run** button appears (also Ctrl/Cmd+Enter).
  Builds are cached by source hash (client and server), so reverting an edit re-runs instantly.
* **Build errors** are parsed into `file:line:col: message` (clang, `#line` directives keep your `.ino` line numbers),
  click one to jump there, offending tokens get a wavy underline, compiler **warnings are listed separately**. If a
  build fails the last good build keeps running. *raw compiler log* links to the full log.
* **Runtime errors** (crash/trap, `exit()`, hang, watchdog) go into the same panel together with the Serial output of
  that run up to the failure.
* **3D view** (centre): front view / orbit view, perspective <-> orthographic, per-layer toggles, glass outlines, axes
  gizmo (and optional origin axes), glow slider. One 128x128 texture per layer, drawn by a dot shader with additive
  blending (it cross-fades to a mip-averaged brightness when dots get smaller than ~2 screen px, so zooming out does not
  alias).
* **Side panels**: virtual clock + measured display refresh rate, pause / speed (0.1x-20x) / restart, per-panel state
  cards (on/off, contrast, DC-DC mode, remap flags, RAM written or garbage), the **Inputs** panel (buttons, switches,
  voltages, see [Inputs](#inputs)), pin map with live levels, run settings, Serial console with virtual timestamps and a
  send box under it, and the hardware **Warnings** list with virtual timestamps.

Geometry: x = column, y up (row 0 on top), z toward display 7, origin = centre of display 4, pixel pitch 20.14/128 =
0.1573 mm, layer pitch 2.5 mm (changeable live in *Run settings*, affects only the viewer, not the sketch's own
`LAYER_PITCH_MM`). The front camera sits on the display-1 side by default (see *Glass view*: text drawn with the
default mapping reads mirrored from there; the *display 7 side* button shows it the right way round).

## u8g2 sketches

Sketches that `#include <U8g2lib.h>`, `<U8x8lib.h>` or `<MUIU8g2.h>` are linked against the **real U8g2 library**, the
copy the Arduino IDE installed (`Documents/Arduino/libraries/U8g2`, or `U8G2_PATH`, or `firmware/sim/vendor/U8g2`). It is
compiled from source against the shim once (about 11 s for its 129 files incl. all fonts), cached by library version
and shim, and the linker drops every font and display driver the sketch does not use. Nothing in u8g2 is re-implemented:
what it draws, the fonts and the exact SH1107 command stream it sends are the library's own.

* **Drawing:** pixel, line, h/v line, frame, box, rounded frame/box, circle and disc (incl. quadrant options), ellipse
  and filled ellipse, triangle, arc, XBM / XBMP / drawBitmap (incl. transparent bitmap mode), draw colour 0/1/2 (XOR),
  clip window, buttons (`drawButtonUTF8`), `setDisplayRotation` (R0-R3, mirror), flip mode, contrast, power save,
  `sendF`, `updateDisplayArea`.
* **Text:** every u8g2 font, `drawStr` / `drawUTF8` / `drawGlyph`, font direction and mode, `print()` through Arduino's
  `Print`, `U8G2LOG` terminals with `drawLog`, and U8x8 tile text (normal, inverse, 2x2).
* **Buffers and buses:** full-buffer (`_F_`) and page-buffer (`_1_`, `_2_`, `firstPage`/`nextPage`) constructors over
  hardware SPI, software SPI, hardware I2C (`Wire`) and software I2C. Bit-banged buses are decoded from the pin edges.
* **Example:** `examples/u8g2_showcase/` puts one family of drawing functions on each display (primitives, round shapes,
  triangles/arcs/bitmaps, fonts, draw modes, rotation, terminal) and then animates a ball, a propeller and a wave
  through the stack. Its setup is the clean power-up order for this board: `SPI.begin(18, -1, 23, -1)` first,
  `beginSimple()`, `0xAD 0x8A`, contrast, blank RAM, then `setPowerSave(0)` and 100 ms.

The tests prove it end to end: each u8g2 test sketch prints u8g2's **own framebuffer**, and the test checks that the
emulated panel shows exactly that, bit for bit (`setFlipMode(0)`: rotated 180 deg), for HW SPI, page mode, HW I2C, SW SPI,
SW I2C and all 7 showcase pages, with and without `pins.json`.

**ESP32 core rules that matter with u8g2** (taken from the installed esp32 core 3.3.3 sources and emulated):
`SPI.begin()` without pins (which is what u8g2 calls if the bus is not running yet) attaches SCK 18, **MISO 19**,
MOSI 23; after that `digitalWrite(19, ...)` is ignored ("IO 19 is not set as GPIO") until `pinMode(19, OUTPUT)` again.
With RST on GPIO19, u8g2's reset pulse never reaches the panels; the lint reports it as `PIN_CLAIMED` / `WRITE_IGNORED`.
Only the first `SPI.begin()` counts, so starting the bus yourself with explicit pins avoids it. `digitalWrite` before
`pinMode` is ignored too. u8g2's SH1107 init sends `0xDA 0x12`, an SSD1306 command the SH1107 does not know; the
emulator ignores it like the chip and notes it as info. u8g2 starts the SH1107 at contrast 0x2F and never selects
external VPP (that is your `sendF("ca", 0xAD, 0x8A)`).

u8g2's menus (`userInterfaceSelectionList`, `userInterfaceMessage`, ...) work with the [Inputs](#inputs): pass the
button pins to `u8g2.begin(select, next, prev, up, down, home)` and they show up in the Inputs panel as pull-up buttons.

**Not emulated:** display controllers other than the SH1107 (their constructors compile and run, but their commands are
interpreted as SH1107 commands, with `UNKNOWN_CMD` warnings).

## Inputs

Buttons, switches, potentiometers and Serial input, in the page and in scripted (headless / test) runs.
`examples/inputs_demo/inputs_demo.ino` uses all of them: `npm run sim -- examples/inputs_demo/inputs_demo.ino`.

**In the page.** The *Inputs* panel lists every pin the sketch set to `INPUT` / `INPUT_PULLUP` / `INPUT_PULLDOWN`,
attached an interrupt to, or called `analogRead()` on, with its mode, interrupt mode and live level. Add any other GPIO
by hand (button or analog). Buttons have **press** (hold the mouse or Space/Enter), **hold** (latches it: a switch) and
**bounce** (about 2.3 ms of contact chatter on every press and release, so you can test your debouncing). Analog pins get
a 0-3300 mV slider. Held buttons and slider values carry over when the run restarts. Under the Serial console, a send
box with the usual line-ending choice (newline by default; arrow keys recall earlier lines) writes to `Serial`.

**What a press does.** A button connects the pin to its *active* level: low for `INPUT_PULLUP`, high otherwise (wired to
3.3 V with a pull-down). Released, the pin floats back to its pull resistor. `level` inputs drive a pin to 0 or 1 or
release it (`z`). Reading a floating `INPUT` pin warns (`FLOATING_INPUT`) and reads 0.

**Emulated API** (ESP32 core 3.x behaviour):

* `digitalRead`. Polling loops such as `while (digitalRead(BTN));` advance virtual time and feed the watchdog.
* `attachInterrupt`, `attachInterruptArg`, `detachInterrupt`, `digitalPinToInterrupt`, with modes `RISING`, `FALLING`,
  `CHANGE`, `ONLOW`, `ONHIGH` (`_WE` too), plus `interrupts()` / `noInterrupts()`. Handlers run with about 2 us of latency
  at the next point where the simulator gets control: any `delay`, `millis`, `digitalRead`, SPI or Serial call. A
  pending interrupt is held while interrupts are off and runs once when they come back on. `delay()` or Serial output
  inside a handler are linted (`DELAY_IN_ISR`, `SERIAL_IN_ISR`).
* `analogRead`, `analogReadMilliVolts`, `analogReadResolution`, `analogSetWidth`, `analogSetAttenuation`,
  `analogSetPinAttenuation`. The ADC is modelled as linear: 0 V up to the full scale of the attenuation reads 0-4095
  (11 dB: 3.1 V, 6 dB: 2.2 V, 2.5 dB: 1.5 V, 0 dB: 1.1 V), then shifted to the chosen resolution. The real ADC bends
  near both ends, so `analogRead` values are only close to the real ones. A pin without ADC returns 0 and warns
  (`ANALOG_NOT_ADC`).
* `pulseIn` / `pulseInLong` time real pulses on the pin in virtual microseconds and return 0 on timeout.
* `Serial` (UART0) receives what you send, paced at the `Serial.begin()` baud rate, with the full `Stream` API:
  `available`, `read`, `peek`, `readString`, `readStringUntil`, `readBytes`, `readBytesUntil`, `parseInt`, `parseFloat`
  (with `SKIP_ALL` / `SKIP_NONE` / `SKIP_WHITESPACE` and the ignore character), `find`, `findUntil` and `setTimeout`
  (default 1000 ms). Blocking reads wait in virtual time. The RX buffer holds 256 bytes (`Serial.setRxBufferSize()` changes it);
  overflow is linted (`SERIAL_RX_OVERFLOW`). `Serial1` / `Serial2` only transmit.

**Scripted inputs.** Headless runs take `--input` (repeatable, times in virtual seconds):

```bash
node tools/headless.js examples/inputs_demo/inputs_demo.ino --until 3 \
     --input "press:0@0.5+0.2" --input "press:0@1.0+0.1!bounce" --input "level:4=1@1.2" --input "level:4=z@2" \
     --input "analog:34=1650@0" --input "serial:text hello\n@1.5"
```

`press:<pin>@<t>[+<duration, default 0.1>][!bounce]`, `level:<pin>=0|1|z@<t>`, `analog:<pin>=<mV>@<t>`,
`serial:<text>@<t>` (`\n`, `\r`, `\t` escapes). From code, `runHeadless({ ..., inputs: [{ t: 0.5, press: 0, dur: 0.2 },
{ t: 1, serial: "42\n" }, { t: 0, analog: 34, mv: 1650 }, { t: 2, level: 4, value: null }] })`.

## Glass view

The **View** button in the 3D toolbar swaps between *Light points only* and *Glass stack*. The glass view draws the
physical stack, front to back:

```
cover glass, cover glass | SCREEN 1 | acrylic | SCREEN 2 | ... | SCREEN 7 | acrylic | SCREEN 8 (unlit) | cover glass
```

2 + 8 + 7 + 1 = 18 slabs: acrylic between every pair of screens but not on the outer sides, two glass sheets in front of
screen 1, one behind the spare screen 8. Screens are 85 % transparent, acrylic 95 %.

**How it is rendered.** The stack is a solid 3D box of 18 slabs and every camera ray that hits it, through the front,
the back or any edge, is traced through it per pixel (a fragment-shader ray march, `viewer/glassView.js`; the same
maths for face-on rays lives in plain JS in `viewer/glassModel.js` for the table and tests). The light points are real
3D objects on each screen's emission plane, so you can orbit round to the side and still see them:

* **Refraction (Snell):** inside each slab the ray bends toward the normal, `sin(theta_slab) = sin(theta_air) / n`
  (glass 1.52, acrylic 1.49). Seen from the front the layers therefore look about 1.5x closer together than the real
  2.5 mm, and a deep dot shifts sideways less than a straight line would predict (parallax is compressed).
* **Absorption:** a slab passes `T^(1/cos(theta_slab))`: oblique rays travel a longer path through the same slab, so the
  stack gets darker as you go off-axis (e.g. the room behind it: 14.8 % head-on, ~12 % at 40 deg). The two outer
  air/glass surfaces also lose more light at grazing angles (Fresnel, unpolarised).
* **Dots under the glass:** at each screen's emission plane the ray picks up the dot underneath it and carries it to
  the eye through everything in between. Head-on from the display-1 side display 7 arrives at 28 % of display 1's
  brightness (display 8 would be 22 %), because its light crosses 6 screens, 6 acrylics and 2 cover glasses. That is the
  "darkness of compounding transparency": the room behind the whole stack is dimmed to 14.8 %, so lit dots still read
  against it, but the deeper the dot the more it sinks toward that darkness. The Glass-stack panel shows the table for
  both head-on and an adjustable off-axis angle.
* **Seen through the edge:** a ray entering a side face travels *along* the screens, so it crosses a 1 mm screen
  over many millimetres and loses far more (0.85 per mm of path) than a face-on ray. The dots are still there but dim
  and smeared, which is the "hard to see through the side" you would expect. The polished plate edges also totally
  internally reflect shallow rays (critical angle ~42 deg), so the edge acts as a mirror and can show a second,
  mirrored copy of a lit screen next to it.
* **Plates:** glass-green edges with the layer structure visible on the sides, a rim, a mirrored window in the front
  surface, a faint outline of every screen's active area, and a gridded room around the stack so the shift and the
  darkening of the background can be judged. *Room behind* sets that wall's brightness (0 = pitch-dark room), *Room
  light on glass* sets the veiling glare reflected off the front surface.
* **View from:** *display 1 side* (default, where the two cover glasses are) or *display 7 side*. The glass stack is
  asymmetric, so the two sides see very different brightness. **From the display-1 side the demo's text is mirrored**:
  the sketch's x = column assumes you look from the display-7 side. If your real stack reads correctly from the front,
  your boards are mirrored relative to that assumption: set `MIRROR_X 1` in the sketch (or use the other side button).

**Given:** screens 1.0 mm thick, cover glass 1.5 mm thick each. **Assumptions** (editable in the *Glass stack* panel; I
had no values): cover-glass transparency 92 %, plates 24 x 24 mm, all parts in direct contact (no air gaps), the quoted
percentages are the *total* normal-incidence transmittance of one part. Acrylic thickness = layer pitch - screen
thickness (1.5 mm at 2.5 mm pitch).

**Not modelled:** partial (Fresnel) reflections between surfaces, i.e. ghost / double images (only total internal
reflection is traced), polarisation, colour dispersion, scattering, and the emission going out the back and reflecting
back. Transparent PMOLED really emits both ways, so a back-facing viewer sees the same dots.

**Checked:** `tests/glassModel.test.js` (stack order and counts, product of the quoted transmittances, Snell, apparent
depth, oblique dimming, Fresnel). The shader itself is checked in the browser by reading pixels back
(`viewer/selfcheck.js`, run `await (await import('/viewer/selfcheck.js')).runGlassSelfCheck(__holo.scene)` on a loaded
page): head-on brightness of all displays within 1 % of the model, the 30 deg lit width within 0.14 mm, and the refraction
shift between displays within 0.02 mm.

## Hardware lint

Every item is a unit test (`tests/lint.test.js`) and most also run through a deliberately bad sketch
(`tests/fixtures/bad_bus.ino`).

| Code | Fires when |
|---|---|
| `CONTENTION` | two CS lines low at the same time |
| `NO_CS` | SPI bytes sent with no CS low |
| `CS_NOT_IDLE` / `CS_UNUSED` | a CS is not idle-high before the first bus use / never configured (info) |
| `RES_AFTER_ON` / `RES_AFTER_INIT` | RES pulsed after a panel is on / initialised |
| `RES_SHORT`, `NO_RESET` | RES low < 10 us; init without a RES pulse first |
| `NO_EXT_VPP` | panel switched on without `0xAD 0x8A` |
| `ON_BEFORE_RAM` | `0xAF` before any display data (speckle) |
| `ON_TOO_SOON` | < 100 ms between `0xAF` and the next activity on that panel |
| `CONTRAST_LOW`, `ALL_ON` | contrast < 0x30 or `0xA5` left active (checked every 500 virtual ms) |
| `DC_EQ_CS`, `PIN_CLASH` | DC pin number equals a CS pin (the GPIO16 bug), or any duplicate assignment |
| `PIN_STRAPPING`, `PIN_FLASH`, `PIN_USB`, `PIN_INPUT_ONLY`, `PIN_INVALID` | ESP32 pin hazards on every pin the sketch uses |
| `PIN_WROVER` | GPIO16/17 (info only: fine on a DevKit V1, unusable on WROVER) |
| `SPI_FAST` | SPI clock above the configured maximum (default 10 MHz) |
| `UNKNOWN_CMD` / `FOREIGN_CMD` | SH1107 command the emulator does not implement / a command from another controller (u8g2's `0xDA`, info) |
| `PIN_CLAIMED`, `WRITE_IGNORED` | `SPI.begin()` / `Wire.begin()` took over one of your RST/DC/CS pins; a `digitalWrite` to a pin the core no longer treats as GPIO |
| `WRITE_NO_PINMODE`, `SPI_NOT_BEGUN` | `digitalWrite` before `pinMode`; SPI transfer before `SPI.begin()` (both do nothing on the ESP32) |
| `I2C_NACK`, `I2C_FAST`, `I2C_NOT_BEGUN` | write to an address with no panel; clock above 400 kHz; `Wire` used before `begin()` |
| `SW_SPI`, `SW_I2C`, `SPI_DEFAULT_PINS` | info: bit-banged bus detected; `SPI.begin()` used the default VSPI pins |
| `FLOATING_INPUT`, `READ_NOT_GPIO`, `ANALOG_NOT_ADC` | `digitalRead` of an `INPUT` pin nothing drives (info); of a pin never set with `pinMode`; `analogRead` on a pin without ADC |
| `DELAY_IN_ISR`, `SERIAL_IN_ISR`, `SERIAL_RX_OVERFLOW` | `delay()` / Serial output inside an interrupt handler; more Serial bytes arrived than the RX buffer holds (256, or `setRxBufferSize()`) |

## How it works

```
sketch.ino --ino2cpp--> sketch.cpp --zig cc (wasm32-wasi)--> sketch.wasm    (cached by hash)
                                                                  |
shim/Arduino.h, SPI.h, Wire.h  -> hc_* imports ->  emulator/host.js (virtual clock, WASI shim, watchdogs)
                                                  |
                                           emulator/bus.js  (pins, SPI, I2C, bit-bang decoding)  + lint.js
                                                  |
                                           emulator/sh1107.js x7  ->  viewer (Three.js) / tools/render.js (PNG)
```

* `String` (`shim/WString.h/.cpp`) has the ESP32 core's API and behaviour, written for the simulator rather than copied
  from the core. Quirks are kept, e.g. `String(2.5, 0)` is `" 3"` (the core pads to 2 characters) and an empty String
  is still `true` in `if (s)`. `Print` gains `print(String)`, so `Serial.print(s)` and `u8g2.print(s)` work.
* Builds define what Arduino-ESP32 defines (`ARDUINO=10819`, `ESP32`, `ARDUINO_ARCH_ESP32`, `ESP_PLATFORM`,
  `F_CPU=240000000L`), so sketches and libraries take their ESP32 code paths. Headers next to the sketch can be
  `#include`d; extra `.c`/`.cpp` files are compiled only when the sketch sits in a folder of its own name (the Arduino rule).
* `tools/ino2cpp.js` replicates Arduino's prototype generation (every global function gets a prototype inserted before
  the first function, after your typedefs/structs) and emits `#line` directives.
* The firmware runs synchronously in a Worker. Instead of Asyncify, every time-consuming import advances the virtual
  clock and then sleeps (`Atomics.wait`) until wall time catches up, honouring pause/speed from a shared control
  buffer; the page thread stays free. This is why the dev server sends COOP/COEP headers.
* Busy waits such as `while (millis()-t0 < ms)` work because each `millis()`/`micros()` call advances time (1 us,
  accelerating inside long poll loops).
* **CPU cost model**: virtual time += `cpuFactor` x wall time the WASM spends computing between host calls (default 40,
  a ballpark for ESP32 @ 240 MHz vs. WASM on a desktop). Without it compute-heavy demos run at hundreds of fps because
  computing is free. Set 0 for deterministic runs.
* **Watchdogs**: virtual (default 5000 ms without `delay()`/`yield()`/SPI/`loop()` return, like the ESP32 task
  watchdog) and wall-clock (4 s in the page, `--wall-timeout` headless) for loops that never call the simulator.

### SH1107 emulation

16 pages x 128 columns, bit0 on top, column offset 0. Implemented: `AE/AF`, `AD`+`8A/8B`, `81`+contrast, `A4/A5`,
`A6/A7`, `B0..BF`, `00..0F`, `10..17`, `20/21` (page / vertical addressing), `A0/A1`, `C0/C8`, `A8`, `D3`, `D5`, `D9`,
`DB`, `DC` and `40..7F`, `E3`. Two-byte commands consume their argument (it is never executed as a command). Unknown
commands are logged and linted. RES low resets registers but **not** GDDRAM; power-up RAM is seeded random garbage, so a
panel switched on before it is written shows speckle. Brightness follows contrast, optionally scaled for the IREF
resistor (1 MOhm = 1.0, 750 kOhm = 1.33x).

## Tests

```bash
npm test          # ~40 s: unit + integration (real demo, glass model, u8g2; first run also builds U8g2)
```

Build products are cached in `build/` (set `HOLO_BUILD_DIR` to use another directory, e.g. an empty one to test a cold
cache). Cache entries are written under private names and renamed into place, so parallel test files or two browser
tabs compiling the same thing never read a half-written object, archive or `.wasm`.

* `sh1107.test.js`, `bus.test.js`, `lint.test.js`, `ino2cpp.test.js` (incl. compile-button logic): unit tests.
* `demo.test.js`: the unchanged `seven_panel_volume_demo.ino` through the whole slideshow; text scene vs. a reference
  layout parsed from the sketch's own font tables (pixel-exact, also through the PNG dump); axes centred on display 4;
  sphere poles on displays 1 and 7; golden frame hash (`tests/golden/text_scene.sha256`, refresh with
  `UPDATE_GOLDEN=1`); CPU-model sanity.
* `sketches.test.js`: lint on a bad sketch, syntax error line/message, warnings kept separate, cache, both watchdogs,
  `exit()`, out-of-bounds crash.
* `glassModel.test.js`: the glass-stack physics (see *Glass view*).
* `string.test.js`: the Arduino `String` class against the ESP32 core's results (number formatting, float rounding,
  search, substring, replace/remove/trim, comparisons, truthiness, `"a" + String(b) + c` chains), also with u8g2.
* `u8g2.test.js`: the real U8g2 library: emulated display == u8g2's own framebuffer for every bus, buffer mode, flip
  mode and showcase page; U8x8 text; the RST-on-GPIO19 trap. Skipped if U8g2 is not installed.
* `inputs.test.js`: buttons and switches with pull-ups/-downs, interrupts (FALLING, CHANGE with argument, bounce,
  `noInterrupts`, `detachInterrupt`), the ADC model (resolution, attenuation, saturation, non-ADC pin), `pulseIn`, and
  the Serial `Stream` API (parseInt/parseFloat/readStringUntil/find/readBytesUntil/timeouts), plus the input spec parser
  and the page-to-worker command ring.
* `server.test.js`: the `/api/compile` contract (error -> fix -> new behaviour -> revert from cache), isolation headers.

The in-page behaviours (compile button hidden/shown, failed build leaves the old build running, error panel, hang
report, pause, speed, Inputs panel buttons / hold / slider, Serial send, inputs kept across a restart) were exercised by hand in a real browser, not by automated UI tests.

## Limitations / not done

* Zig is the only supported compiler backend (no Emscripten path).
* Most ESP32-specific APIs beyond the Arduino core are not shimmed (`Serial`, `SPI`, `Wire`, `String`, pins, timing and
  `ESP.*` basics are). A missing symbol shows up as an ordinary build error.
* Interrupts preempt the sketch only where it calls into the simulator (see [Inputs](#inputs)), not in the middle of
  pure computation. `analogWrite`/LEDC, touch pins, hardware timers and the second core are not emulated.
* `libm` is musl's, not newlib's: float results can differ from the ESP32 in the last bit.
* Start-line / display-offset (`D3`, `DC`) semantics are a best guess (shift of the RAM row, offset added), unverified.
* Orientation: the default `0xA0`/`0xC0` mapping (RAM column c / row r shown at x = c, y = r) and the 2.5 mm layer
  pitch are **assumptions I could not confirm on the real stack**. Both are easy to change (`MIRROR_X` in the sketch,
  `--layer-pitch` / *Run settings*).
