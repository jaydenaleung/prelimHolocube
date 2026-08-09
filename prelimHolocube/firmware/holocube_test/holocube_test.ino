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
//  4  A0/DC  -> GPIO16   (any GPIO; can be SHARED by all 8 panels later)
//  5  RES    -> GPIO4   (MUST be a GPIO - do NOT tie to ESP32 EN pin)
//  6  CS     -> GPIO17  (unique per panel)
//  7  IREF   -> 1M 1% resistor to GND
//  8  VDD    -> 3.3V (ESP32 3V3), 1uF ceramic to GND at the pin
//  9  VSS    -> GND
// 10  VCOMH  -> 4.7uF (>=25V) to GND  (cap only, nothing else)
// 11  VPP    -> +13.5V REGULATED (7..16.5V operating, 17V ABS MAX),
//               4.7uF (>=25V) + 100nF to GND at the pin
// 12  VSS    -> GND
//
// Power-up order (datasheet p.15): VDD+VPP on while RES held low >=10us,
// then RES high, init, 0xAF. u8g2 handles this if RES is on a GPIO.
// Power-down: display off / VPP off first, then VDD (~100ms later).
// -----------------------------------------------------------------


#include <U8g2lib.h>
#include <SPI.h>


#define PIN_CS   17
#define PIN_DC   16
#define PIN_RST  4


// Full framebuffer (2KB) - fine on ESP32
U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI u8g2(U8G2_R0, PIN_CS, PIN_DC, PIN_RST);


void setup() {
  Serial.begin(115200);


  Serial.println("Pre-delay boot");
  delay(1000);
  Serial.println("Post-delay boot");


  u8g2.begin();                 // resets panel, sends SH1107 init, display on


  // Belt-and-braces for a bare panel with EXTERNAL VPP:
  // DC-DC Control Mode Set (0xAD) + 0x8A = internal DC-DC OFF.
  // (POR default 0x8B = DC-DC on; panel has no AVDD bonded out, and the
  //  upir board works without this, but external-VPP mode is the spec'd config.)
  u8g2.sendF("ca", 0xAD, 0x8A);


  u8g2.setContrast(0xA2);       // datasheet "normal mode" contrast setting


  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB14_tr);
  u8g2.drawStr(10, 40, "Hello");
  u8g2.drawStr(10, 70, "Jayden!");
  u8g2.drawFrame(0, 0, 128, 128);   // border = quick check of size/offset
  u8g2.sendBuffer();


  Serial.println("Init done - panel should be lit.");
}


void loop() {
  // blink a pixel so you can tell the loop is alive
  static bool on = false;
  on = !on;
  u8g2.setDrawColor(on ? 1 : 0);
  u8g2.drawBox(60, 100, 8, 8);
  u8g2.sendBuffer();
  delay(500);
}


// void setup() {
//   Serial.begin(115200);


//   Serial.println("Pre-delay boot");
//   delay(1000);
//   Serial.println("Post-delay boot");
 
//   smoke_test();
// }


// void loop() {
 
// }


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
  digitalWrite(PIN_RST, LOW);  delayMicroseconds(100);   // reset pulse
  digitalWrite(PIN_RST, HIGH); delay(10);
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(PIN_DC, LOW);   // command
  digitalWrite(PIN_CS, LOW);
  SPI.transfer(0xAD); SPI.transfer(0x8A);  // DC-DC off (external VPP)
  SPI.transfer(0xA5);                      // entire display ON (all pixels)
  SPI.transfer(0xAF);                      // display on
  digitalWrite(PIN_CS, HIGH);
  SPI.endTransaction();
  // 0xA5 forces ALL pixels on regardless of RAM -> whole panel glows.
}

