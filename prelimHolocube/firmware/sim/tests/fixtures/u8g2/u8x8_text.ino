// U8x8: tile-based text output without a framebuffer.
#include <U8x8lib.h>
#include <SPI.h>

U8X8_SH1107_PIMORONI_128X128_4W_HW_SPI u8x8(13, 21, 19);

void setup() {
  Serial.begin(115200);
  SPI.begin(18, -1, 23, -1);
  u8x8.begin();
  u8x8.setFont(u8x8_font_chroma48medium8_r);
  u8x8.drawString(0, 0, "HELLO");
  u8x8.setInverseFont(1);
  u8x8.drawString(0, 2, "INV");
  u8x8.setInverseFont(0);
  u8x8.draw2x2String(0, 5, "2X");
  Serial.println("TEXT done");
  delay(300);
}

void loop() { delay(1000); }
