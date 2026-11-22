// u8g2 over hardware I2C (Wire). The test maps 7-bit address 0x3C to display 1.
#include <U8g2lib.h>
#include <Wire.h>
#include "dump.h"

U8G2_SH1107_PIMORONI_128X128_F_HW_I2C u8g2(U8G2_R0, /*reset=*/U8X8_PIN_NONE, /*clock=*/22, /*data=*/21);

void setup() {
  Serial.begin(115200);
  u8g2.begin();
  draw_scene(u8g2);
  u8g2.sendBuffer();
  dump_u8g2("i2c", u8g2);
  // plain Wire: a mapped and an unmapped address
  Wire.beginTransmission(0x3C);
  Wire.write(0x00); Wire.write(0xE3);          // control byte "commands follow", NOP
  Serial.printf("ACK %u\n", Wire.endTransmission());
  Wire.beginTransmission(0x50);
  Wire.write(0x00);
  Serial.printf("NACK %u\n", Wire.endTransmission());
}

void loop() { delay(1000); }
