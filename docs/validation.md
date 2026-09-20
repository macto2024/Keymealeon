# Validation

Checked during creation on 2026-09-16:

- Arduino firmware compiled and linked for `arduino:esp32:nano_nora:USBMode=default,PinNumbers=default` using Arduino ESP32 Boards **2.0.18-arduino.5** and U8g2 **2.36.19**.
- Build result: **335,337 bytes flash**, **32,008 bytes static RAM** (10% and 9% of reported limits).
- **12 companion tests passed**: app classification, malformed serial events, exactly-once handling, cross-app and same-app window changes, focus-provider failure, dry-run, Spotify targeting, GNOME reply decoding, and refusal to use XWayland as a full focus provider.
- Python byte compilation and JavaScript module syntax check passed.
- Wiring SVG rendered to PNG and visually inspected; power/ground nets and board-label mappings checked against the wiring table.

Reproduce firmware compilation after installing Arduino CLI:

```bash
arduino-cli core update-index
arduino-cli core install arduino:esp32@2.0.18-arduino.5
arduino-cli lib install U8g2@2.36.19
arduino-cli compile \
  --fqbn arduino:esp32:nano_nora:USBMode=default,PinNumbers=default \
  firmware/Keymaeleon
```

The temporary build toolchain was installed under `/tmp`; no board was flashed, system packages installed, GNOME extension enabled, or login autostart configured during creation.

Not hardware-validated: exact HiLetgo module controller/address, OLED output, physical switch/keycap wiring, USB serial/HID enumeration, GNOME Shell runtime integration, and Spotify MPRIS behavior. The development environment has no attached board or GNOME Shell Meta typelib, so a JavaScript syntax check does not establish extension runtime compatibility. README instructions include a focus watcher and dry-run to verify those integrations on the target machine.

Suggested bench sequence:

1. With USB unplugged, verify each net and absence of 3V3/GND shorts.
2. Upload; confirm both OLEDs show Offline and inputs produce no action.
3. Enable the GNOME provider and run `--watch`; check every app, desktop, overview, and lock/unlock.
4. Start the companion with `--dry-run`; check each press triggers once and matches the displayed label.
5. Run normally; verify each of the ten actions in disposable test windows/files.
6. Switch focus rapidly and press; stale presses should be dropped.
7. Stop the companion; confirm Offline after two seconds. Unplug/replug the board and confirm reconnection when using a stable serial path.

## X11 README and simulator update — 2026-09-17

- X11 is now the default backend; `--simulate` runs a Tk display preview without serial access or action execution.
- All 15 companion tests pass, including simulator labels, hardware-free startup, and rejection of conflicting hardware options. Python byte compilation passed.
- Live Tk rendering could not be checked in this tool environment because its X display (`:1`) was inaccessible. Run `--simulate` from a terminal in the Ubuntu desktop to check the window and app switching.

## Pictograms — 2026-09-17

Replaced OLED text with full-height monochrome pictograms, shared with the simulator. The generated contact sheet was visually inspected. All 16 companion tests pass, including a byte-for-byte comparison of simulator pixels and firmware XBM data. Python syntax checks pass. The temporary Arduino toolchain from the original build is no longer present, so this firmware revision has not been recompiled or hardware-tested.

## Six-key hardware-I²C wave firmware — 2026-09-19

- Added separate `firmware/Keymaeleon6/Keymaeleon6.ino` and portable `Wave.h`; existing firmware and Animation Lab files were not changed.
- Compiled successfully for `arduino:esp32:nano_nora:USBMode=default,PinNumbers=default` using installed Arduino ESP32 Boards 2.0.18-arduino.5 and U8g2 2.36.19.
- Build: 340,917 bytes flash (10%), 32,616 bytes static RAM (9%).
- All five native C++ wave tests passed: pixel comparison with Animation Lab, overlapping rings, 32-wave queue bound, timer wrap, and restoration of the base frame.
- Generated and visually inspected the new six-key wiring schematic. Both mux addresses, channels 0–2, switch GPIOs, shared upstream bus and mux reset net are documented.
- Not physically tested: mux communication/reset, actual OLED refresh timing, six-switch operation, electrical pull-ups/current draw, and display scan behavior. No board was flashed.

Compile again with Arduino CLI and the board/library installed:

```bash
arduino-cli compile \
  --fqbn arduino:esp32:nano_nora:USBMode=default,PinNumbers=default \
  firmware/Keymaeleon6
```

## Concurrent dual-I²C revision — 2026-09-19

- Top row now owns `Wire` on A4/A5 and reset D8; bottom row owns `Wire1` on A6/A7 and reset D9. Mux addresses remain 0x70/0x71.
- Separate FreeRTOS workers pinned to cores 0/1 own independent U8g2 instances, frame buffers and wave state. Main-loop presses cross to workers through bounded FreeRTOS queues; shared telemetry uses atomics. Bus faults reset only the affected row.
- Compiled successfully with Arduino ESP32 Boards 2.0.18-arduino.5 and U8g2 2.36.19: 341,189 bytes flash (10%), 33,192 bytes static RAM (10%). Worker stacks/queues also allocate runtime heap.
- All five wave-renderer regression tests passed. The revised wiring diagram was rendered and visually inspected.
- Target changed to 50 FPS per OLED; actual concurrent bus operation and achieved frame rate have NOT been measured on hardware. STATS includes frame counts and recent frame-start intervals for bench verification. No board was flashed.

## Single-multiplexer revision — 2026-09-19

- Supersedes the two-mux designs: one TCA9548A at 0x70 on Wire A4/A5, reset D8; channels 0–5 map to keys 1–6. A6/A7/D9 are unused.
- One display worker owns all six display states and the shared bus/buffer. Input remains queued separately. Refresh target is 20 FPS/key; wave thickness/speed remain 8 px / 120 px/s.
- Nano compile passed with Arduino ESP32 Boards 2.0.18-arduino.5 and U8g2 2.36.19: 340,813 bytes flash, 32,728 bytes static RAM. All five wave regression tests passed.
- Updated wiring SVG/PNG and instructions; rendered schematic inspected. Physical mux operation, display refresh rates and assembled hardware remain untested. No board flashed.

## Single-mux freeze diagnostics — 2026-09-19

- User reports keys 4–6 freeze after animation starts; all displays are blank with all six attached. Moving displays to working signal connections makes them operate. No hardware root cause has been established.
- Inspected installed U8g2 2.36.19: identical 64x32 constructors share `u8g2_m_8_4_f()`'s static framebuffer, and the default fast I²C CAD callback shares `in_transfer`. These invalidate the independence assumptions in the earlier dual-worker revision. They do not explain the single-worker fault by themselves.
- Current single-mux debug firmware explicitly owns the framebuffer and uses the stateless classic CAD callback. Added mux mask readback, OFF/eight-channel scans, one-shot numbered patterns, 100/400 kHz tests, reverse reinitialization, recovery despite historical errors, and separate short-write/transaction/error/event-queue counters.
- Native test of the installed C transport passed: two interleaved display streams each transmitted 256 payload bytes; largest transaction 25 bytes; reproduced the default shared-framebuffer allocation. Five wave tests also passed.
- Nano compile passed: 348,033 bytes flash (11%), 33,136 bytes static RAM (10%). Wiring unchanged. No serial device was exposed in this environment; no firmware was flashed and no electrical/physical tests were performed.
- Next required evidence is the user's 100 kHz SCAN / TEST ALL / STATS output and actual displayed key labels. Returning to dual muxes is deferred until this single-mux baseline works; future concurrent workers must keep explicit independent framebuffers and stateless command transport.

## Restored dual hardware buses with U8g2 isolation fix — 2026-09-19

- Current firmware again uses Wire A4/A5 -> top mux 0x70 (reset D8) and Wire1 A6/A7 -> bottom mux 0x71 (reset D9), channels 0–2 per mux. Each row has a worker on a separate core, dedicated actual framebuffer and staging bitmap, independent transaction/rate/initialization state and command queues.
- `IsolatedDisplay.h` installs a row-owned framebuffer and stateless classic SSD13xx transport before any begin/drawing. This corrects the shared-memory/fast-CAD hazards in the original dual-bus implementation.
- Diagnostics route to both workers, identify bus/channel/global key, and emit one DONE per bus. A mutex serializes log lines, not I²C transfers. Scans, static patterns, selectable 100/400 kHz operation and detailed error counters are retained.
- Seven native tests passed: five wave tests, actual-library transport chunking/interleaving, and a two-thread regression using the exact isolation helper. Each thread sent 100 frames with distinct intact payloads; no shared framebuffers, unclosed transfers or transactions over 25 bytes were observed.
- Nano compile passed with Arduino ESP32 Boards 2.0.18-arduino.5 / U8g2 2.36.19: 349,053 bytes flash (11%), 33,880 bytes static RAM (10%). Runtime task stacks/queues also use heap.
- Updated wiring drawing was rendered and visually inspected. No board flashed, no physical timing/power measurements made. Target 50 FPS is unmeasured. User-reported blank/frozen hardware behavior is NOT confirmed resolved; proceed with the dual-bus diagnostic sequence in firmware/Keymaeleon6/DEBUGGING.md.

## Both mux addresses set to 0x70 — 2026-09-19

Current firmware expects 0x70 on both independent buses. Updated wiring and setup/debug instructions specify A0/A1/A2 grounded on both modules. Nano compilation passed (349,053 bytes flash; 33,880 bytes static RAM), and the regenerated wiring image was visually checked. No board flashed or physical communication verified. Earlier 0x71 references above describe historical revisions only.

## Six-key app companion — 2026-09-19

- User confirmed the mux2 hardware fault was faulty displays: replacing them restored operation. This supersedes earlier unresolved-hardware notes; it is user-reported testing of the preceding firmware, not a hardware test of the new companion.
- Added `companion/keymaeleon_6.py`, six-action X11 profiles, shared pictograms and a 2×3 wave simulator. Spotify top row is system volume down/mute/up; bottom row is previous/play-pause/next.
- Extended six-key firmware with layout mailboxes, per-display rendered revisions, sequence-tagged press events, boot notification and a 1.5-second host heartbeat timeout. Existing dual-bus ownership, diagnostics and wave timing remain.
- All 30 repository tests passed, including stale-focus/duplicate/dry-run handling, shared generated artwork/profile order, simulator-vs-native-C++ animated pictogram pixels, original wave regression and actual U8g2 concurrent transport tests.
- Final Nano build passed with Arduino ESP32 Boards 2.0.18-arduino.5 and U8g2 2.36.19: 354,673 bytes flash; 33,936 bytes static RAM. Firmware was not uploaded from this environment.
- Python CLI/help checks passed. A live simulator smoke test could not connect to DISPLAY=:1 in this execution environment, so GUI appearance/click behavior was not verified here. Pixel rendering is covered by native/Python comparison. Actual host shortcuts/media and USB companion integration still require the user's desktop/board.
