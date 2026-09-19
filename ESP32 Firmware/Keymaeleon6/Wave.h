#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// Bottom-wave geometry from animations/AnimationTest, fixed at 8 px / 120 px/s.
namespace Keymaeleon6 {
constexpr uint8_t WIDTH = 64, HEIGHT = 32, THICKNESS = 8, MAX_WAVES = 32;
constexpr uint16_t SPEED = 120;
constexpr uint32_t LIFETIME_MS = 450; // (46 + 8) / 120 seconds, including tail.
struct Wave {
  uint32_t started[MAX_WAVES] = {};
  uint8_t count = 0;

  void prune(uint32_t now) {
    uint8_t live = 0;
    for (uint8_t i = 0; i < count; ++i)
      if (uint32_t(now - started[i]) < LIFETIME_MS) started[live++] = started[i];
    count = live;
  }
  void trigger(uint32_t now) {
    prune(now);
    if (count == MAX_WAVES) {
      memmove(started, started + 1, (MAX_WAVES - 1) * sizeof(uint32_t));
      --count;
    }
    started[count++] = now;
  }
  void frame(uint32_t now, uint8_t *bitmap, const uint8_t *background = nullptr) {
    prune(now);
    float outer[MAX_WAVES], inner[MAX_WAVES];
    for (uint8_t i = 0; i < count; ++i) {
      float radius = uint32_t(now - started[i]) * SPEED / 1000.0f;
      outer[i] = radius * radius;
      float r = radius - THICKNESS;
      inner[i] = r < 0 ? -1 : r * r;
    }
    memset(bitmap, 0, WIDTH * HEIGHT / 8);
    for (int y = 0; y < HEIGHT; ++y) for (int x = 0; x < WIDTH; ++x) {
      bool base = (((y == 1 || y == 30) && x >= 2 && x <= 61) ||
                   ((x == 1 || x == 62) && y >= 2 && y <= 29) ||
                   (x >= 25 && x <= 42 && abs(y - 16) <= (42 - x) * 2 / 3));
      if (background) base = (background[y * 8 + x / 8] >> (x % 8)) & 1;
      float dx = x - 31.5f, dy = y - 31.0f;
      float distance = dx * dx + dy * dy;
      bool flip = false;
      for (uint8_t i = 0; i < count; ++i) {
        // Union, not XOR: overlapping rings do not cancel each other.
        if (distance <= outer[i] && distance > inner[i]) { flip = true; break; }
      }
      if (base != flip) bitmap[y * 8 + x / 8] |= uint8_t(1U << (x % 8));
    }
  }
};
} // namespace Keymaeleon6
