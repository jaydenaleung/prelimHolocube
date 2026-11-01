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
// SLIDESHOW (repeats forever):
//   Static (HOLD_MS each):  text -> axes -> axes + sphere
//   Animated (DEMO_MS each): rotating cube, torus, wireframe globe, DNA helix,
//                            atom, ripple surface, 3D rain, Lissajous snake,
//                            bouncing ball in a box, expanding shells
//
// COORDINATES: x = column (0..127), y = row (0..127, down), z = display
// number (display 1 = layer 0 ... display 7 = layer 6).
// Axes origin = centre of display 4 (x=64, y=64, layer 3); each axis runs
// -3..+3 units, 1 unit = one display spacing.
// Every display keeps its own RAM, so all 7 stay ON the whole time.
// Animations are drawn in millimetres (x right, y up, z toward display 7)
// and snapped to the nearest display layer.


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

typedef void (*SceneFn)();
typedef void (*AnimFn)(float);

// ---- PHYSICAL GEOMETRY ----
#define PX_PITCH_MM     0.1573f   // 20.14 mm active area / 128 px (datasheet)
#define LAYER_PITCH_MM  2.5f      // distance between neighbouring displays (centre to centre)

#define SPI_HZ     1000000 // proven speed. Try 4000000 for ~4x smoother animation once stable
#define HOLD_MS    10000   // each static scene stays up this long
#define DEMO_MS    12000   // each animated demo runs this long
#define MIRROR_X   0       // set to 1 if x is flipped (board's left/right comes out mirrored)
#define TEXT_FIRST 4       // display 5  (layer index 4)
#define TEXT_LAST  6       // display 7  (layer index 6)
#define POINT_PX   2       // sphere points are POINT_PX x POINT_PX pixel blocks

// One 128x128 1-bit framebuffer per display: 16 pages x 128 columns
uint8_t fb[NUM_PANELS][16][128];
// What each panel's RAM currently holds, so unchanged pages are not re-sent
uint8_t shadow[NUM_PANELS][16][128];

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
  // ---- static scenes ----
  show_static("Scene: text",          scene_text,          HOLD_MS);
  show_static("Scene: axes",          scene_axes,          HOLD_MS);
  show_static("Scene: axes + sphere", scene_axes_sphere,   HOLD_MS);

  // ---- animated demos ----
  run_anim("Demo: rotating cube",       demo_cube,    DEMO_MS);
  run_anim("Demo: torus",               demo_torus,   DEMO_MS);
  run_anim("Demo: wireframe globe",     demo_globe,   DEMO_MS);
  run_anim("Demo: DNA helix",           demo_dna,     DEMO_MS);
  run_anim("Demo: atom",                demo_atom,    DEMO_MS);
  run_anim("Demo: ripple surface",      demo_ripple,  DEMO_MS);
  run_anim("Demo: 3D rain",             demo_rain,    DEMO_MS);
  run_anim("Demo: Lissajous snake",     demo_lissajous, DEMO_MS);
  run_anim("Demo: bouncing ball",       demo_bounce,  DEMO_MS);
  run_anim("Demo: expanding shells",    demo_pulse,   DEMO_MS);
}


// ---------------- slideshow helpers ----------------

void show_static(const char *name, SceneFn draw, uint32_t ms) {
  Serial.println(name);
  clear_all();
  draw();
  push_all();
  delay(ms);
}

void run_anim(const char *name, AnimFn draw, uint32_t ms) {
  Serial.println(name);
  uint32_t t0 = millis();
  uint32_t frames = 0;
  while (millis() - t0 < ms) {
    float t = (millis() - t0) / 1000.0f;
    clear_all();
    draw(t);
    push_all();
    frames++;
  }
  Serial.printf("  %lu frames (%.1f fps)\n", (unsigned long)frames, frames * 1000.0f / ms);
}


// ---------------- low-level SPI helpers ----------------

void send_cmds(uint8_t cs, const uint8_t *cmds, size_t n) {
  SPI.beginTransaction(SPISettings(SPI_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(PIN_DC, LOW);   // command mode
  digitalWrite(cs, LOW);
  for (size_t i = 0; i < n; i++) SPI.transfer(cmds[i]);
  digitalWrite(cs, HIGH);
  SPI.endTransaction();
}

// Send only the pages that differ from what the panel already shows
void send_frame(uint8_t cs, uint8_t buf[16][128], uint8_t sh[16][128]) {
  SPI.beginTransaction(SPISettings(SPI_HZ, MSBFIRST, SPI_MODE0));
  for (int page = 0; page < 16; page++) {
    if (memcmp(buf[page], sh[page], 128) == 0) continue;   // unchanged page
    digitalWrite(PIN_DC, LOW);   // command mode: set page + column 0
    digitalWrite(cs, LOW);
    SPI.transfer(0xB0 | page);   // page address
    SPI.transfer(0x00);          // column low nibble  = 0
    SPI.transfer(0x10);          // column high nibble = 0
    digitalWrite(PIN_DC, HIGH);  // data mode: 128 bytes for this page
    SPI.writeBytes(buf[page], 128);
    digitalWrite(cs, HIGH);
    memcpy(sh[page], buf[page], 128);
  }
  SPI.endTransaction();
}

void push_all() {
  for (int i = 0; i < NUM_PANELS; i++) send_frame(cs_pins[i], fb[i], shadow[i]);
}

void clear_all() {
  memset(fb, 0, sizeof(fb));
}

// ---------------- drawing primitives (pixel space) ----------------

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

// circle in pixel space on one layer (outline or filled disc)
void circle_px(int layer, int cx, int cy, float rp, bool fill) {
  if (fill) {
    int r = (int)ceilf(rp);
    for (int dy = -r; dy <= r; dy++)
      for (int dx = -r; dx <= r; dx++)
        if (dx * dx + dy * dy <= rp * rp) set_px(layer, cx + dx, cy + dy);
  } else {
    int n = (int)fmaxf(8.0f, 2.0f * PI * rp * 1.2f);
    for (int i = 0; i < n; i++) {
      float a = 2.0f * PI * i / n;
      set_px(layer, cx + (int)roundf(rp * cosf(a)), cy + (int)roundf(rp * sinf(a)));
    }
  }
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

// ---------------- 3D primitives (millimetres, y up, snapped to layers) ----------------

// Plot a size x size pixel dot at a 3D point; z snaps to the nearest display layer
void plot(float x, float y, float z, int size) {
  int k = (int)roundf(z / LAYER_PITCH_MM) + MID;
  if (k < 0 || k >= NUM_PANELS) return;
  int px = CX + (int)roundf(x / PX_PITCH_MM) - size / 2;
  int py = CY - (int)roundf(y / PX_PITCH_MM) - size / 2;
  block(k, px, py, size, size);
}

// Straight 3D line, sampled finely enough to be continuous in every layer
void line3(float x0, float y0, float z0, float x1, float y1, float z1, int size) {
  float dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  float len = sqrtf(dx * dx + dy * dy + dz * dz);
  int n = (int)ceilf(len / 0.1f);
  if (n < 1) n = 1;
  for (int i = 0; i <= n; i++) {
    float f = (float)i / n;
    plot(x0 + dx * f, y0 + dy * f, z0 + dz * f, size);
  }
}

// rotate the pair (a,b) by ang
void rot(float &a, float &b, float ang) {
  float c = cosf(ang), s = sinf(ang);
  float na = a * c - b * s;
  b = a * s + b * c;
  a = na;
}

// View rotation: spin about Y, then tilt about X. Set once per frame, apply per point.
float gca = 1, gsa = 0, gcb = 1, gsb = 0;
void set_view(float ay, float ax) {
  gca = cosf(ay); gsa = sinf(ay);
  gcb = cosf(ax); gsb = sinf(ax);
}
void view(float &x, float &y, float &z) {
  float x1 = x * gca - z * gsa;
  float z1 = x * gsa + z * gca;
  float y2 = y * gcb - z1 * gsb;
  float z2 = y * gsb + z1 * gcb;
  x = x1; y = y2; z = z2;
}

// deterministic pseudo-random in 0..1 (same value every frame for the same i/salt)
uint32_t hash32(uint32_t x) {
  x ^= x >> 16; x *= 0x7feb352d; x ^= x >> 15; x *= 0x846ca68b; x ^= x >> 16;
  return x;
}
float rnd(uint32_t i, uint32_t salt) {
  return (hash32(i * 2654435761u + salt * 40503u) & 0xFFFF) / 65535.0f;
}

// triangle wave: u -> -1..+1 (for bouncing)
float tri(float u) {
  u = fmodf(u, 2.0f);
  if (u < 0) u += 2.0f;
  return (u < 1.0f) ? (u * 2.0f - 1.0f) : (3.0f - u * 2.0f);
}

// ---------------- geometry ----------------

void compute_geometry() {
  // One unit on X/Y equals one display spacing physically, so the axes are isotropic.
  TICK_PX = (int)roundf(LAYER_PITCH_MM / PX_PITCH_MM);
  if (TICK_PX > 19) TICK_PX = 19;      // keep +-3 units inside the 128 px panel
  Serial.printf("1 unit = %d px (%.2f mm), axes span +-%d px\n", TICK_PX, TICK_PX * PX_PITCH_MM, 3 * TICK_PX);
}

// ---------------- static scenes ----------------

// Same text on displays 5, 6, 7 -> letters 3 displays thick
void scene_text() {
  for (int layer = TEXT_FIRST; layer <= TEXT_LAST; layer++) {
    draw_text_centered(layer, 12, "MIT", 7, 7, 3);          // top row: big + bold
    draw_text_centered(layer, 76, "Maker", 2, 2, 0);        // second row
    draw_text_centered(layer, 96, "Portfolio", 2, 2, 0);    // third row
  }
}

// Axes centred on the middle of display 4.
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

// Largest sphere that fits the volume, as a uniform sparse point cloud, centred on the axes origin.
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

void scene_axes_sphere() {
  scene_axes();
  scene_sphere();
}

// ---------------- animated demos ----------------

// 1. Tumbling wireframe cube
void demo_cube(float t) {
  const float a = 4.2f;                       // half side; circumradius 7.3 mm fits the 7.5 mm half-depth
  float v[8][3];
  set_view(t * 0.9f, t * 0.55f);
  for (int i = 0; i < 8; i++) {
    float x = (i & 1) ? a : -a;
    float y = (i & 2) ? a : -a;
    float z = (i & 4) ? a : -a;
    view(x, y, z);
    v[i][0] = x; v[i][1] = y; v[i][2] = z;
  }
  for (int i = 0; i < 8; i++)
    for (int b = 1; b <= 4; b <<= 1)
      if (!(i & b)) line3(v[i][0], v[i][1], v[i][2], v[i | b][0], v[i | b][1], v[i | b][2], 1);
  for (int i = 0; i < 8; i++) plot(v[i][0], v[i][1], v[i][2], 3);   // bright corners
}

// 2. Tumbling torus (sparse point surface)
void demo_torus(float t) {
  const float R = 4.7f, r = 2.3f;             // outer radius 7.0 mm
  set_view(t * 0.7f, t * 1.1f);
  for (int i = 0; i < 28; i++) {
    float u = 2.0f * PI * i / 28;
    for (int j = 0; j < 10; j++) {
      float vv = 2.0f * PI * j / 10;
      float x = (R + r * cosf(vv)) * cosf(u);
      float y = (R + r * cosf(vv)) * sinf(u);
      float z = r * sinf(vv);
      view(x, y, z);
      plot(x, y, z, 2);
    }
  }
}

// 3. Spinning wireframe globe (latitude + longitude lines)
void demo_globe(float t) {
  const float G = 7.3f, STEP = 0.12f;
  set_view(t * 0.8f, 0.45f);
  for (int la = -60; la <= 60; la += 30) {                   // latitude circles
    float lat = la * PI / 180.0f;
    float rho = G * cosf(lat), y0 = G * sinf(lat);
    int n = (int)ceilf(2.0f * PI * rho / STEP);
    for (int i = 0; i < n; i++) {
      float ang = 2.0f * PI * i / n;
      float x = rho * cosf(ang), y = y0, z = rho * sinf(ang);
      view(x, y, z);
      plot(x, y, z, 1);
    }
  }
  int n = (int)ceilf(2.0f * PI * G / STEP);                  // meridians (6 great circles)
  for (int lo = 0; lo < 180; lo += 30) {
    float lon = lo * PI / 180.0f;
    float cl = cosf(lon), sl = sinf(lon);
    for (int i = 0; i < n; i++) {
      float p = 2.0f * PI * i / n;
      float c = G * cosf(p);
      float x = c * cl, y = G * sinf(p), z = c * sl;
      view(x, y, z);
      plot(x, y, z, 1);
    }
  }
}

// 4. Rotating double helix with base-pair rungs
void demo_dna(float t) {
  const float R = 5.0f, H = 8.5f, k = 2.0f * PI / 8.0f;      // 8 mm per turn
  float ph = t * 2.0f;
  for (float y = -H; y <= H; y += 0.2f) {
    float a = k * y + ph;
    plot(R * cosf(a),      y, R * sinf(a),      2);          // strand A
    plot(R * cosf(a + PI), y, R * sinf(a + PI), 2);          // strand B
  }
  for (float y = -H + 0.5f; y <= H; y += 1.25f) {            // rungs
    float a = k * y + ph;
    line3(R * cosf(a), y, R * sinf(a), -R * cosf(a), y, -R * sinf(a), 1);
  }
}

// 5. Atom: nucleus + three tilted orbits with orbiting electrons
void demo_atom(float t) {
  const float R = 6.6f;
  set_view(t * 0.5f, 0.35f);
  plot(0, 0, 0, 5);                                          // nucleus
  for (int j = 0; j < 3; j++) {
    float beta = j * PI / 3.0f;                              // orbit plane: 0, 60, 120 degrees about Y
    for (int i = 0; i < 64; i++) {                           // dotted orbit
      float th = 2.0f * PI * i / 64;
      float x = R * cosf(th), y = R * sinf(th), z = 0;
      rot(x, z, beta);
      view(x, y, z);
      plot(x, y, z, 1);
    }
    float th = t * (2.0f + 0.7f * j) + j * 2.1f;             // electron
    float x = R * cosf(th), y = R * sinf(th), z = 0;
    rot(x, z, beta);
    view(x, y, z);
    plot(x, y, z, 5);
  }
}

// 6. Ripple: a water-like surface, height encoded as display layer
void demo_ripple(float t) {
  for (float gy = -9.0f; gy <= 9.01f; gy += 0.9f) {
    for (float gx = -9.0f; gx <= 9.01f; gx += 0.9f) {
      float r = sqrtf(gx * gx + gy * gy);
      float z = 6.5f * sinf(2.0f * PI * r / 6.0f - t * 3.0f) * fmaxf(0.0f, 1.0f - r / 14.0f);
      plot(gx, gy, z, 2);
    }
  }
}

// 7. Rain: drops falling through the whole volume
void demo_rain(float t) {
  const int N = 40;
  for (int i = 0; i < N; i++) {
    float x  = (rnd(i, 1) - 0.5f) * 18.0f;                   // mm
    int   k  = (int)(rnd(i, 2) * NUM_PANELS);                // which display
    if (k >= NUM_PANELS) k = NUM_PANELS - 1;
    float sp = 14.0f + rnd(i, 3) * 18.0f;                    // mm/s
    float ph = rnd(i, 4) * 20.0f;
    float y  = 9.5f - fmodf(ph + sp * t, 20.0f);             // falls from +9.5 to -10.5 mm, then wraps
    int px = CX + (int)roundf(x / PX_PITCH_MM);
    int py = CY - (int)roundf(y / PX_PITCH_MM);
    block(k, px, py, 2, 2);                                  // head
    vline(k, px, py - 8, py - 1);                            // tail (above the head)
  }
}

// 8. Snake tracing a 3D Lissajous curve
void demo_lissajous(float t) {
  for (int j = 0; j < 100; j++) {
    float s = t * 1.3f - j * 0.03f;
    float x = 6.5f * sinf(3.0f * s + 1.2f);
    float y = 8.0f * sinf(2.0f * s);
    float z = 6.5f * sinf(5.0f * s);
    int size = (j < 3) ? 4 : (j < 30 ? 2 : 1);               // thick head, thin tail
    plot(x, y, z, size);
  }
}

// 9. Ball bouncing around inside a wireframe box
void demo_bounce(float t) {
  const float B = 7.5f;                                      // box half-size (full depth)
  const float Rb = 3.2f;                                     // ball radius
  for (int i = 0; i < 8; i++)                                // box edges
    for (int b = 1; b <= 4; b <<= 1)
      if (!(i & b)) {
        float x0 = (i & 1) ? B : -B, y0 = (i & 2) ? B : -B, z0 = (i & 4) ? B : -B;
        float x1 = (b == 1) ? -x0 : x0, y1 = (b == 2) ? -y0 : y0, z1 = (b == 4) ? -z0 : z0;
        line3(x0, y0, z0, x1, y1, z1, 1);
      }

  float bx = (B - Rb) * tri(t * 0.55f + 0.10f);
  float by = (B - Rb) * tri(t * 0.43f + 0.40f);
  float bz = 5.0f      * tri(t * 0.31f + 0.70f);
  int cx = CX + (int)roundf(bx / PX_PITCH_MM);
  int cy = CY - (int)roundf(by / PX_PITCH_MM);
  for (int k = 0; k < NUM_PANELS; k++) {                     // ball = stack of filled discs
    float dz = (k - MID) * LAYER_PITCH_MM - bz;
    float r2 = Rb * Rb - dz * dz;
    if (r2 < 0) continue;
    circle_px(k, cx, cy, sqrtf(r2) / PX_PITCH_MM, true);
  }
}

// 10. Spherical shells expanding from the centre, like a sonar pulse
void demo_pulse(float t) {
  const float RMAX = 7.5f;
  for (int s = 0; s < 3; s++) {
    float R = fmodf(t * 3.0f + s * 2.5f, RMAX);
    for (int k = 0; k < NUM_PANELS; k++) {
      float dz = (k - MID) * LAYER_PITCH_MM;
      if (fabsf(dz) > R) continue;
      float rp = sqrtf(R * R - dz * dz) / PX_PITCH_MM;
      circle_px(k, CX, CY, rp, false);
    }
  }
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

  // Force-write a blank frame to every page (shadow starts as "unknown" = all 0xFF)
  memset(shadow, 0xFF, sizeof(shadow));
  clear_all();
  for (int i = 0; i < NUM_PANELS; i++) {
    send_cmds(cs_pins[i], init_cmds, sizeof(init_cmds));
    send_frame(cs_pins[i], fb[i], shadow[i]); // blank RAM so there is no speckle when turned on
  }

  const uint8_t on = 0xAF;                   // display on - all 7 stay on from here
  for (int i = 0; i < NUM_PANELS; i++) send_cmds(cs_pins[i], &on, 1);
  delay(100);                                // datasheet: wait 100 ms after display on

  Serial.println("Init done - all panels on (blank).");
}