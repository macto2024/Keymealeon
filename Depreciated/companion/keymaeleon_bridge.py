#!/usr/bin/env python3
"""Drive the six-key keyboard from the Keymaeleon backend.

This program is a display, not a brain. The backend resolves which six actions belong on the
keys and publishes them; this maps each action to a pictogram, writes it to the firmware, and
sends presses back. It never decides what a key should be -- if it did, the keyboard and the
on-screen client would drift, and a cap would eventually disagree with the action its own
press dispatches.

Two revision counters meet here and they are deliberately the same number. The backend stamps
every layout with `keyboard.layout_revision`; the firmware reports the revision it actually had
on screen when a key went down. Passing that straight back to POST /api/key means a press that
raced a context change is rejected by the backend with 409 rather than firing the action that
replaced it. The user pressed what they saw, or nothing happens.

    python3 companion/keymaeleon_bridge.py --port /dev/ttyACM0
    python3 companion/keymaeleon_bridge.py --simulate      # no hardware; draws the caps in the terminal
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

LOG = logging.getLogger('bridge')
ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'assets' / 'icons_6.json'
RESEND_SECONDS = 0.5      # the firmware falls back to Idle after 1.5s of silence
HELLO_SECONDS = 1.0
CAPABILITY = 'COMPANION_2'  # per-key icons; COMPANION_1 firmware can only select a profile


class Backend:
    """Thin client for the local backend. Loopback only; no Origin header, so it passes the gate."""

    def __init__(self, base: str) -> None:
        self.base = base.rstrip('/')
        self.token: str | None = None

    def _request(self, path: str, payload: dict | None = None, timeout: float = 5.0):
        data = json.dumps(payload).encode() if payload is not None else None
        headers = {'Content-Type': 'application/json'} if data else {}
        if self.token:
            headers['X-Six-Token'] = self.token
        request = urllib.request.Request(f'{self.base}{path}', data=data, headers=headers,
                                         method='POST' if data else 'GET')
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read() or b'{}')

    def snapshot(self) -> dict:
        body = self._request('/api/context')
        self.token = body.get('token')
        return body

    def press(self, slot: int, revision: int) -> dict:
        return self._request('/api/key', {'slot': slot, 'revision': revision})

    def events(self):
        """Yield snapshots from the server-sent event stream until it drops."""
        request = urllib.request.Request(f'{self.base}/api/events')
        with urllib.request.urlopen(request, timeout=None) as stream:
            for raw in stream:
                line = raw.decode('utf-8', 'replace').rstrip('\n')
                if not line.startswith('data: '):
                    continue          # comments are heartbeats, blank lines are frame separators
                try:
                    yield json.loads(line[6:])
                except json.JSONDecodeError:
                    LOG.warning('Ignored malformed event')


class Icons:
    """Action id -> pictogram id, from the manifest the firmware header was generated with."""

    def __init__(self) -> None:
        manifest = json.loads(MANIFEST.read_text())
        self.actions: dict[str, int] = manifest['actions']
        self.fallback: int = manifest['fallback']
        self.names = {value: key for key, value in manifest['icons'].items()}
        self.count = len(manifest['icons'])
        self.unmapped: set[str] = set()

    def for_keys(self, keys: list | None) -> list[int]:
        out = []
        for key in (keys or [])[:6]:
            if not key:
                out.append(self.fallback)
                continue
            action = key.get('id', '')
            if action not in self.actions and action not in self.unmapped:
                self.unmapped.add(action)
                LOG.warning('No pictogram for action %r; showing blank. Add it to ACTION_ICONS.', action)
            out.append(self.actions.get(action, self.fallback))
        return out + [self.fallback] * (6 - len(out))

    def name(self, icon_id: int) -> str:
        return self.names.get(icon_id, '?').replace('six_', '')


class SerialLink:
    """The real keyboard, over a USB CDC serial device.

    Uses termios from the standard library rather than pyserial. The backend has no
    dependencies and neither should its display; a hackathon machine that cannot reach PyPI
    is a bad place to discover an install step.
    """

    def __init__(self, port: str, baud: int = 115200) -> None:
        import termios
        speed = getattr(termios, f'B{baud}', None)
        if speed is None:
            raise SystemExit(f'Unsupported baud rate {baud}')
        try:
            self.fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        except OSError as error:
            hint = ''
            if isinstance(error, PermissionError):
                hint = f'\nAdd yourself to the dialout group:  sudo usermod -aG dialout $USER  (then log out and back in)'
            raise SystemExit(f'Cannot open {port}: {error}{hint}')
        attrs = termios.tcgetattr(self.fd)
        attrs[0] = 0                                             # iflag: no translation at all
        attrs[1] = 0                                             # oflag: no post-processing
        attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL   # 8N1, ignore modem lines
        attrs[3] = 0                                             # lflag: raw, no echo
        attrs[4] = attrs[5] = speed
        attrs[6][termios.VMIN] = 0                                # never block on read
        attrs[6][termios.VTIME] = 0
        termios.tcsetattr(self.fd, termios.TCSANOW, attrs)
        self.buffer = b''

    def write(self, line: str) -> None:
        data = (line + '\n').encode('ascii')
        while data:
            try:
                data = data[os.write(self.fd, data):]
            except BlockingIOError:
                time.sleep(0.005)

    def lines(self):
        try:
            chunk = os.read(self.fd, 4096)
        except BlockingIOError:
            chunk = b''
        except OSError as error:
            LOG.warning('Serial read failed: %s', error)
            chunk = b''
        self.buffer += chunk
        while b'\n' in self.buffer:
            line, self.buffer = self.buffer.split(b'\n', 1)
            yield line.decode('ascii', 'replace').strip()

    def close(self) -> None:
        try:
            os.close(self.fd)
        except OSError:
            pass


class SimulatedLink:
    """Stands in for the keyboard: answers HELLO, and draws the caps in the terminal."""

    def __init__(self) -> None:
        self.pending: list[str] = []
        self.icons = Icons()

    def write(self, line: str) -> None:
        if line == 'HELLO':
            self.pending.append(f'KEYMAELEON6 DUAL_I2C COMPANION_1 {CAPABILITY} WAVE 8 120')
        elif line.startswith('SETK6 '):
            ids = [int(value) for value in line.split()[2:8]]
            caps = [f'{self.icons.name(i):^12}' for i in ids]
            print(f'  ┌{"┬".join("─"*12 for _ in range(3))}┐')
            print(f'  │{"│".join(caps[:3])}│')
            print(f'  │{"│".join(caps[3:])}│')
            print(f'  └{"┴".join("─"*12 for _ in range(3))}┘', flush=True)

    def lines(self):
        while self.pending:
            yield self.pending.pop(0)

    def close(self) -> None:
        pass


def parse_press(line: str):
    """PRESS6 <sequence> <displayed-revision> <key>."""
    fields = line.split()
    if len(fields) != 4 or fields[0] != 'PRESS6':
        return None
    try:
        sequence, revision, key = (int(value) for value in fields[1:])
    except ValueError:
        return None
    if 0 < sequence <= 0xffffffff and 0 <= revision <= 0xffffffff and 0 <= key < 6:
        return sequence, revision, key
    return None


class Bridge:
    def __init__(self, backend: Backend, link, icons: Icons, dry_run: bool = False) -> None:
        self.backend, self.link, self.icons, self.dry_run = backend, link, icons, dry_run
        self.ready = False
        self.revision = 0
        self.sent: list[int] | None = None
        self.last_send = 0.0
        self.last_hello = 0.0
        self.last_sequence = 0
        self.labels: list[str] = []

    def apply(self, snapshot: dict) -> None:
        """Take a published layout. The backend already decided; this only renders it."""
        context = snapshot.get('context') or {}
        revision = (context.get('keyboard') or {}).get('layout_revision') or 0
        icons = self.icons.for_keys(snapshot.get('keys'))
        self.labels = [(key or {}).get('label', '--') for key in (snapshot.get('keys') or [None] * 6)]
        if revision > 0:
            self.revision = revision
        if icons != self.sent:
            self.sent = icons
            LOG.info('Keys: %s', ' | '.join(self.labels))
            self.send_layout()

    def send_layout(self) -> None:
        if not self.ready or self.sent is None or self.revision <= 0:
            return
        self.link.write(f'SETK6 {self.revision} ' + ' '.join(str(i) for i in self.sent))
        self.last_send = time.monotonic()

    def tick(self) -> None:
        now = time.monotonic()
        if not self.ready:
            if now - self.last_hello >= HELLO_SECONDS:
                self.link.write('HELLO')
                self.last_hello = now
            return
        # The firmware drops to Idle after 1.5s without a layout, so silence is not an option.
        if now - self.last_send >= RESEND_SECONDS:
            self.send_layout()

    def receive(self, line: str) -> None:
        if not line:
            return
        if line == 'BOOT6':
            LOG.info('Keyboard rebooted; re-handshaking')
            self.ready = False
            self.last_hello = self.last_sequence = 0
            return
        if line.startswith('KEYMAELEON6 '):
            if CAPABILITY not in line.split():
                raise SystemExit(f'This firmware predates {CAPABILITY}. Reflash Keymaeleon6.ino '
                                 f'with the regenerated Icons6.h to get per-key layouts.')
            if not self.ready:
                self.ready = True
                self.link.write('RUN')
                LOG.info('Keyboard ready')
                self.send_layout()
            return
        event = parse_press(line)
        if event is None or not self.ready:
            return
        sequence, revision, key = event
        # Sequences are monotonic except across the 32-bit wrap.
        if sequence <= self.last_sequence and not (self.last_sequence > 0xffffff00 and sequence < 256):
            return
        self.last_sequence = sequence
        label = self.labels[key] if key < len(self.labels) else '?'
        if self.dry_run:
            LOG.info('Key %d (%s) -- dry run, not dispatched', key + 1, label)
            return
        try:
            # The revision the cap was actually showing, not the one we last sent.
            result = self.backend.press(key, revision)
            LOG.info('Key %d (%s): %s', key + 1, label, result.get('message', 'ok'))
        except urllib.error.HTTPError as error:
            detail = json.loads(error.read() or b'{}').get('error', error.reason)
            # 409 is the system working: the keys moved between the render and the press.
            LOG.info('Key %d ignored: %s', key + 1, detail)
        except OSError as error:
            LOG.warning('Backend unreachable: %s', error)

    def run(self) -> None:
        """Serial is serviced on this thread; the event stream is read on another.

        The firmware falls back to Idle after 1.5s without a layout, and reading server-sent
        events blocks until the next one arrives -- which, on a quiet context, is the 15 second
        heartbeat. Reading the stream on this loop would leave the keys blank for most of a
        demo. Keeping the two apart means the resend timer runs no matter how quiet the backend is.
        """
        inbox: queue.Queue = queue.Queue()
        stop = threading.Event()

        def reader() -> None:
            while not stop.is_set():
                try:
                    inbox.put(self.backend.snapshot())
                    for snapshot in self.backend.events():
                        inbox.put(snapshot)
                        if stop.is_set():
                            return
                except OSError as error:
                    LOG.warning('Backend at %s unavailable (%s); retrying', self.backend.base, error)
                stop.wait(1.0)

        thread = threading.Thread(target=reader, name='events', daemon=True)
        thread.start()
        try:
            while True:
                while True:
                    try:
                        self.apply(inbox.get_nowait())
                    except queue.Empty:
                        break
                self.pump(0.05)
        finally:
            stop.set()

    def pump(self, seconds: float) -> None:
        """Service the serial link while waiting, so handshake and resend never stall."""
        deadline = time.monotonic() + seconds
        while True:
            for line in self.link.lines():
                self.receive(line)
            self.tick()
            if time.monotonic() >= deadline:
                return
            time.sleep(0.02)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', help='serial device, e.g. /dev/ttyACM0')
    parser.add_argument('--baud', type=int, default=115200)
    parser.add_argument('--simulate', action='store_true', help='draw the caps in the terminal instead')
    parser.add_argument('--backend', default='http://127.0.0.1:5173')
    parser.add_argument('--dry-run', action='store_true', help='log presses without dispatching them')
    parser.add_argument('--verbose', action='store_true')
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format='%(asctime)s  %(message)s', datefmt='%H:%M:%S')
    if not args.port and not args.simulate:
        parser.error('give --port for hardware, or --simulate to run without it')

    link = SimulatedLink() if args.simulate else SerialLink(args.port, args.baud)
    bridge = Bridge(Backend(args.backend), link, Icons(), dry_run=args.dry_run)
    try:
        bridge.run()
    except KeyboardInterrupt:
        pass
    finally:
        link.close()


if __name__ == '__main__':
    main()
