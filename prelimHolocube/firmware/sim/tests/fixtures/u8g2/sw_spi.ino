// u8g2 over software (bit-banged) SPI: the simulator decodes the clock/data pin edges.
#include <U8g2lib.h>
#include "dump.h"

U8G2_SH1107_PIMORONI_128X128_F_4W_SW_SPI u8g2(U8G2_R0, /*clock=*/18, /*data=*/23, /*cs=*/13, /*dc=*/21, /*reset=*/19);

void setup() {
  Serial.begin(115200);
  u8g2.begin();
  draw_scene(u8g2);
  u8g2.sendBuffer();
  dump_u8g2("swspi", u8g2);
}

void loop() { delay(1000); }
