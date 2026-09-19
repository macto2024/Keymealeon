# Using the backend with VS Code and the keyboard

How to get from a fresh clone to six keys that change as you work.

## The three pieces

| | What it is | Who runs it |
|---|---|---|
| **backend** — `server/` | a Node program: watches your work, decides the six keys | you — `npm start` |
| **extension** — `vscode-extension/` | a VS Code plugin: reports the editor, executes editor actions | VS Code loads it |
| **bridge** — `companion/` | a Python program: draws the keys on the keyboard, sends presses back | you — `python3 …` |

Only the backend decides anything. The extension is a sensor and a pair of hands; the bridge is a
display. Neither works out what a key should be — if they did, the keyboard and the browser would
eventually disagree, and a cap would lie about what it does.

```
  VS Code extension ─┐
  Codex session logs ┤
  Git + test process ┼──►  backend :5173  ──►  live.js decides  ──►  six actions
  Browser page       ─┘                                                   │
                                          ┌────────────────────┬──────────┘
                                     browser display      keyboard bridge
                                          └───── POST /api/key ┘
```

## Prerequisites

Node 18+, VS Code 1.85+, Python 3.8+, Git. Optionally the `codex` CLI for the agent keys.
No `npm install` — the backend has no dependencies, and neither does the bridge.

## Quick start

```sh
git clone git@github.com:macto2024/Keymealeon.git && cd Keymealeon
npm test                     # 33 pass, 0 fail
npm start                    # backend on http://127.0.0.1:5173

native/install-vscode.sh     # install the extension, then reload VS Code
code ~/some/project          # any local git repo with a test command
```

Open **http://127.0.0.1:5173** beside your editor. You should see six keys.

## Step by step

### 1. Start the backend

```sh
npm start
```

```
SIX keyboard backend: http://127.0.0.1:5173
Project: waiting for VS Code
```

It waits deliberately. With `root: null` it adopts whichever VS Code window you focus, so you can
switch projects by focusing a different window rather than editing config.

### 2. Connect VS Code

```sh
native/install-vscode.sh
```

Then **Ctrl+Shift+P → Developer: Reload Window**. Open a project folder and focus it. The status bar
should read **SIX: connected** with the project path as its tooltip.

The folder must be **local and trusted**. Remote-SSH, virtual and untrusted workspaces are declared
unsupported, so the extension will not load in them at all.

The backend should now report the project:

```sh
curl -s -H "Host: 127.0.0.1:5173" http://127.0.0.1:5173/api/context \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["context"]["project"]);print(" | ".join(k["label"] for k in d["keys"]))'
```

```
/home/you/some/project
Run Tests | Git Diff | Output | Codex in Terminal | More | Context
```

### 3. Configure the project's tests

`six.config.json`:

| Key | Meaning |
|---|---|
| `root` | project folder, or `null` to adopt the focused VS Code window |
| `command` | test command as an array — `["npm","test"]`, `["pytest"]`, `["cargo","test"]` |
| `requireForeground` | must be **`false`** on Linux; there is no foreground-app host |
| `codexModel` | model passed to the Codex CLI |
| `timeoutMs` | test-run timeout, default 60000 |

Restart the backend after editing. If `command` is `null`, Run Tests stays disabled **with that as
its reason** rather than silently doing nothing.

The runner is TAP-aware. Exit zero is a pass; a nonzero exit **with** a TAP failure total is failing
tests; any other nonzero exit is reported as a runner error rather than mislabelled as a failure.
`node --test` emits TAP automatically when not attached to a terminal.

### 4. Pick a display

**Browser** — already running at `http://127.0.0.1:5173`. Shows labels and the reason the current
layer won, which the 64×32 caps cannot.

**Terminal** — the caps as pictograms, no hardware:

```sh
python3 companion/keymaeleon_bridge.py --simulate
```

```
  ┌────────────┬────────────┬────────────┐
  │    run     │    diff    │    list    │
  │  sparkle   │    more    │  context   │
  └────────────┴────────────┴────────────┘
```

**Real keyboard** — see below.

## Use it

Letters never move. Labels do.

```
U — primary     I — secondary     O — inspect
J — agent       K — more          L — back
```

| What you do | What the keys become |
|---|---|
| Editing | `Run Tests · Git Diff · Output · Codex in Terminal · More · Context` |
| Type without saving | **`U` dims** — *"Save your VS Code files before running tests."* |
| Press **U** | tests run; `Output · Stop Tests · …` |
| Tests fail | reason: *"Tests failed with exit 1"* |
| Edit and save after a run | reason: *"Source changed since the last test run"* — the result went stale |
| Press **J** | Codex opens in a `SIX Codex` terminal |
| Codex is working | reason: *"Codex is working on: \<your request\>"* |
| Codex finishes with edits | **`U` becomes a diff of the exact file it patched** |
| Press **K** | more actions; **L** goes back |

A key that cannot fire keeps its slot and shows **why**. It is never hidden and never silently dead.

The two worth watching are the dimmed key and the post-Codex review. The first proves the backend is
reading real editor state; the second is read from Codex's own session transcript in
`~/.codex/sessions/` — nothing polls the CLI, it reports on itself.

## With the real keyboard

Connecting it is not enough — the device must be running the regenerated firmware.

```sh
python3 tools/generate_six_icons.py     # rewrites Icons6.h and assets/icons_6.json
```

Open `ESP32 Firmware/Keymaeleon6/Keymaeleon6.ino` in Arduino IDE (Board: **Arduino Nano ESP32**,
Normal mode (TinyUSB)), keep `Wave.h`, `IsolatedDisplay.h` and `Icons6.h` beside it, and upload.

```sh
sudo usermod -aG dialout $USER          # once, then log out and back in
python3 companion/keymaeleon_bridge.py --port /dev/ttyACM0
```

Check in this order, since each depends on the last:

1. Serial Monitor at 115200: send `HELLO` → the reply must contain **`COMPANION_2`**
2. Send `SETK6 1 4 22 26 25 33 32` by hand → six caps change
3. Start the bridge → caps track the backend
4. Press a key → the backend acts and the layout changes

Steps 1 and 2 need no bridge. If they work, the hard part is done.

The bridge refuses to run against older firmware rather than showing wrong caps.

**None of this has run on real hardware yet.** The whole path is verified against a simulated
firmware over a pseudo-terminal, which exercises the same code, but not I²C, the displays or the
wave animation.

## Testing without any hardware

```sh
python3 companion/fake_firmware.py --press 4 --after 2    # press K, watch the layout change
python3 companion/fake_firmware.py --press 0 --stale      # a stale press is refused
```

The second one demonstrates the safety property. The firmware reports the revision the cap was
*actually showing*; the bridge passes it to `POST /api/key`; if the context moved in between the
backend answers **409** and nothing fires. You press what you saw, or nothing happens.

## Troubleshooting

- **"waiting for VS Code" forever** — the extension is not connected. Hover the VS Code status bar,
  or open Output → **SIX**.
- **"Focus a VS Code project window to select it"** — set `requireForeground: false`. On Linux
  nothing reports which app is focused, so the bridge cannot satisfy that check.
- **"Open this project folder in VS Code: /path"** — the backend adopted a different folder. Open
  that one, or restart the backend.
- **Run Tests always disabled** — either `command` is `null`, or you have unsaved files. The key
  says which.
- **Git keys disabled** — the folder must be a git repository **root**, not a subdirectory.
- **Keys never change** — check the browser display first. If it moves and the keyboard does not,
  the problem is the bridge or the firmware, not the backend.
- **Serial will not open** — you are not in `dialout` yet, or you have not logged out since.

## Not built yet

So you know what you are looking at:

- **The keys do not react to browser errors.** `demo/` reports them and they reach
  `context.browser`, but `live.js` does not read that field, so the layer never changes.
- **A disabled key looks normal on the caps.** `SETK6` carries icons only, with no dim state, so
  the most convincing behaviour in the system is invisible on the hardware.
- **No Accept / Reject.** The agent CLI runs `--sandbox read-only`, so there is no real approval to
  accept. See milestone 2 in [PLAN.md](PLAN.md).
- **No commit, stage or push.** Git access is strictly read-only.

See [PLAN.md](PLAN.md) for the build order, [DEMO.md](DEMO.md) for the demo script,
[vscode-extension/README.md](vscode-extension/README.md) for the extension, and
[companion/README.md](companion/README.md) for the serial protocol.
