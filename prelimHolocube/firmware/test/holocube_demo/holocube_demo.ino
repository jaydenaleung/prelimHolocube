// Surenoo SOG128128A_P112 1.12" transparent OLED (SH1107G, 4-wire SPI, external VPP)
// ESP32 DevKit V1 (30-pin), raw SPI (no u8g2) - 7 stacked panels used (board 8 unused)
//
// ---------------- WIRING (single-panel bring-up) ----------------
// Panel FPC pin -> signal -> ESP32
//  1  VSS    -> GND (common with VPP supply ground AND USB ground!)
//  2  SI     -> GPIO23 (VSPI MOSI)
//  3  SCL    -> GPIO18 (VSPI SCK)
//  4  A0/DC  -> GPIO16 (RX2) (any GPIO; can be SHARED by all 8 panels later)
//  5  RES    -> GPIO4  (MUST be a GPIO - do NOT tie to ESP32 EN pin)
//  6  CS     -> GPIO17 (TX2) (unique per panel)
//  7  IREF   -> 1M 1% resistor to GND
//  8  VDD    -> 3.3V (ESP32 3V3), 1uF ceramic to GND at the pin
//  9  VSS    -> GND
// 10  VCOMH  -> 4.7uF (>=25V) to GND  (cap only, nothing else)
// 11  VPP    -> +13.5V REGULATED (7..16.5V operating, 17V ABS MAX),
//               4.7uF (>=25V) to GND at the pin
// 12  VSS    -> GND
//
// Power-up order (datasheet p.15): VDD+VPP on while RES held low >=10us,
// then RES high, init, 0xAF.
// -----------------------------------------------------------------
//
// SEQUENCE (repeats forever):
//   1. "MIT" / "Maker" / "Portfolio" on displays 5-7   -> 10 s
//   2. 3D axes (X, Y, Z) with ticks, numbers, labels    -> 10 s
//   3. axes + largest sphere as a uniform point cloud   -> 10 s
//
// COORDINATES: x = column (0..127), y = row (0..127, down), z = display
// number (display 1 = layer 0 ... display 7 = layer 6).
// Axes origin = centre of display 4 (x=64, y=64, layer 3); each axis runs
// -3..+3 units, 1 unit = one display spacing.
// Every display keeps its own RAM, so all 7 stay ON the whole time.


#include <SPI.h>


#define PIN_CS   13   // board 1
#define PIN_CS2  27   // board 2
#define PIN_CS3  26   // board 3
#define PIN_CS4  25   // board 4
#define PIN_CS5  33   // board 5
#define PIN_CS6  32   // board 6
#define PIN_CS7  16   // board 7
//      PIN_CS8  17   // board 8 - not used
#define PIN_DC   21
#define PIN_RST  19

#define NUM_PANELS 7
const uint8_t cs_pins[NUM_PANELS] = {PIN_CS, PIN_CS2, PIN_CS3, PIN_CS4, PIN_CS5, PIN_CS6, PIN_CS7};

// ---- PHYSICAL GEOMETRY ----
#define PX_PITCH_MM     0.1573f   // 20.14 mm active area / 128 px (datasheet)
#define LAYER_PITCH_MM  2.5f      // distance between neighbouring displays (centre to centre)

#define HOLD_MS    10000   // each scene stays up this long
#define MIRROR_X   0       // set to 1 if x is flipped (board's left/right comes out mirrored)
#define TEXT_FIRST 4       // display 5  (layer index 4)
#define TEXT_LAST  6       // display 7  (layer index 6)
#define POINT_PX   2       // sphere points are POINT_PX x POINT_PX pixel blocks

// One 128x128 1-bit framebuffer per display: 16 pages x 128 columns
uint8_t fb[NUM_PANELS][16][128];

int TICK_PX;                     // pixels per axis unit (= one display spacing), set in compute_geometry
const int CX = 64, CY = 64;      // axes origin = centre of display 4
const int MID = 3;               // display 4 = layer index 3


// ---------------- 5x7 font (columns, bit0 = top row) ----------------
struct Glyph { char c; uint8_t col[5]; };
const Glyph font[] = {
  {' ', {0x00, 0x00, 0x00, 0x00, 0x00}},
  {'M', {0x7F, 0x02, 0x0C, 0x02, 0x7F}},
  {'I', {0x00, 0x41, 0x7F, 0x41, 0x00}},
  {'T', {0x01, 0x01, 0x7F, 0x01, 0x01}},
  {'P', {0x7F, 0x09, 0x09, 0x09, 0x06}},
  {'X', {0x63, 0x14, 0x08, 0x14, 0x63}},
  {'Y', {0x03, 0x04, 0x78, 0x04, 0x03}},
  {'Z', {0x61, 0x51, 0x49, 0x45, 0x43}},
  {'a', {0x20, 0x54, 0x54, 0x54, 0x78}},
  {'e', {0x38, 0x54, 0x54, 0x54, 0x18}},
  {'f', {0x08, 0x7E, 0x09, 0x01, 0x02}},
  {'i', {0x00, 0x44, 0x7D, 0x40, 0x00}},
  {'k', {0x7F, 0x10, 0x28, 0x44, 0x00}},
  {'l', {0x00, 0x41, 0x7F, 0x40, 0x00}},
  {'o', {0x38, 0x44, 0x44, 0x44, 0x38}},
  {'r', {0x7C, 0x08, 0x04, 0x04, 0x08}},
  {'t', {0x04, 0x3F, 0x44, 0x40, 0x20}},
};

// ---------------- tiny 3x5 font for tick numbers (rows, bit2 = left pixel) ----------------
struct TinyGlyph { char c; uint8_t row[5]; };
const TinyGlyph tiny[] = {
  {'0', {7, 5, 5, 5, 7}},
  {'1', {2, 6, 2, 2, 7}},
  {'2', {7, 1, 7, 4, 7}},
  {'3', {7, 1, 7, 1, 7}},
  {'-', {0, 0, 7, 0, 0}},
};


void setup() {
  Serial.begin(115200);

  Serial.println("Pre-delay boot");
  delay(5000);
  Serial.println("Post-delay boot");

  compute_geometry();
  init_panels();
}


void loop() {
  // 1. text on displays 5-7
  clear_all();
  scene_text();
  push_all();
  Serial.println("Scene 1: text");
  delay(HOLD_MS);

  // 2. axes
  clear_all();
  scene_axes();
  push_all();
  Serial.println("Scene 2: axes");
  delay(HOLD_MS);

  // 3. axes + sphere
  clear_all();
  scene_axes();
  scene_sphere();
  push_all();
  Serial.println("Scene 3: sphere");
  delay(HOLD_MS);
}


// ---------------- low-level SPI helpers ----------------

void send_cmds(uint8_t cs, const uint8_t *cmds, size_t n) {
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(PIN_DC, LOW);   // command mode
  digitalWrite(cs, LOW);
  for (size_t i = 0; i < n; i++) SPI.transfer(cmds[i]);
  digitalWrite(cs, HIGH);
  SPI.endTransaction();
}

void send_frame(uint8_t cs, uint8_t buf[16][128]) {
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  for (int page = 0; page < 16; page++) {
    digitalWrite(PIN_DC, LOW);   // command mode: set page + column 0
    digitalWrite(cs, LOW);
    SPI.transfer(0xB0 | page);   // page address
    SPI.transfer(0x00);          // column low nibble  = 0
    SPI.transfer(0x10);          // column high nibble = 0
    digitalWrite(PIN_DC, HIGH);  // data mode: 128 bytes for this page
    SPI.writeBytes(buf[page], 128);
    digitalWrite(cs, HIGH);
  }
  SPI.endTransaction();
}

void push_all() {
  for (int i = 0; i < NUM_PANELS; i++) send_frame(cs_pins[i], fb[i]);
}

void clear_all() {
  memset(fb, 0, sizeof(fb));
}

// ---------------- drawing primitives ----------------

void set_px(int layer, int x, int y) {
  if (layer < 0 || layer >= NUM_PANELS) return;
  if (x < 0 || x > 127 || y < 0 || y > 127) return;
  if (MIRROR_X) x = 127 - x;
  fb[layer][y >> 3][x] |= (1 << (y & 7));
}

void block(int layer, int x, int y, int w, int h) {
  for (int dy = 0; dy < h; dy++)
    for (int dx = 0; dx < w; dx++) set_px(layer, x + dx, y + dy);
}

void hline(int layer, int x0, int x1, int y) {
  for (int x = x0; x <= x1; x++) set_px(layer, x, y);
}

void vline(int layer, int x, int y0, int y1) {
  for (int y = y0; y <= y1; y++) set_px(layer, x, y);
}

// 5x7 character, each font pixel drawn as an (sx+bold) x (sy+bold) block -> bold > 0 fattens strokes
void draw_char(int layer, int x, int y, char c, int sx, int sy, int bold) {
  for (size_t g = 0; g < sizeof(font) / sizeof(font[0]); g++) {
    if (font[g].c != c) continue;
    for (int col = 0; col < 5; col++)
      for (int row = 0; row < 7; row++)
        if ((font[g].col[col] >> row) & 1)
          block(layer, x + col * sx, y + row * sy, sx + bold, sy + bold);
    return;
  }
}

// Horizontally centred text, drawn on one layer
void draw_text_centered(int layer, int y, const char *s, int sx, int sy, int bold) {
  int n = strlen(s);
  int w = n * 6 * sx - sx + bold;
  int x = (128 - w) / 2;
  for (int i = 0; i < n; i++) draw_char(layer, x + i * 6 * sx, y, s[i], sx, sy, bold);
}

// ---- tiny 3x5 numbers ----
int tiny_width(const char *s) { return strlen(s) * 4 - 1; }

void draw_tiny(int layer, int x, int y, const char *s) {
  for (int i = 0; s[i]; i++) {
    for (size_t g = 0; g < sizeof(tiny) / sizeof(tiny[0]); g++) {
      if (tiny[g].c != s[i]) continue;
      for (int r = 0; r < 5; r++)
        for (int c = 0; c < 3; c++)
          if ((tiny[g].row[r] >> (2 - c)) & 1) set_px(layer, x + i * 4 + c, y + r);
    }
  }
}

// number string for an integer tick index (-3..3)
void tick_str(int v, char *out) {
  if (v < 0) sprintf(out, "-%d", -v);
  else       sprintf(out, "%d", v);
}

// ---------------- geometry ----------------

void compute_geometry() {
  // One unit on X/Y equals one display spacing physically, so the axes are isotropic.
  TICK_PX = (int)roundf(LAYER_PITCH_MM / PX_PITCH_MM);
  if (TICK_PX > 19) TICK_PX = 19;      // keep +-3 units inside the 128 px panel
  Serial.printf("1 unit = %d px (%.2f mm), axes span +-%d px\n", TICK_PX, TICK_PX * PX_PITCH_MM, 3 * TICK_PX);
}

// ---------------- scenes ----------------

// Scene 1: same text on displays 5, 6, 7 -> letters 3 displays thick
void scene_text() {
  for (int layer = TEXT_FIRST; layer <= TEXT_LAST; layer++) {
    draw_text_centered(layer, 12, "MIT", 7, 7, 3);          // top row: big + bold
    draw_text_centered(layer, 76, "Maker", 2, 2, 0);        // second row
    draw_text_centered(layer, 96, "Portfolio", 2, 2, 0);    // third row
  }
}

// Scene 2: axes centred on the middle of display 4.
//   X and Y lie in display 4 (-3..+3 units through the centre),
//   Z runs through the stack at the centre (one marker per display, -3..+3).
void scene_axes() {
  int ext = 3 * TICK_PX;
  char buf[4];

  // X axis (display 4)
  hline(MID, CX - ext, CX + ext, CY);
  for (int i = -3; i <= 3; i++) {
    vline(MID, CX + i * TICK_PX, CY - 2, CY + 2);
    if (i == 0) continue;
    tick_str(i, buf);
    draw_tiny(MID, CX + i * TICK_PX - tiny_width(buf) / 2, CY + 5, buf);     // below the axis
  }

  // Y axis (display 4), +Y is up
  vline(MID, CX, CY - ext, CY + ext);
  for (int i = -3; i <= 3; i++) {
    hline(MID, CX - 2, CX + 2, CY - i * TICK_PX);
    if (i == 0) continue;
    tick_str(i, buf);
    draw_tiny(MID, CX - 5 - tiny_width(buf), CY - i * TICK_PX - 2, buf);     // left of the axis
  }

  // Z axis: a point + tick on every display, number = displays from display 4
  for (int k = 0; k < NUM_PANELS; k++) {
    set_px(k, CX, CY);
    vline(k, CX, CY - 2, CY + 2);
    tick_str(k - MID, buf);
    draw_tiny(k, CX + 4, CY - 8, buf);                                       // upper right of the axis point
  }

  // Axis names (positive ends)
  draw_char(MID, CX + ext + 5, CY - 3, 'X', 1, 1, 0);
  draw_char(MID, CX - 2, CY - ext - 10, 'Y', 1, 1, 0);
  draw_char(NUM_PANELS - 1, CX + 9, CY - 3, 'Z', 1, 1, 0);                   // on display 7
}

// Scene 3: largest sphere that fits the volume, as a uniform sparse point cloud,
//   centred on the axes origin.
//   Radius is limited by the stack depth (poles land on displays 1 and 7) or the panel
//   width, whichever is smaller. On each display the points form a circle whose point
//   spacing equals the display spacing, so spacing is ~uniform in all three directions.
void scene_sphere() {
  float R = 3.0f * LAYER_PITCH_MM;                  // depth limit (3 display gaps each side)
  float Rpanel = 60.0f * PX_PITCH_MM;               // width limit (60 px from centre)
  if (Rpanel < R) R = Rpanel;

  int total = 0;
  for (int k = 0; k < NUM_PANELS; k++) {
    float dz = (k - MID) * LAYER_PITCH_MM;
    if (fabsf(dz) > R + 0.05f * LAYER_PITCH_MM) continue;   // layer misses the sphere

    float r_mm = sqrtf(fmaxf(0.0f, R * R - dz * dz));        // circle radius on this display
    float r_px = r_mm / PX_PITCH_MM;
    int   n    = (r_mm < 0.01f) ? 1 : (int)fmaxf(1.0f, roundf(2.0f * PI * r_mm / LAYER_PITCH_MM));
    float ph   = k * 0.9f;                                    // rotate each ring so points don't line up

    for (int j = 0; j < n; j++) {
      float th = ph + 2.0f * PI * j / n;
      int px = (int)roundf(CX + r_px * cosf(th)) - POINT_PX / 2;
      int py = (int)roundf(CY + r_px * sinf(th)) - POINT_PX / 2;
      block(k, px, py, POINT_PX, POINT_PX);
      total++;
    }
  }
  Serial.printf("Sphere: R = %.2f mm (%.0f px), %d points\n", R, R / PX_PITCH_MM, total);
}

// ---------------- panel init ----------------

void init_panels() {
  pinMode(PIN_DC, OUTPUT); pinMode(PIN_RST, OUTPUT);
  for (int i = 0; i < NUM_PANELS; i++) {
    pinMode(cs_pins[i], OUTPUT);
    digitalWrite(cs_pins[i], HIGH);          // deselect all panels
  }
  SPI.begin(18, -1, 23, -1);

  digitalWrite(PIN_RST, LOW);  delay(100);   // reset pulse (shared by all panels)
  digitalWrite(PIN_RST, HIGH); delay(100);

  const uint8_t init_cmds[] = {
    0xAE,           // display off
    0xAD, 0x8A,     // DC-DC off (external VPP)
    0x81, 0xFF,     // Set Contrast Control command to max
    0xA4,           // display follows RAM (NOT all-pixels-on)
    0xA6            // normal (not inverted)
  };

  clear_all();
  for (int i = 0; i < NUM_PANELS; i++) {
    send_cmds(cs_pins[i], init_cmds, sizeof(init_cmds));
    send_frame(cs_pins[i], fb[i]);           // blank RAM so there is no speckle when turned on
  }

  const uint8_t on = 0xAF;                   // display on - all 7 stay on from here
  for (int i = 0; i < NUM_PANELS; i++) send_cmds(cs_pins[i], &on, 1);
  delay(100);                                // datasheet: wait 100 ms after display on

  Serial.println("Init done - all panels on (blank).");
}