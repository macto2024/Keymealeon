# Keymaeleon 6 — dual hardware I²C, isolated display buffers

Six OLED keys in two rows of three, using an **Arduino Nano ESP32** and **two TCA9548A multiplexers**, one per hardware I²C interface. Each row has its own worker, U8g2 object, actual framebuffer, staging bitmap and transport counters. Both rows can transmit concurrently.

This revision fixes the earlier implementation's U8g2 shared-memory/shared-transfer-state hazards: `IsolatedDisplay.h` binds an independently owned framebuffer and selects the stateless classic SSD13xx command callback. The physical cause of the reported freezing/blank screens has **not** been confirmed; keep using the included diagnostics if problems remain.

Each press runs the Animation Lab bottom wave: **8 pixels thick, 120 pixels/second**, over the play/border image. Waves stack independently, merge on overlap and finish after 450 ms. This standalone animation/button test sends no keyboard or media actions and needs no Ubuntu companion.

## Wiring

![Dual-bus wiring](../../docs/wiring-six-key.png)

[Scalable SVG](../../docs/wiring-six-key.svg). Matching net names connect together; follow module labels, not connector positions.

**From the single-mux version:** power off. Leave keys 1–3 on channels 0–2 of the top mux. Move keys 4–6 from channels 3–5 to channels **0–2 of the second mux**. Connect its SDA/SCL to **A6/A7** and its RESET to **D9**. Set its address to **0x70**. Do not join the two upstream buses or reset nets.

| Row / bus | Mux address | Nano SDA | Nano SCL | Mux RESET |
|---|---|---|---|---|
| Top / `Wire`, bus 0 | `0x70` | A4 / GPIO11 | A5 / GPIO12 | D8 / GPIO17 |
| Bottom / `Wire1`, bus 1 | `0x70` | A6 / GPIO13 | A7 / GPIO14 | D9 / GPIO18 |

Both mux VCC/VIN inputs and all OLED VCC pins connect to **3V3**, using 3.3 V-compatible breakout modules. All grounds join. USB-C provides board power/data.

| Mux | A2 | A1 | A0 |
|---|---|---|---|
| Top, `0x70` | GND | GND | GND |
| Bottom, `0x70` | GND | GND | GND |

**Both muxes use 0x70**, with A0/A1/A2 grounded. This works because each mux is on a separate hardware bus. If you previously strapped the bottom mux A0 high for 0x71, disconnect power and remove that high strap before grounding A0; never short 3V3 to GND.

| Key | Position | Mux | Channel | OLED SDA/SCL | Switch to GND | GPIO |
|---|---|---|---:|---|---|---:|
| 1 | Top left | Top | 0 | SD0 / SC0 | D2 | 5 |
| 2 | Top middle | Top | 1 | SD1 / SC1 | D3 | 6 |
| 3 | Top right | Top | 2 | SD2 / SC2 | D4 | 7 |
| 4 | Bottom left | Bottom | 0 | SD0 / SC0 | D5 | 8 |
| 5 | Bottom middle | Bottom | 1 | SD1 / SC1 | D6 | 9 |
| 6 | Bottom right | Bottom | 2 | SD2 / SC2 | D7 | 10 |

All OLEDs retain **0x3C**. Leave mux channels **3–7** unconnected. Only one channel per mux is selected at a time; one display on each independent bus can transmit simultaneously. Switches use `INPUT_PULLUP` and connect to GND when pressed.

- Each RESET net needs its own pull-up, typically **10 kΩ to 3V3**, if absent on the breakout. Connect to mux RESET, not Nano RST; do not hard-wire it to 3V3 while driven by a GPIO.
- Each upstream SDA/SCL pair and every used downstream pair needs pull-ups to **3V3**. Breakouts often include them; if absent, start with 4.7 kΩ and verify signal quality. Avoid blindly adding parallel pull-ups.
- Keep wires short, with flexible wires/strain relief at moving keycaps. Use local decoupling if absent, typically 100 nF per module. Never use 5 V pull-ups on Nano GPIO.
- Check the total six-OLED/mux load against available 3.3 V power. With an external regulated peripheral supply, join GND but do not connect its output to the Nano's 3V3 output.

## Upload

1. Stop any serial companion/monitor.
2. Install **Arduino ESP32 Boards by Arduino** and **U8g2 by oliver**.
3. Open `Keymaeleon6.ino`, keeping **Wave.h and IsolatedDisplay.h** alongside it.
4. Select **Arduino Nano ESP32**, **Normal mode (TinyUSB)**, **By Arduino pin (default)**, then upload.

The OLED driver remains `U8G2_SSD1306_64X32_1F_F_HW_I2C`. The default bus rate is **400 kHz per bus** and target refresh **50 FPS per key**. This is a scheduling target, not a hardware measurement; three displays still share each bus. Wave speed is based on elapsed time, so delayed frames do not slow the animation's timeline.

## Verify and diagnose

Serial Monitor: **115200 baud**, newline endings. Send commands one at a time:

```text
HELLO
SCAN
TEST ALL
STATS
RUN
TRIGGER ALL
```

`HELLO` must report `KEYMAELEON6 DUAL_I2C DEBUG_2 WAVE 8 120`.

**SCAN, TEST, RUN, HZ and REINIT produce two DONE lines, one for each bus. Wait for both before sending the next command.** Output order may vary because the workers run concurrently. Individual lines are serialized so characters do not mix.

`TEST ALL` writes static patterns labelled KEY 1–6 and leaves both rows paused. `RUN` restores the base image and enables animations. `TRIGGER 3` / `TEST 3` mean physical key 4, now **bus 1, channel 0**. All serial key arguments remain global **0–5**. `TEST 3` pauses both rows but tests only key 4.

Other commands: `HZ 100000`, `HZ 400000`, `REINIT`, `REINIT REVERSE`. Rates/reinitialization apply independently to both buses and leave them paused. Reverse initialization is channels 2,1,0 on **each** mux. Scans probe all eight channels per mux, but only 0–2 should have OLEDs.

STATS reports each bus's state/rate and per-display availability, errors, frames and frame intervals. `IO KEY` lines include bus/channel, probe result, last nonzero error, short writes, maximum transaction bytes and transaction count. Historical errors remain until reboot; successful reinitialization is not blocked by them.

A mux failure disables/resets only its row. A display transmission failure disables that display and prints a FAULT line. Each worker owns its queues, bus, reset and memory; only diagnostic logging is shared. The two-key Python companion/Animation Lab GUI does not control this six-key diagnostic protocol.

See [DEBUGGING.md](DEBUGGING.md) for interpretation and a low-speed test sequence. [Validation notes](../../docs/validation.md) distinguish software checks from unperformed hardware tests.

References: [TI TCA9548A datasheet](https://www.ti.com/lit/ds/symlink/tca9548a.pdf), [ESP32 hardware I²C API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/i2c.html), [Nano pinout](https://docs.arduino.cc/resources/pinouts/ABX00083-full-pinout.pdf).
