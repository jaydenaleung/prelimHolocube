// The trap from holocube_single-test: u8g2.begin() starts the SPI bus itself with SPI.begin(), which on the
// ESP32 attaches MISO to GPIO19 - the RST pin. Every reset pulse after that is ignored by the core.
#include <U8g2lib.h>
#include <SPI.h>

U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI u8g2(U8G2_R0, 13, 21, 19);

void setup() {
  Serial.begin(115200);
  u8g2.begin();
  u8g2.setFont(u8g2_font_ncenB14_tr);
  u8g2.drawStr(10, 40, "no reset");
  u8g2.sendBuffer();
  Serial.println("drawn");
  delay(300);
}

void loop() { delay(1000); }
