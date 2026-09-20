# Companion — driving the keyboard from the backend

The bridge is a **display**, not a brain. The backend resolves which six actions belong on the
keys and publishes them; the bridge maps each action to a pictogram, writes it to the firmware,
and sends presses back. It never decides what a key should be — if it did, the keyboard and the
on-screen client would drift, and a cap would eventually disagree with the action its own press
dispatches.

```
backend :5173  ──SSE /api/events──►  bridge  ──SETK6──►  firmware  ──►  six OLED caps
      ▲                                                      │
      └───────── POST /api/key ◄────── PRESS6 ◄──────────────┘
```

## Run it

```sh
npm start                                              # backend, from the repo root
python3 companion/keymaeleon_bridge.py --simulate      # no hardware: draws the caps in the terminal
python3 companion/keymaeleon_bridge.py --port /dev/ttyACM0
```

No dependencies. Serial uses `termios` from the standard library, not pyserial — a machine that
cannot reach PyPI is a bad place to discover an install step.

If the device will not open, you are probably not in the `dialout` group:

```sh
sudo usermod -aG dialout $USER     # then log out and back in
```

## Flash first

The firmware must be the regenerated one. `HELLO` has to answer with **`COMPANION_2`**; the bridge
refuses to run against older firmware rather than silently showing the wrong caps.

```sh
python3 tools/generate_six_icons.py      # rewrites Icons6.h and assets/icons_6.json
# then open ESP32 Firmware/Keymaeleon6/Keymaeleon6.ino in Arduino IDE and upload
```

## Two revisions that are one number

The backend stamps every layout with `keyboard.layout_revision`. The firmware records the revision
it *actually had on screen* when a key went down and reports it in `PRESS6`. The bridge passes that
straight back to `POST /api/key`.

So a press that raced a context change is rejected by the backend with **409** instead of firing
whatever replaced it. The user pressed what they saw, or nothing happens. Verified:

```
firmware -> bridge   PRESS6 1 102 0        (a revision the cap was not showing)
bridge log           Key 1 ignored: Keys changed. Try the current layout.
```

## Testing without hardware

`fake_firmware.py` opens a pseudo-terminal, launches the bridge against it, and speaks the firmware
side of the protocol. The bridge takes exactly the same code path it uses with a real Arduino.

```sh
python3 companion/fake_firmware.py --press 4 --after 2     # press K and watch the layout change
python3 companion/fake_firmware.py --press 0 --stale       # prove a stale press is refused
```

This proves the transport, handshake, resend timer, revision discipline and press round trip. It
proves nothing about I²C, the displays or the wave animation — those need the device.

## Protocol

| Direction | Line | Meaning |
|---|---|---|
| → firmware | `HELLO` | Sent every second until answered |
| ← firmware | `KEYMAELEON6 DUAL_I2C COMPANION_1 COMPANION_2 WAVE 8 120` | Capabilities |
| → firmware | `RUN` | Leave diagnostics, start rendering |
| → firmware | `SETK6 <revision> <i0..i5>` | Six pictogram ids, one per cap |
| → firmware | `SET6 <revision> <profile>` | The original fixed app profiles, still supported |
| ← firmware | `PRESS6 <sequence> <displayed-revision> <key>` | A key went down |
| ← firmware | `BOOT6` | Rebooted; the bridge re-handshakes |

`SETK6` is re-sent every 500 ms because the firmware falls back to Idle after 1.5 s of silence.
The bridge reads the event stream on a separate thread for exactly this reason: server-sent events
block until the next one arrives, which on a quiet context is the 15-second heartbeat, and the caps
would go blank for most of a demo.

## Status

Everything above is verified against the simulated firmware. **None of it has run against the real
keyboard yet** — the device was not connected to the machine this was built on. The first hardware
session should check, in order: that `HELLO` answers with `COMPANION_2`, that a layout appears on
all six caps, that channels 3–5 land on the second mux, and that a physical press reaches the
backend.
