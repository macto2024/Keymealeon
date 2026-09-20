#!/usr/bin/env python3
"""Generate Icons6.h and assets/icons_6.json for the six-key keyboard.

Two rules shape this script.

The twenty-one pictograms already on the hardware are recovered from the existing header
byte for byte and never redrawn. They are known-good at 64x32 on a real SSD1306, and the
original artwork is not in the repository, so regenerating them could only lose fidelity.

Everything new is drawn here from vector primitives with no third-party dependency, so the
header can be regenerated on any machine with Python. The firmware and the host read the
same generated manifest, which is what keeps a cap and its label from ever disagreeing.

Format, confirmed against the shipping header: 64x32, one bit per pixel, 8 bytes per row,
32 rows, least significant bit leftmost -- the XBM convention U8g2's drawXBMP expects.

    python3 tools/generate_six_icons.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path

WIDTH, HEIGHT = 64, 32
ROOT = Path(__file__).resolve().parents[1]
HEADER = ROOT / 'ESP32 Firmware' / 'Keymaeleon6' / 'Icons6.h'
MANIFEST = ROOT / 'assets' / 'icons_6.json'

# Profile 0-5 as the firmware and companion already use them. Preserved exactly.
PROFILE_NAMES = ['Idle', 'Firefox', 'VS Code', 'Terminal', 'Spotify', 'Desktop']


class Canvas:
    """A 64x32 one-bit canvas with just enough drawing to make legible pictograms."""

    def __init__(self) -> None:
        self.rows = [[False] * WIDTH for _ in range(HEIGHT)]

    def px(self, x: int, y: int) -> None:
        if 0 <= x < WIDTH and 0 <= y < HEIGHT:
            self.rows[y][x] = True

    def rect(self, x0: int, y0: int, x1: int, y1: int) -> None:
        for y in range(min(y0, y1), max(y0, y1) + 1):
            for x in range(min(x0, x1), max(x0, x1) + 1):
                self.px(x, y)

    def frame(self, x0: int, y0: int, x1: int, y1: int, t: int = 2) -> None:
        self.rect(x0, y0, x1, y0 + t - 1)
        self.rect(x0, y1 - t + 1, x1, y1)
        self.rect(x0, y0, x0 + t - 1, y1)
        self.rect(x1 - t + 1, y0, x1, y1)

    def brush(self, x: int, y: int, t: int) -> None:
        """A square nib. Square reads better than round at this size -- fewer stray pixels."""
        half = t // 2
        self.rect(x - half, y - half, x - half + t - 1, y - half + t - 1)

    def line(self, x0: int, y0: int, x1: int, y1: int, t: int = 3) -> None:
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        err = dx + dy
        while True:
            self.brush(x0, y0, t)
            if x0 == x1 and y0 == y1:
                return
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    def disc(self, cx: int, cy: int, r: int) -> None:
        for y in range(cy - r, cy + r + 1):
            for x in range(cx - r, cx + r + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                    self.px(x, y)

    def ring(self, cx: int, cy: int, r: int, t: int = 3) -> None:
        inner = max(0, r - t)
        for y in range(cy - r, cy + r + 1):
            for x in range(cx - r, cx + r + 1):
                d = (x - cx) ** 2 + (y - cy) ** 2
                if inner * inner < d <= r * r:
                    self.px(x, y)

    def poly(self, points: list[tuple[int, int]]) -> None:
        """Even-odd scanline fill, so concave shapes such as the star come out right."""
        for y in range(HEIGHT):
            crossings = []
            for i, (x0, y0) in enumerate(points):
                x1, y1 = points[(i + 1) % len(points)]
                if (y0 <= y < y1) or (y1 <= y < y0):
                    crossings.append(x0 + (y - y0) * (x1 - x0) / (y1 - y0))
            crossings.sort()
            for a, b in zip(crossings[0::2], crossings[1::2]):
                for x in range(int(round(a)), int(round(b)) + 1):
                    self.px(x, y)

    def pack(self) -> list[int]:
        """To XBM bytes: 8 bytes per row, least significant bit leftmost."""
        out = []
        for row in self.rows:
            for byte_index in range(WIDTH // 8):
                value = 0
                for bit in range(8):
                    if row[byte_index * 8 + bit]:
                        value |= 1 << bit
                out.append(value)
        return out


def draw(fn) -> list[int]:
    canvas = Canvas()
    fn(canvas)
    return canvas.pack()


# --- new pictograms, for actions the developer layers need -------------------------------

def problem(c):           # warning triangle with a bang: an error worth stopping for
    c.line(32, 3, 52, 28, 3); c.line(52, 28, 12, 28, 3); c.line(12, 28, 32, 3, 3)
    c.rect(30, 12, 33, 21); c.rect(30, 23, 33, 26)

def diff(c):              # plus over minus: something changed, in both directions
    c.rect(22, 8, 42, 11); c.rect(30, 3, 34, 16)
    c.rect(22, 22, 42, 25)

def check(c):             # accept
    c.line(14, 17, 26, 27, 5); c.line(26, 27, 50, 5, 5)

def cross(c):             # reject
    c.line(18, 5, 46, 27, 5); c.line(46, 5, 18, 27, 5)

def sparkle(c):           # the agent
    c.poly([(32, 1), (36, 12), (47, 16), (36, 20), (32, 31), (28, 20), (17, 16), (28, 12)])
    c.poly([(52, 3), (54, 8), (59, 10), (54, 12), (52, 17), (50, 12), (45, 10), (50, 8)])

def listing(c):           # output, a log, a diff summary
    for i, (x0, x1) in enumerate([(13, 51), (13, 43), (13, 51), (13, 37)]):
        c.rect(x0, 4 + i * 7, x1, 7 + i * 7)

def terminal(c):          # an interactive shell
    c.line(14, 8, 25, 16, 3); c.line(25, 16, 14, 24, 3)
    c.rect(30, 21, 50, 24)

def branch(c):            # git
    c.ring(17, 6, 5, 3); c.ring(17, 26, 5, 3); c.ring(46, 16, 5, 3)
    c.rect(15, 10, 19, 23)
    c.rect(17, 14, 42, 17)

def push(c):              # send it somewhere
    c.rect(12, 2, 52, 6)
    c.poly([(32, 9), (46, 22), (18, 22)])
    c.rect(28, 21, 36, 31)

def devtools(c):          # </> -- inspect the page
    c.line(19, 7, 9, 16, 3); c.line(9, 16, 19, 25, 3)
    c.line(45, 7, 55, 16, 3); c.line(55, 16, 45, 25, 3)
    c.line(38, 5, 26, 27, 3)

def console(c):           # the browser console: a framed prompt
    c.frame(6, 3, 57, 28, 3)
    c.line(14, 10, 21, 16, 3); c.line(21, 16, 14, 22, 3)
    c.rect(27, 19, 47, 22)

def context(c):           # what the system currently believes
    c.ring(32, 16, 14, 3); c.disc(32, 16, 5)

def more(c):              # another page of actions
    for x in (14, 32, 50):
        c.disc(x, 16, 5)


# Which pictogram stands for which backend action. This lives in the manifest rather than in
# the bridge so the cap and the label can never come from different tables. Actions with no
# dedicated glyph borrow the nearest honest one; an unknown action falls back to six_idle,
# which reads as "nothing here" rather than as a wrong instruction.
ACTION_ICONS = {
    'run_tests': 'six_run', 'tests_stop': 'six_stop', 'test_output': 'six_list',
    'git_diff': 'six_diff', 'git_log': 'six_branch', 'view_context': 'six_context',
    'agent_launch': 'six_sparkle', 'agent_back': 'six_back', 'editor_agent_focus': 'six_sparkle',
    'editor_open': 'six_files', 'editor_diff': 'six_diff', 'editor_problem': 'six_problem',
    'editor_problems': 'six_problem', 'editor_terminal': 'six_terminal',
    'editor_test_output': 'six_list', 'editor_focus': 'six_overview',
    'more': 'six_more', 'back': 'six_back',
    'app_vscode': 'six_devtools', 'app_codex': 'six_sparkle', 'app_claude': 'six_sparkle',
    'app_chrome': 'six_console', 'app_terminal': 'six_terminal', 'app_finder': 'six_files',
    'voice_start': 'six_sparkle', 'voice_starting': 'six_refresh', 'voice_stop': 'six_stop',
    'voice_transcribing': 'six_refresh', 'voice_cancel': 'six_cross', 'voice_insert': 'six_check',
    'voice_review': 'six_list', 'voice_retry': 'six_refresh',
    # Layers still to be built. Named now so the bridge needs no change when they land.
    'browser_console': 'six_console', 'browser_reload': 'six_refresh', 'browser_network': 'six_devtools',
    'agent_ask_error': 'six_sparkle', 'agent_revert': 'six_cross', 'agent_accept': 'six_check',
    'git_stage': 'six_check', 'git_commit': 'six_branch', 'git_push': 'six_push',
}

NEW_ICONS = {
    'six_problem': problem, 'six_diff': diff, 'six_check': check, 'six_cross': cross,
    'six_sparkle': sparkle, 'six_list': listing, 'six_terminal': terminal,
    'six_branch': branch, 'six_push': push, 'six_devtools': devtools,
    'six_console': console, 'six_context': context, 'six_more': more,
}


def read_existing() -> tuple[dict[str, list[int]], list[str], list[list[str]]]:
    """Recover the shipping bitmaps and profile table so neither can regress."""
    source = HEADER.read_text(encoding='utf-8')
    bitmaps, order = {}, []
    for match in re.finditer(r'static const uint8_t (\w+)\[256\]\s*=\s*\{([^}]*)\}', source):
        name = match.group(1)
        values = [int(v) for v in match.group(2).split(',') if v.strip()]
        if len(values) != 256:
            raise SystemExit(f'{name}: expected 256 bytes, found {len(values)}')
        bitmaps[name] = values
        order.append(name)
    table = re.search(r'sixProfiles\[6\]\[6\]\s*=\s*\{(.*?)\};', source, re.S)
    profiles = [[n.strip() for n in row.split(',')] for row in re.findall(r'\{([^{}]*)\}', table.group(1))]
    return bitmaps, order, profiles


def render(name: str, bitmap: list[int]) -> str:
    body = ','.join(str(b) for b in bitmap)
    return f'static const uint8_t {name}[256] = {{{body}}};'


def main() -> None:
    bitmaps, order, profiles = read_existing()
    for name, fn in NEW_ICONS.items():
        if name not in bitmaps:
            order.append(name)
        bitmaps[name] = draw(fn)

    ids = {name: index for index, name in enumerate(order)}
    missing = sorted({icon for icon in ACTION_ICONS.values() if icon not in ids})
    if missing:
        raise SystemExit(f'ACTION_ICONS references icons that do not exist: {missing}')

    lines = [
        '// Generated by tools/generate_six_icons.py -- do not edit by hand.',
        '//',
        '// The first entries are the original pictograms, preserved byte for byte. The rest are',
        '// drawn by the generator for the developer action layers. sixIcons indexes every one of',
        f'// them by id, which is what SETK6 addresses; sixProfiles stays as the six fixed app layouts.',
        '#pragma once',
        '#include <stdint.h>',
        '',
    ]
    lines += [render(name, bitmaps[name]) for name in order]
    lines.append('')
    lines.append(f'static const uint8_t sixIconCount = {len(order)};')
    lines.append('static const uint8_t *const sixIcons[%d] = {%s};' % (len(order), ','.join(order)))
    lines.append('static const uint8_t *const sixProfiles[6][6] = {%s};'
                 % ','.join('{%s}' % ','.join(row) for row in profiles))
    # The same six app layouts as numeric ids, so SET6 can expand a profile into the per-key
    # icon array that SETK6 addresses directly. One code path draws both.
    lines.append('static const uint8_t sixProfileIcons[6][6] = {%s};'
                 % ','.join('{%s}' % ','.join(str(ids[name]) for name in row) for row in profiles))
    lines.append('')
    HEADER.write_text('\n'.join(lines), encoding='utf-8')

    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps({
        'width': WIDTH, 'height': HEIGHT, 'order': 'xbm-lsb-first',
        'icons': ids,
        'profile_names': PROFILE_NAMES,
        'profiles': [[ids[name] for name in row] for row in profiles],
        'fallback': ids['six_idle'],
        'actions': {action: ids[icon] for action, icon in sorted(ACTION_ICONS.items())},
    }, indent=2) + '\n', encoding='utf-8')

    print(f'{HEADER.relative_to(ROOT)}: {len(order)} icons ({len(NEW_ICONS)} generated)')
    print(f'{MANIFEST.relative_to(ROOT)}: manifest written')


if __name__ == '__main__':
    main()
