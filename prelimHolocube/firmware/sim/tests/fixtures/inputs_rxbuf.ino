// RX buffer size and overflow: 40 bytes arrive at 0.1 s into a 16-byte buffer that nobody reads until 0.5 s.
void setup() {
  Serial.setRxBufferSize(16);
  Serial.begin(115200);
  delay(500);
  Serial.printf("avail=%d\n", Serial.available());
  Serial.printf("got=[%s]\n", Serial.readString().c_str());
  Serial.println("END");
}
void loop() { delay(1000); }
