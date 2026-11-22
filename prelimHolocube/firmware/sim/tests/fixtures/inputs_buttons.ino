// Buttons, switches and interrupts. Driven by scripted inputs from tests/inputs.test.js:
//   0.5 s press GPIO0 for 200 ms     1.2 s bounced press GPIO0 for 100 ms
//   1.8 s GPIO4 driven high          2.2 s GPIO4 released (pull-down)
//   2.7 s press GPIO0 (interrupts off)   3.2 s press GPIO0 (handler detached)
volatile int falls = 0;
volatile int changes = 0;

void IRAM_ATTR onFall() { falls++; }
void IRAM_ATTR onChange(void *arg) { (*(volatile int *)arg)++; }

void setup() {
  Serial.begin(115200);
  pinMode(0, INPUT_PULLUP);
  pinMode(4, INPUT_PULLDOWN);
  attachInterrupt(digitalPinToInterrupt(0), onFall, FALLING);
  attachInterruptArg(4, onChange, (void *)&changes, CHANGE);
  Serial.printf("idle=%d,%d\n", digitalRead(0), digitalRead(4));
  delay(600);                                                   // t = 0.6: button held
  Serial.printf("pressed=%d falls=%d\n", digitalRead(0), falls);
  delay(400);                                                   // t = 1.0: released
  Serial.printf("released=%d falls=%d\n", digitalRead(0), falls);
  delay(500);                                                   // t = 1.5: after the bounced press
  Serial.printf("bounced=%d\n", falls);
  delay(1000);                                                  // t = 2.5
  Serial.printf("changes=%d pin4=%d\n", changes, digitalRead(4));
  noInterrupts();
  delay(500);                                                   // t = 3.0: a press happened meanwhile
  int held = falls;
  interrupts();
  delay(1);
  Serial.printf("held=%d after=%d\n", held, falls);
  detachInterrupt(0);
  delay(500);                                                   // t = 3.5
  Serial.printf("detached=%d\n", falls);
  Serial.println("END");
}

void loop() { delay(1000); }
