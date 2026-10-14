// Surenoo SOG128128A_P112 1.12" transparent OLED (SH1107G, 4-wire SPI, external VPP)
// ESP32 DevKit V1 (30-pin) + u8g2
//
// Proven-working constructor for this exact panel (upir / sjm4306 project):
//   U8G2_SH1107_PIMORONI_128X128_x_4W_HW_SPI
//
// ---------------- WIRING (single-panel bring-up) ----------------
// Panel FPC pin -> signal -> ESP32
//  1  VSS    -> GND (common with VPP supply ground AND USB ground!)
//  2  SI     -> GPIO23 (VSPI MOSI)
//  3  SCL    -> GPIO18 (VSPI SCK)
//  4  A0/DC  -> GPIO16 (RX2) (any GPIO; can be SHARED by all 8 panels later)
//  5  RES    -> GPIO4  (MUST be a GPIO - do NOT tie to ESP32 EN pin)
//  6  CS     -> GPIO17 (TX2) (unique per panel)
//  7  IREF   -> 1M 1% resistor to GND
//  8  VDD    -> 3.3V (ESP32 3V3), 1uF ceramic to GND at the pin
//  9  VSS    -> GND
// 10  VCOMH  -> 4.7uF (>=25V) to GND  (cap only, nothing else)
// 11  VPP    -> +13.5V REGULATED (7..16.5V operating, 17V ABS MAX),
//               4.7uF (>=25V) to GND at the pin
// 12  VSS    -> GND
//
// Power-up order (datasheet p.15): VDD+VPP on while RES held low >=10us,
// then RES high, init, 0xAF. u8g2 handles this if RES is on a GPIO.
// Power-down: display off / VPP off first, then VDD (~100ms later).
// -----------------------------------------------------------------


#include <U8g2lib.h>
#include <SPI.h>


#define PIN_CS   13
#define PIN_DC   16
#define PIN_RST  17


// // Full framebuffer (2KB) - fine on ESP32
// U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI u8g2(U8G2_R0, PIN_CS, PIN_DC, PIN_RST);


// void setup() {
//   Serial.begin(115200);


//   Serial.println("Pre-delay boot");
//   delay(1000);
//   Serial.println("Post-delay boot");


//   u8g2.begin();                 // resets panel, sends SH1107 init, display on


//   // Belt-and-braces for a bare panel with EXTERNAL VPP:
//   // DC-DC Control Mode Set (0xAD) + 0x8A = internal DC-DC OFF.
//   // (POR default 0x8B = DC-DC on; panel has no AVDD bonded out, and the
//   //  upir board works without this, but external-VPP mode is the spec'd config.)
//   u8g2.sendF("ca", 0xAD, 0x8A);


//   u8g2.setContrast(0xA2);       // datasheet "normal mode" contrast setting


//   u8g2.clearBuffer();
//   u8g2.setFont(u8g2_font_ncenB14_tr);
//   u8g2.drawStr(10, 40, "Hello");
//   u8g2.drawStr(10, 70, "Jayden!");
//   u8g2.drawFrame(0, 0, 128, 128);   // border = quick check of size/offset
//   u8g2.sendBuffer();


//   Serial.println("Init done - panel should be lit.");
// }


// void loop() {
//   // blink a pixel so you can tell the loop is alive
//   static bool on = false;
//   on = !on;
//   u8g2.setDrawColor(on ? 1 : 0);
//   u8g2.drawBox(60, 100, 8, 8);
//   u8g2.sendBuffer();
//   delay(500);
// }


void setup() {
  Serial.begin(115200);


  Serial.println("Pre-delay boot");
  delay(5000);
  Serial.println("Post-delay boot");
 
  smoke_test();
}


void loop() {
 
}


/* ---------------- MINIMAL HARDWARE SMOKE TEST ----------------
   If u8g2 shows nothing, replace setup()/loop() with this. It only
   pulses RES and sends DISPLAY ON (0xAF). With VDD+VPP present and a
   good FPC connection, the panel MUST show random pixels/speckle
   (RAM is uninitialized). If it stays fully dark, the problem is
   hardware: FPC orientation/pin order, VPP, RES, or ground.
*/


void smoke_test() {
  pinMode(PIN_CS, OUTPUT); pinMode(PIN_DC, OUTPUT); pinMode(PIN_RST, OUTPUT);
  SPI.begin(18, -1, 23, PIN_CS);
  digitalWrite(PIN_RST, LOW);  delay(100);   // reset pulse
  digitalWrite(PIN_RST, HIGH); delay(100);
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(PIN_DC, LOW);   // command mode
  digitalWrite(PIN_CS, LOW);
  SPI.transfer(0xAD); SPI.transfer(0x8A);  // DC-DC off (external VPP)
  SPI.transfer(0x81); SPI.transfer(0xFF);  // Set Contrast Control command to max
  SPI.transfer(0xA5);                      // entire display ON (all pixels)
  SPI.transfer(0xAF);                      // display on
  digitalWrite(PIN_CS, HIGH);
  SPI.endTransaction();
  // 0xA5 forces ALL pixels on regardless of RAM -> whole panel glows.
}






/////////////////////////////////////////////////////////






// // Surenoo SOG128128A_P112 1.12" transparent OLED (SH1107G, 4-wire SPI, external VPP)
// // ESP32 DevKit V1 (30-pin) + u8g2
// //
// // Proven-working constructor for this exact panel (upir / sjm4306 project):
// //   U8G2_SH1107_PIMORONI_128X128_x_4W_HW_SPI
// //
// // MULTIBOARD TEST: 8 panels on one SPI bus. Each panel shows its number
// // (1..8) so every CS line / FPC can be checked at a glance.
// //
// // ---------------- WIRING (multiboard, 8 panels) ----------------
// // Signal         -> ESP32              (notes)
// //  SI   (MOSI)   -> GPIO23 (D23)       shared by all panels (VSPI MOSI)
// //  SCL  (SCK)    -> GPIO18 (D18)       shared by all panels (VSPI SCK)
// //  A0   (DC)     -> GPIO16 (RX2)       shared by all panels
// //  RES           -> GPIO17 (TX2)       shared by all panels, 10k pull-up (R2)
// //  CS_1          -> GPIO13 (D13)       10k pull-up (R3)
// //  CS_2          -> GPIO14 (D14)       10k pull-up (R5)
// //  CS_3          -> GPIO27 (D27)       10k pull-up (R6)
// //  CS_4          -> GPIO26 (D26)       10k pull-up (R8)
// //  CS_5          -> GPIO25 (D25)       10k pull-up (R9)
// //  CS_6          -> GPIO33 (D33)       10k pull-up (R11)
// //  CS_7          -> GPIO32 (D32)       10k pull-up (R12)
// //  CS_8          -> GPIO4  (D4)        10k pull-up (R14)
// //
// // Per-panel FPC pin -> signal
// //  1  VSS    -> GND (common with VPP supply ground AND USB ground!)
// //  2  SI     -> SI bus
// //  3  SCL    -> SCL bus
// //  4  A0/DC  -> A0 bus
// //  5  RES    -> RES bus (MUST be a GPIO - do NOT tie to ESP32 EN pin)
// //  6  CS     -> CS_n (unique per panel)
// //  7  IREF   -> 1M 1% resistor to GND
// //  8  VDD    -> 3.3V (ESP32 3V3), 1uF ceramic to GND at the pin
// //  9  VSS    -> GND
// // 10  VCOMH  -> 4.7uF (>=25V) to GND  (cap only, nothing else)
// // 11  VPP    -> +13.5V REGULATED (7..16.5V operating, 17V ABS MAX),
// //               4.7uF (>=25V) to GND at the pin
// // 12  VSS    -> GND
// //
// // Power-up order (datasheet p.15): VDD+VPP on while RES held low >=10us,
// // then RES high, init, 0xAF.
// // RES is SHARED, so it is pulsed ONCE here by hand; the u8g2 objects get
// // U8X8_PIN_NONE for reset, otherwise every begin() would reset (and blank)
// // the panels that were already initialised.
// // Power-down: display off / VPP off first, then VDD (~100ms later).
// // -----------------------------------------------------------------


// #include <U8g2lib.h>
// #include <SPI.h>


// #define DISPLAY_COUNT 8

// #define PIN_DC   16
// #define PIN_RST  17
// #define PIN_SCK  18
// #define PIN_MOSI 23

// // CS_1 .. CS_8
// const uint8_t CS_PINS[DISPLAY_COUNT] = {13, 14, 27, 26, 25, 33, 32, 4};


// // Full framebuffer (2KB each, 16KB total) - fine on ESP32
// U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI displays[DISPLAY_COUNT] = {
//   U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[0], PIN_DC, U8X8_PIN_NONE),
//   U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[1], PIN_DC, U8X8_PIN_NONE),
//   U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[2], PIN_DC, U8X8_PIN_NONE),
//   U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[3], PIN_DC, U8X8_PIN_NONE),
//   U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[4], PIN_DC, U8X8_PIN_NONE),
//   U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[5], PIN_DC, U8X8_PIN_NONE),
//   U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[6], PIN_DC, U8X8_PIN_NONE),
//   U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[7], PIN_DC, U8X8_PIN_NONE)
// };


// // Deselect every panel so nothing listens while the bus comes up
// void deselectAll() {
//   for (uint8_t i = 0; i < DISPLAY_COUNT; i++) {
//     pinMode(CS_PINS[i], OUTPUT);
//     digitalWrite(CS_PINS[i], HIGH);
//   }
// }


// // One reset pulse for all panels (shared RES line)
// void resetAll() {
//   pinMode(PIN_RST, OUTPUT);
//   digitalWrite(PIN_RST, LOW);  delay(100);
//   digitalWrite(PIN_RST, HIGH); delay(100);
// }


// // Big centered number + border (border = quick check of size/offset)
// void drawNumber(uint8_t i) {
//   U8G2 &d = displays[i];
//   char label[2] = { (char)('1' + i), '\0' };

//   d.clearBuffer();
//   d.setFont(u8g2_font_logisoso30_tn);   // digits are 30px tall
//   int x = (128 - d.getStrWidth(label)) / 2;
//   int y = (128 + d.getAscent()) / 2;
//   d.drawStr(x, y, label);
//   d.drawFrame(0, 0, 128, 128);
//   d.sendBuffer();
// }


// void setup() {
//   Serial.begin(115200);


//   Serial.println("Pre-delay boot");
//   delay(5000);
//   Serial.println("Post-delay boot");

//   deselectAll();
//   resetAll();

//   for (uint8_t i = 0; i < DISPLAY_COUNT; i++) {
//     displays[i].begin();                     // SH1107 init, display on (no reset - done above)

//     // Belt-and-braces for a bare panel with EXTERNAL VPP:
//     // DC-DC Control Mode Set (0xAD) + 0x8A = internal DC-DC OFF.
//     displays[i].sendF("ca", 0xAD, 0x8A);

//     displays[i].setContrast(0xA2);           // datasheet "normal mode" contrast setting

//     drawNumber(i);

//     Serial.printf("Panel %d (CS GPIO%d) init + drawn\n", i + 1, CS_PINS[i]);
//   }

//   Serial.println("Init done - panels should show 1..8.");
// }


// void loop() {
//   // blink a pixel block on each panel so you can tell the loop is alive
//   static bool on = false;
//   on = !on;
//   for (uint8_t i = 0; i < DISPLAY_COUNT; i++) {
//     displays[i].setDrawColor(on ? 1 : 0);
//     displays[i].drawBox(116, 116, 8, 8);
//     displays[i].setDrawColor(1);
//     displays[i].sendBuffer();
//   }
//   delay(500);
// }


// /* ---------------- MINIMAL HARDWARE SMOKE TEST ----------------
//    If u8g2 shows nothing, call smoke_test() from setup() instead of the
//    u8g2 code. It pulses the shared RES once and sends DISPLAY ON to every
//    panel with 0xA5 (entire display ON), so every panel with VDD+VPP and a
//    good FPC connection MUST glow fully. A dark panel is hardware: FPC
//    orientation/pin order, VPP, RES, CS, or ground.
// */


// void smoke_test() {
//   for (uint8_t i = 0; i < DISPLAY_COUNT; i++) { pinMode(CS_PINS[i], OUTPUT); }
//   pinMode(PIN_DC, OUTPUT);
//   pinMode(PIN_RST, OUTPUT);
//   SPI.begin(PIN_SCK, -1, PIN_MOSI, -1);
//   resetAll();
//   SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
//   digitalWrite(PIN_DC, LOW);   // command mode
//   for (uint8_t i = 0; i < DISPLAY_COUNT; i++) {
//     digitalWrite(CS_PINS[i], LOW);
//     SPI.transfer(0xAD); SPI.transfer(0x8A);  // DC-DC off (external VPP)
//     SPI.transfer(0x81); SPI.transfer(0xFF);  // Set Contrast Control command to max
//     SPI.transfer(0xA5);                      // entire display ON (all pixels)
//     SPI.transfer(0xAF);                      // display on
//     digitalWrite(CS_PINS[i], HIGH);
//     Serial.printf("Smoke test sent to panel %d (CS GPIO%d)\n", i + 1, CS_PINS[i]);
//   }
//   SPI.endTransaction();
//   // 0xA5 forces ALL pixels on regardless of RAM -> whole panel glows.
// }
