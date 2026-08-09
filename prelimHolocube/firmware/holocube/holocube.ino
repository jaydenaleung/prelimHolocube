// Surenoo SOG128128A_P112 1.12" transparent OLED (SH1107G, 4-wire SPI, external VPP)
// ESP32 DevKit V1 (30-pin) + u8g2
//
// ---------------- WIRING (single-panel bring-up) ----------------
// Panel FPC pin -> signal -> ESP32
//  1  VSS    -> GND (common with VPP supply ground AND USB ground!)
//  2  SI     -> GPIO23 (VSPI MOSI)
//  3  SCL    -> GPIO18 (VSPI SCK)
//  4  A0/DC  -> GPIO16   (any GPIO; can be SHARED by all 8 panels later)
//  5  RES    -> GPIO4   (MUST be a GPIO - do NOT tie to ESP32 EN pin)
//  6  CS     -> GPIO17  (unique per panel)
//  7  IREF   -> 1M 1% resistor to GND
//  8  VDD    -> 3.3V (ESP32 3V3), 1uF ceramic to GND at the pin
//  9  VSS    -> GND
// 10  VCOMH  -> 4.7uF (>=25V) to GND  (cap only, nothing else)
// 11  VPP    -> +13.5V REGULATED (7..16.5V operating, 17V ABS MAX),
//               4.7uF (>=25V) + 100nF to GND at the pin
// 12  VSS    -> GND
//
// Power-up order (datasheet p.15): VDD+VPP on while RES held low >=10us,
// then RES high, init, 0xAF. u8g2 handles this if RES is on a GPIO.
// Power-down: display off / VPP off first, then VDD (~100ms later).
// -----------------------------------------------------------------

#include <U8g2lib.h>
#include "model_data.h" // variables and methods automatically loaded and usable: MODEL_SIZE_X/Y/Z, MODEL_POINTS[][], POINT_COUNT

// Display data
const uint8_t DISPLAY_COUNT = 8;

const int DISPLAY_SIZE_X = 128; // width / left-right
const uint8_t DISPLAY_SIZE_Y = DISPLAY_COUNT; // depth
const int DISPLAY_SIZE_Z = 128; // height
// Note: Origin is at Top-Left-Front corner

// Pin definitions
const uint8_t PIN_DC = 16
const uint8_t PIN_RST = 4
const uint8_t CS_PINS[DISPLAY_COUNT] = {17, 5, 18, 19, 21, 22, 23, 25};

// Initialize displays, full framebuffer
U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI displays[DISPLAY_COUNT] = {
  U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[0], PIN_DC, PIN_RST),
  U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[1], PIN_DC, PIN_RST),
  U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[2], PIN_DC, PIN_RST),
  U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[3], PIN_DC, PIN_RST),
  U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[4], PIN_DC, PIN_RST),
  U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[5], PIN_DC, PIN_RST),
  U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[6], PIN_DC, PIN_RST),
  U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI(U8G2_R0, CS_PINS[7], PIN_DC, PIN_RST)
};

void setup() {
  Serial.begin(115200);

  if (MODEL_SIZE_X <= DISPLAY_SIZE_X && MODEL_SIZE_Y <= DISPLAY_SIZE_Y && MODEL_SIZE_Z <= DISPLAY_SIZE_Z) { // model size check
    // Init
    for (uint8_t i = 0; i < DISPLAY_COUNT; i++) {
      displays[i].begin();
      displays[i].sendF("ca", 0xAD, 0x8A); // turn off internal DC-DC
      displays[i].setContrast(0xA2); // normal contrast
    }

    Serial.println("Displays initialized");
    
    // Render
    renderDisplays();

    Serial.println("Displays rendered");

  } else {
    Serial.println("Error: Model size exceeds display size.");
  }
}

void loop() {
  // blink a pixel so you can tell the loop is alive
  static bool on = false;
  on = !on;
  displays[0].clearBuffer(); // needs?
  displays[0].setDrawColor(on ? 1 : 0);
  displays[0].drawBox(60, 100, 8, 8);
  displays[0].sendBuffer();
  delay(500);
}

void renderDisplays() {
  // Clear buffer
  for (uint8_t i = 0; i < DISPLAY_COUNT; i++) {
      displays[i].clearBuffer();
  }

  // Extract point data and draw points
  for (uint8_t i = 0; i < POINT_COUNT; i++) {
    uint8_t x = MODEL_POINTS[POINT_COUNT][0];
    uint8_t y = MODEL_POINTS[POINT_COUNT][1];
    uint8_t z = MODEL_POINTS[POINT_COUNT][2];

    displays[y].drawPixel(x,z);
  }

  // Send buffer
  for (uint8_t i = 0; i < DISPLAY_COUNT; i++) {
    displays[i].sendBuffer();
  }
}
