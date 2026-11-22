// Holocube simulator - Arduino core shim (ESP32-flavoured subset).
// The firmware is compiled against this header instead of the real Arduino core;
// all hardware access is routed to the JS host through the hc_* imports below.
#ifndef HOLOCUBE_SIM_ARDUINO_H
#define HOLOCUBE_SIM_ARDUINO_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <math.h>
#include <ctype.h>
#include <limits.h>
#include <inttypes.h>
#include "WString.h"

#define HC_IMPORT(name) __attribute__((import_module("env"), import_name(#name)))

extern "C" {
HC_IMPORT(hc_pin_mode)     void hc_pin_mode(int pin, int mode);
HC_IMPORT(hc_digital_write) void hc_digital_write(int pin, int level);
HC_IMPORT(hc_digital_read) int  hc_digital_read(int pin);
HC_IMPORT(hc_delay_us)     void hc_delay_us(uint32_t us);
HC_IMPORT(hc_millis)       uint32_t hc_millis(void);
HC_IMPORT(hc_micros)       uint32_t hc_micros(void);
HC_IMPORT(hc_yield)        void hc_yield(void);
HC_IMPORT(hc_loop_boundary) void hc_loop_boundary(void);
HC_IMPORT(hc_spi_begin)    void hc_spi_begin(int sck, int miso, int mosi, int ss);
HC_IMPORT(hc_spi_end)      void hc_spi_end(void);
HC_IMPORT(hc_spi_begin_tx) void hc_spi_begin_tx(uint32_t hz, int bitOrder, int mode);
HC_IMPORT(hc_spi_end_tx)   void hc_spi_end_tx(void);
HC_IMPORT(hc_spi_set_clock) void hc_spi_set_clock(uint32_t hz);
HC_IMPORT(hc_spi_transfer) int  hc_spi_transfer(int byte);
HC_IMPORT(hc_spi_write)    void hc_spi_write(const uint8_t *data, uint32_t len);
HC_IMPORT(hc_serial_write) void hc_serial_write(const char *data, uint32_t len);
HC_IMPORT(hc_analog_read)  int  hc_analog_read(int pin);
HC_IMPORT(hc_i2c_begin)    void hc_i2c_begin(int sda, int scl, uint32_t hz);
HC_IMPORT(hc_i2c_set_clock) void hc_i2c_set_clock(uint32_t hz);
HC_IMPORT(hc_i2c_end)      void hc_i2c_end(void);
HC_IMPORT(hc_i2c_write)    int  hc_i2c_write(int addr7, const uint8_t *data, uint32_t len, int sendStop);
HC_IMPORT(hc_analog_mv)    int  hc_analog_mv(int pin);
HC_IMPORT(hc_attach_interrupt) void hc_attach_interrupt(int pin, uint32_t fn, uint32_t arg, int hasArg, int mode);
HC_IMPORT(hc_detach_interrupt) void hc_detach_interrupt(int pin);
HC_IMPORT(hc_set_interrupts) void hc_set_interrupts(int on);
HC_IMPORT(hc_pulse_in)     uint32_t hc_pulse_in(int pin, int state, uint32_t timeoutUs);
HC_IMPORT(hc_serial_begin) void hc_serial_begin(int port, uint32_t baud);
HC_IMPORT(hc_serial_available) int hc_serial_available(int port);
HC_IMPORT(hc_serial_read)  int  hc_serial_read(int port, int peek);
HC_IMPORT(hc_serial_wait)  int  hc_serial_wait(int port, uint32_t timeoutMs);
HC_IMPORT(hc_serial_rx_size) uint32_t hc_serial_rx_size(int port, uint32_t size);
}

// ---- constants ----
#define HIGH 0x1
#define LOW  0x0
#define INPUT          0x01
#define OUTPUT         0x03
#define INPUT_PULLUP   0x05
#define INPUT_PULLDOWN 0x09
#define LSBFIRST 0
#define MSBFIRST 1
#define DEC 10
#define HEX 16
#define OCT 8
#define BIN 2
#define LED_BUILTIN 2

// ESP32 DevKit (variants/esp32/pins_arduino.h): default VSPI and I2C pins. SPI.begin() with no arguments and
// Wire.begin() with no arguments claim these, exactly as on the real core.
#ifdef __cplusplus
static const uint8_t SS = 5;
static const uint8_t MOSI = 23;
static const uint8_t MISO = 19;
static const uint8_t SCK = 18;
static const uint8_t SDA = 21;
static const uint8_t SCL = 22;
#endif

#ifndef PI
#define PI 3.1415926535897932384626433832795
#endif
#define HALF_PI 1.5707963267948966192313216916398
#define TWO_PI 6.283185307179586476925286766559
#define DEG_TO_RAD 0.017453292519943295769236907684886
#define RAD_TO_DEG 57.295779513082320876798154814105
#define EULER 2.718281828459045235360287471352

#define PROGMEM
#define PGM_P const char *
#define PSTR(s) (s)
#define F(s) (s)
#define IRAM_ATTR
#define DRAM_ATTR
#define RTC_DATA_ATTR
#define pgm_read_byte(addr)  (*(const unsigned char *)(addr))
#define pgm_read_word(addr)  (*(const unsigned short *)(addr))
#define pgm_read_dword(addr) (*(const unsigned long *)(addr))
#define pgm_read_float(addr) (*(const float *)(addr))
#define pgm_read_ptr(addr)   (*(void *const *)(addr))

typedef bool boolean;
typedef uint8_t byte;
typedef uint16_t word;

#define bitRead(value, bit) (((value) >> (bit)) & 0x01)
#define bitSet(value, bit) ((value) |= (1UL << (bit)))
#define bitClear(value, bit) ((value) &= ~(1UL << (bit)))
#define bitWrite(value, bit, bitvalue) ((bitvalue) ? bitSet(value, bit) : bitClear(value, bit))
#define bit(b) (1UL << (b))
#define lowByte(w) ((uint8_t)((w) & 0xff))
#define highByte(w) ((uint8_t)((w) >> 8))
#define sq(x) ((x) * (x))
#define radians(deg) ((deg) * DEG_TO_RAD)
#define degrees(rad) ((rad) * RAD_TO_DEG)
#define clockCyclesPerMicrosecond() 240L
#define microsecondsToClockCycles(a) ((a) * 240L)
#define digitalPinToInterrupt(p) (p)
#define NOT_AN_INTERRUPT -1

// interrupt modes (esp32-hal-gpio.h)
#define RISING    0x01
#define FALLING   0x02
#define CHANGE    0x03
#define ONLOW     0x04
#define ONHIGH    0x05
#define ONLOW_WE  0x0C
#define ONHIGH_WE 0x0D
// Interrupts are delivered between calls into the simulator (delay, millis, digitalRead, SPI...), which is where
// the simulator can preempt the sketch. cli()/noInterrupts() hold them back until sei()/interrupts().
#define sei() hc_set_interrupts(1)
#define cli() hc_set_interrupts(0)
#define interrupts() sei()
#define noInterrupts() cli()
typedef void (*voidFuncPtr)(void);
typedef void (*voidFuncPtrArg)(void *);
void attachInterrupt(uint8_t pin, voidFuncPtr handler, int mode);
void attachInterruptArg(uint8_t pin, voidFuncPtrArg handler, void *arg, int mode);
void detachInterrupt(uint8_t pin);

// ADC (esp32-hal-adc.h). Linear model: 0 .. full scale of the attenuation -> 0 .. 4095, then scaled to the resolution.
typedef enum { ADC_0db, ADC_2_5db, ADC_6db, ADC_11db, ADC_ATTENDB_MAX } adc_attenuation_t;
uint32_t analogReadMilliVolts(uint8_t pin);
void analogReadResolution(uint8_t bits);
void analogSetWidth(uint8_t bits);
void analogSetAttenuation(adc_attenuation_t attenuation);
void analogSetPinAttenuation(uint8_t pin, adc_attenuation_t attenuation);

// Arduino-style min/max/abs/constrain (templates for min/max so they never collide with <algorithm>-style usage)
#ifdef __cplusplus
template <typename A, typename B>
static inline auto min(A a, B b) -> decltype(a < b ? a : b) { return (a < b) ? a : b; }
template <typename A, typename B>
static inline auto max(A a, B b) -> decltype(a < b ? b : a) { return (a < b) ? b : a; }
#endif
#define constrain(amt, low, high) ((amt) < (low) ? (low) : ((amt) > (high) ? (high) : (amt)))

void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t val);
int digitalRead(uint8_t pin);
uint16_t analogRead(uint8_t pin);
void analogWrite(uint8_t pin, int value);
void delay(uint32_t ms);
void delayMicroseconds(uint32_t us);
uint32_t millis(void);
uint32_t micros(void);
unsigned long pulseIn(uint8_t pin, uint8_t state, unsigned long timeout = 1000000UL);
unsigned long pulseInLong(uint8_t pin, uint8_t state, unsigned long timeout = 1000000UL);
void yield(void);

long random(long max);
long random(long min, long max);
void randomSeed(unsigned long seed);
long map(long x, long in_min, long in_max, long out_min, long out_max);
uint16_t makeWord(uint16_t w);
uint16_t makeWord(uint8_t h, uint8_t l);
void shiftOut(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder, uint8_t val);

// ---------------- Print / Serial ----------------
class Print {
public:
  virtual ~Print() {}
  virtual size_t write(uint8_t c) = 0;
  virtual size_t write(const uint8_t *buf, size_t n) {
    size_t i = 0;
    while (i < n) i += write(buf[i]);
    return i;
  }
  size_t write(const char *s) { return s ? write((const uint8_t *)s, strlen(s)) : 0; }
  size_t write(const char *s, size_t n) { return write((const uint8_t *)s, n); }

  size_t print(const char *s) { return write(s); }
  size_t print(const String &s) { return write((const uint8_t *)s.c_str(), s.length()); }
  size_t print(const __FlashStringHelper *s) { return print(reinterpret_cast<const char *>(s)); }
  size_t print(char c) { return write((uint8_t)c); }
  size_t print(unsigned char v, int base = DEC) { return printNumber(v, base); }
  size_t print(int v, int base = DEC) { return printSigned(v, base); }
  size_t print(unsigned int v, int base = DEC) { return printNumber(v, base); }
  size_t print(long v, int base = DEC) { return printSigned(v, base); }
  size_t print(unsigned long v, int base = DEC) { return printNumber(v, base); }
  size_t print(long long v, int base = DEC) { return printSigned(v, base); }
  size_t print(unsigned long long v, int base = DEC) { return printNumber(v, base); }
  size_t print(double v, int digits = 2) { return printFloat(v, digits); }
  size_t println(void) { return write("\r\n"); }
  size_t println(const char *s) { size_t n = print(s); return n + println(); }
  size_t println(const String &s) { size_t n = print(s); return n + println(); }
  size_t println(const __FlashStringHelper *s) { size_t n = print(s); return n + println(); }
  size_t println(char c) { size_t n = print(c); return n + println(); }
  size_t println(unsigned char v, int base = DEC) { size_t n = print(v, base); return n + println(); }
  size_t println(int v, int base = DEC) { size_t n = print(v, base); return n + println(); }
  size_t println(unsigned int v, int base = DEC) { size_t n = print(v, base); return n + println(); }
  size_t println(long v, int base = DEC) { size_t n = print(v, base); return n + println(); }
  size_t println(unsigned long v, int base = DEC) { size_t n = print(v, base); return n + println(); }
  size_t println(long long v, int base = DEC) { size_t n = print(v, base); return n + println(); }
  size_t println(unsigned long long v, int base = DEC) { size_t n = print(v, base); return n + println(); }
  size_t println(double v, int digits = 2) { size_t n = print(v, digits); return n + println(); }

  size_t printf(const char *fmt, ...) __attribute__((format(printf, 2, 3))) {
    char stackBuf[256];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(stackBuf, sizeof(stackBuf), fmt, ap);
    va_end(ap);
    if (n < 0) return 0;
    if ((size_t)n < sizeof(stackBuf)) return write((const uint8_t *)stackBuf, (size_t)n);
    char *heap = (char *)malloc((size_t)n + 1);
    if (!heap) return 0;
    va_start(ap, fmt);
    vsnprintf(heap, (size_t)n + 1, fmt, ap);
    va_end(ap);
    size_t w = write((const uint8_t *)heap, (size_t)n);
    free(heap);
    return w;
  }

private:
  size_t printNumber(unsigned long long v, int base) {
    char buf[8 * sizeof(long long) + 1];
    char *p = &buf[sizeof(buf) - 1];
    *p = 0;
    if (base < 2) base = 10;
    do {
      unsigned d = (unsigned)(v % (unsigned)base);
      v /= (unsigned)base;
      *--p = (char)(d < 10 ? '0' + d : 'A' + d - 10);
    } while (v);
    return write(p);
  }
  size_t printSigned(long long v, int base) {
    if (base == 10 && v < 0) return write('-') + printNumber((unsigned long long)(-v), 10);
    return printNumber((unsigned long long)v, base);
  }
  size_t printFloat(double v, int digits) {
    char buf[64];
    int n = snprintf(buf, sizeof(buf), "%.*f", digits, v);
    return n > 0 ? write((const uint8_t *)buf, (size_t)n) : 0;
  }
};

// ---------------------------------------------------------------- Stream
// Same behaviour as the ESP32 core's Stream: 1 s default timeout, parseInt/parseFloat skip to the first digit or '-'
// and stop at the first character that does not fit, every read gives up after the timeout.
enum LookaheadMode { SKIP_ALL, SKIP_NONE, SKIP_WHITESPACE };
#define NO_IGNORE_CHAR '\x01'

class Stream : public Print {
public:
  virtual int available() = 0;
  virtual int read() = 0;
  virtual int peek() = 0;
  void setTimeout(unsigned long timeout) { _timeout = timeout; }
  unsigned long getTimeout(void) const { return _timeout; }
  bool find(const char *target);
  bool find(const uint8_t *target) { return find((const char *)target); }
  bool find(const char *target, size_t length);
  bool find(const uint8_t *target, size_t length) { return find((const char *)target, length); }
  bool find(char target) { return find(&target, 1); }
  bool findUntil(const char *target, const char *terminator);
  bool findUntil(const uint8_t *target, const char *terminator) { return findUntil((const char *)target, terminator); }
  bool findUntil(const char *target, size_t targetLen, const char *terminate, size_t termLen);
  long parseInt(LookaheadMode lookahead = SKIP_ALL, char ignore = NO_IGNORE_CHAR);
  float parseFloat(LookaheadMode lookahead = SKIP_ALL, char ignore = NO_IGNORE_CHAR);
  size_t readBytes(char *buffer, size_t length);
  size_t readBytes(uint8_t *buffer, size_t length) { return readBytes((char *)buffer, length); }
  size_t readBytesUntil(char terminator, char *buffer, size_t length);
  size_t readBytesUntil(char terminator, uint8_t *buffer, size_t length) { return readBytesUntil(terminator, (char *)buffer, length); }
  String readString();
  String readStringUntil(char terminator);

protected:
  unsigned long _timeout = 1000;
  unsigned long _startMillis = 0;
  virtual int timedRead();
  virtual int timedPeek();
  int peekNextDigit(LookaheadMode lookahead, bool detectDecimal);
  struct MultiTarget { const char *str; size_t len; size_t index; };
  int findMulti(MultiTarget *targets, int tCount);
};

// UART. Serial (UART0) receives what you type in the simulator's Serial box or what a test scripts; Serial1/Serial2
// only transmit (into the same console).
class HardwareSerial : public Stream {
public:
  explicit HardwareSerial(int port = 0) : _port(port) {}
  void begin(unsigned long baud = 115200, uint32_t config = 0, int8_t rx = -1, int8_t tx = -1) {
    (void)config; (void)rx; (void)tx;
    hc_serial_begin(_port, (uint32_t)baud);
  }
  void end() {}
  size_t write(uint8_t c) override { char ch = (char)c; hc_serial_write(&ch, 1); return 1; }
  size_t write(const uint8_t *buf, size_t n) override { hc_serial_write((const char *)buf, (uint32_t)n); return n; }
  using Print::write;
  size_t write(int n) { return write((uint8_t)n); }          // integer overloads, as in the ESP32 core
  size_t write(unsigned int n) { return write((uint8_t)n); }
  size_t write(long n) { return write((uint8_t)n); }
  size_t write(unsigned long n) { return write((uint8_t)n); }
  int available() override { return hc_serial_available(_port); }
  int read() override { return hc_serial_read(_port, 0); }
  int peek() override { return hc_serial_read(_port, 1); }
  int availableForWrite() { return 128; }
  size_t setRxBufferSize(size_t size) { return hc_serial_rx_size(_port, (uint32_t)size); }   // call before begin(), like on the ESP32
  void flush() {}
  operator bool() const { return true; }

protected:
  // wait in the simulator (virtual time) instead of spinning on millis()
  int timedRead() override { int c = read(); if (c >= 0) return c; return hc_serial_wait(_port, (uint32_t)_timeout) ? read() : -1; }
  int timedPeek() override { int c = peek(); if (c >= 0) return c; return hc_serial_wait(_port, (uint32_t)_timeout) ? peek() : -1; }

private:
  int _port;
};

extern HardwareSerial Serial;
extern HardwareSerial Serial1;
extern HardwareSerial Serial2;

#define SERIAL_8N1 0x800001c

// Minimal ESP object so sketches that print heap/chip info still build.
class EspClass {
public:
  uint32_t getFreeHeap() { return 280000; }
  uint32_t getHeapSize() { return 320000; }
  uint32_t getCpuFreqMHz() { return 240; }
  const char *getChipModel() { return "ESP32-D0WDQ6 (simulated)"; }
  uint32_t getEfuseMac() { return 0; }
  void restart() { exit(0); }
};
extern EspClass ESP;

#endif
