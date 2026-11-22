// Page-buffer mode (_1_: 128x8 buffer, firstPage/nextPage) on display 1 next to a full-buffer reference on display 2.
#include <U8g2lib.h>
#include <SPI.h>
#include "dump.h"

U8G2_SH1107_PIMORONI_128X128_1_4W_HW_SPI paged(U8G2_R0, 13, 21, 19);
U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI full(U8G2_R0, 27, 21, U8X8_PIN_NONE);

void setup() {
  Serial.begin(115200);
  pinMode(13, OUTPUT); digitalWrite(13, HIGH);
  pinMode(27, OUTPUT); digitalWrite(27, HIGH);
  SPI.begin(18, -1, 23, -1);
  paged.begin();
  full.begin();
  uint8_t pages = 0;
  paged.firstPage();
  do { draw_scene(paged); pages++; } while (paged.nextPage());
  Serial.printf("PAGES %u\n", pages);
  draw_scene(full);
  full.sendBuffer();
  dump_u8g2("ref", full);
}

void loop() { delay(1000); }
