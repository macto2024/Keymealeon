# Dual-bus diagnostic build

This revision returns to **two buses/two muxes**, with the software isolation fix applied. Update 2026-09-19: the user replaced faulty displays and confirmed that the mux2 hardware issue is resolved. Wiring is in [README.md](README.md).

## What was fixed

The installed U8g2 2.36.19's `u8g2_m_8_4_f()` gives identical display objects the same static framebuffer. Its default `u8x8_cad_ssd13xx_fast_i2c()` also shares a function-static `in_transfer` flag. Separate objects and staging bitmaps did not isolate either of these; concurrent workers could interfere.

The actual sketch now calls `Keymaeleon6::isolateDisplay()` from `IsolatedDisplay.h` before beginning/drawing each display object. It assigns a row-owned 256-byte framebuffer and the stateless classic command callback. Each worker also has independent wave state, transfer-byte accounting, bus-rate state, command queues and mux-reset pin. A logging mutex protects whole output lines, without locking display transfers together.

A native regression test exercises this exact isolation helper and the installed C library using two threads. Both send 100 frames with different payload patterns; the test checks intact data, independent framebuffers, closed transactions, and a maximum of 25 bytes per transaction. That is below the installed ESP32 Wire default 128-byte buffer. Hardware I²C timing and electrical behavior are separate checks.

## First hardware check

After uploading with **Wave.h, IsolatedDisplay.h and Icons6.h** present, connect all six OLEDs as documented. Serial Monitor: **115200, newline**. Send commands individually:

```text
HELLO
STATS
HZ 100000
SCAN
TEST ALL
STATS
```

Check `HELLO` contains `DUAL_I2C COMPANION_1`. Diagnostic commands finish with **two DONE lines**, tagged `BUS 0` and `BUS 1`; wait for both. HELLO/STATS do not produce DONE. Workers can print their lines in either order.

Expected static images: border, top bars, and **KEY 1–6**. TEST sends one pattern per screen and pauses animation, eliminating continuous animation load. Initialization also sends configuration and clear data. Send back the full output and which numbered patterns appeared if problems remain.

### Channel mapping

| Global serial key index | Physical key | Bus | Channel |
|---:|---:|---:|---:|
| 0 | 1 | 0 | 0 |
| 1 | 2 | 0 | 1 |
| 2 | 3 | 0 | 2 |
| 3 | 4 | 1 | 0 |
| 4 | 5 | 1 | 1 |
| 5 | 6 | 1 | 2 |

Bottom-row displays must move from single-mux channels 3–5 onto second-mux channels **0–2**. Top mux is `0x70`, bottom mux `0x70`. Do not connect A4/A5 to A6/A7 or D8 to D9.

### Scan results

Each bus first disables all mux channels. `SCAN BUS ... OFF` should report `MUX_OK 1`, `MASK_READ 0`, and normally `OLED_3C 2` (no OLED reachable). An ACK at 0x3C while all channels are disabled suggests a bypass/direct connection or another upstream device at that address.

Channels **0–2 on each mux** should report:

- `MUX_OK 1` and decimal `MASK_READ` **1, 2, 4** respectively.
- `OLED_3C 0`: address acknowledged. ACK alone does not prove correct displayed pixels.
- `OLED_3D 2`: normally no alternate-address device. A `0` can indicate a module strapped to 0x3D.

Channels 3–7 should have no OLED ACK. `-1` means a read failed or a probe was skipped. A channel that holds the bus can require mux reset before continuing; results retain the failure. Normal display selections also verify the mux mask before transmitting.

### Error counters

- `PROBE`: latest address probe (0 success, 255 not reached).
- `LAST_ERROR`: last nonzero Wire error, retained after later successful retries.
- `SHORT_WRITES`: Wire accepted fewer bytes than requested; this directly tests a transmit-buffer failure.
- `MAX_BYTES`: largest requested transaction; expect no more than **25** for the classic callback.
- `QUEUE_DROPS`: rejected animation events, not dropped framebuffer data.
- `FRAMES`: attempted frame transfers. Inspect error/availability status as well.
- `INTERVAL_US`: latest frame-start interval (millisecond resolution); during continuous animation FPS is approximately `1000000 / INTERVAL_US`. It includes idle gaps, so inspect during active animation.

Wire codes: 0 success, 1 data too long, 2 address NACK, 3 data NACK, 4 other error, 5 timeout. ESP32 can map some errors broadly. Cumulative counters reset on reboot; TEST's NEW_ERRORS is a per-pattern delta. A FAULT line explains when an I²C error disables a screen, which can otherwise look like a frozen animation.

## Next tests

If static patterns work at 100 kHz, compare at normal speed:

```text
HZ 400000
SCAN
TEST ALL
STATS
RUN
TRIGGER ALL
```

Wait for both DONE lines after each diagnostic command, and about one second after TRIGGER ALL before requesting STATS. Press keys repeatedly to inspect continuous timing. The 50 FPS target is not guaranteed; mux transactions, mask readback and transport overhead reduce achievable rates.

`TEST 3` tests only physical key 4 (bus 1/channel 0), while pausing both rows. `RUN` resumes both. `REINIT REVERSE` resets/retries channels 2,1,0 within each row; inspect STATS before TEST ALL, which initializes in normal order. Mux reset is not a power cycle of OLED modules.

If failures persist at low speed with static patterns:

1. Power off before changing wiring. Test a known-good OLED and signal cable on each suspect mux channel, retaining known-good power/ground connections.
2. Connect displays one at a time and record which addition causes existing displays to fail.
3. Check SDn/SCn pairing, address straps, 3.3 V pull-ups, and that upstream buses/reset lines are separate.
4. Measure 3V3 at the OLEDs with one and six connected; check for repeated Nano resets or USB disconnects. A meter cannot exclude brief dips. Do not tie another supply output to the Nano's 3V3 output.
5. If only 400 kHz fails, investigate wiring length, pull-ups and rise time. A logic analyzer can inspect masks/ACKs; a scope can inspect electrical signals/power.

Reported single-mux symptoms (freezes and blank output with all six connected) remain unverified on hardware. Do not infer their cause solely from the now-corrected dual-worker software issue.
