#!/usr/bin/env python3
"""Keymaeleon animation lab: standalone preview and optional USB control."""
import math
import time
import tkinter as tk
from tkinter import ttk

MAX_WAVES = 32

MODES = ('Invert (hold)', 'Bottom wave', 'Center ripple', 'Wipe', 'Dissolve', 'Sparkle')
DESCRIPTIONS = (
    'Inverts every pixel while the physical button is held. Test flashes for 450 ms.',
    'Each press adds a bottom wave. Rapid presses create overlapping rings.',
    'A circular ripple expands from the center of the display.',
    'A vertical band sweeps across the display from left to right.',
    'Pixels dissolve into an inverted image and then return.',
    'Scattered pixels shimmer across the display. Thickness controls density.',
)


def frame(mode, thickness, speed, elapsed, held=False, wave_ages=None):
    """64×32 monochrome frame; same formulas and limits as the sketch."""
    travel = max(0, elapsed) * speed
    limit = 46 + thickness if mode == 1 else 37 + thickness if mode == 2 else 64 + thickness if mode == 3 else 64
    active = elapsed >= 0 and travel < limit
    rings = []
    if mode == 1:
        ages = [elapsed] if wave_ages is None else wave_ages
        rings = [age * speed for age in ages if 0 <= age * speed < limit]
        active = bool(rings)
    pixels = []
    for y in range(32):
        row = []
        for x in range(64):
            base = (((y == 1 or y == 30) and 2 <= x <= 61) or
                    ((x == 1 or x == 62) and 2 <= y <= 29) or
                    (25 <= x <= 42 and abs(y - 16) <= (42 - x) * 2 // 3))
            flip = mode == 0 and held
            noise = (x * 37 + y * 73 + x * y * 13) % 101
            if active and mode:
                if mode in (1, 2):
                    distance = math.hypot(x - 31.5, y - (31 if mode == 1 else 15.5))
                    flip = (any(radius - thickness < distance <= radius for radius in rings)
                            if mode == 1 else travel - thickness < distance <= travel)
                elif mode == 3:
                    flip = travel - thickness < x <= travel
                elif mode == 4:
                    flip = noise < 100 * math.sin(math.pi * travel / 64)
                else:
                    flip = (noise + int(travel / 3) * 17) % 101 < thickness and (x + y) % 3 == 0
            row.append(bool(base) != bool(flip))
        pixels.append(row)
    return pixels


class AnimationLab:
    def __init__(self, root):
        self.root = root
        self.port = None
        self.ready = False
        self.pending = bytearray()
        self.started = [None, None]
        self.waves = [[], []]
        self.held = [False, False]
        self.pulse_until = [0, 0]
        self.last_hello = 0
        self.last_stats = 0
        self.apply_job = None
        self.connected_at = 0
        self.mode = tk.StringVar(value=MODES[1])
        self.thickness = tk.IntVar(value=5)
        self.speed = tk.IntVar(value=45)
        self.status = tk.StringVar(value='Preview mode — connect a board when ready.')
        self.timing = tk.StringVar(value='Hardware transfer timing appears when connected.')
        self.description = tk.StringVar(value=DESCRIPTIONS[1])
        self.port_name = tk.StringVar()
        root.title('Keymaeleon · Animation Lab')
        root.resizable(False, False)
        outer = ttk.Frame(root, padding=20)
        outer.pack(fill='both', expand=True)
        ttk.Label(outer, text='Animation Lab', font=('Sans', 20, 'bold')).pack(anchor='w')
        ttk.Label(outer, text='64 × 32 OLEDs · press either key to animate its display').pack(anchor='w', pady=(2, 16))
        connection = ttk.Frame(outer)
        connection.pack(fill='x')
        self.ports = ttk.Combobox(connection, textvariable=self.port_name, width=32)
        self.ports.pack(side='left')
        ttk.Button(connection, text='Refresh ports', command=self.refresh_ports).pack(side='left', padx=6)
        self.connect_button = ttk.Button(connection, text='Connect', command=self.connect)
        self.connect_button.pack(side='left')
        previews = ttk.Frame(outer)
        previews.pack(pady=20)
        self.images = []
        for i, name in enumerate(('Left key · D2', 'Right key · D3')):
            panel = ttk.Frame(previews)
            panel.pack(side='left', padx=8)
            ttk.Label(panel, text=name).pack(pady=(0, 8))
            image = tk.PhotoImage(width=64, height=32)
            label = ttk.Label(panel)
            label.pack()
            self.images.append((image, label))
            ttk.Button(panel, text='Test press', command=lambda key=i: self.trigger(key)).pack(pady=8)
        controls = ttk.Frame(outer)
        controls.pack(fill='x')
        ttk.Label(controls, text='Animation').grid(row=0, column=0, sticky='w', padx=(0, 12))
        choices = ttk.Combobox(controls, textvariable=self.mode, values=MODES, state='readonly', width=26)
        choices.grid(row=0, column=1, sticky='w')
        choices.bind('<<ComboboxSelected>>', self.settings_changed)
        for row, (title, variable, low, high) in enumerate((
            ('Thickness / density', self.thickness, 1, 16),
            ('Speed (pixels/sec)', self.speed, 5, 160)), 1):
            ttk.Label(controls, text=title).grid(row=row, column=0, sticky='w')
            tk.Scale(controls, variable=variable, from_=low, to=high, orient='horizontal',
                     length=320, command=self.settings_changed).grid(row=row, column=1)
        ttk.Label(outer, textvariable=self.description, wraplength=560).pack(anchor='w', pady=(12, 6))
        ttk.Label(outer, text='Settings apply to both keys. Bottom waves stack with each press.\n'
                  'Effects run on the board; USB is only needed to change settings.').pack(anchor='w')
        ttk.Label(outer, textvariable=self.status, wraplength=560).pack(anchor='w', pady=(16, 0))
        ttk.Label(outer, textvariable=self.timing, wraplength=560).pack(anchor='w', pady=(6, 0))
        self.refresh_ports()
        root.protocol('WM_DELETE_WINDOW', self.close)
        root.after(33, self.tick)

    def refresh_ports(self):
        try:
            from serial.tools import list_ports
            devices = [p.device for p in list_ports.comports()]
            self.ports['values'] = devices
            if devices and not self.port_name.get():
                self.port_name.set(devices[0])
        except ImportError:
            self.status.set('Preview available. Install pyserial to connect a board.')

    def disconnect(self, message='Disconnected — preview mode.'):
        if self.port:
            self.port.close()
        self.port = None
        self.ready = False
        self.pending.clear()
        self.held = [False, False]
        self.connect_button.configure(text='Connect')
        self.status.set(message)
        self.timing.set('Hardware transfer timing appears when connected.')

    def connect(self):
        if self.port:
            self.disconnect()
            return
        try:
            import serial
            self.port = serial.Serial(self.port_name.get(), 115200, timeout=0, write_timeout=0.1, exclusive=True)
            self.connected_at = time.monotonic()
            self.last_hello = 0
            self.connect_button.configure(text='Disconnect')
            self.status.set('Waiting for AnimationTest firmware…')
        except (ImportError, OSError, ValueError) as exc:
            self.status.set(f'Cannot connect: {exc}')

    def send(self, command):
        if self.port:
            try:
                self.port.write((command + '\n').encode('ascii'))
            except (OSError, ValueError) as exc:
                self.disconnect(f'USB error: {exc}')

    def settings_changed(self, *_):
        self.description.set(DESCRIPTIONS[MODES.index(self.mode.get())])
        self.started = [None, None]
        self.waves = [[], []]
        self.pulse_until = [0, 0]
        if self.apply_job:
            self.root.after_cancel(self.apply_job)
        self.apply_job = self.root.after(120, self.apply_settings)

    def apply_settings(self):
        self.apply_job = None
        if self.ready:
            self.send(f'SET {MODES.index(self.mode.get())} {self.thickness.get()} {self.speed.get()}')

    def start_effect(self, key, now):
        self.started[key] = now
        if self.mode.get() == MODES[1]:
            lifetime = (46 + self.thickness.get()) / self.speed.get()
            self.waves[key] = [start for start in self.waves[key] if now - start < lifetime]
            self.waves[key].append(now)
            self.waves[key] = self.waves[key][-MAX_WAVES:]

    def trigger(self, key):
        now = time.monotonic()
        self.start_effect(key, now)
        self.pulse_until[key] = now + .45
        if self.ready:
            self.send(f'TRIGGER {key}')

    def receive(self, line):
        if line == 'ANIMATIONS 1':
            if not self.ready:
                self.ready = True
                self.apply_settings()
        elif line.startswith('STATS '):
            fields = line.split()
            if len(fields) == 5 and all(value.isdigit() for value in fields[1:]):
                left, right, errors_left, errors_right = map(int, fields[1:])
                self.timing.set(f'Last frame transfer: left {left / 1000:.1f} ms · '
                                f'right {right / 1000:.1f} ms · '
                                f'I²C errors: {errors_left}/{errors_right}')
        elif line.startswith('OK '):
            self.status.set(f'Connected to {self.port_name.get()} · settings applied')
        elif line.startswith('BUTTON '):
            parts = line.split()
            if len(parts) == 3 and parts[1] in ('0', '1') and parts[2] in ('0', '1'):
                key, pressed = int(parts[1]), parts[2] == '1'
                self.held[key] = pressed
                if pressed:
                    self.start_effect(key, time.monotonic())
        elif line.startswith('ERROR'):
            self.status.set(f'Board: {line}')

    def tick(self):
        now = time.monotonic()
        if self.port:
            try:
                data = self.port.read(1024)
                self.pending.extend(data)
                while b'\n' in self.pending:
                    line, _, tail = self.pending.partition(b'\n')
                    self.pending = bytearray(tail)
                    self.receive(line.decode('ascii', errors='replace').strip())
                if len(self.pending) > 4096:
                    self.pending.clear()
                if self.ready and now - self.last_stats >= 1:
                    self.last_stats = now
                    self.send('STATS')
                if not self.ready:
                    if now - self.connected_at > 8:
                        self.disconnect('No AnimationTest firmware detected. Upload the sketch, then reconnect.')
                    elif now - self.last_hello > .7:
                        self.last_hello = now
                        self.send('HELLO')
            except (OSError, ValueError) as exc:
                self.disconnect(f'USB disconnected: {exc}')
        for key, (image, label) in enumerate(self.images):
            elapsed = -1 if self.started[key] is None else now - self.started[key]
            pixels = frame(MODES.index(self.mode.get()), self.thickness.get(), self.speed.get(),
                           elapsed, self.held[key] or now < self.pulse_until[key],
                           wave_ages=[now - start for start in self.waves[key]])
            image.put(' '.join('{' + ' '.join('#eefbff' if p else '#05090d' for p in row) + '}' for row in pixels))
            enlarged = image.zoom(4, 4)
            label.configure(image=enlarged)
            label.image = enlarged
        self.root.after(33, self.tick)

    def close(self):
        self.disconnect()
        self.root.destroy()


if __name__ == '__main__':
    root = tk.Tk()
    AnimationLab(root)
    root.mainloop()
