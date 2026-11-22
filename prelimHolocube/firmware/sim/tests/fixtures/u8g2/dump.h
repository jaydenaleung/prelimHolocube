// Shared by the u8g2 test fixtures: print a u8g2 full framebuffer as one hex line, then pause so the
// simulator captures the panels in that state.
#pragma once
#include <U8g2lib.h>

static char dump_hex[2 * 2048 + 1];
static void dump_u8g2(const char *tag, U8G2 &u) {
  const uint8_t *b = u.getBufferPtr();
  uint16_t n = 8 * u.getBufferTileHeight() * u.getBufferTileWidth();
  static const char *H = "0123456789ABCDEF";
  for (uint16_t k = 0; k < n; k++) { dump_hex[2 * k] = H[b[k] >> 4]; dump_hex[2 * k + 1] = H[b[k] & 15]; }
  dump_hex[2 * n] = 0;
  Serial.printf("BUF %s ", tag);
  Serial.println(dump_hex);
  delay(300);
}

// the same scene in every fixture: frame, text, shapes in all four corners (catches flips and offsets)
static void draw_scene(U8G2 &u) {
  u.clearBuffer();
  u.drawFrame(0, 0, 128, 128);
  u.drawBox(2, 2, 10, 6);                  // top-left marker
  u.drawDisc(120, 8, 5, U8G2_DRAW_ALL);    // top-right marker
  u.drawTriangle(2, 125, 14, 125, 2, 113); // bottom-left marker
  u.drawPixel(125, 125);                   // bottom-right single pixel
  u.setFont(u8g2_font_ncenB14_tr);
  u.drawStr(10, 40, "u8g2");
  u.setFont(u8g2_font_6x10_tf);
  u.drawUTF8(10, 60, "SH1107 \xC2\xB0");
  u.drawCircle(80, 90, 20, U8G2_DRAW_ALL);
  u.drawLine(10, 70, 60, 120);
}
