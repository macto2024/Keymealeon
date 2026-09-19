# Keymaeleon — demo plan

Date: 2026-09-19
Target: a physical six-key keyboard whose caps visibly change through a web-development session, driven from macOS over USB serial.

## What we are optimising for

A viable demo, not a finished product. The goal is that someone watches a developer work for two minutes and sees the keys change *with the work*, on real hardware, without the presenter touching a mode switch.

That means we deliberately do **not** try to make the whole pipeline live on stage. Live VS Code, live Codex and a live test runner all have to succeed within a two-minute window, over conference wifi, with CLI auth intact. One failure and there is no demo.

Instead: **scripted beats, real layout engine.**

- A scene runner advances through the story on the presenter's cue. Each beat is deterministic and cannot fail.
- Each beat constructs a real `context` object and feeds it to the **actual `live.js` resolver** already in this repo. The six keys that appear are genuinely the ones the system would pick from that state — not hand-drawn mockups.
- The keyboard is real. The serial link is real. The icons on the caps are real.

So when a judge asks *"how did it decide that?"*, the answer is a function they can read, and the honest caveat is *"the events are staged; the decision is not."* That is a much better position than either a pure mockup or a live demo that died.

## The scene: a web developer fixing a checkout bug

Twelve beats. The presenter advances with a keypress — ideally a press on the keyboard itself, so even the advance is diegetic.

| # | What the developer is doing | U | I | O | J | K | L |
|---|---|---|---|---|---|---|---|
| 1 | Previewing the app in the browser | Reload | DevTools | Console | Next Tab | More | Desktop |
| 2 | Switches to VS Code, opens `CheckoutForm.tsx` | Run Tests | Git Diff | Output | Codex in Terminal | More | Context |
| 3 | Types an edit, doesn't save | ~~Run Tests~~ | Git Diff | Output | Codex | More | Context |
| 4 | Saves — a type error appears | Go to Error | Problems | Copy Error | Ask Codex about error | More | Back |
| 5 | Fixes the type, runs tests | Output | Stop Tests | Git Diff | Focus Codex | More | Context |
| 6 | A test fails | First Failure | Test Output | Rerun | Ask Codex to investigate | More | Back |
| 7 | Asks Codex — it starts working | Focus Terminal | Git Diff | Problems | Test Output | More | Context |
| 8 | Codex proposes a change | Inspect Request | **Accept** | **Reject** | Explain | More | Back |
| 9 | Accepted; two files now dirty | Diff `CheckoutForm.tsx` | Run Tests | Git Diff | Problems | More | Context |
| 10 | Tests pass | Git Diff | Run Tests | Output | Codex | More | Context |
| 11 | Ready to commit | Stage | Commit | Git Log | Push | More | Back |
| 12 | Back to the browser to verify | Reload | DevTools | Console | Next Tab | More | Desktop |

Beat 3 is the one to not cut. `U` goes **dim** with the reason *"Save your VS Code files before running tests."* A key that refuses to fire, and says why, is the most convincing thing in the whole run — it is the opposite of a mockup, which never has a reason to say no.

Beats 4, 6, 8 and 11 are the arc: an error appears and the keys become about the error; a test fails and they become about the failure; an agent proposes and they become Accept/Reject; the work is done and they become Git. Nobody pressed a mode button.

### Honesty inside the demo

Beats 8 and 11 use actions the backend **cannot execute today** — real approval handling is milestone 2 and commit/push is milestone 3 (below). In the demo they display and animate, but they are staged.

We say so, once, in the talk track: *"Accept and Reject are the next integration; everything up to here reads real state."* Claiming otherwise is the one thing that turns a good demo into a bad one when someone asks a follow-up question.

The scene runner marks staged beats in its own output so we never lose track of which is which.

## What has to be built

### 1. Firmware: per-key icons

Today `SET6 <revision> <profile>` selects one of six fixed profiles (`Icons6.h`, `sixProfiles[6][6]`). That is enough for Spotify or Chrome, where the six keys never change. It cannot express beat 6, where the keys are a one-off combination.

Add a second command alongside it, keeping `SET6` working:

```
SETK6 <revision> <i0> <i1> <i2> <i3> <i4> <i5>
```

Six icon IDs indexing a flat icon table, plus a dim flag for unavailable keys. Existing revision handling, mailboxes, wave animation and bus isolation stay exactly as they are — this is a parser addition and an indirection in the draw call, not a rework.

`HELLO` should then report a new capability token (`COMPANION_2`) so a host can tell which firmware it is talking to.

### 2. Icons

The scene needs roughly thirteen glyphs that do not exist yet: problem, diff, check, cross, sparkle (agent), list/output, terminal, branch, push, devtools, console, context, and the More/Back arrows.

`tools/generate_six_icons.py` is referenced by the firmware README but **is not in the repo**, so `Icons6.h` currently cannot be regenerated. We rewrite it: a small script that renders 64×32 1-bit XBM byte arrays and emits `Icons6.h` plus a JSON manifest the host reads to map action ID → icon ID. Keeping host and firmware on one generated manifest is what stops the two drifting.

### 3. Scene runner

A Node script in this repo that:

- holds the twelve beats as context patches over a base context,
- calls the existing `resolveLayer` / `liveLayout` from `live.js` to get the six actions,
- maps each action ID to an icon ID via the generated manifest,
- writes `SETK6` over the serial port and re-sends every 500 ms as the firmware expects,
- reads `PRESS6` so a press on the physical keyboard advances the scene,
- drives the existing browser display client in parallel, so the laptop screen shows the **labels and the layer's reason** while the caps show icons.

That last point matters: the caps are 64×32 and cannot show "Codex finished and changed 2 files". The screen carries the words, the keyboard carries the actions, and together they explain themselves.

### 4. Serial transport

macOS, USB CDC at 115200. The backend currently has no serial dependency and no npm dependencies at all; a serial link needs either one small package or a minimal file-descriptor write to `/dev/cu.usbmodem*`. Prefer the latter if it holds, to keep `npm install` unnecessary.

## Order of work

1. **Icon generator + expanded `Icons6.h`.** Everything else depends on the manifest existing. Nothing else can be finished first.
2. **Firmware `SETK6`.** Small, testable over Serial Monitor alone, before any host exists.
3. **Serial bridge + scene runner with two beats.** Proves the whole path end to end on real hardware.
4. **Remaining ten beats.** Cheap once the path works — each is a context patch.
5. **Talk track and a rehearsal that runs the full scene twice without a reset.**

Steps 1–3 are the risk. Steps 4–5 are volume.

## Housekeeping, before anything else

Three things in the repo will cost time if left:

- **`Keymaeleon6/` at the repo root is stale and will not compile.** It is 411 lines against 447 in `ESP32 Firmware/Keymaeleon6/`, and it does not include `Icons6.h` — the file that defines `sixProfiles`. `Icons6.h` is not even present in that folder. Delete it so there is one firmware source of truth.
- **The technical backend README was overwritten** by the hackathon narrative in `f968bb6`. The API reference, configuration table and observation sources are still recoverable from `git show 7d660ce:README.md`. Restore them as `BACKEND.md` and leave the narrative as the root `README.md`.
- **Files the firmware README references are missing:** `companion/keymaeleon_6.py`, `tools/generate_six_icons.py`, `assets/icons_6.json`, `docs/wiring-six-key.png`/`.svg`, `docs/validation.md`. The Python companion executed all the X11 actions, so without it the static profiles are **icons only — no key does anything**. Confirm whether it exists elsewhere before rewriting it; on macOS it would need rewriting regardless.

## What already works, and is worth keeping

The backend in this repo is not scaffolding. It observes real state today, and the scene runner reuses the part that matters:

| Capability | Where |
|---|---|
| Layer resolution, disabled keys with reasons | `live.js` — **the scene runner's engine** |
| Codex/Claude lifecycle from their own session transcripts | `server/agents.js` |
| Git state, content fingerprinting, real test process with TAP-aware classification | `server/runtime.js` |
| VS Code context: active file, diagnostics, unsaved count, focus | `server/editor.js` + `vscode-extension/` |
| Display client | `index.html`, `app.js`, `style.css` |
| 27 passing tests over the above | `test/` |

The post-agent review layer (beat 9) is fully real today: `server/agents.js` tails `~/.codex/sessions/**/rollout-*.jsonl`, and when a turn completes with a dirty tree, `U` becomes a diff of the exact file Codex patched. If anything in the demo can afford to be live, it is that one — and it is the most impressive beat.

## Integration milestones, after the demo

These are what "make it actually work" means, in order. Nothing here blocks the demo.

1. **Error-driven keys.** Diagnostics and `context.agent.last_command.exit_code` are already observed and published; neither drives a layer yet. This is beats 4 and 6 becoming real, and it is the smallest real win available.
2. **Real Accept / Reject.** Beat 8. Needs the approval request's ID and scope, a path back to answer that specific request, and isolation from unrelated hand edits. Until all three hold, no Accept key renders outside the staged demo — a key that accepts the wrong thing is worse than no key.
3. **Safe shipping actions.** Beat 11. Stage, commit, log, PR, behind an explicit review step. Git access is read-only until then.
4. **Host ↔ firmware convergence.** One host process feeding both the display client and the keyboard, so the demo path and the real path stop being separate code.
5. **Profiles for unowned apps.** The Spotify/Chrome/Terminal static profiles already in `Icons6.h`, driven by real foreground-app detection rather than a scene beat.

## Recorded decisions

- Six keys, 2×3, `U/I/O` over `J/K/L`. Letters fixed, labels and icons dynamic.
- Deterministic ranking first. The agent does coding work; it does not choose the six keys.
- A key appears enabled only when the integration behind it exists and the action will really happen. Everything else is disabled **with its reason**, or staged and declared.
- Read the agents' own transcripts rather than scraping terminals or driving the CLI.
- Presses carry the layout revision they were drawn from, so a press that raced a context change is rejected rather than firing what replaced it. The firmware's `PRESS6` already works this way; so does `POST /api/key`.
- Demo runs on macOS. The firmware's original Ubuntu X11 companion is not the path.
- Host and firmware share one generated icon manifest, so the caps and the labels can never disagree.
