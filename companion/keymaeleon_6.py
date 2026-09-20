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
from shortcut_oracle import Oracle, app_identity
from vscode_bridge import Bridge, key_icon

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
# Profile 6 holds LLM-generated shortcuts; the firmware draws their labels as text.
# Profile 7 is the spinner the firmware animates while a lookup is in flight.
GENERATED, BUSY = 6, 7


def profile_name(profile, layout=None):
    if profile == 8:
        return 'VS Code · live context'
    if profile == GENERATED:
        return f'Generated · {layout.app}' if layout else 'Generated'
    if profile == BUSY:
        return 'Generating'
    return PROFILES[profile]


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
    def __init__(self, port, focus, dry_run=False, oracle=None, bridge=None):
        self.port, self.focus, self.dry_run = port, focus, dry_run
        self.bridge = bridge
        self.vscode = None
        self.icon_support = False
        self.label_support = False
        self.oracle = oracle
        self.ready = False
        self.current = None
        self.generated = None
        self.sent_text = False
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
        context = self.focus.read()
        current = signature(context)
        layout = None
        self.vscode = self.bridge.snapshot() if self.bridge and current[0] == 2 else None
        if self.vscode and self.icon_support:
            current = (8, current[1], self.vscode[0])
        elif current[0] == 2 and self.bridge:
            reason = ('Firmware lacks ICON6_1; flash firmware/Keymaeleon6 before using live pictographs'
                      if not self.icon_support else self.bridge.connection_reason())
            current = (0, reason)
        if current[0] == 0 and classify(context) == 0 and self.oracle:
            # Unknown app: ask the model once, and adopt its layout when the answer lands.
            identity = app_identity(context, current[1] if len(current) > 1 else None)
            if identity:
                layout = self.oracle.layout_for(identity, context)
                if layout:
                    # Key off the app name, so a changing window title does not churn revisions.
                    current = (GENERATED, layout.app or identity)
                elif self.oracle.waiting(identity):
                    current = (BUSY, identity)  # Spin the keys until the answer lands.
        changed = current != self.current
        if changed:
            self.current, self.generated, self.sent_text = current, layout, False
            self.revision = (self.revision % 0xffffffff) + 1
            LOG.info('Profile: %s', profile_name(current[0], layout) if current[0] >= GENERATED
                     else f'{PROFILES[current[0]]} · {current[1]}')
        if changed or now - self.last_send >= .5:
            if self.generated and not self.sent_text:
                # Labels precede SET6, so the firmware never pairs text with another revision.
                for key, label in enumerate(self.generated.labels):
                    self.send(f'TEXT6 {self.revision} {key} {label}')
                self.sent_text = True
            if current[0] == 8:
                icons = list(ICONS)
                ids = ' '.join(str(icons.index(key_icon(item, self.label_support))) for item in self.vscode[1])
                self.send(f'ICON6 {self.revision} {ids}')
            else:
                self.send(f'SET6 {self.revision} {current[0]}')
            self.last_send = now

    def receive(self, line):
        if line == 'BOOT6':
            self.ready = False; self.current = None; self.last_seq = 0
            self.generated = None; self.sent_text = False
            self.last_hello = 0
            return
        if line.startswith('ERROR text revision'):
            self.sent_text = False  # Labels were lost in transit; resend them with the heartbeat.
            return
        if line.startswith('KEYMAELEON6 '):
            tokens = line.split()
            if 'COMPANION_1' not in tokens:
                raise RuntimeError('Upload the updated firmware/Keymaeleon6 sketch with Icons6.h first.')
            self.icon_support = 'ICON6_1' in tokens
            self.label_support = 'ICON6_LABELS_1' in tokens
            if self.oracle and 'TEXT6_1' not in tokens:
                LOG.warning('Firmware predates TEXT6; re-upload Keymaeleon6 to show generated '
                            'shortcuts. Generation disabled for this session.')
                self.oracle = None
            if not self.ready:
                if self.icon_support and not self.label_support:
                    LOG.warning('VS Code text labels require updated Keymaeleon6 firmware; using pictograms until it is flashed')
                LOG.info('Firmware: live pictographs %s', 'supported (ICON6_1)' if self.icon_support else 'unavailable (ICON6_1 missing)')
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
        generated = self.current[0] == GENERATED
        if (revision != self.revision or self.current[0] in (0, BUSY) or
                (generated and not self.generated)):
            LOG.info('Ignored stale/idle press on key %d', key+1)
            return
        if self.current[0] == 8:
            if not self.dry_run:
                self.bridge.press(self.vscode[0], key)
            return
        if generated:
            combination = self.generated.keys[key]
            command = ['xdotool', 'key', '--clearmodifiers', combination] if combination else None
            label = f'{self.generated.labels[key]} ({combination or "no usable shortcut"})'
        else:
            command = action_command(self.current[0], key)
            label = LABELS[self.current[0]][key]
        LOG.info('%s: %s%s', profile_name(self.current[0], self.generated), label,
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


def simulate(focus, oracle=None, bridge=None, interactive=False):
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
    status = ttk.Label(root, text='Live VS Code actions enabled' if interactive else 'Preview only; no actions executed')
    status.grid(row=1,column=0,columnspan=3)
    live = None
    panels, waves = [], [[] for _ in range(6)]
    for key in range(6):
        panel = ttk.Frame(root, padding=8); panel.grid(row=2+key//3,column=key%3)
        image = tk.PhotoImage(width=64,height=32)
        screen = ttk.Label(panel); screen.pack()
        caption = ttk.Label(panel); caption.pack()
        def trigger(event, k=key):
            if interactive and bridge and live and choice.get() == names[0]:
                bridge.press(live[0], k, allow_unfocused=True)
            now = time.monotonic()
            waves[k] = [t for t in waves[k] if now-t < .45][-31:] + [now]
        screen.bind('<Button-1>', trigger)
        panels.append((image, screen, caption))
    previous_profile = 0
    generated = None
    next_focus = 0

    def refresh():
        nonlocal previous_profile, next_focus, generated, live
        now = time.monotonic()
        if choice.get() == names[0]:
            if now >= next_focus:
                context = focus.read()
                # Clicking preview retains the last external app for wave inspection.
                if 'keymaeleonsimulator' not in str(context).lower():
                    previous_profile = classify(context)
                    identity = app_identity(context) if previous_profile == 0 and oracle else None
                    generated = oracle.layout_for(identity, context) if identity else None
                next_focus = now + .15
            profile = previous_profile
        else:
            profile = names.index(choice.get())-1
            generated = None
        live = bridge.snapshot(allow_unfocused=True) if bridge and profile == 2 and choice.get() == names[0] else None
        if bridge:
            status.configure(text=(f"{live[2].get('git', {}).get('branch', '')} · Tests: {live[2].get('tests', {}).get('state', 'idle')} · {bridge.last_action}" if live else 'VS Code disconnected / another app active'))
        for key, (image, screen, caption) in enumerate(panels):
            waves[key] = [t for t in waves[key] if now-t < .45]
            pixels = wave_frame(ICONS[key_icon(live[1][key]) if live else LAYOUTS[profile][key]], [now-t for t in waves[key]])
            image.put(' '.join('{'+' '.join('white' if p else 'black' for p in row)+'}' for row in pixels))
            screen.image = image.zoom(3,3); screen.configure(image=screen.image)
            # Hardware draws generated labels on the OLEDs; the preview shows them as captions.
            label = (f'{generated.labels[key]} · {generated.keys[key]}' if generated
                     else LABELS[profile][key])
            if live: label = live[1][key]['label'] + (' (unavailable)' if live[1][key]['reason'] else '')
            caption.configure(text=f'{key+1} · {label}')
        root.after(20, refresh)
    refresh(); root.mainloop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port')
    parser.add_argument('--bridge-port', type=int, default=5173)
    parser.add_argument('--no-vscode', action='store_true')
    parser.add_argument('--interactive', action='store_true', help='enable VS Code actions from simulator clicks')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--simulate', action='store_true')
    modes.add_argument('--watch', action='store_true')
    modes.add_argument('--list-ports', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--no-llm', action='store_true',
                        help='never ask OpenAI for shortcuts; unknown apps stay disabled')
    parser.add_argument('--stream', action='store_true',
                        help='print the prompt and stream the reply as it arrives (the default)')
    parser.add_argument('--no-stream', action='store_true',
                        help='log each reply once it is complete instead of streaming it')
    parser.add_argument('--verbose', action='store_true',
                        help='log the full request and response JSON for every LLM lookup')
    args = parser.parse_args()
    if args.interactive and not args.simulate: parser.error('--interactive requires --simulate')
    if args.simulate and (args.port or args.dry_run): parser.error('--simulate takes no --port or --dry-run')
    if not (args.simulate or args.watch or args.list_ports or args.port): parser.error('Specify --port; use --list-ports to find the Nano')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    focus = Focus('x11')
    oracle = None if args.no_llm or args.list_ports or args.watch else Oracle.from_env()
    if oracle:
        oracle.verbose = oracle.verbose or args.verbose
        # Streaming is on unless refused; --verbose implies it, being the readable way to see a reply.
        oracle.stream = not args.no_stream and (oracle.stream or args.stream or args.verbose)
    try:
        bridge = Bridge(args.bridge_port) if not (args.no_vscode or args.list_ports or args.watch) else None
    except OSError as exc:
        raise RuntimeError(f'Cannot start VS Code bridge on port {args.bridge_port}: {exc}. Close the other companion or use --bridge-port.') from exc
    if bridge:
        LOG.info('VS Code bridge listening at http://127.0.0.1:%s; reload VS Code after extension updates', args.bridge_port)
    if args.simulate:
        if args.port or args.dry_run: parser.error('--simulate takes no --port or --dry-run')
        simulate(focus, oracle, bridge, args.interactive); return
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
                controller = Controller(port,focus,args.dry_run,oracle,bridge)
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
