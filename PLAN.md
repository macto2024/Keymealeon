# Keymaeleon — build plan

Date: 2026-09-19
Target: the 3:30 demo in [DEMO.md](DEMO.md), on macOS. Hardware connection is deferred.

## What already exists

Before planning anything, the honest inventory. Most of the pipeline is built.

| Piece | Where | State |
|---|---|---|
| VS Code context source | `vscode-extension/extension.cjs` | **Works.** Reports active file, language, selection, unsaved count, diagnostics with file/line/severity, window focus, terminal state |
| Editor command execution | same | **Works.** Opens files, diffs, terminals, Problems, Git; runs the agent CLI; **inserts text into the agent terminal** |
| Decision logic | `live.js` | **Works.** Resolves one layer per context, with the reason it won and per-key disabled reasons |
| Context aggregation | `server/runtime.js` | **Works.** Git state, content fingerprinting, real test process with TAP-aware classification |
| Agent lifecycle | `server/agents.js` | **Works.** Tails Codex/Claude session transcripts: working vs. finished, patched files, last command exit code |
| Editor bridge | `server/editor.js` | **Works.** Heartbeat, command queue, acknowledgement, path confinement |
| Six-key display | `index.html`, `app.js`, `style.css` | **Works.** Renders the caps, streams events, posts presses |
| Tests | `test/` | 27 passing |
| Firmware | `ESP32 Firmware/Keymaeleon6/` | **Works on hardware.** Dual-bus I²C, six OLEDs, wave animation, `SET6`/`PRESS6` protocol |
| Serial companion | `ESP32 Firmware/Keymaeleon6/keymaeleon_6.py` | **Cannot run.** Missing `keymaeleon.py` and `assets/icons_6.json`; Ubuntu X11 only |

So the demo does not need a VS Code extension written, and it does not need the key-selection logic written. Both exist.

## The correction worth making

The instinct was "write the VS Code extension and a Python program that shows the right keys." Two things to adjust:

**The extension is written.** It needs two small additions (below), not a build.

**The Python program's only unique job is the hardware.** Icons and serial. Everything upstream of that — context, decisions, labels — already exists in the Node backend, and there is already a display client rendering six keys. Writing Python now means maintaining a second display surface and a second copy of the decision logic, and they will drift.

Since hardware is deferred, **Python is deferred with it.** When it arrives it should not re-derive anything: it subscribes to the backend's existing event stream and posts presses back to the existing endpoint.

## Architecture

One brain. Many sources. Interchangeable displays.

```
  VS Code extension  ─┐
  Codex session logs ─┤
  Git + test process ─┼──►  Node backend  ──► live.js  ──►  six actions
  Browser error hook ─┤       (:5173)                          │
  Foreground app     ─┘                                        │
                                          ┌──────────────┬─────┴────────┐
                                     browser client   Python+serial   (future
                                      (today)          (later)        hardware)
                                          └──────────────┴──────────────┘
                                                   POST /api/key
```

The contract between the brain and any display is the API that already exists: `GET /api/events` for the stream, `POST /api/key` with `{slot, revision}` for a press. The Python companion becomes a *client* of that, not a parallel implementation. Its `Controller` class already has the right discipline — revision bumping, stale-press rejection — so it ports rather than rewrites.

## Build order

Sequenced so the demo is rehearsable as early as possible, and each step leaves something demonstrable.

### 1. The demo app — the thing on screen

A minimal checkout page with the real bug: formatter takes `price.toFixed()`, the test passes a number, the API returns a string. Needs a passing test, a failing test, and a visible `$NaN`.

This is first because every other step needs something to point at, and because the bug has to be genuinely reproducible or the demo is theatre.

### 2. Browser error reporting — makes the wall real

A `window.onerror` hook in the demo app that POSTs to a new `/api/browser/error` endpoint, the way a Sentry SDK would. Roughly thirty lines, plus a `browser` field on the context.

Highest value per line in the whole project. It converts the 2:00 and 2:25 beats from scripted to real, and it is the concrete evidence for the claim that the keyboard sees more than the agent does.

### 3. Two new layers in `live.js`

- **Browser error, tests passing** — the wall. `Console · Revert Codex · View Diff · Ask Codex + error · More · Back`. Wins over the ordinary editing layer, sits below any explicit operation.
- **Tests failed** already exists; the new one is that a *browser* error outranks green tests, because green tests plus a broken page is a more urgent fact than either alone.

Layer precedence stays as it is otherwise. Both layers get tests, like the existing ones.

### 4. `Ask Codex with this error` — the key that justifies the project

The promise: the key carries the error into the prompt and the human never copy-pastes.

The mechanism already exists — `editor_agent_insert` inserts text into the agent terminal without pressing Enter, so the developer still reads it before sending. What is new is composing the prompt from context: the console error, the file, and the failing test. One new action ID, one composer, no new extension command.

Two small extension additions support this and the rest of the run:

- report the dev-server/agent terminal state needed to decide the key is available,
- a revert command for `I — Revert Codex`, scoped to exactly the files the agent patched.

### 5. Scene runner — the safety net

A script that replays the nine beats as context patches through the real `live.js`, so the whole run can be rehearsed without VS Code, Codex, or a network. Also the fallback if something dies on stage.

It is a fallback, not the plan. The difference matters: the beats it replays are the same contexts the live system produces.

### 6. Rehearse

Full run twice without a reset. Time each beat against the sheet.

## Deferred to hardware

Not needed for the demo, and cheaper once the above is settled.

- **Icon generator.** Rewrite the missing `tools/generate_six_icons.py`, emitting `Icons6.h` plus `assets/icons_6.json`. Preserve the 20 existing bitmaps byte-for-byte; add roughly thirteen for the developer actions (problem, diff, check, cross, sparkle, list, terminal, branch, push, devtools, console, context, more). Format is confirmed: 64×32, 8 bytes per row, LSB-first.
- **Firmware `SETK6 <revision> <i0>…<i5>`.** Per-key icon IDs alongside the existing `SET6` profile command, which keeps working. A parser addition and an indirection in the draw call; mailboxes, wave animation and bus isolation untouched. `HELLO` gains a `COMPANION_2` token so a host can tell the firmwares apart.
- **Python companion, rewritten as a backend client.** Subscribe to `/api/events`, map action IDs to icon IDs via the generated manifest, drive serial, post presses to `/api/key`. Port `Controller`'s revision and sequence discipline as-is. Keep the Tkinter simulator — it previews real pictograms and waves without hardware.
- **macOS action layer.** The existing companion shells out to `xdotool`, `pactl`, `playerctl`, `nautilus`. On macOS these become AppleScript and media-key events.
- **`keymaeleon.py`.** Missing, and imported by `keymaeleon_6.py`. Ask Michael whether it exists elsewhere before rewriting; its `Focus` and `classify` are worth reading even though the X11 parts get replaced.

## Integration milestones, after the demo

What "make it actually work" means. None of this blocks the demo.

1. **Error-driven keys, live.** Diagnostics and `context.agent.last_command.exit_code` are already observed and published but drive no layer. Smallest real win available.
2. **Real Accept / Reject.** Needs the approval request's ID and scope, a path back to answer that specific request, and isolation from unrelated hand edits. Until all three hold, no Accept key renders outside a staged beat — a key that accepts the wrong thing is worse than no key.
3. **Safe shipping actions.** Stage, commit, log, PR, behind explicit review. Git access is read-only until then.
4. **Foreground-app profiles.** The Spotify/Chrome/Terminal profiles already in `Icons6.h`, driven by real app detection rather than a beat.

## Housekeeping

- **Restore the technical README.** `f968bb6` replaced it with the hackathon narrative. The API reference, configuration table and observation sources are recoverable from `git show 7d660ce:README.md` — restore as `BACKEND.md`, leave the narrative at the root.
- The duplicate root `Keymaeleon6/` was removed upstream in `7f09486`. Resolved.

## Recorded decisions

- Six keys, 2×3, `U/I/O` over `J/K/L`. Letters fixed, labels and icons dynamic.
- Deterministic ranking first. The agent does coding work; it does not choose the six keys.
- A key appears enabled only when the integration behind it exists and the action will really happen. Everything else is disabled **with its reason**, or staged and declared out loud.
- Read the agents' own transcripts rather than scraping terminals or driving the CLI.
- Presses carry the layout revision they were drawn from, so a press that raced a context change is rejected rather than firing what replaced it. `POST /api/key` and the firmware's `PRESS6` already agree on this.
- One brain, many displays. A display never re-derives which keys to show.
- Demo runs on macOS. The firmware's original Ubuntu X11 path is not it.
