#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

// Nano ESP32: mux2 only, Wire1 SDA=A6(GPIO13), SCL=A7(GPIO14).
// Mux1 RESET=D8 held LOW. Mux2 RESET=D9. Reset nets MUST be separate.
constexpr uint8_t MUX = 0x70;
constexpr uint8_t OLED = 0x3C;
constexpr uint32_t HZ = 100000;
U8G2_SSD1306_64X32_1F_F_HW_I2C screen(U8G2_R0, U8X8_PIN_NONE);
uint8_t framebuffer[256];
uint32_t errors = 0;
bool ready = false;

uint8_t displayBytes(u8x8_t *d, uint8_t msg, uint8_t count, void *data) {
  switch (msg) {
    case U8X8_MSG_BYTE_INIT: return ready;
    case U8X8_MSG_BYTE_START_TRANSFER:
      Wire1.beginTransmission(u8x8_GetI2CAddress(d) >> 1); break;
    case U8X8_MSG_BYTE_SEND:
      if (Wire1.write(static_cast<uint8_t *>(data), count) != count) {
        ++errors; Serial.println("OLED SHORT_WRITE"); return 0;
      }
      break;
    case U8X8_MSG_BYTE_END_TRANSFER: {
      uint8_t code = Wire1.endTransmission();
      if (code) { ++errors; Serial.printf("OLED ERROR %u\n", code); return 0; }
      break;
    }
    case U8X8_MSG_BYTE_SET_DC: break;
    default: return 0;
  }
  return 1;
}
void resetMux2() {
  digitalWrite(D9, LOW); delay(2);
  digitalWrite(D9, HIGH); delay(2);
}
bool selectMask(uint8_t mask) {
  Wire1.beginTransmission(MUX); Wire1.write(mask);
  uint8_t code = Wire1.endTransmission();
  int readback = -1;
  if (!code && Wire1.requestFrom(MUX, uint8_t(1)) == 1) readback = Wire1.read();
  Serial.printf("MUX mask=0x%02X write_code=%u readback=%d\n", mask, code, readback);
  return code == 0 && readback == mask;
}
void scan() {
  if (!ready) return;
  resetMux2(); // Disconnect all downstream channels before upstream scan.
  Serial.println("UPSTREAM SCAN (all mux2 channels off):");
  int found = 0;
  for (uint8_t address=8; address<120; ++address) {
    Wire1.beginTransmission(address);
    uint8_t code = Wire1.endTransmission();
    if (!code) { Serial.printf("FOUND 0x%02X\n", address); ++found; }
    else if (code != 2) Serial.printf("ADDRESS 0x%02X ERROR %u\n", address, code);
  }
  Serial.printf("SCAN DONE: %d devices; expect mux at 0x70\n", found);
}
void testKey(uint8_t channel) {
  if (!ready) return;
  resetMux2(); // A bad downstream channel cannot contaminate the next test.
  Serial.printf("TEST mux2 CH%u = physical KEY %u\n", channel, channel+4);
  if (!selectMask(uint8_t(1U << channel))) {
    Serial.println("FAIL: mux2 selection. Check mux power, RESET, A6/A7 and address straps.");
    resetMux2(); return;
  }
  Wire1.beginTransmission(OLED);
  uint8_t code = Wire1.endTransmission();
  Serial.printf("OLED 0x3C probe_code=%u\n", code);
  if (code) {
    Wire1.beginTransmission(0x3D);
    Serial.printf("OLED alternate 0x3D probe_code=%u\n", Wire1.endTransmission());
    resetMux2(); return;
  }
  uint32_t before = errors;
  screen.begin(); screen.setContrast(100);
  screen.clearBuffer();
  screen.drawFrame(0, 0, 64, 32);
  screen.setFont(u8g2_font_6x10_tf);
  screen.drawStr(17, 11, "MUX 2");
  char label[12]; snprintf(label, sizeof(label), "KEY %u", channel+4);
  screen.drawStr(17, 25, label);
  screen.sendBuffer();
  Serial.printf("TEST DONE key=%u transfer_errors=%lu\n", channel+4,
                (unsigned long)(errors-before));
  resetMux2(); // OLED retains its static image while disconnected from I2C.
}
void setup() {
  Serial.begin(115200);
  digitalWrite(D8, LOW); pinMode(D8, OUTPUT); // Disable mux1 for the entire test.
  digitalWrite(D9, LOW); pinMode(D9, OUTPUT);
  resetMux2();
  ready = Wire1.begin(A6, A7, HZ);
  Wire1.setTimeOut(25);
  screen.getU8x8()->byte_cb = displayBytes;
  screen.getU8x8()->cad_cb = u8x8_cad_ssd13xx_i2c;
  screen.getU8g2()->tile_buf_ptr = framebuffer;
  screen.setI2CAddress(OLED << 1); screen.setBusClock(HZ);
  // Bounded delay gives Serial Monitor a chance to attach; no host required.
  delay(1500);
  Serial.printf("MUX2 ONLY: Wire1 A6/A7 100kHz, mux=0x70, begin=%u\n", ready);
  if (ready) { scan(); for (uint8_t i=0;i<3;++i) testKey(i); }
  Serial.println("Commands: S=scan, T=test all, 0/1/2=test channel, ?=status");
}
void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'S' || c == 's') scan();
    else if (c == 'T' || c == 't') { for (uint8_t i=0;i<3;++i) testKey(i); }
    else if (c >= '0' && c <= '2') testKey(c-'0');
    else if (c == '?') Serial.printf("MUX2_ONLY ready=%u errors=%lu SDA=%d SCL=%d\n",
                                     ready, (unsigned long)errors, digitalRead(A6), digitalRead(A7));
  }
  delay(1);
}
