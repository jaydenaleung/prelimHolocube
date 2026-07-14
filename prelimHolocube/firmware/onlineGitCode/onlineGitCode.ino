// SOG128128A_Firmware.ino
// ESP32 + SOG128128A_T112 (SH1107) SPI OLED: receive 1bpp frames over UART and display.
//
// SPI CLK  - GPIO_18
// SPI MOSI - GPIO_23
// CS       - GPIO_16
// A0 (D/C) - GPIO_17
// RES      - GPIO_21

#include <SPI.h>

const int8_t _a0  = 17;   // D/C (A0)
const int8_t _cs  = 16;   // Chip select (active low)
const int8_t _rst = 21;   // Reset (active low)

static constexpr uint8_t OLED_W = 128;
static constexpr uint8_t OLED_H = 128;
static constexpr uint8_t OLED_PAGES = OLED_H / 8;
static constexpr uint32_t FRAME_BYTES = (OLED_W * OLED_H) / 8;

static SPISettings oledSpi(10000000, MSBFIRST, SPI_MODE0); // SH1107 SPI typically mode 0

static uint8_t frameBuf[OLED_PAGES][OLED_W];

static bool specialChar = false;
static bool inFrame = false;
static uint32_t byte_index = 0;
static uint32_t frameCount = 0;
static uint32_t missedFrames = 0;
static uint32_t lastStatMs = 0;
static uint32_t bytesPerSec = 0;


static inline void csLow()
{
  digitalWrite(_cs, LOW);
}

static inline void csHigh()
{
  digitalWrite(_cs, HIGH);
}

static void oledWriteCommand(uint8_t cmd)
{
  SPI.beginTransaction(oledSpi);
  csLow();
  digitalWrite(_a0, LOW);
  SPI.transfer(cmd);
  csHigh();
  SPI.endTransaction();
}

static void oledWriteData(const uint8_t* data, size_t n)
{
  SPI.beginTransaction(oledSpi);
  csLow();
  digitalWrite(_a0, HIGH);
  while (n--) SPI.transfer(*data++);
  csHigh();
  SPI.endTransaction();
}

static void oledReset()
{
  digitalWrite(_rst, HIGH);
  delay(10);
  digitalWrite(_rst, LOW);
  delay(50);
  digitalWrite(_rst, HIGH);
  delay(100);
}

static void OLED_SetInitCode()
{
  oledWriteCommand(0xAE); // Display OFF
  oledWriteCommand(0x20); // Page addressing mode
  oledWriteCommand(0x10); // column high = 0
  oledWriteCommand(0x00); // column low  = 0
  oledWriteCommand(0xB0); // page start address

  oledWriteCommand(0xA8);
  oledWriteCommand(0x7F); // 128MUX

  oledWriteCommand(0xA1); // Segment remap (flip X)
  oledWriteCommand(0xC8); // COM scan direction (flip Y)

  oledWriteCommand(0x81);
  oledWriteCommand(0xA0); // Contrast

  oledWriteCommand(0xAD);
  oledWriteCommand(0x80); // DC-DC on when display on

  oledWriteCommand(0xA4); // Display follows RAM
  oledWriteCommand(0xA6); // Normal display

  oledWriteCommand(0xD5);
  oledWriteCommand(0x50); // Display clock divide

  oledWriteCommand(0xD9);
  oledWriteCommand(0x25); // Pre-charge

  oledWriteCommand(0xDB);
  oledWriteCommand(0x30); // VCOMH

  oledWriteCommand(0xAF); // Display ON
}

static void oledSetPageCol(uint8_t page, uint8_t col)
{
  oledWriteCommand(0xB0 | (page & 0x0F));
  oledWriteCommand(0x00 | (col & 0x0F));
  oledWriteCommand(0x10 | ((col >> 4) & 0x0F));
}

static void oledClear()
{
  uint8_t zeros[OLED_W];
  memset(zeros, 0x00, sizeof(zeros));
  for (uint8_t p = 0; p < OLED_PAGES; p++)
  {
    oledSetPageCol(p, 0);
    oledWriteData(zeros, sizeof(zeros));
  }
}

static void oledRenderBuffer()
{
  for (uint8_t p = 0; p < OLED_PAGES; p++)
  {
    oledSetPageCol(p, 0);
    oledWriteData(frameBuf[p], OLED_W);
  }
}

void setup()
{
  Serial.begin(460800);
  //Serial.begin(921600);
  Serial.setRxBufferSize(8192);
  Serial.setTxBufferSize(1024);
  delay(200);

  pinMode(_a0, OUTPUT);
  pinMode(_cs, OUTPUT);
  pinMode(_rst, OUTPUT);

  csHigh();
  digitalWrite(_a0, LOW);
  digitalWrite(_rst, HIGH);

  SPI.begin();
  oledReset();
  OLED_SetInitCode();
  oledClear();

  Serial.println("ESP32 VideoOverUART ready.");
}


void loop()
{
  while (Serial.available() > 0)
  {
    int c = Serial.read();
    bytesPerSec++;
    if (c < 0) 
    {
      continue;
    }
    uint8_t b = (uint8_t)c;
    
    if (!specialChar && b == 0x69)
    {
      specialChar = true;
      continue;
    }

    if (specialChar)
    {
      specialChar = false;
      if (b == 0x01)
      {
        if (inFrame && byte_index > 0 && byte_index < FRAME_BYTES)
        {
          missedFrames++;
        }
        byte_index = 0;
        inFrame = true;
        continue;
      }
    }

    if (!inFrame)
    {
      continue;
    }

    if (byte_index < FRAME_BYTES)
    {
      frameBuf[byte_index / OLED_W][byte_index % OLED_W] = b;
      byte_index++;
      if (byte_index >= FRAME_BYTES)
      {
        oledRenderBuffer();
        frameCount++;
        inFrame = false;
      }
    }
  }

  uint32_t now = millis();
  uint32_t elapsedMs = now - lastStatMs;
  if (elapsedMs >= 1000)
  {
    uint32_t fps = (elapsedMs > 0) ? (frameCount * 1000UL / elapsedMs) : 0;
    Serial.print("Missed frames per sec: ");
    Serial.println(missedFrames);
    
    Serial.print("FPS: ");
    Serial.println(fps);

    Serial.print("BPS: ");
    Serial.println(bytesPerSec);
    
    frameCount = 0;
    missedFrames = 0;
    bytesPerSec = 0;
    lastStatMs = now;
  }
}
