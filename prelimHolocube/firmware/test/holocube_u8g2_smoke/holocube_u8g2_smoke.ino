// u8g2 SMOKE TEST - holocube v1.0 main PCB
// Surenoo SOG128128A_P112 transparent OLED (SH1107G, 4-wire SPI, external VPP)
// ESP32 DevKit V1 (30-pin) + u8g2, 7 of 8 panel positions populated.
//
// Pinout taken from pcb/v1.0/main/holocube.kicad_sch (same as holocube_demo.ino):
//   SI   (MOSI) -> GPIO23   shared      SCL (SCK) -> GPIO18   shared
//   A0   (DC)   -> GPIO21   shared      RES       -> GPIO19   shared
//   CS1..CS7    -> GPIO 13, 27, 26, 25, 33, 32, 16 (one per panel)
//   CS8         -> GPIO17   (panel 8 not fitted; driven HIGH so it stays quiet)
//
// WHAT TO TEST: set TEST_PANEL below.
//   0     -> all 7 panels
//   1..7  -> only that panel (handy for first power-up of a single board)
//
// WHAT YOU SHOULD SEE (watch the Serial Monitor @ 115200 as well):
//   Stage 1  all selected panels glow fully for 2 s (command 0xA5, ignores RAM).
//            Dark panel here = hardware: FPC seating/orientation, VPP (+13.5 V),
//            RES, CS wiring or ground. u8g2 is not the problem.
//   Stage 2  every selected panel shows its number, a frame, a FILLED square top-left
//            and a HOLLOW square top-right, plus "CSnn" at the bottom.
//            - Wrong number on a panel      -> CS lines / FPC swapped
//            - Squares mirrored or flipped  -> orientation (try U8G2_MIRROR / U8G2_R2)
//            - Frame clipped or offset      -> column/row offset of the PIMORONI mode
//            - Speckle / garbage            -> bus too fast or a floating CS
//   Stage 3  (loop) lights ONE panel at a time, 1 -> 7, so you can confirm the physical
//            stack order. A corner box blinks each full pass as a heartbeat.
//
// RES is shared, so it is pulsed ONCE by hand and every u8g2 object gets
// U8X8_PIN_NONE for reset - otherwise each begin() would reset (blank) the panels
// that were already initialised.

#include <U8g2lib.h>
#include <SPI.h>

// ---------------- configuration ----------------
#define TEST_PANEL     0          // 0 = all, 1..7 = single panel
#define BOOT_DELAY_MS  3000       // time to open the Serial Monitor
#define SPI_HZ         1000000    // 1 MHz = proven speed in holocube_demo.ino
#define CONTRAST       0xA2       // datasheet "normal"; 0xFF = max (demo uses max)
#define PIXELS_ON_MS   2000
#define ID_HOLD_MS     3000
#define CHASE_MS       600

// ---------------- pins (v1.0 main) ----------------
#define PIN_SCK   18
#define PIN_MOSI  23
#define PIN_DC    21
#define PIN_RST   19
#define PIN_CS8   17              // panel 8 - not fitted
#define NUM_PANELS 7

const uint8_t CS_PINS[NUM_PANELS] = {13, 27, 26, 25, 33, 32, 16};

// Full framebuffer (2 KB each, 14 KB total) - fine on ESP32.
// Proven constructor for this panel (upir / sjm4306 project).
typedef U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI Panel;
Panel panels[NUM_PANELS] = {
  Panel(U8G2_R0, CS_PINS[0], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[1], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[2], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[3], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[4], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[5], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[6], PIN_DC, U8X8_PIN_NONE),
};

uint8_t active[NUM_PANELS];       // indices (0..6) of the panels under test
uint8_t nActive = 0;


// ---------------- helpers ----------------

// Deselect every panel (incl. the unused CS8) so nothing listens while the bus comes up.
void deselectAll() {
  for (uint8_t i = 0; i < NUM_PANELS; i++) {
    pinMode(CS_PINS[i], OUTPUT);
    digitalWrite(CS_PINS[i], HIGH);
  }
  pinMode(PIN_CS8, OUTPUT);
  digitalWrite(PIN_CS8, HIGH);
}

// One reset pulse for all panels (shared RES). VDD + VPP must already be on.
void resetAll() {
  pinMode(PIN_RST, OUTPUT);
  digitalWrite(PIN_RST, LOW);  delay(100);
  digitalWrite(PIN_RST, HIGH); delay(100);
}

// Number + frame + asymmetric corner markers + CS pin label
void drawId(uint8_t i, bool beat) {
  Panel &d = panels[i];
  char label[2] = { (char)('1' + i), '\0' };
  char cs[12];
  snprintf(cs, sizeof(cs), "P%u CS%u", i + 1, CS_PINS[i]);

  d.clearBuffer();
  d.drawFrame(0, 0, 128, 128);                 // size / offset check
  d.drawBox(5, 5, 12, 12);                     // top-left  = FILLED
  d.drawFrame(111, 5, 12, 12);                 // top-right = HOLLOW (reveals mirroring)

  d.setFont(u8g2_font_logisoso30_tn);          // digits are 30 px tall
  d.drawStr((128 - d.getStrWidth(label)) / 2, (128 + d.getAscent()) / 2, label);

  d.setFont(u8g2_font_6x10_tr);
  d.drawStr(6, 120, cs);                       // bottom-left label

  if (beat) d.drawBox(111, 111, 10, 10);       // heartbeat, bottom-right
  d.sendBuffer();
}

void blank(uint8_t i) {
  panels[i].clearBuffer();
  panels[i].sendBuffer();
}


// ---------------- test ----------------

void setup() {
  Serial.begin(115200);
  Serial.println("\nholocube u8g2 smoke test");
  delay(BOOT_DELAY_MS);

  // Which panels?
  for (uint8_t i = 0; i < NUM_PANELS; i++)
    if (TEST_PANEL == 0 || TEST_PANEL == i + 1) active[nActive++] = i;
  Serial.printf("Testing %u panel(s)\n", nActive);

  deselectAll();
  resetAll();
  SPI.begin(PIN_SCK, -1, PIN_MOSI, -1);        // explicit: keeps MISO off GPIO19 (RES)

  for (uint8_t n = 0; n < nActive; n++) {
    uint8_t i = active[n];
    panels[i].setBusClock(SPI_HZ);             // must come before begin()
    bool ok = panels[i].begin();               // SH1107 init, clears RAM, display on
    panels[i].sendF("ca", 0xAD, 0x8A);         // DC-DC off: VPP is external
    panels[i].setContrast(CONTRAST);
    Serial.printf("  panel %u (CS GPIO%u): begin() %s\n", i + 1, CS_PINS[i], ok ? "ok" : "FAILED");
  }

  // Stage 1: entire display ON, independent of RAM contents
  Serial.println("Stage 1: all pixels ON - every panel should glow fully");
  for (uint8_t n = 0; n < nActive; n++) panels[active[n]].sendF("c", 0xA5);
  delay(PIXELS_ON_MS);
  for (uint8_t n = 0; n < nActive; n++) panels[active[n]].sendF("c", 0xA4);   // back to RAM

  // Stage 2: identity screens on every panel at once
  Serial.println("Stage 2: ID screens - check number, markers, frame");
  for (uint8_t n = 0; n < nActive; n++) drawId(active[n], false);
  delay(ID_HOLD_MS);

  // Stage 3 starts from a dark stack
  for (uint8_t n = 0; n < nActive; n++) blank(active[n]);
  Serial.println("Stage 3: chase - one panel at a time, 1 -> 7");
}


void loop() {
  static uint8_t pos = 0;
  static bool beat = false;

  uint8_t i = active[pos];
  if (nActive > 1) blank(active[(pos + nActive - 1) % nActive]);   // previous one off
  drawId(i, beat);
  Serial.printf("  lit panel %u (CS GPIO%u)\n", i + 1, CS_PINS[i]);

  pos = (pos + 1) % nActive;
  if (pos == 0) beat = !beat;                  // heartbeat flips once per pass
  delay(CHASE_MS);
}
