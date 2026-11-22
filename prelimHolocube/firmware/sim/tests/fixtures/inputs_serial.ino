// Serial input through the Stream API. Text arrives at 0.1, 0.3, 0.5 and 0.7 s (see tests/inputs.test.js).
void setup() {
  Serial.begin(115200);
  Serial.setTimeout(500);
  long v = Serial.parseInt();
  Serial.printf("int=%ld\n", v);
  String rest = Serial.readStringUntil('\n');
  Serial.printf("rest=[%s]\n", rest.c_str());
  float f = Serial.parseFloat();
  Serial.printf("float=%.2f\n", f);
  Serial.readStringUntil('\n');
  String line = Serial.readStringUntil('\n');
  Serial.printf("line=[%s]\n", line.c_str());
  bool found = Serial.find(">");
  char buf[8];
  size_t n = Serial.readBytesUntil('<', buf, 7);
  buf[n] = 0;
  Serial.printf("find=%d bytes=[%s]\n", found, buf);
  uint32_t t0 = millis();
  long none = Serial.parseInt();
  Serial.printf("timeout=%ld dt=%lu avail=%d\n", none, (unsigned long)(millis() - t0), Serial.available());
  Serial.println("END");
}

void loop() {
  if (Serial.available()) {                       // echo whatever arrives later
    String s = Serial.readStringUntil('\n');
    Serial.println("echo:" + s);
  }
  delay(10);
}
