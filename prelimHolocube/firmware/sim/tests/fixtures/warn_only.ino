int noReturn(int x) { if (x > 0) return 1; }
void setup() { Serial.println(noReturn(1)); }
void loop() { delay(100); }
