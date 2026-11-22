// Surenoo SOG128128A_P112 1.12" transparent OLED (SH1107G, 4-wire SPI, external VPP)
// ESP32 DevKit V1 (30-pin) + u8g2
//
// ---------------- WIRING (v1.0 main PCB, pcb/v1.0/main/holocube.kicad_sch) ----------------
// Panel FPC pin -> signal -> ESP32
//  1  VSS    -> GND (common with VPP supply ground AND USB ground!)
//  2  SI     -> GPIO23 (VSPI MOSI)   shared
//  3  SCL    -> GPIO18 (VSPI SCK)    shared
//  4  A0/DC  -> GPIO21               shared
//  5  RES    -> GPIO19               shared (MUST be a GPIO - do NOT tie to ESP32 EN pin)
//  6  CS     -> CS1..CS8 = GPIO 13, 27, 26, 25, 33, 32, 16, 17 (unique per panel)
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
#include <SPI.h>
#include "model_data.h" // must sit in THIS folder. Provides: GRID_SIZE_X/Y/Z, POINT_COUNT, MODEL_POINTS[][3] (PROGMEM)

// Display data
const uint8_t DISPLAY_COUNT = 8;

const int DISPLAY_SIZE_X = 128; // width / left-right
const int DISPLAY_SIZE_Y = DISPLAY_COUNT; // depth
const int DISPLAY_SIZE_Z = 128; // height
// Note: Origin is at Top-Left-Front corner

// Pin definitions (v1.0 main PCB)
const uint8_t PIN_SCK = 18;
const uint8_t PIN_MOSI = 23;
const uint8_t PIN_DC = 21;
const uint8_t PIN_RST = 19;
const uint8_t CS_PINS[DISPLAY_COUNT] = {13, 27, 26, 25, 33, 32, 16, 17};
const uint32_t SPI_HZ = 1000000; // 1 MHz = proven in holocube_demo.ino

// Initialize displays, full framebuffer.
// RES is shared by all panels, so ONLY displays[0] owns it: its begin() (called first) resets
// every panel once. If every object had PIN_RST, each begin() would reset the already
// initialised panels again and only the last one would stay on.
typedef U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI Panel;
Panel displays[DISPLAY_COUNT] = {
  Panel(U8G2_R0, CS_PINS[0], PIN_DC, PIN_RST),
  Panel(U8G2_R0, CS_PINS[1], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[2], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[3], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[4], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[5], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[6], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[7], PIN_DC, U8X8_PIN_NONE)
};

void setup() {
  Serial.begin(115200);

  // Must come before the first begin(). u8g2's default SPI.begin() would attach MISO to GPIO19,
  // which is RES on this PCB. (Passing -1 for MISO keeps GPIO19 a plain output.)
  SPI.begin(PIN_SCK, -1, PIN_MOSI, -1);

  if (GRID_SIZE_X <= DISPLAY_SIZE_X && GRID_SIZE_Y <= DISPLAY_SIZE_Y && GRID_SIZE_Z <= DISPLAY_SIZE_Z) { // model size check
    // Init
    for (uint8_t i = 0; i < DISPLAY_COUNT; i++) {
      displays[i].setBusClock(SPI_HZ); // before begin()
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
  // Heartbeat: XOR a box on displays[0] so the loop is visibly alive. No clearBuffer() here -
  // that would wipe the model layer that renderDisplays() drew on this panel.
  displays[0].setDrawColor(2); // XOR
  displays[0].drawBox(60, 100, 8, 8);
  displays[0].setDrawColor(1);
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
    uint8_t x = pgm_read_byte(&MODEL_POINTS[i][0]);
    uint8_t y = pgm_read_byte(&MODEL_POINTS[i][1]); // depth -> which display
    uint8_t z = pgm_read_byte(&MODEL_POINTS[i][2]); // height -> pixel row

    if (y < DISPLAY_COUNT) displays[y].drawPixel(x, z);
  }

  // Send buffer
  for (uint8_t i = 0; i < DISPLAY_COUNT; i++) {
    displays[i].sendBuffer();
  }
}
