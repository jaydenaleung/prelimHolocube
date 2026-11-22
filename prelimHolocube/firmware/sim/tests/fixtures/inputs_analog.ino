// analogRead family + pulseIn. Inputs: 1650 mV on GPIO34 and 4000 mV on GPIO35 from t = 0,
// a 300 us high pulse on GPIO14 at 0.1 s.
void setup() {
  Serial.begin(115200);
  pinMode(14, INPUT);
  unsigned long w = pulseIn(14, HIGH, 1000000);
  Serial.printf("pulse=%lu\n", w);
  Serial.printf("pulse_timeout=%lu\n", pulseIn(14, HIGH, 10000));
  Serial.printf("raw12=%u\n", analogRead(34));
  Serial.printf("over=%u\n", analogRead(35));
  analogReadResolution(10);
  Serial.printf("raw10=%u\n", analogRead(34));
  analogReadResolution(12);
  analogSetPinAttenuation(34, ADC_0db);
  Serial.printf("raw0db=%u\n", analogRead(34));
  Serial.printf("mv0db=%u\n", analogReadMilliVolts(34));
  Serial.printf("mv35=%u\n", analogReadMilliVolts(35));
  Serial.printf("notadc=%u\n", analogRead(5));
  Serial.println("END");
}

void loop() { delay(1000); }
