void setup() { Serial.println("about to hang"); }
void loop() { volatile unsigned long i = 0; for (;;) { i = i + 1; } }
