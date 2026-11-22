// Inputs demo for the simulator: a button with an interrupt, a switch, a potentiometer and Serial commands,
// shown on display 1. In the simulator use the Inputs panel (press GPIO0, hold GPIO4, slide GPIO34) and the box under
// the Serial console (try "text hello" or "count 0").
#include <U8g2lib.h>
#include <SPI.h>

U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI u8g2(U8G2_R0, /*cs=*/13, /*dc=*/21, /*reset=*/19);

const int BUTTON = 0;    // BOOT button on most ESP32 boards: active low
const int SWITCH = 4;    // switch to 3.3 V, pull-down
const int POT = 34;      // potentiometer wiper (ADC1)

volatile uint32_t presses = 0;
volatile uint32_t lastPressUs = 0;
String text = "hi";

void IRAM_ATTR onPress() {
  uint32_t now = micros();
  if (now - lastPressUs > 20000) presses++;   // 20 ms software debounce
  lastPressUs = now;
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON, INPUT_PULLUP);
  pinMode(SWITCH, INPUT_PULLDOWN);
  attachInterrupt(digitalPinToInterrupt(BUTTON), onPress, FALLING);
  SPI.begin(18, -1, 23, -1);
  u8g2.begin();
  u8g2.setFont(u8g2_font_6x10_tr);
  Serial.println("commands: text <words> | count <n>");
}

void handleSerial() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd.startsWith("text ")) text = cmd.substring(5);
  else if (cmd.startsWith("count ")) { noInterrupts(); presses = cmd.substring(6).toInt(); interrupts(); }
  else { Serial.print("unknown: "); Serial.println(cmd); return; }
  Serial.println("ok");
}

void loop() {
  handleSerial();
  int raw = analogRead(POT);
  bool on = digitalRead(SWITCH);
  bool down = digitalRead(BUTTON) == LOW;

  u8g2.clearBuffer();
  u8g2.setCursor(2, 12);  u8g2.print("presses: "); u8g2.print(presses);
  u8g2.setCursor(2, 26);  u8g2.print("button:  "); u8g2.print(down ? "DOWN" : "up");
  u8g2.setCursor(2, 40);  u8g2.print("switch:  "); u8g2.print(on ? "ON" : "off");
  u8g2.setCursor(2, 54);  u8g2.print("pot: "); u8g2.print(analogReadMilliVolts(POT)); u8g2.print(" mV");
  u8g2.drawFrame(2, 60, 124, 12);
  u8g2.drawBox(4, 62, map(raw, 0, 4095, 0, 120), 8);
  u8g2.setCursor(2, 88);  u8g2.print(text);
  if (on) u8g2.drawDisc(64, 110, 12); else u8g2.drawCircle(64, 110, 12);
  u8g2.sendBuffer();
  delay(30);
}
