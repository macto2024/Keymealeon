#!/usr/bin/env python3
"""Focus-aware USB companion. Runs as your desktop user, never as root."""
import argparse
import ast
import json
import logging
import os
import re
import subprocess
import time
from pathlib import Path

LOG = logging.getLogger("keymaeleon")
PROFILES = {0: "Idle", 1: "Firefox", 2: "VS Code", 3: "Terminal", 4: "Spotify", 5: "Desktop"}
ACTIONS = {1: ("back", "refresh"), 2: ("save", "run"), 3: ("clear", "tab"),
           4: ("play-pause", "next"), 5: ("down", "up")}
LABELS = {0: ("--", "--"), 1: ("Back", "Refresh"), 2: ("Save", "Run"),
          3: ("Clear", "New tab"), 4: ("Play/Pause", "Next"), 5: ("Vol -", "Vol +")}


def display_content(context):
    """Profile and accessible action descriptions for the simulator."""
    profile = classify(context)
    return PROFILES[profile], LABELS[profile]


def display_icons(context):
    return ACTIONS.get(classify(context), ("idle", "idle"))


def simulate(focus):
    # Import only in simulation mode: hardware operation does not need Tk.
    try:
        import tkinter as tk
    except ImportError as exc:
        raise RuntimeError("Simulator needs Tk: sudo apt install python3-tk") from exc
    try:
        root = tk.Tk(className="KeymaeleonSimulator")
    except tk.TclError as exc:
        raise RuntimeError("Cannot open simulator window; run inside your graphical desktop session") from exc
    root.title("Keymaeleon — display simulator")
    root.configure(bg="#18232f")
    root.resizable(False, False)
    root.attributes("-topmost", True)
    icons = json.loads((Path(__file__).resolve().parents[1] / "assets/icons.json").read_text())
    tk.Label(root, text="KEYMAELEON", fg="#e7edf4", bg="#18232f",
             font=("Sans", 16, "bold")).pack(pady=(16, 4))
    tk.Label(root, text="Live key displays · preview only", fg="#acbbc9", bg="#18232f").pack()
    row = tk.Frame(root, bg="#18232f")
    row.pack(padx=16, pady=16)
    displays = []
    for key in ("LEFT KEY", "RIGHT KEY"):
        frame = tk.Frame(row, bg="#18232f")
        frame.pack(side="left", padx=8)
        tk.Label(frame, text=key, fg="#acbbc9", bg="#18232f").pack(pady=(0, 8))
        canvas = tk.Canvas(frame, width=256, height=128, bg="black",
                           highlightthickness=2, highlightbackground="#45566a")
        canvas.pack()
        caption = tk.Label(frame, fg="#acbbc9", bg="#18232f")
        caption.pack(pady=(8, 0))
        displays.append((canvas, caption))
    tk.Label(root, text="Switch to Firefox, VS Code, Terminal or Spotify to see the labels change.\n"
             "Focusing this preview shows Idle. Close the window to stop.",
             fg="#acbbc9", bg="#18232f").pack(padx=16, pady=(0, 16))
    previous = None

    def refresh():
        nonlocal previous
        context = focus.read()
        content = display_content(context)
        if content != previous:
            heading, labels = content
            for (canvas, caption), label, icon in zip(displays, labels, display_icons(context)):
                canvas.delete("all")
                for y, row in enumerate(icons[icon]):
                    for x, pixel in enumerate(row):
                        if pixel == "1":
                            canvas.create_rectangle(x*4, y*4, (x+1)*4, (y+1)*4,
                                                    fill="white", outline="")
                caption.configure(text=f"{heading} · {label}")
            previous = content
        root.after(150, refresh)

    try:
        refresh()
        root.mainloop()
    finally:
        try:
            root.destroy()
        except tk.TclError:
            pass


def run(args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=0.4).strip()


def classify(context):
    if context.get("blocked"):
        return 0
    if context.get("desktop"):
        return 5
    # Match application identifiers, never document/window titles.
    identities = {str(context.get(k, "")).lower().removesuffix(".desktop")
                  for k in ("app", "wmclass")}
    aliases = {
        1: {"firefox", "org.mozilla.firefox", "firefox_firefox"},
        2: {"code", "code-url-handler", "code-insiders", "com.visualstudio.code", "codium"},
        3: {"gnome-terminal", "gnome-terminal-server", "org.gnome.terminal", "org.gnome.console", "kgx"},
        4: {"spotify", "com.spotify.client", "spotify_spotify"},
    }
    for profile, matches in aliases.items():
        if identities & matches:
            return profile
    return 0


class Focus:
    def __init__(self, backend):
        self.backend = backend
        self.last_error = None

    def read(self):
        try:
            if self.backend == "gnome":
                reply = run(["gdbus", "call", "--session", "--dest", "com.keymaeleon.Context",
                             "--object-path", "/com/keymaeleon/Context",
                             "--method", "com.keymaeleon.Context.GetContext"])
                context = json.loads(ast.literal_eval(reply)[0])
            else:
                # Refuse to mistake XWayland's partial view for the focused desktop.
                if os.environ.get("XDG_SESSION_TYPE") == "wayland":
                    raise RuntimeError("X11 backend cannot detect native Wayland apps; use --backend gnome")
                active = run(["xprop", "-root", "_NET_ACTIVE_WINDOW"])
                match = re.search(r"0x[0-9a-fA-F]+", active)
                if not match:
                    raise RuntimeError("Window manager does not expose _NET_ACTIVE_WINDOW")
                wid = match[0]
                if int(wid, 16) == 0:
                    context = {"blocked": True}  # No focus is not proof of desktop or unlocked state.
                else:
                    props = run(["xprop", "-id", wid, "WM_CLASS", "_NET_WM_WINDOW_TYPE"])
                    classes = re.findall(r'"([^"\n]*)"', props.split("\n")[0])
                    context = {"app": classes[0] if classes else "", "wmclass": classes[-1] if classes else "",
                               "id": wid, "desktop": "_NET_WM_WINDOW_TYPE_DESKTOP" in props}
            if not isinstance(context, dict):
                raise ValueError("Invalid focus response")
            self.last_error = None
            return context
        except (OSError, subprocess.SubprocessError, ValueError, SyntaxError, IndexError, RuntimeError) as exc:
            message = str(exc)
            if message != self.last_error:
                LOG.warning("Focus unavailable; keys disabled: %s", message)
                self.last_error = message
            return {"blocked": True}


def signature(context):
    return classify(context), str(context.get("id", "")), bool(context.get("blocked"))


def parse_press(line):
    fields = line.split()
    if len(fields) != 4 or fields[0] != "PRESS":
        return None
    try:
        seq, revision, key = map(int, fields[1:])
    except ValueError:
        return None
    if not (0 < seq <= 0xFFFFFFFF and 0 <= revision <= 0xFFFFFFFF and key in (0, 1)):
        return None
    return seq, revision, key


class Controller:
    def __init__(self, port, focus, dry_run=False):
        self.port, self.focus, self.dry_run = port, focus, dry_run
        self.current = None
        self.revision = 0
        self.last_send = 0
        self.last_seq = 0

    def send(self, line):
        self.port.write((line + "\n").encode("ascii"))

    def update(self, force=False):
        current = signature(self.focus.read())
        if current != self.current:
            self.current = current
            self.revision = (self.revision + 1) & 0xFFFFFFFF
            LOG.info("Profile: %s (window %s)", PROFILES[current[0]], current[1])
            force = True
        if force or time.monotonic() - self.last_send >= 0.5:
            self.send(f"SET {self.revision} {current[0]}")
            self.last_send = time.monotonic()

    def press(self, line):
        event = parse_press(line)
        if not event:
            return
        seq, revision, key = event
        # Each sequence executes once, including host-side Spotify commands.
        if seq <= self.last_seq and not (self.last_seq > 0xFFFFFF00 and seq < 256):
            return
        self.last_seq = seq
        self.update()  # Recheck focus before using the displayed profile.
        if revision != self.revision or self.current[0] not in ACTIONS:
            self.send(f"DO {seq} none")
            return
        profile = self.current[0]
        action = ACTIONS[profile][key]
        LOG.info("%s: %s", PROFILES[profile], action)
        if self.dry_run:
            self.send(f"DO {seq} none")
        elif profile == 4:
            self.send(f"DO {seq} none")
            try:
                run(["playerctl", "--player=spotify", action])
            except (OSError, subprocess.SubprocessError) as exc:
                LOG.warning("Spotify action failed (is the desktop app running?): %s", exc)
        else:
            self.send(f"DO {seq} {action}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", help="Serial device, preferably /dev/serial/by-id/...")
    parser.add_argument("--backend", choices=("gnome", "x11"), default="x11", help="Focus provider (default: x11)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--list-ports", action="store_true")
    mode.add_argument("--watch", action="store_true", help="Print focused app identities without hardware")
    mode.add_argument("--simulate", action="store_true", help="Show live key displays in a window; no hardware or actions")
    parser.add_argument("--dry-run", action="store_true", help="Update displays and log presses without executing actions")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    focus = Focus(args.backend)
    if args.simulate:
        if args.port or args.dry_run:
            parser.error("--simulate runs without hardware; omit --port and --dry-run")
        try:
            simulate(focus)
        except RuntimeError as exc:
            parser.exit(1, f"{exc}\n")
        return
    if args.watch:
        previous = None
        while True:
            context = focus.read()
            if context != previous:
                print(json.dumps({"context": context, "profile": PROFILES[classify(context)]}), flush=True)
                previous = context
            time.sleep(0.15)
    import serial
    from serial.tools import list_ports
    if args.list_ports:
        for port in list_ports.comports():
            print(f"{port.device}\t{port.description}\t{port.hwid}")
        return
    if not args.port:
        parser.error("Specify --port; use --list-ports to locate the Nano")
    while True:
        try:
            with serial.Serial(args.port, 115200, timeout=0.02, write_timeout=0.5, exclusive=True) as port:
                LOG.info("Connected to %s", args.port)
                port.reset_input_buffer()
                controller = Controller(port, focus, args.dry_run)
                pending = bytearray()
                discard = False
                next_poll = 0
                while True:
                    now = time.monotonic()
                    if now >= next_poll:
                        controller.update()
                        next_poll = time.monotonic() + 0.15
                    for byte in port.read(256):
                        if byte == 10:
                            if not discard:
                                controller.press(pending.decode("ascii", errors="replace").strip())
                            pending.clear()
                            discard = False
                        elif len(pending) < 128:
                            pending.append(byte)
                        else:
                            discard = True
        except (serial.SerialException, OSError) as exc:
            LOG.warning("Serial connection unavailable: %s; retrying in 2 seconds", exc)
            time.sleep(2)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
