#!/usr/bin/env python3
"""Six-key Keymaeleon companion for Ubuntu X11, with an animated 2×3 preview."""
import argparse
import json
import logging
import secrets
import subprocess
import time
from pathlib import Path
from keymaeleon import Focus, PROFILES, classify, signature, run

LOG = logging.getLogger('keymaeleon6')
ASSETS = json.loads((Path(__file__).resolve().parents[1] / 'assets/icons_6.json').read_text())
ICONS, LAYOUTS = ASSETS['icons'], ASSETS['profiles']
# Physical order: top left-to-right, then bottom left-to-right.
LABELS = [('--',)*6,
          ('Back', 'Refresh', 'Forward', 'New tab', 'Find', 'Next tab'),
          ('Save', 'Run', 'Find', 'New file', 'Copy', 'Paste'),
          ('Clear', 'New tab', 'Copy', 'Paste', 'Previous tab', 'Next tab'),
          ('Volume −', 'Mute', 'Volume +', 'Previous', 'Play / pause', 'Next'),
          ('Volume −', 'Mute', 'Volume +', 'Overview', 'Files', 'Play / pause')]
SHORTCUTS = {
    1: ('alt+Left', 'ctrl+r', 'alt+Right', 'ctrl+t', 'ctrl+f', 'ctrl+Tab'),
    2: ('ctrl+s', 'ctrl+F5', 'ctrl+f', 'ctrl+n', 'ctrl+c', 'ctrl+v'),
    3: ('ctrl+l', 'ctrl+shift+t', 'ctrl+shift+c', 'ctrl+shift+v', 'ctrl+Page_Up', 'ctrl+Page_Down'),
}


def action_command(profile, key):
    if profile in SHORTCUTS:
        return ['xdotool', 'key', '--clearmodifiers', SHORTCUTS[profile][key]]
    if profile in (4, 5) and key < 3:
        return (['pactl', 'set-sink-mute', '@DEFAULT_SINK@', 'toggle'] if key == 1 else
                ['pactl', 'set-sink-volume', '@DEFAULT_SINK@', '-5%' if key == 0 else '+5%'])
    if profile == 4:
        return ['playerctl', '--player=spotify', ('previous', 'play-pause', 'next')[key-3]]
    if profile == 5:
        return {3: ['xdotool', 'key', '--clearmodifiers', 'super'],
                4: ['nautilus', '--new-window'], 5: ['playerctl', 'play-pause']}[key]
    return None


def parse_press(line):
    fields = line.split()
    if len(fields) != 4 or fields[0] != 'PRESS6':
        return None
    try:
        seq, revision, key = map(int, fields[1:])
    except ValueError:
        return None
    if 0 < seq <= 0xffffffff and 0 <= revision <= 0xffffffff and 0 <= key < 6:
        return seq, revision, key
    return None


class Controller:
    def __init__(self, port, focus, dry_run=False):
        self.port, self.focus, self.dry_run = port, focus, dry_run
        self.ready = False
        self.current = None
        self.revision = secrets.randbelow(0xfffffffe) + 1
        self.last_seq = 0
        self.last_send = self.last_hello = 0

    def send(self, line):
        self.port.write((line+'\n').encode('ascii'))

    def update(self):
        now = time.monotonic()
        if not self.ready:
            if now - self.last_hello >= 1:
                self.send('HELLO'); self.last_hello = now
            return
        current = signature(self.focus.read())
        changed = current != self.current
        if changed:
            self.current = current
            self.revision = (self.revision % 0xffffffff) + 1
            LOG.info('Profile: %s · %s', PROFILES[current[0]], current[1])
        if changed or now - self.last_send >= .5:
            self.send(f'SET6 {self.revision} {current[0]}')
            self.last_send = now

    def receive(self, line):
        if line == 'BOOT6':
            self.ready = False; self.current = None; self.last_seq = 0
            self.last_hello = 0
            return
        if line.startswith('KEYMAELEON6 '):
            if 'COMPANION_1' not in line.split():
                raise RuntimeError('Upload the updated firmware/Keymaeleon6 sketch with Icons6.h first.')
            if not self.ready:
                self.ready = True; self.send('RUN'); self.update()
            return
        event = parse_press(line)
        if not self.ready or event is None:
            return
        seq, revision, key = event
        if seq <= self.last_seq and not (self.last_seq > 0xffffff00 and seq < 256):
            return
        self.last_seq = seq
        self.update()  # Reject stale displays and presses after a focus change.
        if revision != self.revision or self.current[0] == 0:
            LOG.info('Ignored stale/idle press on key %d', key+1)
            return
        command = action_command(self.current[0], key)
        LOG.info('%s: %s%s', PROFILES[self.current[0]], LABELS[self.current[0]][key],
                 ' (dry run)' if self.dry_run else '')
        if command and not self.dry_run:
            try:
                run(command)
            except (OSError, subprocess.SubprocessError) as exc:
                LOG.warning('Action failed: %s', exc)


def wave_frame(icon, ages):
    """Same bottom-origin, union-of-rings inversion as firmware/Wave.h."""
    radii = [age*120 for age in ages[-32:] if 0 <= age < .45]
    return [[(pixel == '1') != any(max(0, r-8)**2 < (x-31.5)**2+(y-31)**2 <= r*r
                                  for r in radii)
             for x, pixel in enumerate(row)] for y, row in enumerate(icon)]


def simulate(focus):
    import tkinter as tk
    from tkinter import ttk
    try:
        root = tk.Tk(className='KeymaeleonSimulator')
    except tk.TclError as exc:
        raise RuntimeError('Cannot open simulator; launch it inside your graphical X11 desktop session.') from exc
    root.title('Keymaeleon 6 · pictograms + waves'); root.resizable(False, False)
    root.attributes('-topmost', True)
    choice = tk.StringVar(value='Auto (focused app)')
    names = ['Auto (focused app)'] + list(PROFILES.values())
    ttk.Combobox(root, textvariable=choice, values=names, state='readonly').grid(row=0,column=0,columnspan=3,pady=8)
    ttk.Label(root, text='Click a key to preview its wave; no actions are executed.').grid(row=1,column=0,columnspan=3)
    panels, waves = [], [[] for _ in range(6)]
    for key in range(6):
        panel = ttk.Frame(root, padding=8); panel.grid(row=2+key//3,column=key%3)
        image = tk.PhotoImage(width=64,height=32)
        screen = ttk.Label(panel); screen.pack()
        caption = ttk.Label(panel); caption.pack()
        def trigger(event, k=key):
            now = time.monotonic()
            waves[k] = [t for t in waves[k] if now-t < .45][-31:] + [now]
        screen.bind('<Button-1>', trigger)
        panels.append((image, screen, caption))
    previous_profile = 0
    next_focus = 0

    def refresh():
        nonlocal previous_profile, next_focus
        now = time.monotonic()
        if choice.get() == names[0]:
            if now >= next_focus:
                context = focus.read()
                # Clicking preview retains the last external app for wave inspection.
                if 'keymaeleonsimulator' not in str(context).lower():
                    previous_profile = classify(context)
                next_focus = now + .15
            profile = previous_profile
        else:
            profile = names.index(choice.get())-1
        for key, (image, screen, caption) in enumerate(panels):
            waves[key] = [t for t in waves[key] if now-t < .45]
            pixels = wave_frame(ICONS[LAYOUTS[profile][key]], [now-t for t in waves[key]])
            image.put(' '.join('{'+' '.join('white' if p else 'black' for p in row)+'}' for row in pixels))
            screen.image = image.zoom(3,3); screen.configure(image=screen.image)
            caption.configure(text=f'{key+1} · {LABELS[profile][key]}')
        root.after(20, refresh)
    refresh(); root.mainloop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--simulate', action='store_true')
    modes.add_argument('--watch', action='store_true')
    modes.add_argument('--list-ports', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    focus = Focus('x11')
    if args.simulate:
        if args.port or args.dry_run: parser.error('--simulate takes no --port or --dry-run')
        simulate(focus); return
    if args.watch:
        while True:
            context = focus.read()
            print(json.dumps({'context': context, 'profile': PROFILES[classify(context)]}), flush=True)
            time.sleep(.5)
    import serial
    from serial.tools import list_ports
    if args.list_ports:
        for port in list_ports.comports(): print(f'{port.device}\t{port.description}')
        return
    if not args.port: parser.error('Specify --port; use --list-ports to find the Nano')
    while True:
        try:
            with serial.Serial(args.port,115200,timeout=.02,write_timeout=.5,exclusive=True) as port:
                port.reset_input_buffer()
                controller = Controller(port,focus,args.dry_run)
                pending = bytearray(); discard = False; next_poll = 0
                connected = time.monotonic()
                while True:
                    now = time.monotonic()
                    if not controller.ready and now-connected > 10:
                        raise RuntimeError('No compatible six-key firmware response. Upload Keymaeleon6 (not Mux2Test), then retry.')
                    if now >= next_poll:
                        controller.update(); next_poll = time.monotonic()+.15
                    for byte in port.read(512):
                        if byte == 10:
                            if not discard:
                                line = pending.decode('ascii',errors='replace').strip()
                                if line == 'BOOT6': connected = time.monotonic()
                                controller.receive(line)
                            pending.clear(); discard = False
                        elif len(pending) < 256: pending.append(byte)
                        else: discard = True
        except (serial.SerialException, OSError) as exc:
            LOG.warning('Serial unavailable: %s; retrying in 2 seconds',exc); time.sleep(2)


if __name__ == '__main__':
    try: main()
    except KeyboardInterrupt: pass
    except (RuntimeError, ImportError) as exc: raise SystemExit(str(exc))
