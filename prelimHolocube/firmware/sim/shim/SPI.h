#ifndef HOLOCUBE_SIM_SPI_H
#define HOLOCUBE_SIM_SPI_H

#include "Arduino.h"

#define SPI_MODE0 0
#define SPI_MODE1 1
#define SPI_MODE2 2
#define SPI_MODE3 3
#define VSPI 3
#define HSPI 2
#define FSPI 1
#define SPI_CLOCK_DIV2 2
#define SPI_CLOCK_DIV4 4
#define SPI_CLOCK_DIV8 8

class SPISettings {
public:
  SPISettings() : _clock(1000000), _bitOrder(MSBFIRST), _dataMode(SPI_MODE0) {}
  SPISettings(uint32_t clock, uint8_t bitOrder, uint8_t dataMode)
      : _clock(clock), _bitOrder(bitOrder), _dataMode(dataMode) {}
  uint32_t _clock;
  uint8_t _bitOrder;
  uint8_t _dataMode;
};

// Write-only SPI master. MISO is never driven, transfer() returns 0xFF like a floating bus.
class SPIClass {
public:
  SPIClass(uint8_t bus = VSPI) { (void)bus; }
  void begin(int8_t sck = -1, int8_t miso = -1, int8_t mosi = -1, int8_t ss = -1) {
    hc_spi_begin(sck, miso, mosi, ss);
  }
  void end() { hc_spi_end(); }
  void beginTransaction(SPISettings s) { hc_spi_begin_tx(s._clock, s._bitOrder, s._dataMode); }
  void endTransaction() { hc_spi_end_tx(); }
  void setFrequency(uint32_t hz) { hc_spi_set_clock(hz); }
  void setDataMode(uint8_t) {}
  void setBitOrder(uint8_t) {}
  void setHwCs(bool) {}
  uint8_t transfer(uint8_t b) { return (uint8_t)hc_spi_transfer(b); }
  uint16_t transfer16(uint16_t w) {
    hc_spi_transfer((w >> 8) & 0xFF);
    hc_spi_transfer(w & 0xFF);
    return 0xFFFF;
  }
  void transfer(void *buf, uint32_t n) { hc_spi_write((const uint8_t *)buf, n); }
  void transferBytes(const uint8_t *tx, uint8_t *rx, uint32_t n) {
    if (tx) hc_spi_write(tx, n);
    if (rx) memset(rx, 0xFF, n);
  }
  void write(uint8_t b) { hc_spi_transfer(b); }
  void write16(uint16_t w) { transfer16(w); }
  void write32(uint32_t w) {
    hc_spi_transfer((w >> 24) & 0xFF); hc_spi_transfer((w >> 16) & 0xFF);
    hc_spi_transfer((w >> 8) & 0xFF);  hc_spi_transfer(w & 0xFF);
  }
  void writeBytes(const uint8_t *data, uint32_t n) { hc_spi_write(data, n); }
  void writePixels(const void *data, uint32_t bytes) { hc_spi_write((const uint8_t *)data, bytes); }
  void writePattern(const uint8_t *data, uint8_t size, uint32_t repeat) {
    for (uint32_t i = 0; i < repeat; i++) hc_spi_write(data, size);
  }
};

extern SPIClass SPI;

#endif
