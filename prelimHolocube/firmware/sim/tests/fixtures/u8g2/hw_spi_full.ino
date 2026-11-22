// Full-buffer u8g2 over hardware SPI, plus both flip modes.
#include <U8g2lib.h>
#include <SPI.h>
#include "dump.h"

U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI u8g2(U8G2_R0, 13, 21, 19);

void setup() {
  Serial.begin(115200);
  SPI.begin(18, -1, 23, -1);
  u8g2.begin();
  draw_scene(u8g2);
  u8g2.sendBuffer();
  dump_u8g2("full", u8g2);
  u8g2.setFlipMode(1);
  u8g2.sendBuffer();
  dump_u8g2("flip1", u8g2);
  u8g2.setFlipMode(0);
  u8g2.sendBuffer();
  dump_u8g2("flip0", u8g2);
}

void loop() { delay(1000); }
