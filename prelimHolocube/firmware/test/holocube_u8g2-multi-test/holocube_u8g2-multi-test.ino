// holocube u8g2 multi-test - v1.0 main PCB, 7 panels (SH1107, 128x128, 4-wire HW SPI)
//   SI -> GPIO23, SCL -> GPIO18, A0/DC -> GPIO21, RES -> GPIO19 (all shared)
//   CS1..CS7 -> GPIO 13, 27, 26, 25, 33, 32, 16   (CS8 -> GPIO17, unused)
//
// Pick the panels to test in TEST_PANELS below (1 = test, 0 = skip), e.g. {1,1,1,0,0,0,0}
// tests panels 1, 2 and 3 only. Watch the Serial Monitor @ 115200 too.
//
// Stage 1  All-pixels-on (0xA5) for every selected panel. Dark panel = hardware: FPC seating,
//          VPP (+13.5 V), RES, CS wiring or ground.
// Stage 2  ID screen on every selected panel: number, frame, FILLED square top-left, HOLLOW
//          square top-right, "P# CS##" label.
//            wrong number      -> CS lines / FPC swapped
//            squares mirrored  -> orientation (try U8G2_MIRROR / U8G2_R2)
//            frame clipped     -> column/row offset
//            speckle           -> bus too fast, or a floating CS
// Stage 3  (loop) Chase: one selected panel lit at a time, in order, to confirm physical stack
//          order. Bottom-right box toggles each full pass as a heartbeat.


// ---------------- Libraries ----------------

#include <U8g2lib.h>
#include <SPI.h>


// ---------------- Constants ----------------

// Pinouts
#define PIN_SCK   18
#define PIN_MOSI  23
#define PIN_DC    21
#define PIN_RST   19
#define PIN_CS8   17  // not used here
#define NUM_PANELS 7  // eighth panel not used

// Chip select pins
const uint8_t CS_PINS[NUM_PANELS] = {13, 27, 26, 25, 33, 32, 16};

// Which panels to test: 1 = test, 0 = skip. Index 0 = panel 1 (CS1) ... index 6 = panel 7 (CS7).
const bool TEST_PANELS[NUM_PANELS] = {1, 1, 1, 1, 1, 1, 1};

// Configuration
#define BOOT_DELAY_MS  3000     // time to open the Serial Monitor
#define SPI_HZ         1000000  // Clock speed; 1 MHz = proven speed
#define CONTRAST       0xA2     // Panel contrast; 0x00..0xFF
#define PIXELS_ON_MS   2000     // stage 1 duration
#define ID_HOLD_MS     3000     // stage 2 duration
#define CHASE_MS       600      // stage 3 time per panel


// ---------------- U8G2 Objects ----------------

// RES is shared and pulsed manually in setup(), so no u8g2 object gets the reset pin.
typedef U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI Panel;  // proven working constructor
Panel panels[NUM_PANELS] = {
  Panel(U8G2_R0, CS_PINS[0], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[1], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[2], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[3], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[4], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[5], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[6], PIN_DC, U8X8_PIN_NONE),
};

uint8_t active[NUM_PANELS];  // indices (0..6) of the panels under test
uint8_t nActive = 0;


// ---------------- Setup ----------------

void setup() {
  Serial.begin(115200);
  delay(BOOT_DELAY_MS);
  Serial.println("\nholocube u8g2 multi-test");

  // Build the list of selected panels.
  for (uint8_t i = 0; i < NUM_PANELS; i++)
    if (TEST_PANELS[i]) active[nActive++] = i;

  if (nActive == 0) {
    Serial.println("No panels selected - set at least one entry of TEST_PANELS to 1.");
    while (true) delay(1000);
  }
  Serial.printf("Testing %u panel(s)\n", nActive);

  // Set pin modes; CS idles HIGH so unselected panels stay quiet.
  pinMode_all();

  // Explicit pins keep MISO off GPIO19 (= RES).
  SPI.begin(PIN_SCK, -1, PIN_MOSI, -1);

  // One manual reset pulse for all panels.
  reset_all();

  // Initialize the selected panels.
  for (uint8_t n = 0; n < nActive; n++) {
    uint8_t i = active[n];
    panels[i].setBusClock(SPI_HZ);        // before begin()
    bool ok = panels[i].begin();          // init, clear RAM, display on
    panels[i].sendF("ca", 0xAD, 0x8A);    // internal DC-DC off (VPP is external)
    panels[i].setContrast(CONTRAST);
    Serial.printf("  panel %u (CS GPIO%u): begin() %s\n", (unsigned)(i + 1), (unsigned)CS_PINS[i], ok ? "ok" : "FAILED");
  }

  // Stage 1: entire display ON, independent of RAM contents.
  Serial.println("Stage 1: all pixels ON - every selected panel should glow fully");
  for (uint8_t n = 0; n < nActive; n++) panels[active[n]].sendF("c", 0xA5);
  delay(PIXELS_ON_MS);
  for (uint8_t n = 0; n < nActive; n++) panels[active[n]].sendF("c", 0xA4);  // back to RAM

  // Stage 2: ID screens on all selected panels at once.
  Serial.println("Stage 2: ID screens - check number, markers, frame");
  for (uint8_t n = 0; n < nActive; n++) drawId(active[n], false);
  delay(ID_HOLD_MS);

  // Stage 3 starts from a dark stack.
  for (uint8_t n = 0; n < nActive; n++) blank(active[n]);
  Serial.println("Stage 3: chase - one panel at a time");
}


// ---------------- Loop ----------------

void loop() {
  static uint8_t pos = 0;   // position in the active list
  static bool beat = false;

  uint8_t i = active[pos];
  if (nActive > 1) blank(active[(pos + nActive - 1) % nActive]);  // previous panel off
  drawId(i, beat);
  Serial.printf("  lit panel %u (CS GPIO%u)\n", (unsigned)(i + 1), (unsigned)CS_PINS[i]);

  pos = (pos + 1) % nActive;
  if (pos == 0) beat = !beat;  // heartbeat flips once per full pass
  delay(CHASE_MS);
}


// ---------------- Draw Methods ----------------

// Number + frame + asymmetric corner markers + CS pin label + optional heartbeat box.
void drawId(uint8_t i, bool beat) {
  Panel &d = panels[i];
  char label[2] = { (char)('1' + i), '\0' };
  char cs[12];
  snprintf(cs, sizeof(cs), "P%u CS%u", (unsigned)(i + 1), (unsigned)CS_PINS[i]);

  d.clearBuffer();
  d.drawFrame(0, 0, 128, 128);             // size / offset check
  d.drawBox(5, 5, 12, 12);                 // top-left  = FILLED
  d.drawFrame(111, 5, 12, 12);             // top-right = HOLLOW (reveals mirroring)

  d.setFont(u8g2_font_logisoso30_tn);      // digits are 30 px tall
  d.drawStr((128 - d.getStrWidth(label)) / 2, (128 + d.getAscent()) / 2, label);

  d.setFont(u8g2_font_6x10_tr);
  d.drawStr(6, 120, cs);                   // bottom-left label

  if (beat) d.drawBox(111, 111, 10, 10);   // heartbeat, bottom-right
  d.sendBuffer();
}

// Clears one panel to black.
void blank(uint8_t i) {
  panels[i].clearBuffer();
  panels[i].sendBuffer();
}


// ---------------- Helper Methods ----------------

// Declares the pinMode for all pins.
void pinMode_all() {
  // CS and RES idle HIGH: write the level first so the pin never glitches LOW when it becomes an output.
  for (uint8_t i = 0; i < NUM_PANELS; i++) { digitalWrite(CS_PINS[i], HIGH); pinMode(CS_PINS[i], OUTPUT); }
  digitalWrite(PIN_CS8, HIGH); pinMode(PIN_CS8, OUTPUT);
  digitalWrite(PIN_RST, HIGH); pinMode(PIN_RST, OUTPUT);
  pinMode(PIN_DC, OUTPUT);
}

// Pulses the shared reset pin once for all panels. Call pinMode_all() first.
void reset_all() {
  digitalWrite(PIN_RST, LOW);  delay(100);
  digitalWrite(PIN_RST, HIGH); delay(100);
}
