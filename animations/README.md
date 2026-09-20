# Animation Lab

A separate test sketch and Python GUI for the existing **Arduino Nano ESP32** and two **SSD1306 64 × 32** OLEDs. The main firmware and companion are unchanged. This sketch only animates displays; it sends no keyboard or media actions.

## Flash

1. Stop the normal companion and close Serial Monitor.
2. Open `AnimationTest/AnimationTest.ino` in Arduino IDE.
3. Select **Arduino Nano ESP32**, using **Arduino ESP32 Boards by Arduino**, and install **U8g2 by oliver**.
4. Use the same USB settings as the main sketch: **Normal mode (TinyUSB)**, **By Arduino pin (default)**. Upload.

Wiring is unchanged: left OLED SDA=A4, SCL=A5; right OLED SDA=D4, SCL=D5. Both use address 0x3C on separate buses. Buttons D2 and D3 connect to GND, using internal pull-ups. OLED power is 3.3 V. The sketch retains the project's `64X32_1F` driver. Both displays now use separate ESP32 hardware I²C controllers (`Wire` and `Wire1`) at 400 kHz, with explicit callbacks and the same pins; no rewiring is needed.

## Run

From the repository root:

```bash
.venv/bin/pip install -r animations/requirements.txt
.venv/bin/python animations/animations.py
```

Tk is also required (`sudo apt install python3-tk` on Ubuntu). Without pyserial the GUI still supports previews.

Select or type the serial port, then click **Connect**. Settings are sent automatically as you adjust them. The GUI shows the most recent full-frame transfer time for each display and cumulative I²C transmission errors since boot. Timings remain at the last measured value while a display is idle; they measure transfer duration, not total frame time. **Test press** triggers that key on the board and in the preview; physical button presses also update the preview. You can preview without connecting hardware.

## Effects

- **Invert (hold):** invert the entire image while a physical button is held; release restores it. GUI test presses last 450 ms.
- **Bottom wave:** each press launches another inverted ring from the bottom-middle; existing rings keep moving. Thickness is 1–16 pixels; speed is 5–160 pixels/second.
- **Center ripple:** the same ring grows from the screen center.
- **Wipe:** an inverted vertical band crosses the screen.
- **Dissolve:** a repeatable scattered-pixel transition inverts the image, then restores it.
- **Sparkle:** scattered pixels shimmer; thickness sets density.

Both screens show a play symbol inside a border so the pixel inversion is easy to see. Settings apply to both screens, but buttons animate independently. Bottom waves stack independently on every press, with up to 32 waves per key (the oldest is replaced at the limit). Overlapping rings merge rather than cancel. Other modes restart on each press. Except for invert, effects run once and finish even if the button is released. Changing settings cancels current effects. Speed affects all timed effects; thickness affects rings, wipe, and sparkle, but does not affect invert or dissolve.

The board runs effects locally and works without the GUI. On boot it defaults to bottom wave, thickness 5, speed 45. Settings are kept in RAM and reset on reboot. The GUI preview uses the same pixel formulas, but USB latency and OLED transfer time can make physical timing differ, especially at high speeds. The hardware-I²C change has not been compiled with the Arduino board toolchain or validated on physical hardware here.

To restore normal macro-key behavior, re-upload `firmware/Keymaeleon/Keymaeleon.ino` and run the normal companion.

## Slow refresh troubleshooting

Re-upload the updated sketch and restart the GUI to use hardware I²C and see transfer timings. The earlier software-I²C implementation uses driver delay constants rather than the `setBusClock()` value, so changing that setting alone does not speed it up. The new callback sets the hardware clock with `Wire.begin(..., I2C_HZ)`; change `I2C_HZ` if testing another rate.

At 400 kHz, 256 bytes plus acknowledgement bits need about 5.8 ms per screen before command/transaction overhead. The animation target remains about 30 FPS. Nonzero I²C errors indicate a communication problem; check the wiring and module pull-ups. Timings substantially above that baseline help distinguish transfer stalls from display scan artifacts.

## Checks and serial protocol

```bash
python3 -m unittest discover -s animations -p 'test_*.py'
```

115200 baud, ASCII lines ending in newline:

- `HELLO` → `ANIMATIONS 1`
- `STATS` → `STATS <left transfer µs> <right transfer µs> <left errors> <right errors>`
- `SET <mode 0..5> <thickness 1..16> <speed 5..160>` → `OK <mode> <thickness> <speed>`
- `TRIGGER <key 0..1>` → `TRIGGERED <key>`
- Physical changes emit `BUTTON <key> <pressed 0..1>` after 25 ms debounce.

Mode numbers follow the effect list above. Overlong lines are discarded, malformed commands return `ERROR command`, and serial processing is bounded to keep button sampling responsive.
