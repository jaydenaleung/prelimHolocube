// Holocube simulator - shim implementation + entry point.
// Compiled once to shim.o and linked with every sketch.
#include "Arduino.h"
#include "SPI.h"
#include "Wire.h"

HardwareSerial Serial(0);
HardwareSerial Serial1(1);
HardwareSerial Serial2(2);
EspClass ESP;
SPIClass SPI;
TwoWire Wire(0);
TwoWire Wire1(1);

void pinMode(uint8_t pin, uint8_t mode) { hc_pin_mode(pin, mode); }
void digitalWrite(uint8_t pin, uint8_t val) { hc_digital_write(pin, val); }
int digitalRead(uint8_t pin) { return hc_digital_read(pin); }
// ---- ADC: linear model of the ESP32 SAR ADC. Full scale per attenuation (where the 12-bit reading saturates):
//      0 dB ~1.1 V, 2.5 dB ~1.5 V, 6 dB ~2.2 V, 11 dB ~3.1 V. The real ADC is not linear near both ends.
static uint8_t s_adc_bits = 12;
static adc_attenuation_t s_adc_att[40];
static bool s_adc_init = false;
static const uint16_t kFullScaleMv[ADC_ATTENDB_MAX] = {1100, 1500, 2200, 3100};
static adc_attenuation_t att_of(uint8_t pin) {
  if (!s_adc_init) { for (int i = 0; i < 40; i++) s_adc_att[i] = ADC_11db; s_adc_init = true; }
  return pin < 40 ? s_adc_att[pin] : ADC_11db;
}
uint16_t analogRead(uint8_t pin) {
  int mv = hc_analog_mv(pin);
  if (mv < 0) return 0;                                  // not an ADC pin (the simulator warns)
  uint32_t fs = kFullScaleMv[att_of(pin)];
  uint32_t raw = (uint32_t)mv >= fs ? 4095u : ((uint32_t)mv * 4095u + fs / 2) / fs;
  if (s_adc_bits < 12) return (uint16_t)(raw >> (12 - s_adc_bits));
  if (s_adc_bits > 12) return (uint16_t)(raw << (s_adc_bits - 12));
  return (uint16_t)raw;
}
uint32_t analogReadMilliVolts(uint8_t pin) {
  int mv = hc_analog_mv(pin);
  if (mv < 0) return 0;
  uint32_t fs = kFullScaleMv[att_of(pin)];
  return (uint32_t)mv > fs ? fs : (uint32_t)mv;
}
void analogReadResolution(uint8_t bits) { if (bits >= 1 && bits <= 16) s_adc_bits = bits; }
void analogSetWidth(uint8_t bits) { if (bits >= 9 && bits <= 12) s_adc_bits = bits; }
void analogSetAttenuation(adc_attenuation_t a) { att_of(0); if (a < ADC_ATTENDB_MAX) for (int i = 0; i < 40; i++) s_adc_att[i] = a; }
void analogSetPinAttenuation(uint8_t pin, adc_attenuation_t a) { att_of(0); if (pin < 40 && a < ADC_ATTENDB_MAX) s_adc_att[pin] = a; }

// ---- interrupts: the handler is passed to the simulator as its index in the WASM function table
void attachInterrupt(uint8_t pin, voidFuncPtr handler, int mode) { hc_attach_interrupt(pin, (uint32_t)(uintptr_t)handler, 0, 0, mode); }
void attachInterruptArg(uint8_t pin, voidFuncPtrArg handler, void *arg, int mode) {
  hc_attach_interrupt(pin, (uint32_t)(uintptr_t)handler, (uint32_t)(uintptr_t)arg, 1, mode);
}
void detachInterrupt(uint8_t pin) { hc_detach_interrupt(pin); }
void analogWrite(uint8_t pin, int value) { hc_digital_write(pin, value > 127 ? 1 : 0); }
void delay(uint32_t ms) { hc_delay_us(ms * 1000u); }
void delayMicroseconds(uint32_t us) { hc_delay_us(us); }
uint32_t millis(void) { return hc_millis(); }
uint32_t micros(void) { return hc_micros(); }
void yield(void) { hc_yield(); }
unsigned long pulseIn(uint8_t pin, uint8_t state, unsigned long timeout) { return hc_pulse_in(pin, state, (uint32_t)timeout); }
unsigned long pulseInLong(uint8_t pin, uint8_t state, unsigned long timeout) { return hc_pulse_in(pin, state, (uint32_t)timeout); }

// ---------------------------------------------------------------- Stream (behaviour of the ESP32 core's Stream)
int Stream::timedRead() {
  _startMillis = millis();
  do { int c = read(); if (c >= 0) return c; } while (millis() - _startMillis < _timeout);
  return -1;
}
int Stream::timedPeek() {
  _startMillis = millis();
  do { int c = peek(); if (c >= 0) return c; } while (millis() - _startMillis < _timeout);
  return -1;
}
// next digit (or '-', or '.' when detectDecimal) after skipping what the lookahead mode allows; -1 = fail/timeout
int Stream::peekNextDigit(LookaheadMode lookahead, bool detectDecimal) {
  for (;;) {
    int c = timedPeek();
    if (c < 0 || c == '-' || (c >= '0' && c <= '9') || (detectDecimal && c == '.')) return c;
    if (lookahead == SKIP_NONE) return -1;
    if (lookahead == SKIP_WHITESPACE && !(c == ' ' || c == '\t' || c == '\r' || c == '\n')) return -1;
    read();
  }
}
long Stream::parseInt(LookaheadMode lookahead, char ignore) {
  bool negative = false;
  long value = 0;
  int c = peekNextDigit(lookahead, false);
  if (c < 0) return 0;
  do {
    if ((char)c == ignore) {}
    else if (c == '-') negative = true;
    else if (c >= '0' && c <= '9') value = value * 10 + (c - '0');
    read();
    c = timedPeek();
  } while ((c >= '0' && c <= '9') || (char)c == ignore);
  return negative ? -value : value;
}
float Stream::parseFloat(LookaheadMode lookahead, char ignore) {
  bool negative = false, fraction = false;
  double value = 0.0, scale = 1.0;
  int c = peekNextDigit(lookahead, true);
  if (c < 0) return 0;
  do {
    if ((char)c == ignore) {}
    else if (c == '-') negative = true;
    else if (c == '.') fraction = true;
    else if (c >= '0' && c <= '9') {
      if (fraction) { scale *= 0.1; value += scale * (c - '0'); }
      else value = value * 10 + (c - '0');
    }
    read();
    c = timedPeek();
  } while ((c >= '0' && c <= '9') || (c == '.' && !fraction) || (char)c == ignore);
  return (float)(negative ? -value : value);
}
size_t Stream::readBytes(char *buffer, size_t length) {
  size_t n = 0;
  while (n < length) { int c = timedRead(); if (c < 0) break; buffer[n++] = (char)c; }
  return n;
}
size_t Stream::readBytesUntil(char terminator, char *buffer, size_t length) {
  size_t n = 0;
  while (n < length) { int c = timedRead(); if (c < 0 || (char)c == terminator) break; buffer[n++] = (char)c; }
  return n;
}
String Stream::readString() {
  String s;
  for (int c = timedRead(); c >= 0; c = timedRead()) s += (char)c;
  return s;
}
String Stream::readStringUntil(char terminator) {
  String s;
  for (int c = timedRead(); c >= 0 && (char)c != terminator; c = timedRead()) s += (char)c;
  return s;
}
bool Stream::find(const char *target) { return findUntil(target, strlen(target), nullptr, 0); }
bool Stream::find(const char *target, size_t length) { return findUntil(target, length, nullptr, 0); }
bool Stream::findUntil(const char *target, const char *terminator) {
  return findUntil(target, strlen(target), terminator, terminator ? strlen(terminator) : 0);
}
bool Stream::findUntil(const char *target, size_t targetLen, const char *terminator, size_t termLen) {
  if (!terminator) { MultiTarget t[1] = {{target, targetLen, 0}}; return findMulti(t, 1) == 0; }
  MultiTarget t[2] = {{target, targetLen, 0}, {terminator, termLen, 0}};
  return findMulti(t, 2) == 0;
}
// Read until one of the targets has been seen; returns its index, or -1 on timeout. After a mismatch a target keeps
// the longest prefix of itself that is still a suffix of what was read ("1112" is found in "11112").
int Stream::findMulti(MultiTarget *targets, int tCount) {
  for (int i = 0; i < tCount; i++) if (targets[i].len == 0) return i;
  for (;;) {
    int c = timedRead();
    if (c < 0) return -1;
    for (int i = 0; i < tCount; i++) {
      MultiTarget &t = targets[i];
      if ((char)c == t.str[t.index]) {
        if (++t.index == t.len) return i;
        continue;
      }
      size_t k = t.index;                     // matched t.str[0..k-1], then c: find the longest prefix that fits
      size_t next = 0;
      for (size_t len = k; len >= 1; len--) {  // candidate prefix length len: t.str[0..len-1] == (matched + c) tail
        if (t.str[len - 1] != (char)c) continue;
        bool ok = true;
        for (size_t j = 0; j + 1 < len; j++)
          if (t.str[j] != t.str[k - (len - 1) + j]) { ok = false; break; }
        if (ok) { next = len; break; }
      }
      t.index = next;
    }
  }
}

long random(long max) { return max <= 0 ? 0 : (long)(((unsigned long)rand()) % (unsigned long)max); }
long random(long min, long max) { return min >= max ? min : min + random(max - min); }
void randomSeed(unsigned long seed) { srand((unsigned)seed); }
long map(long x, long in_min, long in_max, long out_min, long out_max) {
  const long run = in_max - in_min;
  if (run == 0) return 0;
  return (x - in_min) * (out_max - out_min) / run + out_min;
}
uint16_t makeWord(uint16_t w) { return w; }
uint16_t makeWord(uint8_t h, uint8_t l) { return (uint16_t)((h << 8) | l); }
void shiftOut(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder, uint8_t val) {
  for (uint8_t i = 0; i < 8; i++) {
    digitalWrite(dataPin, bitOrder == LSBFIRST ? !!(val & (1 << i)) : !!(val & (1 << (7 - i))));
    digitalWrite(clockPin, HIGH);
    digitalWrite(clockPin, LOW);
  }
}

// ---- minimal C++ runtime so we do not need libc++abi ----
void *operator new(size_t n) { return malloc(n ? n : 1); }
void *operator new[](size_t n) { return malloc(n ? n : 1); }
void operator delete(void *p) noexcept { free(p); }
void operator delete[](void *p) noexcept { free(p); }
void operator delete(void *p, size_t) noexcept { free(p); }
void operator delete[](void *p, size_t) noexcept { free(p); }
extern "C" void __cxa_pure_virtual() { exit(70); }

// ---- entry point: Arduino's loopTask ----
void setup();
void loop();

int main() {
  setup();
  for (;;) {
    loop();
    hc_loop_boundary();
  }
  return 0;
}
