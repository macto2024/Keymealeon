#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <atomic>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "Wave.h"
#include "Icons6.h"
#include "IsolatedDisplay.h"
#include "freertos/semphr.h"
#include <stdarg.h>
#include <string.h>

// Physical layout: 1 2 3 / 4 5 6. App-aware serial companion; actions execute on the host, no HID.
constexpr uint8_t KEY_COUNT = 6;
constexpr uint8_t BUTTON_PINS[KEY_COUNT] = {D2, D3, D4, D5, D6, D7};
// One TCA9548A per hardware bus; channels 0–2 serve each row.
constexpr uint8_t MUX_ADDRESSES[2] = {0x70, 0x70};
constexpr uint8_t SDA_PINS[2] = {A4, A6};
constexpr uint8_t SCL_PINS[2] = {A5, A7};
constexpr uint8_t RESET_PINS[2] = {D8, D9}; // Active-low mux reset, pulled up to 3V3.
constexpr uint8_t OLED_ADDRESS = 0x3C;
constexpr uint32_t I2C_HZ = 400000;
constexpr uint32_t FRAME_MS = 20; // Target 50 FPS/key; three displays share each independent bus.
U8G2_SSD1306_64X32_1F_F_HW_I2C topOLED(U8G2_R0, U8X8_PIN_NONE);
U8G2_SSD1306_64X32_1F_F_HW_I2C bottomOLED(U8G2_R0, U8X8_PIN_NONE);

// Worker-owned state: never read/written by loop().
struct DisplayState {
  Keymaeleon6::Wave wave;
  bool dirty = true;
  uint32_t lastFrame = 0;
};
struct Row {
  TwoWire *wire;
  U8G2 *oled;
  QueueHandle_t queue = nullptr;
  DisplayState displays[3];
  uint8_t bitmap[256] = {};
  uint8_t framebuffer[256] = {}; // Explicit ownership; U8g2 defaults can share static memory.
  uint8_t selected = 0;
  Row(TwoWire *w, U8G2 *d) : wire(w), oled(d) {}
} rows[2] = {{&Wire, &topOLED}, {&Wire1, &bottomOLED}};

// Atomic telemetry is safe to inspect from loop() while the display worker transfers.
struct Telemetry {
  std::atomic<bool> available{false};
  std::atomic<uint32_t> transferUs{0}, errors{0}, frames{0}, intervalUs{0};
  std::atomic<uint32_t> shortWrites{0}, transactions{0}, maxBytes{0};
  std::atomic<uint32_t> lastCode{0}, lastBytes{0}, probeCode{255};
} stats[KEY_COUNT];
std::atomic<bool> busReady[2];
std::atomic<uint32_t> muxErrors[2];
enum DebugCommand : uint8_t { SCAN, TEST, RUN, RATE, REINIT };
struct DebugRequest { DebugCommand command; int value; };
QueueHandle_t debugQueue[2] = {nullptr, nullptr};
std::atomic<bool> paused[2];
std::atomic<uint32_t> busHz[2];
uint32_t transactionBytes[2] = {};
bool reverseInit[2] = {};
std::atomic<uint32_t> queueDrops{0};
struct Press { uint8_t channel; uint32_t at; };
struct Button {
  bool raw = HIGH, stable = HIGH;
  uint32_t changed = 0;
} buttons[KEY_COUNT];
struct Layout { uint32_t revision; uint8_t icons[KEY_COUNT]; };
QueueHandle_t layoutQueue[2] = {nullptr, nullptr};
Layout activeLayout[2] = {}; // Worker-owned.
std::atomic<uint32_t> shownRevision[6];
bool companionActive = false;
uint32_t lastLayout = 0, pressSequence = 0;
char input[64];
size_t used = 0;
bool overflow = false;

SemaphoreHandle_t logMutex = nullptr;
void logLine(const char *format, ...) {
  char text[256];
  va_list args; va_start(args, format);
  vsnprintf(text, sizeof(text), format, args); va_end(args);
  if (logMutex) xSemaphoreTake(logMutex, portMAX_DELAY);
  Serial.print(text);
  if (logMutex) xSemaphoreGive(logMutex);
}

bool muxWrite(uint8_t row, uint8_t mask) {
  TwoWire &bus = *rows[row].wire;
  bus.beginTransmission(MUX_ADDRESSES[row]);
  bus.write(mask);
  if (bus.endTransmission() == 0) return true;
  ++muxErrors[row];
  return false;
}
void busFault(uint8_t row) {
  digitalWrite(RESET_PINS[row], LOW);
  delayMicroseconds(10);
  digitalWrite(RESET_PINS[row], HIGH);
  busReady[row] = false;
  for (uint8_t i = row*3; i < row*3+3; ++i) stats[i].available = false;
  // Reset disconnects every downstream channel after a mux fault.
}
bool selectDisplay(uint8_t row, uint8_t channel) {
  if (!busReady[row] || channel >= 3) return false;
  // One-hot control register replaces any previous selection on THIS mux only.
  if (!muxWrite(row, uint8_t(1U << channel))) { busFault(row); return false; }
  if (rows[row].wire->requestFrom(MUX_ADDRESSES[row], uint8_t(1)) != 1 ||
      rows[row].wire->read() != int(1U << channel)) {
    ++muxErrors[row]; busFault(row); return false;
  }
  rows[row].selected = channel;
  return true;
}
uint8_t displayI2C(u8x8_t *display, uint8_t message, uint8_t count, void *data) {
  const uint8_t row = display == topOLED.getU8x8() ? 0 : 1;
  TwoWire &bus = *rows[row].wire;
  Telemetry &s = stats[row*3 + rows[row].selected];
  switch (message) {
    case U8X8_MSG_BYTE_INIT: return busReady[row] ? 1 : 0;
    case U8X8_MSG_BYTE_START_TRANSFER:
      transactionBytes[row] = 0;
      bus.beginTransmission(u8x8_GetI2CAddress(display) >> 1); break;
    case U8X8_MSG_BYTE_SEND:
      transactionBytes[row] += count;
      if (transactionBytes[row] > s.maxBytes.load()) s.maxBytes = transactionBytes[row];
      if (bus.write(static_cast<uint8_t *>(data), count) != count) {
        ++s.errors; ++s.shortWrites; return 0;
      }
      break;
    case U8X8_MSG_BYTE_END_TRANSFER: {
      uint8_t code = bus.endTransmission();
      ++s.transactions; s.lastBytes = transactionBytes[row];
      // Keep the last failure code until reset, rather than overwrite with success.
      if (code) { s.lastCode = code; ++s.errors; return 0; }
      break;
    }
    case U8X8_MSG_BYTE_SET_DC: break;
    default: return 0;
  }
  return 1;
}
bool initializeDisplay(uint8_t row, uint8_t channel) {
  Row &r = rows[row];
  Telemetry &s = stats[row*3 + channel];
  s.available = false;
  if (!selectDisplay(row, channel)) return false;
  r.wire->beginTransmission(OLED_ADDRESS);
  uint8_t probe = r.wire->endTransmission();
  s.probeCode = probe;
  if (probe) { ++s.errors; s.lastCode = probe; return false; }
  uint32_t before = s.errors.load();
  r.oled->begin();
  r.oled->setContrast(100);
  s.available = s.errors.load() == before;
  r.displays[channel].wave.count = 0;
  r.displays[channel].dirty = true;
  return s.available;
}
void prepareBus(uint8_t row) {
  Row &r = rows[row];
  digitalWrite(RESET_PINS[row], LOW);
  pinMode(RESET_PINS[row], OUTPUT);
  delay(1);
  digitalWrite(RESET_PINS[row], HIGH);
  delay(1);
  busReady[row] = r.wire->begin(SDA_PINS[row], SCL_PINS[row], busHz[row]);
  r.wire->setTimeOut(20);
  if (!busReady[row] || !muxWrite(row, 0)) { busFault(row); return; }
  r.oled->getU8x8()->byte_cb = displayI2C;
  // Own the real U8g2 framebuffer, not just the staging bitmap.
  Keymaeleon6::isolateDisplay(r.oled->getU8g2(), r.framebuffer);
  r.oled->setI2CAddress(OLED_ADDRESS << 1);
  r.oled->setBusClock(busHz[row]);
 }
void initRow(uint8_t row) {
  prepareBus(row);
  if (!busReady[row]) return;
  for (uint8_t index = 0; index < 3; ++index) {
    uint8_t channel = reverseInit[row] ? 2 - index : index;
    initializeDisplay(row, channel);
    if (!busReady[row]) return;
  }
  if (!muxWrite(row, 0)) busFault(row);
}
void render(uint8_t row, uint8_t channel) {
  if (!selectDisplay(row, channel)) return;
  Row &r = rows[row];
  DisplayState &d = r.displays[channel];
  Telemetry &s = stats[row*3 + channel];
  uint32_t previousErrors = s.errors.load();
  uint32_t now = millis();
  // Actual elapsed time keeps speed fixed even if bus traffic delays a frame.
  d.wave.frame(now, r.bitmap, sixIcons[activeLayout[row].icons[row*3+channel]]);
  r.oled->clearBuffer();
  r.oled->drawXBMP(0, 0, 64, 32, r.bitmap);
  uint32_t start = micros();
  r.oled->sendBuffer();
  if (s.errors.load() == previousErrors) shownRevision[row*3+channel] = activeLayout[row].revision;
  s.transferUs = micros() - start;
  if (s.frames.load()) s.intervalUs = uint32_t(now - d.lastFrame) * 1000;
  ++s.frames;
  d.lastFrame = now;
  d.dirty = false;
  if (!muxWrite(row, 0)) busFault(row);
  if (s.errors.load() != previousErrors) {
    s.available = false;
    logLine("FAULT KEY %u CH %u CODE %lu SHORT_WRITES %lu (display disabled)\n",
                  row*3+channel+1, channel, (unsigned long)s.lastCode.load(),
                  (unsigned long)s.shortWrites.load());
  }
}
void scanChannels(uint8_t row) {
  // No animation transfers run while this worker performs the scan.
  bool off = muxWrite(row, 0);
  int offMask = -1;
  if (rows[row].wire->requestFrom(MUX_ADDRESSES[row], uint8_t(1)) == 1) offMask = rows[row].wire->read();
  int upstream = -1;
  if (off && offMask == 0) {
    rows[row].wire->beginTransmission(OLED_ADDRESS); upstream = rows[row].wire->endTransmission();
  }
  logLine("SCAN BUS %u OFF MUX_OK %u MASK_READ %d OLED_3C %d\n", row, off ? 1 : 0, offMask, upstream);
  if (!off || offMask != 0) { busFault(row); delay(1); }
  for (uint8_t channel = 0; channel < 8; ++channel) {
    bool written = muxWrite(row, uint8_t(1U << channel));
    int actual = -1;
    if (rows[row].wire->requestFrom(MUX_ADDRESSES[row], uint8_t(1)) == 1)
      actual = rows[row].wire->read();
    int ack3c = -1, ack3d = -1;
    if (written && actual == (1 << channel)) {
      rows[row].wire->beginTransmission(0x3C); ack3c = rows[row].wire->endTransmission();
      rows[row].wire->beginTransmission(0x3D); ack3d = rows[row].wire->endTransmission();
    }
    logLine("SCAN BUS %u CH %u MASK_EXPECT 0x%02X MASK_READ %d MUX_OK %u OLED_3C %d OLED_3D %d\n",
                  row, channel, 1 << channel, actual, written ? 1 : 0, ack3c, ack3d);
    if (!muxWrite(row, 0)) { busFault(row); delay(1); }
  }
  logLine("DONE SCAN BUS %u\n", row);
}
void testDisplay(uint8_t row, uint8_t channel) {
  // Recover/isolate before this single display; do not initialize the other five.
  if (!busReady[row]) { rows[row].wire->end(); prepareBus(row); }
  if (!initializeDisplay(row, channel)) {
    logLine("TEST KEY %u CH %u INIT_FAILED PROBE %lu\n", row*3+channel+1, channel,
                  (unsigned long)stats[row*3 + channel].probeCode.load());
    if (!muxWrite(row, 0)) busFault(row);
    return;
  }
  U8G2 &d = *rows[row].oled;
  uint32_t before = stats[row*3 + channel].errors.load();
  d.clearBuffer();
  d.drawFrame(0, 0, 64, 32);
  for (uint8_t x = 2; x < 62; x += 4) d.drawBox(x, 2, 2, 6);
  d.setFont(u8g2_font_6x10_tf);
  char label[12]; snprintf(label, sizeof(label), "KEY %u", row*3+channel+1);
  d.drawStr(17, 22, label);
  // Exactly one frame, then idle: no continuous data or animation queue.
  d.sendBuffer();
  bool off = muxWrite(row, 0);
  logLine("TEST KEY %u CH %u NEW_ERRORS %lu SHORT_WRITES %lu MAX_BYTES %lu LAST_CODE %lu\n",
                row*3+channel+1, channel, (unsigned long)(stats[row*3 + channel].errors.load()-before),
                (unsigned long)stats[row*3 + channel].shortWrites.load(),
                (unsigned long)stats[row*3 + channel].maxBytes.load(),
                (unsigned long)stats[row*3 + channel].lastCode.load());
  if (stats[row*3 + channel].errors.load() != before) stats[row*3 + channel].available = false;
  if (!off) busFault(row);
}
void debugCommand(uint8_t row, DebugRequest request) {
  paused[row] = true;
  for (auto &d : rows[row].displays) d.wave.count = 0;
  if (request.command == SCAN) scanChannels(row);
  else if (request.command == TEST) {
    if (request.value < 0) {
      for (uint8_t i=0; i<3; ++i) testDisplay(row, i);
    } else if (request.value / 3 == row) testDisplay(row, request.value % 3);
    logLine("DONE TEST BUS %u (paused)\n", row);
  } else if (request.command == RATE || request.command == REINIT) {
    // Reset mux/bus and retry initialization; historical errors do not block recovery.
    for (uint8_t i=row*3; i<row*3+3; ++i) stats[i].available = false;
    rows[row].wire->end();
    if (request.command == RATE) busHz[row] = request.value;
    reverseInit[row] = request.command == REINIT && request.value == 1;
    initRow(row);
    logLine("DONE REINIT BUS %u HZ %lu REVERSE %u (paused)\n", row, (unsigned long)busHz[row].load(), reverseInit[row] ? 1 : 0);
  } else if (request.command == RUN) {
    for (auto &d : rows[row].displays) d.dirty = true;
    paused[row] = false;
    logLine("DONE RUN BUS %u\n", row);
  }
}
void displayWorker(void *argument) {
  uint8_t row = static_cast<uint8_t>(reinterpret_cast<uintptr_t>(argument));
  Row &r = rows[row];
  initRow(row);
  uint8_t channel = 0;
  for (;;) {
    Layout layout;
    if (xQueueReceive(layoutQueue[row], &layout, 0) == pdTRUE) {
      if (layout.revision != activeLayout[row].revision || memcmp(layout.icons, activeLayout[row].icons, KEY_COUNT) != 0) {
        activeLayout[row] = layout;
        for (auto &display : r.displays) display.dirty = true;
      }
    }
    DebugRequest request;
    if (xQueueReceive(debugQueue[row], &request, 0) == pdTRUE) debugCommand(row, request);
    Press press;
    // Bounded queue drain; the worker exclusively owns all wave state and the shared buffer.
    for (uint8_t n = 0; n < 32 && xQueueReceive(r.queue, &press, 0) == pdTRUE; ++n) {
      if (!paused[row] && stats[row*3 + press.channel].available) {
        r.displays[press.channel].wave.trigger(press.at);
        r.displays[press.channel].dirty = true;
      }
    }
    DisplayState &d = r.displays[channel];
    if (!paused[row] && busReady[row] && stats[row*3 + channel].available &&
        (d.dirty || d.wave.count) && uint32_t(millis() - d.lastFrame) >= FRAME_MS)
      render(row, channel);
    channel = (channel + 1) % 3;
    vTaskDelay(1); // Yield so button/serial handling remains responsive.
  }
}
bool trigger(uint8_t key) {
  if (key >= KEY_COUNT || paused[key/3] || !busReady[key/3] || !stats[key].available) return false;
  Press press = {uint8_t(key%3), millis()};
  bool sent = rows[key/3].queue && xQueueSend(rows[key/3].queue, &press, 0) == pdTRUE;
  if (!sent) ++queueDrops;
  return sent;
}
void sampleButtons() {
  uint32_t now = millis();
  for (uint8_t i = 0; i < KEY_COUNT; ++i) {
    Button &b = buttons[i];
    bool raw = digitalRead(BUTTON_PINS[i]);
    if (raw != b.raw) { b.raw = raw; b.changed = now; }
    if (raw != b.stable && uint32_t(now - b.changed) >= 25) {
      b.stable = raw;
      if (raw == LOW && !trigger(i)) logLine("ERROR trigger %u paused, unavailable or queue full\n", i);
      logLine("BUTTON %u %u\n", i, raw == LOW ? 1 : 0);
      if (raw == LOW && companionActive && !paused[i/3] && stats[i].available && busReady[i/3]) {
        if (++pressSequence == 0) ++pressSequence;
        logLine("PRESS6 %lu %lu %u\n", (unsigned long)pressSequence,
                (unsigned long)shownRevision[i].load(), i);
      }
    }
  }
}
void command(const char *text) {
  unsigned long revision; int profile; char trailing;
  int icon[KEY_COUNT];
  // Per-key layout: the host names an icon for every cap. Contextual layouts are one-off
  // combinations that the six fixed profiles cannot express.
  if (sscanf(text, "SETK6 %lu %d %d %d %d %d %d %c", &revision,
             &icon[0], &icon[1], &icon[2], &icon[3], &icon[4], &icon[5], &trailing) == 7 && revision > 0) {
    // Validate every id before touching the layout, so a malformed line cannot half-apply.
    for (uint8_t key = 0; key < KEY_COUNT; ++key)
      if (icon[key] < 0 || icon[key] >= sixIconCount) { logLine("ERROR SETK6 icon out of range\n"); return; }
    Layout layout; layout.revision = uint32_t(revision);
    for (uint8_t key = 0; key < KEY_COUNT; ++key) layout.icons[key] = uint8_t(icon[key]);
    for (uint8_t row=0; row<2; ++row)
      if (layoutQueue[row]) xQueueOverwrite(layoutQueue[row], &layout);
    companionActive = true; lastLayout = millis(); return;
  }
  if (sscanf(text, "SET6 %lu %d %c", &revision, &profile, &trailing) == 2 &&
      revision > 0 && profile >= 0 && profile < 6) {
    Layout layout; layout.revision = uint32_t(revision);
    for (uint8_t key = 0; key < KEY_COUNT; ++key) layout.icons[key] = sixProfileIcons[profile][key];
    for (uint8_t row=0; row<2; ++row)
      if (layoutQueue[row]) xQueueOverwrite(layoutQueue[row], &layout);
    companionActive = true; lastLayout = millis(); return;
  }
  int key, hz;
  char extra;
  DebugRequest debug;
  bool diagnostic = true;
  if (!strcmp(text, "SCAN")) debug = {SCAN, 0};
  else if (!strcmp(text, "TEST ALL")) debug = {TEST, -1};
  else if (sscanf(text, "TEST %d %c", &key, &extra) == 1 && key >= 0 && key < KEY_COUNT) debug = {TEST, key};
  else if (!strcmp(text, "RUN")) debug = {RUN, 0};
  else if (!strcmp(text, "REINIT")) debug = {REINIT, 0};
  else if (!strcmp(text, "REINIT REVERSE")) debug = {REINIT, 1};
  else if (sscanf(text, "HZ %d %c", &hz, &extra) == 1 && (hz == 100000 || hz == 400000)) debug = {RATE, hz};
  else diagnostic = false;
  if (diagnostic) {
    // Only loop() produces debug requests. Check both queues before enqueueing
    // so a command is never silently applied to only one running row.
    if (!debugQueue[0] || !debugQueue[1] ||
        !uxQueueSpacesAvailable(debugQueue[0]) || !uxQueueSpacesAvailable(debugQueue[1])) {
      logLine("ERROR diagnostic worker unavailable or queue full\n"); return;
    }
    xQueueSend(debugQueue[0], &debug, 0);
    xQueueSend(debugQueue[1], &debug, 0);
    return;
  }
  if (!strcmp(text, "HELLO")) logLine("KEYMAELEON6 DUAL_I2C COMPANION_1 COMPANION_2 WAVE 8 120\n");
  else if (!strcmp(text, "STATS")) {
    for (uint8_t row=0; row<2; ++row)
      logLine("MODE BUS %u PAUSED %u HZ %lu\n", row, paused[row] ? 1 : 0, (unsigned long)busHz[row].load());
    logLine("QUEUE_DROPS %lu\n", (unsigned long)queueDrops.load());
    for (uint8_t row = 0; row < 2; ++row)
      logLine("BUS %u %u MUX_ERRORS %lu\n", row, busReady[row] ? 1 : 0,
                    (unsigned long)muxErrors[row].load());
    for (uint8_t i = 0; i < KEY_COUNT; ++i)
      logLine("OLED %u %u %lu %lu FRAMES %lu INTERVAL_US %lu\n", i, stats[i].available ? 1 : 0,
                    (unsigned long)stats[i].transferUs.load(), (unsigned long)stats[i].errors.load(),
                    (unsigned long)stats[i].frames.load(), (unsigned long)stats[i].intervalUs.load());
    for (uint8_t i=0; i<KEY_COUNT; ++i)
      logLine("IO KEY %u BUS %u CH %u PROBE %lu LAST_ERROR %lu SHORT_WRITES %lu MAX_BYTES %lu TRANSACTIONS %lu\n",
                    i+1, i/3, i%3, (unsigned long)stats[i].probeCode.load(), (unsigned long)stats[i].lastCode.load(),
                    (unsigned long)stats[i].shortWrites.load(), (unsigned long)stats[i].maxBytes.load(),
                    (unsigned long)stats[i].transactions.load());
  } else if (!strcmp(text, "TRIGGER ALL")) {
    for (uint8_t i=0; i<KEY_COUNT; ++i) if (!trigger(i)) logLine("ERROR trigger %u\n", i);
  } else if (sscanf(text, "TRIGGER %d %c", &key, &extra) == 1 && key >= 0 && key < KEY_COUNT) {
    if (!trigger(key)) logLine("ERROR display paused, unavailable or queue full\n");
    else logLine("TRIGGERED %d\n", key);
  } else logLine("ERROR command\n");
}
void setup() {
  Serial.begin(115200);
  logMutex = xSemaphoreCreateMutex();
  if (!logMutex) { Serial.println("ERROR log mutex allocation"); return; }
  logLine("BOOT6\n");
  for (uint8_t pin : BUTTON_PINS) pinMode(pin, INPUT_PULLUP);
  for (uint8_t row = 0; row < 2; ++row) {
    busReady[row] = false;
    paused[row] = false;
    busHz[row] = I2C_HZ;
    layoutQueue[row] = xQueueCreate(1, sizeof(Layout));
    debugQueue[row] = xQueueCreate(8, sizeof(DebugRequest));
    muxErrors[row] = 0;
    rows[row].queue = xQueueCreate(32, sizeof(Press));
    if (!layoutQueue[row] || !debugQueue[row] || !rows[row].queue || xTaskCreatePinnedToCore(displayWorker,
        row == 0 ? "oled-top" : "oled-bottom", 8192,
        reinterpret_cast<void *>(static_cast<uintptr_t>(row)), 1, nullptr, row) != pdPASS) {
      if (debugQueue[row]) { vQueueDelete(debugQueue[row]); debugQueue[row] = nullptr; }
      if (rows[row].queue) { vQueueDelete(rows[row].queue); rows[row].queue = nullptr; }
      digitalWrite(RESET_PINS[row], LOW);
      pinMode(RESET_PINS[row], OUTPUT);
      logLine("ERROR worker %u could not start\n", row);
    }
  }
}
void loop() {
  if (companionActive && uint32_t(millis() - lastLayout) > 1500) {
    companionActive = false;
    Layout idle = {0, {0, 0, 0, 0, 0, 0}};
    for (uint8_t row=0; row<2; ++row)
      if (layoutQueue[row]) xQueueOverwrite(layoutQueue[row], &idle);
  }
  sampleButtons();
  for (int n = 0; n < 64 && Serial.available(); ++n) {
    char c = Serial.read();
    if (c == '\n') {
      if (overflow) logLine("ERROR line too long\n");
      else { input[used] = 0; command(input); }
      used = 0; overflow = false;
    } else if (c != '\r') {
      if (used < sizeof(input) - 1) input[used++] = c;
      else overflow = true;
    }
  }
  delay(1);
}
