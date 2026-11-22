// Arduino String for the Holocube simulator.
// Same API and the same observable behaviour as the ESP32 Arduino core 3.x WString (number formatting, float
// rounding, substring/indexOf/remove/replace/trim edge cases, truthiness, "a" + String(b) + c chains), written for
// the simulator rather than copied from the core.
#ifndef HOLOCUBE_SIM_WSTRING_H
#define HOLOCUBE_SIM_WSTRING_H

#ifdef __cplusplus

#include <stdint.h>
#include <stddef.h>
#include <string.h>

class __FlashStringHelper;   // F("...") strings; in the simulator they are ordinary RAM strings

class StringSumHelper;

class String {
  // `if (str)` is true while the String holds a buffer, as on the ESP32 (so also for an empty String)
  typedef void (String::*StringIfHelperType)() const;
  void StringIfHelper() const {}

public:
  String(const char *cstr = "");
  String(const char *cstr, unsigned int length);
  String(const uint8_t *cstr, unsigned int length) : String(reinterpret_cast<const char *>(cstr), length) {}
  String(const String &str);
  String(const __FlashStringHelper *str) : String(reinterpret_cast<const char *>(str)) {}
  String(String &&rval) noexcept;
  explicit String(char c);
  explicit String(unsigned char value, unsigned char base = 10);
  explicit String(int value, unsigned char base = 10);
  explicit String(unsigned int value, unsigned char base = 10);
  explicit String(long value, unsigned char base = 10);
  explicit String(unsigned long value, unsigned char base = 10);
  explicit String(long long value, unsigned char base = 10);
  explicit String(unsigned long long value, unsigned char base = 10);
  explicit String(float value, unsigned int decimalPlaces = 2);
  explicit String(double value, unsigned int decimalPlaces = 2);
  ~String();

  // memory
  bool reserve(unsigned int size);
  inline unsigned int length() const { return len_; }
  inline bool isEmpty() const { return len_ == 0; }
  void clear() { if (buf_) { len_ = 0; buf_[0] = 0; } }

  // assignment
  String &operator=(const String &rhs);
  String &operator=(const char *cstr);
  String &operator=(const __FlashStringHelper *str) { return *this = reinterpret_cast<const char *>(str); }
  String &operator=(String &&rval) noexcept;

  // concatenation: true on success
  bool concat(const String &str);
  bool concat(const char *cstr);
  bool concat(const char *cstr, unsigned int length);
  bool concat(const uint8_t *cstr, unsigned int length) { return concat(reinterpret_cast<const char *>(cstr), length); }
  bool concat(char c);
  bool concat(unsigned char num);
  bool concat(int num);
  bool concat(unsigned int num);
  bool concat(long num);
  bool concat(unsigned long num);
  bool concat(long long num);
  bool concat(unsigned long long num);
  bool concat(float num);
  bool concat(double num);
  bool concat(const __FlashStringHelper *str) { return concat(reinterpret_cast<const char *>(str)); }

  String &operator+=(const String &rhs) { concat(rhs); return *this; }
  String &operator+=(const char *cstr) { concat(cstr); return *this; }
  String &operator+=(char c) { concat(c); return *this; }
  String &operator+=(unsigned char num) { concat(num); return *this; }
  String &operator+=(int num) { concat(num); return *this; }
  String &operator+=(unsigned int num) { concat(num); return *this; }
  String &operator+=(long num) { concat(num); return *this; }
  String &operator+=(unsigned long num) { concat(num); return *this; }
  String &operator+=(long long num) { concat(num); return *this; }
  String &operator+=(unsigned long long num) { concat(num); return *this; }
  String &operator+=(float num) { concat(num); return *this; }
  String &operator+=(double num) { concat(num); return *this; }
  String &operator+=(const __FlashStringHelper *str) { concat(str); return *this; }

  // comparison
  operator StringIfHelperType() const { return buf_ ? &String::StringIfHelper : 0; }
  int compareTo(const String &s) const;
  bool equals(const String &s) const;
  bool equals(const char *cstr) const;
  bool operator==(const String &rhs) const { return equals(rhs); }
  bool operator==(const char *cstr) const { return equals(cstr); }
  bool operator!=(const String &rhs) const { return !equals(rhs); }
  bool operator!=(const char *cstr) const { return !equals(cstr); }
  bool operator<(const String &rhs) const { return compareTo(rhs) < 0; }
  bool operator>(const String &rhs) const { return compareTo(rhs) > 0; }
  bool operator<=(const String &rhs) const { return compareTo(rhs) <= 0; }
  bool operator>=(const String &rhs) const { return compareTo(rhs) >= 0; }
  bool equalsIgnoreCase(const String &s) const;
  unsigned char equalsConstantTime(const String &s) const;
  bool startsWith(const String &prefix) const { return startsWith(prefix, 0); }
  bool startsWith(const char *prefix) const { return startsWith(String(prefix), 0); }
  bool startsWith(const String &prefix, unsigned int offset) const;
  bool endsWith(const String &suffix) const;
  bool endsWith(const char *suffix) const { return endsWith(String(suffix)); }

  // characters
  char charAt(unsigned int index) const;
  void setCharAt(unsigned int index, char c);
  char operator[](unsigned int index) const;
  char &operator[](unsigned int index);
  void getBytes(unsigned char *buf, unsigned int bufsize, unsigned int index = 0) const;
  void toCharArray(char *buf, unsigned int bufsize, unsigned int index = 0) const {
    getBytes(reinterpret_cast<unsigned char *>(buf), bufsize, index);
  }
  const char *c_str() const { return buf_ ? buf_ : ""; }
  char *begin() { return buf_; }
  char *end() { return buf_ ? buf_ + len_ : nullptr; }
  const char *begin() const { return c_str(); }
  const char *end() const { return c_str() + len_; }

  // search
  int indexOf(char ch) const { return indexOf(ch, 0); }
  int indexOf(char ch, unsigned int fromIndex) const;
  int indexOf(const String &str) const { return indexOf(str, 0); }
  int indexOf(const String &str, unsigned int fromIndex) const;
  int lastIndexOf(char ch) const;
  int lastIndexOf(char ch, unsigned int fromIndex) const;
  int lastIndexOf(const String &str) const;
  int lastIndexOf(const String &str, unsigned int fromIndex) const;
  String substring(unsigned int beginIndex) const { return substring(beginIndex, len_); }
  String substring(unsigned int beginIndex, unsigned int endIndex) const;

  // modification
  void replace(char find, char replace);
  void replace(const String &find, const String &replace);
  void replace(const char *find, const String &replace) { this->replace(String(find), replace); }
  void replace(const char *find, const char *replace) { this->replace(String(find), String(replace)); }
  void remove(unsigned int index);
  void remove(unsigned int index, unsigned int count);
  void toLowerCase(void);
  void toUpperCase(void);
  void trim(void);

  // parsing
  long toInt(void) const;
  float toFloat(void) const;
  double toDouble(void) const;

protected:
  char *buf_ = nullptr;
  unsigned int cap_ = 0;
  unsigned int len_ = 0;

  void invalidate();
  bool ensure(unsigned int maxStrLen);
  String &copy(const char *cstr, unsigned int length);
  void move(String &rhs) noexcept;
};

// Lets `"text" + String(x) + 'c' + 42` build one String, like the core's StringSumHelper.
class StringSumHelper : public String {
public:
  StringSumHelper(const String &s) : String(s) {}
  StringSumHelper(const char *p) : String(p) {}
  StringSumHelper(char c) : String(c) {}
  StringSumHelper(unsigned char num) : String(num) {}
  StringSumHelper(int num) : String(num) {}
  StringSumHelper(unsigned int num) : String(num) {}
  StringSumHelper(long num) : String(num) {}
  StringSumHelper(unsigned long num) : String(num) {}
  StringSumHelper(long long num) : String(num) {}
  StringSumHelper(unsigned long long num) : String(num) {}
  StringSumHelper(float num) : String(num) {}
  StringSumHelper(double num) : String(num) {}
};

StringSumHelper operator+(const StringSumHelper &lhs, const String &rhs);
StringSumHelper operator+(const StringSumHelper &lhs, const char *cstr);
StringSumHelper operator+(const StringSumHelper &lhs, char c);
StringSumHelper operator+(const StringSumHelper &lhs, unsigned char num);
StringSumHelper operator+(const StringSumHelper &lhs, int num);
StringSumHelper operator+(const StringSumHelper &lhs, unsigned int num);
StringSumHelper operator+(const StringSumHelper &lhs, long num);
StringSumHelper operator+(const StringSumHelper &lhs, unsigned long num);
StringSumHelper operator+(const StringSumHelper &lhs, long long num);
StringSumHelper operator+(const StringSumHelper &lhs, unsigned long long num);
StringSumHelper operator+(const StringSumHelper &lhs, float num);
StringSumHelper operator+(const StringSumHelper &lhs, double num);
StringSumHelper operator+(const StringSumHelper &lhs, const __FlashStringHelper *rhs);

inline bool operator==(const char *lhs, const String &rhs) { return rhs.equals(lhs); }
inline bool operator!=(const char *lhs, const String &rhs) { return !rhs.equals(lhs); }

extern const String emptyString;

// the core's number <-> text helpers (stdlib_noniso), available to sketches too
extern "C" {
char *itoa(int value, char *result, int base);
char *ltoa(long value, char *result, int base);
char *lltoa(long long value, char *result, int base);
char *utoa(unsigned int value, char *result, int base);
char *ultoa(unsigned long value, char *result, int base);
char *ulltoa(unsigned long long value, char *result, int base);
char *dtostrf(double number, signed int width, unsigned int prec, char *s);
}

#endif  // __cplusplus
#endif
