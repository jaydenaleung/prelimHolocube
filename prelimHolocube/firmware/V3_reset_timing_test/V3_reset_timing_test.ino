// V3 - RESET TIMING / BOOT-RACE TEST
// Surenoo SOG128128A (SH1107), ESP32 DevKit V1, external VPP
//
// WHY THIS EXISTS (Experiment #6):
//   Shaking the wires changed nothing in either state, but the on/off
//   state was latched at power-on. That is an init/reset race, not a
//   loose connection.
//
//   The V1 smoke test used a 100us reset pulse + 10ms settle.
//   Both known-working implementations use FAR longer:
//     u8g2  : 100 ms reset pulse, 100 ms post-reset wait
//             (source comment: "far east OLEDs need much longer setup time")
//     boriz : 50 ms low, 100 ms after release
//   V1 was ~500x shorter than either. That is the prime suspect.
//
// WHAT THIS SKETCH DOES:
//   Re-runs reset + init + 0xA5 (all pixels on) every 3 seconds, forever,
//   WITHOUT a power cycle, and prints an attempt counter.
//
//   This is the discriminator you need:
//     - Panel sometimes lights on a re-init  -> RESET/INIT timing problem.
//       Fixable in software. Note the success rate.
//     - Never lights on re-init, but sometimes lights after a power cycle
//       -> POWER SEQUENCING problem (VDD vs VPP order/timing), not reset.
//     - Lights every single time now -> V1's short reset pulse was the bug.
//
// WIRING: unchanged from V1 (CS=17, DC=16, RST=4, SCK=18, MOSI=23)
//   *** VERIFY CS/A0 ON THE PHYSICAL BOARD ***
//   boriz's project (and your June 30 email) use CS=16, A0=17 - SWAPPED
//   relative to this. A swap is invisible to a commands-only test like
//   this one, because CS and DC are both driven LOW together, but it
//   breaks u8g2 and SH110X data writes.
//
// ALSO DO IN HARDWARE (still outstanding from Experiment #5):
//   10k from RES to 3.3V, 10k from CS to 3.3V.
//   Until those exist, RES floats for the ~300ms the ESP32 takes to boot,
//   which is its own source of boot-to-boot randomness.

#include <SPI.h>

#define PIN_CS   17
#define PIN_DC   16
#define PIN_RST  4
#define PIN_SCK  18
#define PIN_MOSI 23

// Timing - matched to u8g2 / boriz, NOT to the datasheet minimum.
// Datasheet min is 10us; real panels want milliseconds.
#define RESET_LOW_MS    100
#define RESET_SETTLE_MS 100
#define POST_ON_MS      100   // datasheet p.15: wait 100ms after 0xAF

uint32_t attempt = 0;

void cmd(uint8_t c) {
  digitalWrite(PIN_DC, LOW);
  digitalWrite(PIN_CS, LOW);
  SPI.transfer(c);
  digitalWrite(PIN_CS, HIGH);
}

void hardReset() {
  digitalWrite(PIN_RST, HIGH); delay(10);
  digitalWrite(PIN_RST, LOW);  delay(RESET_LOW_MS);
  digitalWrite(PIN_RST, HIGH); delay(RESET_SETTLE_MS);
}

void initPanel() {
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));

  cmd(0xAE);              // display off
  cmd(0x20);              // page addressing mode
  cmd(0xA8); cmd(0x7F);   // multiplex ratio = 128
  cmd(0xA1);              // segment remap   (boriz values)
  cmd(0xC8);              // COM scan dir    (boriz values)
  cmd(0xAD); cmd(0x8A);   // DC-DC OFF - external VPP
  cmd(0xD5); cmd(0x50);   // clock divide
  cmd(0xD9); cmd(0x25);   // pre-charge      (boriz: 0x25, u8g2: 0x22)
  cmd(0xDB); cmd(0x30);   // VCOMH deselect  (boriz: 0x30, u8g2: 0x35)
  cmd(0x81); cmd(0xFF);   // contrast MAX - u8g2 defaults to 0x2F which is
                          // very dim on an already-dim transparent panel
  cmd(0xA6);              // normal (not inverted)
  cmd(0xA5);              // ENTIRE DISPLAY ON - ignores RAM entirely
  cmd(0xAF);              // display on

  SPI.endTransaction();
  delay(POST_ON_MS);
}

void setup() {
  Serial.begin(115200);
  delay(5000);                       // let both rails settle before touching anything
  Serial.println("\n=== V3 reset-timing test ===");
  Serial.println("0xA5 = all pixels on. Panel should be FULLY LIT on success.");
  Serial.printf("Reset: %dms low, %dms settle\n", RESET_LOW_MS, RESET_SETTLE_MS);

  pinMode(PIN_CS, OUTPUT);  digitalWrite(PIN_CS, HIGH);
  pinMode(PIN_DC, OUTPUT);  digitalWrite(PIN_DC, LOW);
  pinMode(PIN_RST, OUTPUT); digitalWrite(PIN_RST, HIGH);

  SPI.begin(PIN_SCK, -1, PIN_MOSI, PIN_CS);
}

void loop() {
  attempt++;
  Serial.printf("\n--- attempt %lu ---\n", attempt);
  Serial.println("  reset + init + 0xA5 ...");

  hardReset();
  initPanel();

  Serial.println("  done. LIT or DARK? (log it)");
  Serial.println("  If DARK: measure IREF (~0.9-1.2V = chip alive)");
  Serial.println("           and VCOMH (~0.77*VPP = display actually on)");

  delay(3000);
}

/* ------------------- HOW TO RUN THIS -------------------

  1. Power up in the DATASHEET order and write it down every time:
        VPP on first (or simultaneously), THEN plug in USB.
     Your notebook never records which rail came up first, and with two
     independently switched supplies that order has been random. The
     datasheet wants VDD and VPP both up with RES held low, then RES
     released - which is only guaranteed if VPP is already present when
     the ESP32 finishes booting.

  2. Watch 20 consecutive attempts. Tally lit vs dark.
     Write the success rate in the notebook. A rate is data; "sometimes"
     is not.

  3. Then power-cycle and repeat, so you have two rates to compare:
        re-init success rate   vs   power-cycle success rate

     re-init works sometimes        -> reset/init timing. Software fix.
     re-init never, power-cycle yes -> power sequencing between VDD/VPP.
     both ~100% now                 -> V1's 100us reset pulse was the bug.

  4. IMPORTANT: re-test the panels you previously wrote off as dead.
     If the per-attempt success rate is ~20%, then five consecutive
     failures happens 33% of the time by chance alone. Your earlier
     dead/alive classification was taken over only a handful of tries,
     so some "dead" panels are probably fine.
--------------------------------------------------------- */
