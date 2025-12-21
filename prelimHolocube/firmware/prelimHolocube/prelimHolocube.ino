#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>
#include <SPI.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 128

// // Arduino
// #define OLED_MOSI 11
// #define OLED_CLK  13
// #define OLED_DC   5
// #define OLED_CS   10
// #define OLED_RST  4

// ESP32
#define OLED_MOSI 23
#define OLED_CLK  18
#define OLED_DC   21
#define OLED_CS   5
#define OLED_RST  22

Adafruit_SH1107 display(SCREEN_WIDTH, SCREEN_HEIGHT, &SPI, OLED_DC, OLED_RST, OLED_CS, 2000000UL);

void setup() {
  Serial.begin(115200);

  SPI.begin(OLED_CLK, -1, OLED_MOSI, OLED_CS);
  SPI.setFrequency(100000);  // 100 kHz
  SPI.setDataMode(SPI_MODE0);
  SPI.setBitOrder(MSBFIRST);
  
  delay(10000);

  display.begin(0, true); // 0x3D because it's not a 128x32 display
  display.clearDisplay();
  display.setRotation(0);
}

void loop() {
  // Re-draw your content
  display.clearDisplay();

  display.drawRect(10, 10, 50, 30, SH110X_WHITE);
  display.fillCircle(90, 30, 15, SH110X_WHITE);

  display.setTextSize(1);
  display.setTextColor(SH110X_WHITE);
  display.setCursor(10, 60);
  display.println("Hello OLED!");

  // Send buffer to screen again
  display.display();

  // Optional delay — adjust this to control SPI frequency
  delay(200); // refresh twice per second
}


// #include <U8g2lib.h>
// #include <SPI.h>
// #include <WiFi.h>

// #define OLED_CS   5
// #define OLED_DC   21
// #define OLED_RST  22

// // Use Pimoroni variant constructor
// U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI u8g2(U8G2_R0, OLED_CS, OLED_DC, OLED_RST);

// void setup() {
//   Serial.begin(115200);

//   #ifdef ESP32
//   btStop();
//   WiFi.mode(WIFI_OFF);
//   WiFi.disconnect(true);
//   #endif

//   SPI.begin(OLED_CLK, -1, OLED_MOSI, OLED_CS);
//   SPI.setFrequency(2000000);  // 2 MHz
//   SPI.setDataMode(SPI_MODE0);
//   SPI.setBitOrder(MSBFIRST);

//   delay(10000);
  
//   Serial.println("Starting U8g2 initialization...");
  
//   // Initialize display
//   u8g2.begin();
  
//   // Optional: set SPI speed
//   u8g2.setBusClock(2000000);  // 2 MHz
  
//   Serial.println("Display ready!");
  
//   // Draw test pattern
//   u8g2.clearBuffer();
  
//   // Draw border
//   u8g2.drawFrame(0, 0, 128, 128);
  
//   // Draw text
//   u8g2.setFont(u8g2_font_ncenB10_tr);
//   u8g2.drawStr(15, 30, "SH1107 Test");
  
//   u8g2.setFont(u8g2_font_ncenB08_tr);
//   u8g2.drawStr(25, 50, "U8g2 Library");
//   u8g2.drawStr(20, 70, "128x128 OLED");
  
//   // Draw some shapes
//   u8g2.drawCircle(64, 96, 20);
//   u8g2.drawLine(20, 110, 108, 110);
  
//   u8g2.sendBuffer();
// }

// void loop() {
//   delay(1000);
// }


/*
 * SH1107 128x128 OLED Display - Precise Bit-Bang SPI Implementation
 * Following exact timing specifications from datasheet pages 13-14
 * 
 * Timing Requirements (VDD = 2.4-3.5V):
 * - Clock cycle: Min 100ns (Max 10MHz)
 * - Clock HIGH: Min 40ns
 * - Clock LOW: Min 40ns
 * - Data setup: Min 40ns
 * - Data hold: Min 20ns
 * - CS setup: Min 40ns
 * - CS hold: Min 40ns
 * - DC setup: Min 40ns
 * - Reset pulse: Min 3μs
 * - Reset to command: Min 3μs
 */

// #include <SPI.h>

// // Pin definitions for ESP32
// #define OLED_MOSI 23  // SI (Serial Input)
// #define OLED_SCK  18  // SCL (Serial Clock)
// #define OLED_CS   5   // CS (Chip Select, active LOW)
// #define OLED_DC   21  // A0/DC (0=Command, 1=Data)
// #define OLED_RST  22  // RES (Reset, active LOW)

// void setup() {
//   Serial.begin(115200);

  

//   SPIClass vspi(VSPI);
  
//   vspi.begin(OLED_SCK, -1, OLED_MOSI, OLED_CS);
//   vspi.beginTransaction(SPISettings(2000000, MSBFIRST, SPI_MODE0));

//   delay(10000);
//   vspi.transfer(0x55);
//   vspi.endTransaction();
// }

// void loop() {

// }