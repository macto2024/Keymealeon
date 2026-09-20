#include <Arduino.h>
#include <U8g2lib.h>
#include "USB.h"
#include "USBHIDKeyboard.h"
#include "USBHIDConsumerControl.h"
#include "Icons.h"

#if ARDUINO_USB_MODE != 0
#error Select USB Mode: Normal mode (TinyUSB)
#endif

// Board label constants work with either Nano pin-numbering menu choice.
// 1F selects the 32-row scan setting; NONAME uses a different multiplex ratio.
U8G2_SSD1306_64X32_1F_F_SW_I2C leftOLED(U8G2_R0, A5, A4, U8X8_PIN_NONE);
U8G2_SSD1306_64X32_1F_F_SW_I2C rightOLED(U8G2_R0, D5, D4, U8X8_PIN_NONE);
U8G2 *screens[] = {&leftOLED, &rightOLED};
USBHIDKeyboard keyboard;
USBHIDConsumerControl consumer;
const uint8_t pins[] = {D2, D3};
uint32_t revision = 0, sequence = 0, lastHost = 0;
int profile = 0;
bool online = false;
struct KeyState {
  bool raw = HIGH, stable = HIGH;
  uint32_t changed = 0, pending = 0, sent = 0;
} keys[2];
char input[100];
size_t inputLen = 0;
bool overflow = false;

void render() {
  for (int i = 0; i < 2; ++i) {
    U8G2 &d = *screens[i];
    d.clearBuffer();
    d.drawXBMP(0, 0, 64, 32, online ? profileIcons[profile][i] : icon_offline);
    d.sendBuffer();
  }
}
void chord(uint8_t modifier, uint8_t key) {
  if (modifier) keyboard.press(modifier);
  keyboard.press(key);
  delay(12);
  keyboard.releaseAll();
}
void act(const char *action) {
  if (!strcmp(action, "back")) chord(KEY_LEFT_ALT, KEY_LEFT_ARROW);
  else if (!strcmp(action, "refresh")) chord(KEY_LEFT_CTRL, 'r');
  else if (!strcmp(action, "save")) chord(KEY_LEFT_CTRL, 's');
  else if (!strcmp(action, "run")) chord(KEY_LEFT_CTRL, KEY_F5);
  else if (!strcmp(action, "clear")) chord(KEY_LEFT_CTRL, 'l');
  else if (!strcmp(action, "tab")) {
    keyboard.press(KEY_LEFT_CTRL);
    chord(KEY_LEFT_SHIFT, 't');
  } else if (!strcmp(action, "down") || !strcmp(action, "up")) {
    consumer.press(!strcmp(action, "down") ? CONSUMER_CONTROL_VOLUME_DECREMENT : CONSUMER_CONTROL_VOLUME_INCREMENT);
    delay(12);
    consumer.release();
  }
}
void command(const char *line) {
  unsigned long rev, seq;
  int p;
  char action[16], extra;
  if (sscanf(line, "SET %lu %d %c", &rev, &p, &extra) == 2 && p >= 0 && p <= 5) {
    bool changed = !online || profile != p;
    if (revision != rev) for (auto &k : keys) k.pending = 0;
    revision = rev; profile = p; online = true; lastHost = millis();
    if (changed) render();
  } else if (sscanf(line, "DO %lu %15s %c", &seq, action, &extra) == 2) {
    for (auto &k : keys) {
      if (seq && k.pending == seq) {
        k.pending = 0; // One response can execute at most once.
        if (online && millis() - lastHost < 2000 && millis() - k.sent < 500) act(action);
      }
    }
  }
}
void setup() {
  for (uint8_t pin : pins) pinMode(pin, INPUT_PULLUP);
  for (auto *d : screens) {
    d->setI2CAddress(0x3C << 1); // U8g2 takes the shifted address; each bus is independent.
    d->setBusClock(100000);
    d->begin();
    d->setContrast(100);
  }
  keyboard.begin(); consumer.begin(); Serial.begin(115200); USB.begin();
  render();
}
void loop() {
  // Bound serial work so malformed traffic cannot starve switch sampling.
  for (int n = 0; n < 128 && Serial.available(); ++n) {
    char c = Serial.read();
    if (c == '\n') {
      if (!overflow) { input[inputLen] = 0; command(input); }
      inputLen = 0; overflow = false;
    } else if (c != '\r') {
      if (inputLen < sizeof(input) - 1) input[inputLen++] = c;
      else overflow = true;
    }
  }
  uint32_t now = millis();
  if (online && now - lastHost >= 2000) {
    online = false;
    keyboard.releaseAll(); consumer.release();
    for (auto &k : keys) k.pending = 0;
    render();
  }
  for (int i = 0; i < 2; ++i) {
    auto &k = keys[i];
    bool raw = digitalRead(pins[i]);
    if (raw != k.raw) { k.raw = raw; k.changed = now; }
    if (raw != k.stable && now - k.changed >= 25) {
      k.stable = raw;
      if (raw == LOW && online && profile != 0) {
        if (++sequence == 0) ++sequence;
        k.pending = sequence; k.sent = now;
        Serial.printf("PRESS %lu %lu %d\n", (unsigned long)sequence, (unsigned long)revision, i);
      }
    }
  }
  delay(1);
}
