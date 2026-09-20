#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <math.h>

// Arduino Nano ESP32; same wiring and OLED driver as the main project.
U8G2_SSD1306_64X32_1F_F_HW_I2C leftOLED(U8G2_R0, U8X8_PIN_NONE);
U8G2_SSD1306_64X32_1F_F_HW_I2C rightOLED(U8G2_R0, U8X8_PIN_NONE);
const uint32_t I2C_HZ = 400000;
uint32_t transferUs[2] = {0, 0};
uint32_t transferErrors[2] = {0, 0};

// Explicit callbacks avoid depending on U8g2's optional second-Wire support.
// Wire.begin() takes SDA, SCL; the OLED constructors used SCL, SDA.
uint8_t displayI2C(u8x8_t *display, uint8_t message, uint8_t count, void *data) {
  const int key = display == leftOLED.getU8x8() ? 0 : 1;
  TwoWire &bus = key == 0 ? Wire : Wire1;
  switch (message) {
    case U8X8_MSG_BYTE_INIT:
      return bus.begin(key == 0 ? A4 : D4, key == 0 ? A5 : D5, I2C_HZ);
    case U8X8_MSG_BYTE_START_TRANSFER:
      bus.beginTransmission(u8x8_GetI2CAddress(display) >> 1);
      break;
    case U8X8_MSG_BYTE_SEND:
      if (bus.write(static_cast<uint8_t *>(data), count) != count) {
        ++transferErrors[key];
        return 0;
      }
      break;
    case U8X8_MSG_BYTE_END_TRANSFER:
      if (bus.endTransmission() != 0) { ++transferErrors[key]; return 0; }
      break;
    case U8X8_MSG_BYTE_SET_DC:
      break;
    default: return 0;
  }
  return 1;
}
U8G2 *screens[] = {&leftOLED, &rightOLED};
const uint8_t pins[] = {D2, D3};
// 0 invert, 1 wave, 2 ripple, 3 wipe, 4 dissolve, 5 sparkle.
int mode = 1, thickness = 8, speed = 120;
const uint8_t MAX_WAVES = 32;
struct State {
  bool raw = HIGH, stable = HIGH, active = false, dirty = true;
  uint32_t changed = 0, started = 0, pulse = 0;
  bool virtualHeld = false;
  uint32_t waves[MAX_WAVES] = {};
  uint8_t waveCount = 0;
} states[2];
char line[80];
size_t used = 0;
bool overflow = false;
uint32_t lastFrame = 0;

bool basePixel(int x, int y) {
  bool border = ((y == 1 || y == 30) && x >= 2 && x <= 61) ||
                ((x == 1 || x == 62) && y >= 2 && y <= 29);
  return border || (x >= 25 && x <= 42 && abs(y - 16) <= (42 - x) * 2 / 3);
}
int noiseAt(int x, int y) { return (x * 37 + y * 73 + x * y * 13) % 101; }
void trigger(int key, bool virtualPress) {
  auto &s = states[key];
  s.started = millis(); s.active = true; s.dirty = true;
  if (mode == 1) {
    // Bounded queue: retain the newest presses if the key is hammered.
    if (s.waveCount == MAX_WAVES) {
      for (uint8_t i = 1; i < MAX_WAVES; ++i) s.waves[i - 1] = s.waves[i];
      --s.waveCount;
    }
    s.waves[s.waveCount++] = s.started;
  }
  if (virtualPress) { s.virtualHeld = true; s.pulse = millis(); }
}
void command(const char *text) {
  int m, w, v, key;
  char extra;
  if (!strcmp(text, "HELLO")) Serial.println("ANIMATIONS 1");
  else if (!strcmp(text, "STATS")) {
    Serial.printf("STATS %lu %lu %lu %lu\n", (unsigned long)transferUs[0],
                  (unsigned long)transferUs[1], (unsigned long)transferErrors[0],
                  (unsigned long)transferErrors[1]);
  }
  else if (sscanf(text, "SET %d %d %d %c", &m, &w, &v, &extra) == 3 &&
           m >= 0 && m <= 5 && w >= 1 && w <= 16 && v >= 5 && v <= 160) {
    mode = m; thickness = w; speed = v;
    for (auto &s : states) { s.active = false; s.waveCount = 0; s.virtualHeld = false; s.dirty = true; }
    Serial.printf("OK %d %d %d\n", mode, thickness, speed);
  } else if (sscanf(text, "TRIGGER %d %c", &key, &extra) == 1 && key >= 0 && key < 2) {
    trigger(key, true); Serial.printf("TRIGGERED %d\n", key);
  } else Serial.println("ERROR command");
}
void render(int key, uint32_t now) {
  auto &s = states[key];
  U8G2 &d = *screens[key];
  float travel = (now - s.started) * speed / 1000.0f;
  // Waves clear the farthest corner including their trailing edge.
  float limit = mode == 1 ? 46 + thickness : mode == 2 ? 37 + thickness : mode == 3 ? 64 + thickness : 64;
  float outerSquared[MAX_WAVES], innerSquared[MAX_WAVES];
  if (mode == 1) {
    uint8_t live = 0;
    for (uint8_t i = 0; i < s.waveCount; ++i) {
      float radius = (now - s.waves[i]) * speed / 1000.0f;
      if (radius >= limit) continue;
      s.waves[live] = s.waves[i];
      outerSquared[live] = radius * radius;
      float inner = radius - thickness;
      innerSquared[live] = inner < 0 ? -1 : inner * inner;
      ++live;
    }
    s.waveCount = live;
    s.active = live != 0;
  } else if (s.active && travel >= limit) s.active = false;
  bool held = s.stable == LOW || s.virtualHeld;
  d.clearBuffer();
  for (int y = 0; y < 32; ++y) for (int x = 0; x < 64; ++x) {
    bool flip = mode == 0 && held;
    if (s.active && mode != 0) {
      float dx = x - 31.5f, dy = y - (mode == 1 ? 31.0f : 15.5f);
      float distanceSquared = dx * dx + dy * dy;
      if (mode == 1) {
        // Union of the rings: overlapping waves do not cancel each other.
        for (uint8_t i = 0; i < s.waveCount; ++i) {
          if (distanceSquared <= outerSquared[i] && distanceSquared > innerSquared[i]) {
            flip = true; break;
          }
        }
      } else if (mode == 2) {
        float distance = sqrtf(distanceSquared);
        flip = distance <= travel && distance > travel - thickness;
      }
      else if (mode == 3) flip = x <= travel && x > travel - thickness;
      else if (mode == 4) flip = noiseAt(x, y) < 100 * sinf(PI * travel / 64);
      else if (mode == 5) {
        int tick = (int)(travel / 3);
        flip = ((noiseAt(x, y) + tick * 17) % 101 < thickness) &&
               ((x + y) % 3 == 0);
      }
    }
    if (basePixel(x, y) != flip) d.drawPixel(x, y);
  }
  uint32_t transferStart = micros();
  d.sendBuffer();
  transferUs[key] = micros() - transferStart;
  s.dirty = false;
}
void setup() {
  Serial.begin(115200);
  for (uint8_t pin : pins) pinMode(pin, INPUT_PULLUP);
  for (auto *d : screens) {
    d->getU8x8()->byte_cb = displayI2C;
    d->setI2CAddress(0x3C << 1); d->setBusClock(I2C_HZ);
    d->begin(); d->setContrast(100);
  }
}
void loop() {
  for (int n = 0; n < 128 && Serial.available(); ++n) {
    char c = Serial.read();
    if (c == '\n') {
      if (!overflow) { line[used] = 0; command(line); }
      used = 0; overflow = false;
    } else if (c != '\r') {
      if (used < sizeof(line) - 1) line[used++] = c;
      else overflow = true;
    }
  }
  uint32_t now = millis();
  for (int i = 0; i < 2; ++i) {
    auto &s = states[i];
    bool raw = digitalRead(pins[i]);
    if (raw != s.raw) { s.raw = raw; s.changed = now; }
    if (raw != s.stable && now - s.changed >= 25) {
      s.stable = raw; s.dirty = true;
      if (raw == LOW) trigger(i, false);
      Serial.printf("BUTTON %d %d\n", i, raw == LOW ? 1 : 0);
    }
    if (s.virtualHeld && now - s.pulse >= 450) { s.virtualHeld = false; s.dirty = true; }
  }
  // A press may have started after the button-sampling timestamp.
  now = millis();
  if (now - lastFrame >= 33) {
    lastFrame = now;
    for (int i = 0; i < 2; ++i) if (states[i].dirty || states[i].active) render(i, now);
  }
  delay(1);
}
