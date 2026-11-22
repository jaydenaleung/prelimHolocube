// u8g2 showcase for the 7-panel Holocube (SH1107 128x128, 4-wire HW SPI, ESP32).
// Every panel shows one family of u8g2 drawing functions, then all 7 run a 3D animation together.
//
//   display 1  primitives      pixel, line, hline, vline, frame, box
//   display 2  round shapes    rframe, rbox, circle (+ quadrants), disc, ellipse, filled ellipse
//   display 3  shapes, bitmaps triangle, arc, drawXBM, drawBitmap
//   display 4  fonts           several fonts, drawStr, drawUTF8, drawGlyph icons, font direction, getStrWidth
//   display 5  draw modes      XOR draw color, transparent font mode, clip window, buttons, print()
//   display 6  rotation        setDisplayRotation R0/R1/R2/R3 + U8G2_MIRROR
//   display 7  text terminal   U8G2LOG + drawLog, partial update with updateDisplayArea
//
// Power-up order that keeps the hardware lint clean on this board (external VPP):
//   SPI.begin(SCK, -1, MOSI, -1) BEFORE u8g2, so GPIO19 (RST) is not taken as MISO
//   beginSimple()       init without switching the display on
//   0xAD 0x8A           DC-DC off (VPP is external)
//   contrast + blank RAM, then setPowerSave(0) = display on, then wait 100 ms
#include <U8g2lib.h>
#include <SPI.h>

#define U8G2_VERSION_STRING_FOR_SHOWCASE "2.35"
#define DUMP_BUFFERS 0        // 1: print every panel's u8g2 framebuffer as hex (used by the simulator's tests)

#define PIN_SCK   18
#define PIN_MOSI  23
#define PIN_DC    21
#define PIN_RST   19
#define NUM_PANELS 7
const uint8_t CS_PINS[NUM_PANELS] = {13, 27, 26, 25, 33, 32, 16};
#define SPI_HZ    4000000UL
#define HOLD_MS   8000
#define ANIM_MS   10000

typedef U8G2_SH1107_PIMORONI_128X128_F_4W_HW_SPI Panel;
Panel panels[NUM_PANELS] = {
  Panel(U8G2_R0, CS_PINS[0], PIN_DC, PIN_RST),   // only the first one owns the (shared) reset line
  Panel(U8G2_R0, CS_PINS[1], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[2], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[3], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[4], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[5], PIN_DC, U8X8_PIN_NONE),
  Panel(U8G2_R0, CS_PINS[6], PIN_DC, U8X8_PIN_NONE),
};

// 16x16 heart (XBM: rows of 2 bytes, bit0 = leftmost pixel) and an 8x16 checker (drawBitmap: MSB = leftmost)
uint8_t heart_xbm[32];
uint8_t checker_bmp[16];

#define LOG_W 21
#define LOG_H 7
uint8_t log_buffer[LOG_W * LOG_H];
U8G2LOG terminal;

void make_bitmaps() {
  for (int y = 0; y < 16; y++) {
    uint16_t row = 0;
    for (int x = 0; x < 16; x++) {
      float fx = (x - 7.5f) / 6.5f, fy = (7.0f - y) / 6.5f + 0.15f;
      float a = fx * fx + fy * fy - 1.0f;
      if (a * a * a - fx * fx * fy * fy * fy <= 0.0f) row |= (1u << x);
    }
    heart_xbm[y * 2] = row & 0xFF;
    heart_xbm[y * 2 + 1] = row >> 8;
  }
  for (int y = 0; y < 16; y++) checker_bmp[y] = ((y / 4) & 1) ? 0xF0 : 0x0F;
}

#if DUMP_BUFFERS
char hexline[2 * 2048 + 1];
void dump(uint8_t i) {
  uint8_t *b = panels[i].getBufferPtr();
  static const char *H = "0123456789ABCDEF";
  for (int k = 0; k < 2048; k++) { hexline[2 * k] = H[b[k] >> 4]; hexline[2 * k + 1] = H[b[k] & 15]; }
  hexline[4096] = 0;
  Serial.printf("BUF %u ", i + 1);
  Serial.println(hexline);
}
#endif

void title(Panel &u, const char *s) {
  u.setFont(u8g2_font_5x7_tr);
  u.setFontPosTop();
  u.drawStr(2, 1, s);
  u.drawHLine(0, 9, 128);
  u.setFontPosBaseline();
}

// ---------------------------------------------------------------- the seven pages
void page_primitives(Panel &u) {
  title(u, "1 PRIMITIVES");
  u.drawFrame(0, 0, 128, 128);
  for (int y = 0; y < 8; y++)                     // drawPixel: dotted grid
    for (int x = 0; x < 8; x++) u.drawPixel(6 + x * 3, 16 + y * 3);
  for (int a = 0; a <= 8; a++)                    // drawLine: fan
    u.drawLine(10, 122, 10 + a * 8, 92);
  for (int i = 0; i < 10; i++) u.drawHLine(6, 46 + i * 4, 4 + i * 2);    // drawHLine
  for (int i = 0; i < 10; i++) u.drawVLine(36 + i * 4, 14, 4 + i * 2);   // drawVLine
  u.drawFrame(84, 14, 38, 24);                    // drawFrame + drawBox
  u.drawBox(90, 20, 26, 12);
  u.setFont(u8g2_font_5x7_tr);
  u.drawStr(84, 50, "pixel");
  u.drawStr(84, 59, "line");
  u.drawStr(84, 68, "hline");
  u.drawStr(84, 77, "vline");
  u.drawStr(84, 86, "frame");
  u.drawStr(84, 95, "box");
}

void page_round(Panel &u) {
  title(u, "2 ROUND SHAPES");
  u.drawRFrame(4, 14, 36, 24, 6);
  u.drawRBox(46, 14, 36, 24, 8);
  u.drawCircle(104, 26, 12, U8G2_DRAW_ALL);
  u.drawCircle(20, 62, 14, U8G2_DRAW_UPPER_RIGHT | U8G2_DRAW_LOWER_LEFT);
  u.drawDisc(60, 62, 14, U8G2_DRAW_ALL);
  u.drawDisc(100, 62, 14, U8G2_DRAW_UPPER_LEFT | U8G2_DRAW_LOWER_RIGHT);
  u.drawEllipse(32, 100, 26, 14, U8G2_DRAW_ALL);
  u.drawFilledEllipse(94, 100, 26, 14, U8G2_DRAW_ALL);
}

void page_shapes(Panel &u) {
  title(u, "3 TRIANGLE ARC BITMAP");
  u.drawTriangle(6, 60, 34, 16, 60, 54);
  u.drawArc(94, 40, 26, 0, 160);                  // arc from 0 to 160 (u8g2 units, 256 = full circle)
  u.drawArc(94, 40, 20, 64, 192);
  u.drawArc(94, 40, 14, 128, 32);
  for (int i = 0; i < 4; i++) u.drawXBM(6 + i * 20, 72, 16, 16, heart_xbm);   // drawXBM
  u.setBitmapMode(1);                             // transparent background
  u.drawXBM(86, 80, 16, 16, heart_xbm);
  u.drawXBM(94, 86, 16, 16, heart_xbm);
  u.setBitmapMode(0);
  u.drawBitmap(6, 98, 1, 16, checker_bmp);         // drawBitmap: 1 byte wide = 8 px
  u.drawBitmap(18, 98, 1, 16, checker_bmp);
  u.setFont(u8g2_font_5x7_tr);
  u.drawStr(34, 110, "XBM  bitmap");
}

void page_fonts(Panel &u) {
  title(u, "4 FONTS");
  u.setFont(u8g2_font_ncenB14_tr);
  u.drawStr(4, 30, "Holocube");
  u.drawHLine(4, 33, u.getStrWidth("Holocube"));  // underline exactly as wide as the text
  u.setFont(u8g2_font_logisoso28_tn);
  u.drawStr(4, 68, "2.35");
  u.setFont(u8g2_font_6x10_tf);
  u.drawUTF8(4, 82, "24\xC2\xB0" "C  \xC3\xA4\xC3\xB6\xC3\xBC");   // "24°C  äöü" in UTF-8
  u.setFont(u8g2_font_open_iconic_weather_2x_t);
  u.drawGlyph(4, 110, 0x45);                      // sun
  u.drawGlyph(26, 110, 0x40);                     // cloud
  u.setFont(u8g2_font_unifont_t_symbols);
  u.drawGlyph(50, 108, 0x2603);                   // snowman
  u.setFont(u8g2_font_6x10_tr);
  u.setFontDirection(1);                          // vertical text
  u.drawStr(112, 14, "vertical");
  u.setFontDirection(0);
}

void page_modes(Panel &u) {
  title(u, "5 DRAW MODES");
  u.drawBox(6, 16, 40, 24);
  u.setDrawColor(2);                              // XOR
  u.drawBox(26, 26, 40, 24);
  u.drawDisc(56, 30, 10, U8G2_DRAW_ALL);
  u.setDrawColor(1);
  u.drawBox(74, 14, 48, 16);
  u.setFontMode(1);                               // transparent glyph background
  u.setDrawColor(0);
  u.setFont(u8g2_font_6x10_tr);
  u.drawStr(78, 25, "inverse");
  u.setDrawColor(1);
  u.setFontMode(0);
  u.setClipWindow(74, 34, 122, 58);               // only this window can be drawn into
  u.drawDisc(98, 58, 22, U8G2_DRAW_ALL);
  u.setMaxClipWindow();
  u.drawFrame(74, 34, 49, 25);
  u.setFont(u8g2_font_helvB08_tr);
  u.drawButtonUTF8(8, 72, U8G2_BTN_BW1, 0, 2, 2, "OK");
  u.drawButtonUTF8(36, 72, U8G2_BTN_SHADOW1 | U8G2_BTN_BW1, 0, 2, 2, "Shadow");
  u.drawButtonUTF8(84, 72, U8G2_BTN_INV | U8G2_BTN_BW1, 0, 2, 2, "Inv");
  u.setFont(u8g2_font_6x10_tr);
  u.setCursor(8, 96);                             // print() via Arduino's Print class
  u.print("pi=");
  u.print(3.14159, 4);
  u.setCursor(8, 110);
  u.print("ms=");
  u.print(millis());
}

void page_rotation(Panel &u) {
  const u8g2_cb_t *rot[4] = {U8G2_R0, U8G2_R1, U8G2_R2, U8G2_R3};
  const char *name[4] = {"R0", "R1", "R2", "R3"};
  u.setFont(u8g2_font_ncenB14_tr);
  for (int i = 0; i < 4; i++) {                   // same coordinates, four rotations
    u.setDisplayRotation(rot[i]);
    u.drawStr(6, 22, name[i]);
    u.drawTriangle(40, 8, 40, 22, 56, 15);
  }
  u.setDisplayRotation(U8G2_MIRROR);
  u.setFont(u8g2_font_6x10_tr);
  u.drawStr(36, 70, "MIRROR");
  u.setDisplayRotation(U8G2_R0);
  u.setFont(u8g2_font_5x7_tr);
  u.drawStr(40, 56, "6 ROTATION");
  u.drawFrame(0, 0, 128, 128);
}

void page_terminal(Panel &u) {
  title(u, "7 U8G2LOG TERMINAL");
  terminal.begin(LOG_W, LOG_H, log_buffer);
  terminal.setLineHeightOffset(1);
  terminal.print("u8g2 ");
  terminal.println(U8G2_VERSION_STRING_FOR_SHOWCASE);
  terminal.println("7 panels, SH1107");
  for (int i = 1; i <= 5; i++) { terminal.print("line "); terminal.print(i); terminal.print(": x="); terminal.println(i * i); }
  u.setFont(u8g2_font_5x7_tr);
  u.drawLog(2, 18, terminal);
  u.drawFrame(0, 12, 128, 66);
}

// ---------------------------------------------------------------- setup / loop
void show_pages() {
  void (*pages[NUM_PANELS])(Panel &) = {page_primitives, page_round, page_shapes, page_fonts, page_modes, page_rotation, page_terminal};
  for (uint8_t i = 0; i < NUM_PANELS; i++) {
    panels[i].clearBuffer();
    panels[i].setDrawColor(1);
    pages[i](panels[i]);
    panels[i].sendBuffer();
#if DUMP_BUFFERS
    dump(i);
#endif
  }
}

// partial refresh: only the tiles of the terminal box are re-sent
void tick_terminal(uint32_t n) {
  Panel &u = panels[6];
  terminal.print("tick ");
  terminal.println(n);
  u.setDrawColor(0); u.drawBox(1, 13, 126, 64); u.setDrawColor(1);
  u.setFont(u8g2_font_5x7_tr);
  u.drawLog(2, 18, terminal);
  u.updateDisplayArea(0, 1, 16, 9);               // tile coordinates: x 0..15, rows 1..9
}

// 3D animation through the stack: a ball travelling in depth, a twisting propeller, a wave
void animate(uint32_t ms) {
  uint32_t t0 = millis(), frames = 0;
  while (millis() - t0 < ms) {
    float t = (millis() - t0) / 1000.0f;
    float bz = 3.0f + 3.0f * sinf(t * 1.7f);       // ball depth, in display spacings (0..6)
    float bx = 64 + 34 * cosf(t * 1.1f), by = 64 + 34 * sinf(t * 1.3f);
    for (uint8_t k = 0; k < NUM_PANELS; k++) {
      Panel &u = panels[k];
      u.clearBuffer();
      float d = k - bz, r2 = 4.0f - d * d;         // ball radius 2 display spacings ~ 32 px
      if (r2 > 0) u.drawDisc(bx, by, sqrtf(r2) * 16, U8G2_DRAW_ALL);
      float a = t * 2.0f + k * 0.45f;              // propeller twisted through the stack
      u.drawLine(64 - 50 * cosf(a), 64 - 50 * sinf(a), 64 + 50 * cosf(a), 64 + 50 * sinf(a));
      for (int x = 0; x < 128; x += 2)             // a travelling sine wave, phase-shifted per panel
        u.drawPixel(x, 112 + 8 * sinf(x * 0.09f + t * 4 + k * 0.9f));
      u.sendBuffer();
    }
    frames++;
  }
  Serial.printf("animation: %lu frames in %lu ms (%.1f fps)\n", (unsigned long)frames, (unsigned long)ms, frames * 1000.0f / ms);
}

void setup() {
  Serial.begin(115200);
  make_bitmaps();
  SPI.begin(PIN_SCK, -1, PIN_MOSI, -1);
  for (uint8_t i = 0; i < NUM_PANELS; i++) { pinMode(CS_PINS[i], OUTPUT); digitalWrite(CS_PINS[i], HIGH); }
  for (uint8_t i = 0; i < NUM_PANELS; i++) {
    Panel &u = panels[i];
    u.setBusClock(SPI_HZ);
    u.beginSimple();                 // init (incl. the one reset pulse via panel 1), display stays off
    u.sendF("ca", 0xAD, 0x8A);        // DC-DC off: VPP is external
    u.setContrast(0xFF);
    u.clearBuffer();
    u.sendBuffer();                  // RAM is written before the panel is switched on: no speckle
  }
  for (uint8_t i = 0; i < NUM_PANELS; i++) panels[i].setPowerSave(0);   // display on
  delay(100);
  Serial.println("u8g2 showcase: 7 panels ready");
}

void loop() {
  Serial.println("Showcase: drawing pages");
  show_pages();
  for (uint32_t n = 1; n <= 6; n++) { delay(HOLD_MS / 6); tick_terminal(n); }
  Serial.println("Showcase: 3D animation");
  animate(ANIM_MS);
}

