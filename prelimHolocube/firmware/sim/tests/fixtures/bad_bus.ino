// Deliberately broken bring-up code. Every hardware lint rule that can fire from a sketch should fire.
#include <SPI.h>

void setup() {
  pinMode(21, OUTPUT); pinMode(19, OUTPUT);
  pinMode(13, OUTPUT); pinMode(27, OUTPUT);   // CS1, CS2
  pinMode(12, OUTPUT);                        // strapping pin
  pinMode(34, OUTPUT);                        // input-only pin used as output
  pinMode(6, OUTPUT);                         // flash pin
  // CS1/CS2 never driven high: not idle-high before first bus use
  SPI.begin(18, -1, 23, -1);
  SPI.beginTransaction(SPISettings(20000000, MSBFIRST, SPI_MODE0));   // too fast
  SPI.transfer(0x55);                         // no CS low
  digitalWrite(19, LOW); delayMicroseconds(3); digitalWrite(19, HIGH); // RES only 3 us
  delay(1);
  digitalWrite(21, LOW);
  digitalWrite(13, LOW); digitalWrite(27, LOW);                       // contention
  SPI.transfer(0xAF);                         // on before RAM written, no 0xAD 0x8A
  SPI.transfer(0x81); SPI.transfer(0x05);     // very low contrast, right after 0xAF
  SPI.transfer(0xA5);                         // entire display on, left active
  SPI.transfer(0x9A);                         // unknown command
  digitalWrite(13, HIGH); digitalWrite(27, HIGH);
  SPI.endTransaction();
  delay(700);                                 // lets the periodic checks run
  digitalWrite(19, LOW); delay(1); digitalWrite(19, HIGH);            // RES while panels are on
}

void loop() { delay(1000); }
