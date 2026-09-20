# Mux2-only test

Open **Mux2Test.ino** in Arduino IDE. Select **Arduino Nano ESP32**, **Normal mode (TinyUSB)**, **By Arduino pin (default)**. Install U8g2 and upload. No other sketch files are required.

This is a separate static test: no animation, no extra worker tasks, no Wire/bus0 initialization. It holds **mux1 RESET (D8) LOW** throughout. That disconnects mux1 channels but does not remove OLED power or erase their existing images.

| Mux2 connection | Nano / destination |
|---|---|
| SDA | A6 / GPIO13 |
| SCL | A7 / GPIO14 |
| RESET | D9 / GPIO18; pull-up to 3V3 if absent |
| VCC/VIN | 3V3 (compatible breakout) |
| GND, A0, A1, A2 | GND (address 0x70) |
| SD0 / SC0 | Key 4 SDA / SCL |
| SD1 / SC1 | Key 5 SDA / SCL |
| SD2 / SC2 | Key 6 SDA / SCL |

OLED VCC=3V3, GND common, address 0x3C. **D8 and D9/reset nets must be separate.** Disconnect USB before rewiring. If mux1 is not connected to D8, disconnect its upstream SDA/SCL to ensure it is excluded. Holding its RESET low is not a power-load isolation test; to test supply loading separately, disconnect its peripherals with power off.

At boot the sketch scans the upstream Wire1 bus at **100 kHz**, then sends a static `MUX 2 / KEY 4`, `KEY 5`, or `KEY 6` pattern to channels 0–2. The mux is reset between tests; static OLED images persist.

Open Serial Monitor at **115200 baud**. If startup output was missed, send these one at a time (newline endings are fine):

```text
S
T
?
```

- `S`: reset mux2 and scan upstream addresses. Expect `FOUND 0x70`. A different found address means different straps; no addresses means communication/power/reset/pin trouble before display rendering.
- `T`: test all three OLEDs once. `0`, `1`, `2` test a single mux2 channel.
- `?`: Wire1 initialization result, cumulative display errors, and instantaneous SDA/SCL levels while idle. Low idle lines warrant checking wiring/pull-ups/devices; high levels alone do not prove a healthy bus.

For each channel expect `write_code=0`, readback **1/2/4**, `probe_code=0`, and `transfer_errors=0`. Wire error codes: 2=NACK (normally no device), 5=timeout; other codes are reported as-is. The alternate 0x3D OLED address is probed if 0x3C fails, but this sketch only renders at 0x3C.

**Send the full S/T/? output and which patterns are visible.** If the Nano repeatedly resets/disconnects, report that too.

Re-upload `firmware/Keymaeleon6/Keymaeleon6.ino` afterward to restore both buses. This test has not been flashed or physically verified by the assistant.
