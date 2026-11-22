// Arduino String implementation for the simulator (see WString.h). Behaviour follows the ESP32 Arduino core 3.x.
#include "WString.h"
#include <stdlib.h>
#include <stdio.h>
#include <ctype.h>
#include <math.h>

// ---------------------------------------------------------------- number formatting (stdlib_noniso)
static void reverse_range(char *b, char *e) {
  while (b < --e) { char t = *b; *b++ = *e; *e = t; }
}

// signed: digits of |value| in base 2..16 (lowercase), '-' in front if negative - in every base, as on the ESP32
template <typename S, typename U>
static char *signed_to_text(S value, char *result, int base) {
  if (base < 2 || base > 16) { *result = 0; return result; }
  char *out = result;
  U q = value < 0 ? (U)(-(value + 1)) + 1 : (U)value;   // magnitude without overflowing on the minimum value
  do { *out++ = "0123456789abcdef"[q % (U)base]; q /= (U)base; } while (q);
  if (value < 0) *out++ = '-';
  reverse_range(result, out);
  *out = 0;
  return result;
}
template <typename U>
static char *unsigned_to_text(U value, char *result, int base) {
  if (base < 2 || base > 16) { *result = 0; return result; }
  char *out = result;
  do { *out++ = "0123456789abcdef"[value % (U)base]; value /= (U)base; } while (value);
  reverse_range(result, out);
  *out = 0;
  return result;
}

extern "C" {
char *itoa(int value, char *result, int base) { return signed_to_text<int, unsigned int>(value, result, base); }
char *ltoa(long value, char *result, int base) { return signed_to_text<long, unsigned long>(value, result, base); }
char *lltoa(long long value, char *result, int base) { return signed_to_text<long long, unsigned long long>(value, result, base); }
char *utoa(unsigned int value, char *result, int base) { return unsigned_to_text<unsigned int>(value, result, base); }
char *ultoa(unsigned long value, char *result, int base) { return unsigned_to_text<unsigned long>(value, result, base); }
char *ulltoa(unsigned long long value, char *result, int base) { return unsigned_to_text<unsigned long long>(value, result, base); }

// Same algorithm as the core's dtostrf: round by adding half of the last digit, then peel digits off one by one,
// space-padding the integer part to `width`. NaN and infinities print as "nan" / "inf".
char *dtostrf(double number, signed int width, unsigned int prec, char *s) {
  if (isnan(number)) { strcpy(s, "nan"); return s; }
  if (isinf(number)) { strcpy(s, "inf"); return s; }
  char *out = s;
  int fill = width;
  if (prec > 0) fill -= (int)(prec + 1);
  bool negative = number < 0.0;
  if (negative) { fill--; number = -number; }
  double rounding = 2.0;
  for (unsigned int i = 0; i < prec; ++i) rounding *= 10.0;
  number += 1.0 / rounding;
  double tenpow = 1.0;
  unsigned int digits = 1;
  while (number >= 10.0 * tenpow) { tenpow *= 10.0; digits++; }
  number /= tenpow;
  fill -= (int)digits;
  while (fill-- > 0) *out++ = ' ';
  if (negative) *out++ = '-';
  digits += prec;
  while (digits-- > 0) {
    int digit = (int)number;
    if (digit > 9) digit = 9;
    *out++ = (char)('0' + digit);
    if (digits == prec && prec > 0) *out++ = '.';
    number -= digit;
    number *= 10.0;
  }
  *out = 0;
  return s;
}
}

// ---------------------------------------------------------------- construction / memory
const String emptyString;

String::String(const char *cstr) { if (cstr) copy(cstr, (unsigned int)strlen(cstr)); else ensure(0); }
String::String(const char *cstr, unsigned int length) { if (cstr) copy(cstr, length); else ensure(0); }
String::String(const String &value) { copy(value.c_str(), value.len_); }
String::String(String &&rval) noexcept { move(rval); }
String::String(char c) { char b[2] = {c, 0}; copy(b, 1); }
String::String(unsigned char value, unsigned char base) { char b[1 + 8 * sizeof(unsigned char)]; utoa(value, b, base); copy(b, (unsigned int)strlen(b)); }
String::String(int value, unsigned char base) { char b[2 + 8 * sizeof(int)]; itoa(value, b, base); copy(b, (unsigned int)strlen(b)); }
String::String(unsigned int value, unsigned char base) { char b[1 + 8 * sizeof(unsigned int)]; utoa(value, b, base); copy(b, (unsigned int)strlen(b)); }
String::String(long value, unsigned char base) { char b[2 + 8 * sizeof(long)]; ltoa(value, b, base); copy(b, (unsigned int)strlen(b)); }
String::String(unsigned long value, unsigned char base) { char b[1 + 8 * sizeof(unsigned long)]; ultoa(value, b, base); copy(b, (unsigned int)strlen(b)); }
String::String(long long value, unsigned char base) { char b[2 + 8 * sizeof(long long)]; lltoa(value, b, base); copy(b, (unsigned int)strlen(b)); }
String::String(unsigned long long value, unsigned char base) { char b[1 + 8 * sizeof(unsigned long long)]; ulltoa(value, b, base); copy(b, (unsigned int)strlen(b)); }
String::String(float value, unsigned int decimalPlaces) {
  char *b = (char *)malloc(decimalPlaces + 42);
  if (b) { dtostrf(value, (int)(decimalPlaces + 2), decimalPlaces, b); copy(b, (unsigned int)strlen(b)); free(b); }
  else copy("nan", 3);
}
String::String(double value, unsigned int decimalPlaces) {
  char *b = (char *)malloc(decimalPlaces + 312);
  if (b) { dtostrf(value, (int)(decimalPlaces + 2), decimalPlaces, b); copy(b, (unsigned int)strlen(b)); free(b); }
  else copy("nan", 3);
}
String::~String() { free(buf_); }

void String::invalidate() { free(buf_); buf_ = nullptr; cap_ = len_ = 0; }

bool String::ensure(unsigned int maxStrLen) {
  if (buf_ && cap_ >= maxStrLen) return true;
  unsigned int want = maxStrLen < 15 ? 15 : maxStrLen;
  char *n = (char *)realloc(buf_, want + 1);
  if (!n) return false;
  if (!buf_) n[0] = 0;
  buf_ = n;
  cap_ = want;
  return true;
}
bool String::reserve(unsigned int size) {
  if (!ensure(size)) return false;
  return true;
}

String &String::copy(const char *cstr, unsigned int length) {
  if (!ensure(length)) { invalidate(); return *this; }
  memmove(buf_, cstr, length);
  len_ = length;
  buf_[len_] = 0;
  return *this;
}
void String::move(String &rhs) noexcept {
  if (this != &rhs) {
    free(buf_);
    buf_ = rhs.buf_; cap_ = rhs.cap_; len_ = rhs.len_;
    rhs.buf_ = nullptr; rhs.cap_ = rhs.len_ = 0;
  }
}

String &String::operator=(const String &rhs) { if (this != &rhs) copy(rhs.c_str(), rhs.len_); return *this; }
String &String::operator=(const char *cstr) { if (cstr) copy(cstr, (unsigned int)strlen(cstr)); else invalidate(); return *this; }
String &String::operator=(String &&rval) noexcept { move(rval); return *this; }

// ---------------------------------------------------------------- concat
bool String::concat(const char *cstr, unsigned int length) {
  if (!cstr) return false;
  if (length == 0) return true;
  unsigned int newlen = len_ + length;
  // the source may live inside our own buffer: remember where before a realloc moves it
  bool inside = buf_ && cstr >= buf_ && cstr < buf_ + len_;
  size_t off = inside ? (size_t)(cstr - buf_) : 0;
  if (!ensure(newlen)) return false;
  memmove(buf_ + len_, inside ? buf_ + off : cstr, length);
  len_ = newlen;
  buf_[len_] = 0;
  return true;
}
bool String::concat(const String &s) { return concat(s.c_str(), s.len_); }
bool String::concat(const char *cstr) { return cstr ? concat(cstr, (unsigned int)strlen(cstr)) : false; }
bool String::concat(char c) { return concat(&c, 1); }
bool String::concat(unsigned char num) { return concat(String(num)); }
bool String::concat(int num) { return concat(String(num)); }
bool String::concat(unsigned int num) { return concat(String(num)); }
bool String::concat(long num) { return concat(String(num)); }
bool String::concat(unsigned long num) { return concat(String(num)); }
bool String::concat(long long num) { return concat(String(num)); }
bool String::concat(unsigned long long num) { return concat(String(num)); }
bool String::concat(float num) { return concat(String(num)); }
bool String::concat(double num) { return concat(String(num)); }

#define SUM(T) StringSumHelper operator+(const StringSumHelper &lhs, T rhs) { StringSumHelper r(lhs); r.concat(rhs); return r; }
SUM(const String &) SUM(const char *) SUM(char) SUM(unsigned char) SUM(int) SUM(unsigned int) SUM(long)
SUM(unsigned long) SUM(long long) SUM(unsigned long long) SUM(float) SUM(double) SUM(const __FlashStringHelper *)
#undef SUM

// ---------------------------------------------------------------- comparison
int String::compareTo(const String &s) const {
  if (!buf_ || !s.buf_) {
    if (s.buf_ && s.len_ > 0) return 0 - *(const unsigned char *)s.buf_;
    if (buf_ && len_ > 0) return *(const unsigned char *)buf_;
    return 0;
  }
  return strcmp(buf_, s.buf_);
}
bool String::equals(const String &s) const { return len_ == s.len_ && compareTo(s) == 0; }
bool String::equals(const char *cstr) const {
  if (len_ == 0) return cstr == nullptr || *cstr == 0;
  if (cstr == nullptr) return buf_[0] == 0;
  return strcmp(buf_, cstr) == 0;
}
bool String::equalsIgnoreCase(const String &s) const {
  if (this == &s) return true;
  if (len_ != s.len_) return false;
  for (unsigned int i = 0; i < len_; i++)
    if (tolower((unsigned char)buf_[i]) != tolower((unsigned char)s.buf_[i])) return false;
  return true;
}
unsigned char String::equalsConstantTime(const String &s) const {
  if (len_ != s.len_) return 0;
  unsigned char diff = 0;
  for (unsigned int i = 0; i < len_; i++) diff |= (unsigned char)(buf_[i] ^ s.buf_[i]);
  return diff == 0;
}
bool String::startsWith(const String &prefix, unsigned int offset) const {
  if (!buf_ || !prefix.buf_ || prefix.len_ > len_ || offset > len_ - prefix.len_) return false;
  return strncmp(buf_ + offset, prefix.buf_, prefix.len_) == 0;
}
bool String::endsWith(const String &suffix) const {
  if (!buf_ || !suffix.buf_ || suffix.len_ > len_) return false;
  return strcmp(buf_ + len_ - suffix.len_, suffix.buf_) == 0;
}

// ---------------------------------------------------------------- characters
char String::charAt(unsigned int index) const { return operator[](index); }
void String::setCharAt(unsigned int index, char c) { if (index < len_) buf_[index] = c; }
char String::operator[](unsigned int index) const { return (index >= len_ || !buf_) ? 0 : buf_[index]; }
char &String::operator[](unsigned int index) {
  static char dummy_writable_char;
  if (index >= len_ || !buf_) { dummy_writable_char = 0; return dummy_writable_char; }
  return buf_[index];
}
void String::getBytes(unsigned char *buf, unsigned int bufsize, unsigned int index) const {
  if (!bufsize || !buf) return;
  if (index >= len_) { buf[0] = 0; return; }
  unsigned int n = bufsize - 1;
  if (n > len_ - index) n = len_ - index;
  memcpy(buf, buf_ + index, n);
  buf[n] = 0;
}

// ---------------------------------------------------------------- search
int String::indexOf(char c, unsigned int fromIndex) const {
  if (fromIndex >= len_) return -1;
  const char *t = strchr(buf_ + fromIndex, c);
  return t ? (int)(t - buf_) : -1;
}
int String::indexOf(const String &s, unsigned int fromIndex) const {
  if (fromIndex >= len_) return -1;
  const char *found = strstr(buf_ + fromIndex, s.c_str());
  return found ? (int)(found - buf_) : -1;
}
int String::lastIndexOf(char c) const { return len_ ? lastIndexOf(c, len_ - 1) : -1; }
int String::lastIndexOf(char c, unsigned int fromIndex) const {
  if (fromIndex >= len_) return -1;
  for (int i = (int)fromIndex; i >= 0; i--) if (buf_[i] == c) return i;
  return -1;
}
int String::lastIndexOf(const String &s) const { return len_ ? lastIndexOf(s, len_ - s.len_) : -1; }
int String::lastIndexOf(const String &s, unsigned int fromIndex) const {
  if (s.len_ == 0 || len_ == 0 || s.len_ > len_) return -1;
  if (fromIndex >= len_) fromIndex = len_ - 1;
  int found = -1;
  for (const char *p = buf_; p <= buf_ + fromIndex; p++) {
    p = strstr(p, s.buf_);
    if (!p) break;
    if ((unsigned int)(p - buf_) <= fromIndex) found = (int)(p - buf_);
  }
  return found;
}
String String::substring(unsigned int left, unsigned int right) const {
  if (left > right) { unsigned int t = right; right = left; left = t; }
  String out;
  if (left >= len_) return out;
  if (right > len_) right = len_;
  out.copy(buf_ + left, right - left);
  return out;
}

// ---------------------------------------------------------------- modification
void String::replace(char find, char replace) {
  for (unsigned int i = 0; i < len_; i++) if (buf_[i] == find) buf_[i] = replace;
}
void String::replace(const String &find, const String &replace) {
  if (len_ == 0 || find.len_ == 0) return;
  String out;
  out.reserve(len_);
  const char *read = buf_;
  const char *hit;
  while ((hit = strstr(read, find.buf_)) != nullptr) {
    out.concat(read, (unsigned int)(hit - read));
    out.concat(replace);
    read = hit + find.len_;
  }
  out.concat(read);
  move(out);
}
void String::remove(unsigned int index) { remove(index, (unsigned int)-1); }
void String::remove(unsigned int index, unsigned int count) {
  if (index >= len_ || count == 0) return;
  if (count > len_ - index) count = len_ - index;
  memmove(buf_ + index, buf_ + index + count, len_ - index - count);
  len_ -= count;
  buf_[len_] = 0;
}
void String::toLowerCase(void) { for (unsigned int i = 0; i < len_; i++) buf_[i] = (char)tolower((unsigned char)buf_[i]); }
void String::toUpperCase(void) { for (unsigned int i = 0; i < len_; i++) buf_[i] = (char)toupper((unsigned char)buf_[i]); }
void String::trim(void) {
  if (!buf_ || len_ == 0) return;
  char *b = buf_;
  while (isspace((unsigned char)*b)) b++;
  char *e = buf_ + len_ - 1;
  while (e >= b && isspace((unsigned char)*e)) e--;
  unsigned int n = (unsigned int)(e + 1 - b);
  if (b > buf_) memmove(buf_, b, n);
  len_ = n;
  buf_[len_] = 0;
}

// ---------------------------------------------------------------- parsing
long String::toInt(void) const { return buf_ ? atol(buf_) : 0; }
float String::toFloat(void) const { return buf_ ? (float)atof(buf_) : 0; }
double String::toDouble(void) const { return buf_ ? atof(buf_) : 0; }
