#!/usr/bin/env python3
"""Stand in for the keyboard so the serial path can be exercised without hardware.

Opens a pseudo-terminal, launches the bridge against its slave end, and speaks the firmware
side of the protocol: answers HELLO, accepts RUN and SETK6, and can inject a key press. The
bridge uses exactly the same code path it uses with a real Arduino, so what passes here is the
transport, the handshake, the resend timer, the revision discipline and the press round trip.

What it does not prove is I2C, the displays, or the wave animation. Those need the device.

    python3 companion/fake_firmware.py --press 0 --after 3
"""
from __future__ import annotations

import argparse
import os
import pty
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BANNER = 'KEYMAELEON6 DUAL_I2C COMPANION_1 COMPANION_2 WAVE 8 120'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--press', type=int, help='key 0-5 to press once the layout arrives')
    parser.add_argument('--after', type=float, default=3.0, help='seconds before pressing')
    parser.add_argument('--seconds', type=float, default=6.0, help='how long to run')
    parser.add_argument('--backend', default='http://127.0.0.1:5173')
    parser.add_argument('--stale', action='store_true',
                        help='report a wrong revision, to prove the backend rejects the press')
    args = parser.parse_args()

    master, slave = pty.openpty()
    device = os.ttyname(slave)
    print(f'fake firmware on {device}\n')

    bridge = subprocess.Popen(
        [sys.executable, '-u', str(HERE / 'keymaeleon_bridge.py'), '--port', device, '--backend', args.backend],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    # Keep the slave open. If every slave fd closes before the bridge opens the device, reads on
    # the master fail with EIO and the harness would report a protocol failure that is its own.
    os.set_blocking(master, False)

    revision, sequence, buffer, deadline = 0, 0, b'', time.monotonic() + args.seconds
    pressed, layouts = False, 0
    try:
        while time.monotonic() < deadline:
            try:
                buffer += os.read(master, 4096)
            except BlockingIOError:
                pass
            except OSError:
                break
            while b'\n' in buffer:
                raw, buffer = buffer.split(b'\n', 1)
                line = raw.decode('ascii', 'replace').strip()
                if not line:
                    continue
                print(f'  bridge -> firmware   {line}')
                if line == 'HELLO':
                    os.write(master, (BANNER + '\n').encode())
                    print(f'  firmware -> bridge   {BANNER}')
                elif line.startswith('SETK6 '):
                    fields = line.split()
                    revision = int(fields[1])
                    layouts += 1
                elif line == 'RUN':
                    pass
            if args.press is not None and not pressed and revision and time.monotonic() > deadline - args.seconds + args.after:
                sequence += 1
                shown = revision + 99 if args.stale else revision
                event = f'PRESS6 {sequence} {shown} {args.press}'
                os.write(master, (event + '\n').encode())
                print(f'\n  firmware -> bridge   {event}   (key {args.press + 1}'
                      f'{", deliberately stale revision" if args.stale else ""})')
                pressed = True
            time.sleep(0.02)
    finally:
        bridge.terminate()
        output = bridge.communicate(timeout=5)[0]
        os.close(master); os.close(slave)

    print(f'\n--- bridge log ---')
    for line in output.splitlines():
        print(f'  {line}')
    print(f'\nlayouts received: {layouts}')


if __name__ == '__main__':
    main()
