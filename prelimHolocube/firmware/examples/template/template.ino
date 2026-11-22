// holocube u8g2 template - v1.0 main PCB, 7 panels (SH1107, 128x128, 4-wire HW SPI)
//   SI -> GPIO23, SCL -> GPIO18, A0/DC -> GPIO21, RES -> GPIO19 (all shared)
//   CS1..CS7 -> GPIO 13, 27, 26, 25, 33, 32, 16   (CS8 -> GPIO17, unused)
//
// Format: include/define libraries and constants; declare and initialize u8g2 objects; begin serial; hold cs high; begin SPI; (for every panel) set clock, u8g2 begin, dc-dc off, set contrast; draw by doing clearBuffer(), drawing methods, sendBuffer(); define any methods.


// ---------------- Libraries ----------------

#include <U8g2lib.h>
#include <SPI.h>


// ---------------- Constants ----------------

// Configuration
#define SPI_HZ    1000000   // Clock speed; 1 MHz = proven speed
#define CONTRAST  0xA2      // Panel contrast; 0x00..0xFF

// Pinouts
#define PIN_SCK   18
#define PIN_MOSI  23
#define PIN_DC    21
#define PIN_RST   19
#define PIN_CS8   17  // not used here
#define NUM_PANELS 7  // eighth panel not used

// Chip select pins
const uint8_t CS_PINS[NUM_PANELS] = {13, 27, 26, 25, 33, 32, 16};


// ---------------- U8G2 Objects ----------------

// Declare and init u8g2 objects.
typedef U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI Panel;  // proven working constructor
Panel panels[NUM_PANELS] = {
  Panel(U8G2_R0, CS_PINS[0], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[1], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[2], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[3], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[4], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[5], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[6], PIN_DC, U8X8_PIN_NONE),
};


// ---------------- Setup ----------------

void setup() {
  Serial.begin(115200); // ESP32 clock speed (Arduino = 9600 baud)

  // Set pin modes; CS idles HIGH to avoid activating all panels.
  pinMode_all();

  // Explicit pins keep MISO off GPIO19 (= RES).
  SPI.begin(PIN_SCK, -1, PIN_MOSI, -1);

  // One manual reset pulse for all panels.
  reset_all();

  // Initialize all panels (except #8).
  for (uint8_t i = 0; i < NUM_PANELS; i++) {
    panels[i].setBusClock(SPI_HZ);        // before begin()
    panels[i].begin();                    // init, clear RAM, display on
    panels[i].sendF("ca", 0xAD, 0x8A);    // internal DC-DC off (VPP is external)
    panels[i].setContrast(CONTRAST);
  }

  Serial.println("Panels initialized");
}


// ---------------- Loop ----------------

void loop() {
  // for each panel: clearBuffer(), draw, sendBuffer()
}


// ---------------- Draw Methods ----------------

// Functions guide: https://github.com/olikraus/u8g2/wiki/u8g2reference#drawframe

// Clears one panel to black.
void blank(uint8_t i) {
  panels[i].clearBuffer();
  panels[i].sendBuffer();
}


// ---------------- Helper Methods ----------------

// Declares the pinMode for all pins.
void pinMode_all() {
  for (uint8_t i = 0; i < NUM_PANELS; i++) { digitalWrite(CS_PINS[i], HIGH); pinMode(CS_PINS[i], OUTPUT); } // CS and RES idle HIGH: write the level first so the pin never glitches LOW when it becomes an output.
  digitalWrite(PIN_CS8, HIGH); pinMode(PIN_CS8, OUTPUT);
  digitalWrite(PIN_RST, HIGH); pinMode(PIN_RST, OUTPUT);
  pinMode(PIN_DC, OUTPUT);
}

// Chip select LOW (activated) for all panels.
void select_all() {
  for (uint8_t i = 0; i < NUM_PANELS; i++) { pinMode(CS_PINS[i], OUTPUT); digitalWrite(CS_PINS[i], LOW); }
  pinMode(PIN_CS8, OUTPUT); digitalWrite(PIN_CS8, LOW);
}

// Chip select HIGH (deactivated) for all panels.
void deselect_all() {
  for (uint8_t i = 0; i < NUM_PANELS; i++) { pinMode(CS_PINS[i], OUTPUT); digitalWrite(CS_PINS[i], HIGH); }
  pinMode(PIN_CS8, OUTPUT); digitalWrite(PIN_CS8, HIGH);
}

// Pulses reset pin which is attached to all pins through hardware.
void reset_all() {
  digitalWrite(PIN_RST, LOW);  delay(100);
  digitalWrite(PIN_RST, HIGH); delay(100);
}