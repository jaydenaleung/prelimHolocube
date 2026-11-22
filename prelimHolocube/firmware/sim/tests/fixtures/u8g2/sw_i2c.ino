// u8g2 over software (bit-banged) I2C: the simulator decodes START/STOP and the bits from SDA/SCL.
#include <U8g2lib.h>
#include "dump.h"

U8G2_SH1107_PIMORONI_128X128_F_SW_I2C u8g2(U8G2_R0, /*clock=*/22, /*data=*/21, /*reset=*/U8X8_PIN_NONE);

void setup() {
  Serial.begin(115200);
  u8g2.begin();
  draw_scene(u8g2);
  u8g2.sendBuffer();
  dump_u8g2("swi2c", u8g2);
}

void loop() { delay(1000); }
