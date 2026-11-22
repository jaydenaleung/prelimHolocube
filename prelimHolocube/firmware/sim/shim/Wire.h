// I2C master (ESP32 TwoWire subset). Each endTransmission() is handed to the simulator as one I2C write
// transaction; SH1107 panels mapped in pins.json ("i2c": {"0x3C": 1}) receive it. Reads return nothing.
#ifndef HOLOCUBE_SIM_WIRE_H
#define HOLOCUBE_SIM_WIRE_H

#include "Arduino.h"

#ifndef I2C_BUFFER_LENGTH
#define I2C_BUFFER_LENGTH 128   // same as the ESP32 core
#endif

class TwoWire : public Print {
public:
  explicit TwoWire(uint8_t bus = 0) : _bus(bus) {}
  bool begin(int sda = -1, int scl = -1, uint32_t frequency = 0) {
    hc_i2c_begin(sda, scl, frequency ? frequency : 100000u);
    return true;
  }
  bool begin(uint8_t address, int sda, int scl, uint32_t frequency) { (void)address; return begin(sda, scl, frequency); }
  bool end() { hc_i2c_end(); return true; }
  bool setClock(uint32_t frequency) { hc_i2c_set_clock(frequency); return true; }
  uint32_t getClock() { return 100000u; }
  uint8_t getBusNum() { return _bus; }
  void setTimeOut(uint16_t) {}
  void beginTransmission(uint16_t address) { _addr = address; _len = 0; _overflow = false; }
  void beginTransmission(uint8_t address) { beginTransmission((uint16_t)address); }
  void beginTransmission(int address) { beginTransmission((uint16_t)address); }
  uint8_t endTransmission(bool sendStop = true) {
    if (_overflow) return 1;   // "data too long to fit in transmit buffer", like the real core
    return (uint8_t)hc_i2c_write(_addr, _buf, _len, sendStop ? 1 : 0);
  }
  uint8_t endTransmission(uint8_t sendStop) { return endTransmission(sendStop != 0); }
  size_t write(uint8_t c) override {
    if (_len >= I2C_BUFFER_LENGTH) { _overflow = true; return 0; }
    _buf[_len++] = c;
    return 1;
  }
  size_t write(const uint8_t *data, size_t n) override {
    size_t i = 0;
    while (i < n && write(data[i])) i++;
    return i;
  }
  using Print::write;
  // integer overloads, as in the ESP32 core (so Wire.write(0x00) is not ambiguous with write(const char*))
  size_t write(int n) { return write((uint8_t)n); }
  size_t write(unsigned int n) { return write((uint8_t)n); }
  size_t write(long n) { return write((uint8_t)n); }
  size_t write(unsigned long n) { return write((uint8_t)n); }
  size_t requestFrom(uint16_t, size_t, bool = true) { return 0; }
  uint8_t requestFrom(uint8_t, uint8_t, uint8_t = 1) { return 0; }
  uint8_t requestFrom(int, int, int = 1) { return 0; }
  int available() { return 0; }
  int read() { return -1; }
  int peek() { return -1; }
  void flush() {}
  void onReceive(void (*)(int)) {}
  void onRequest(void (*)(void)) {}

private:
  uint8_t _bus;
  uint16_t _addr = 0;
  uint8_t _buf[I2C_BUFFER_LENGTH];
  size_t _len = 0;
  bool _overflow = false;
};

extern TwoWire Wire;
extern TwoWire Wire1;

#endif
