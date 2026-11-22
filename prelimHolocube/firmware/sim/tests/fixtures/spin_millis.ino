// Busy loop that polls millis() but never calls delay() or SPI: the virtual watchdog must catch it.
void setup() { Serial.println("spinning on millis()"); }
void loop() { volatile unsigned long t = 0; for (;;) { t = millis(); } }
