// Exercises the Arduino String API. Each line is "key=value"; the test compares with what the ESP32 core prints.
#include <math.h>

void out(const char *k, const String &v) { Serial.print(k); Serial.print('='); Serial.println(v); }
void outi(const char *k, long v) { out(k, String(v)); }

void setup() {
  Serial.begin(115200);
  // numbers -> text
  out("int", String(42));
  out("neg_hex", String(-123, HEX));
  out("hex", String(255, HEX));
  out("bin", String(5, BIN));
  out("ulong", String(4294967295UL));
  out("llong", String(-9000000000LL));
  out("uchar", String((unsigned char)200));
  out("char", String('x'));
  out("f_default", String(3.14159));
  out("f_4", String(3.14159, 4));
  out("f_neg", String(-0.5));
  out("f_round", String(1.999, 2));
  out("f_0dp", String(2.5f, 0));
  out("f_nan", String(NAN));
  out("f_ninf", String(-INFINITY));

  // concatenation
  out("chain", "A" + String(1) + 'c' + 2 + 2.5);
  String t = "v=";
  t += 7; t += ','; t += 1.5;
  out("plus_eq", t);
  outi("concat_null", String("x").concat((const char *)nullptr));

  // search
  String s = "Hello World";
  outi("idx_o", s.indexOf('o'));
  outi("idx_o_5", s.indexOf('o', 5));
  outi("last_o", s.lastIndexOf('o'));
  outi("last_o_5", s.lastIndexOf('o', 5));
  outi("idx_World", s.indexOf("World"));
  outi("last_l", s.lastIndexOf("l"));
  outi("idx_z", s.indexOf('z'));
  out("sub_6", s.substring(6));
  out("sub_8_3", s.substring(8, 3));
  out("sub_20", s.substring(20));

  // comparison
  outi("lt", String("abc") < String("abd"));
  outi("eq_ic", String("abc").equalsIgnoreCase("ABC"));
  outi("starts", s.startsWith("He"));
  outi("starts_off", s.startsWith("World", 6));
  outi("ends", s.endsWith("ld"));
  outi("eq_cstr", s == "Hello World");

  // characters
  out("charAt", String(s.charAt(1)));
  s.setCharAt(0, 'J');
  out("setCharAt", s);
  outi("oob_read", (long)s[100]);
  char buf[6];
  s.toCharArray(buf, sizeof(buf));
  out("toCharArray", String(buf));

  // modification
  String r = "a-b-c";
  r.replace("-", "+=");
  out("replace_str", r);
  r.replace('a', 'x');
  out("replace_chr", r);
  String m = "0123456789";
  m.remove(3, 4);
  out("remove_n", m);
  m.remove(5);
  out("remove_end", m);
  String w = "  hi there \t\n";
  w.trim();
  out("trim", "[" + w + "]");
  String u = "MiXeD";
  u.toUpperCase(); out("upper", u);
  u.toLowerCase(); out("lower", u);

  // parsing
  outi("toInt", String("  -42abc").toInt());
  out("toFloat", String(String("3.25xyz").toFloat(), 2));

  // emptiness and truthiness (an empty String is still "true", as on the ESP32)
  String e;
  outi("empty_true", e ? 1 : 0);
  outi("empty_len", e.length());
  outi("isEmpty", e.isEmpty());
  outi("reserve", e.reserve(100));

  Serial.print(F("flash="));
  Serial.println(F("ok"));
  Serial.println("END");
}

void loop() { delay(1000); }
