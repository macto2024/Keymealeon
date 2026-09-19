# Keymeleon — what we are building

Date: 2026-09-19

## The thesis

Six keys. Their functions change because the system watched what happened, not because the user selected a mode.

A macro pad is a fixed thing you have to remember. Keymeleon inverts that: the developer never configures a layout, and the keys are worth pressing precisely when the system has noticed something — a test exited nonzero, the agent stopped writing and left four files dirty, a diagnostic appeared at a file and line. At any moment there is a small set of things a developer is overwhelmingly likely to do next. Six keys is enough to cover it if, and only if, the choice is driven by observation.

Every application gets basic keys — play/pause for Spotify, new tab for Chrome, open a session with a coding agent. Those are table stakes and they are built. **The work that matters is the VS Code + Codex developer loop**, where the context is rich enough that the right next action is genuinely predictable and genuinely useful.

## The rule we hold ourselves to

A key appears enabled only when the integration behind it exists and the action will really happen.

This is the whole discipline of the project. It is easy to render a key labelled **Accept** and hard to know there is a real pending approval to accept. So a key with no integration behind it is either absent or **shown disabled with the reason it cannot fire**. The backend never claims an action succeeded because it dispatched a command; the VS Code extension acknowledges completion, and failures come back as failures. Tests are classified from the actual process exit status, and a nonzero exit without a TAP failure total is reported as a runner error, not as a failing test.

This is also why the agent lifecycle is read from the agents' own transcripts rather than inferred from terminal text: those records are the agent stating what it did.

## Situation → six keys

`U I O` on the top row, `J K L` on the bottom. `K` pages, `L` goes back. A temporary urgent state may take all six slots provided it offers an exit.

Rows marked **built** are executing today. Rows marked *planned* must not render as enabled keys until their integration lands.

| Situation, and the evidence for it | U | I | O | J | K | L | |
|---|---|---|---|---|---|---|---|
| Start or switch work — foreground app changed, no project yet | VS Code | Codex/Claude | Chrome | Terminal | More | Finder | **built** |
| Editing — editor focused, no failing run | Run Tests | Git Diff | Output | Agent in Terminal | More | Context | **built** |
| Tests running — a real runner process exists | Output | Stop Tests | Git Diff | Agent | More | Context | **built** |
| Tests failed — real nonzero exit, source unchanged since | Run Tests | Git Diff | Output | Agent | More | Context | **built** |
| Tests passed — result current, saved files match tested files | Git Diff | Run Tests | Output | Agent | More | Context | **built** |
| Agent working — its session reports a turn in flight | Focus terminal | Git Diff | Problems | Test Output | More | Context | **built** |
| Agent finished, tree dirty — turn complete + patched files + Git dirty | **Diff patched file** | Run Tests | Git Diff | Problems | More | Context | **built** |
| Agent terminal open | Focus terminal | Run/Stop Tests | Problems | Talk to Agent | More | Project Keys | **built** |
| Recording / transcript ready — real capture and transcription state | Stop & Transcribe / Insert | Cancel / Review | / Record Again | / Cancel | — | — | **built** |
| Editor error appears — new diagnostic with file and line | Go to error | Problems | Copy error + context | Ask agent about error | More | Back | *planned — 1* |
| Terminal command failed — nonzero exit observed in the agent's transcript | **Git Diff** | Rerun | Output | Ask agent to investigate | More | Back | *planned — 1* |
| Agent needs approval — a real pending request with an ID and scope | Inspect request | **Accept** | **Reject** | Ask for explanation | More | Back | *planned — 2* |
| Debugger paused — debug session reports a stopped frame | Continue | Step over | Variables | Ask about stack | More | Stop | *planned — 4* |
| Ready to record work — reviewed files, current pass, Git available | Stage reviewed | Commit | Git Log | Open PR | More | Back | *planned — 3* |

## Layer precedence

When several situations are true at once, exactly one layer wins, and it carries the reason it won so any transition can be explained.

1. **App and project scope.** Project keys only while a connected, relevant VS Code workspace is in play. Switching apps restores app-level keys.
2. **An explicit operation owns the layout.** Recording, a pending approval, a paused debugger, a running test — these hold the keys until they finish or are cancelled. A file-selection update must never displace **Stop** or **Reject**.
3. **Agent state.** Working, then finished-with-changes.
4. **Test results,** while they are still current.
5. **Ordinary editing.**

Deterministic rules come first because they are fast, explainable, and testable. A model may later rank *allowlisted* actions within a layer or suggest a semantic follow-up. It may not invent a command, and it may not enable a key whose integration does not exist.

## Milestones

### 1. Error-driven keys — the next thing to build

Today the backend already sees diagnostics (file, line, severity, message) and the agent's last shell command with its exit code. Neither drives a layer yet. This milestone turns both into keys:

- A new error diagnostic makes **Go to error** primary, jumping to the exact file and line. This is an editor diagnostic, not proof of a runtime failure, and should be labelled as such.
- A nonzero exit observed in the agent transcript raises the **terminal-failure layer** — `git diff` on `U`, rerun on `I`, the failing output on `O`. This is the "terminal hit an error, so the key becomes git diff" case, and the evidence for it is already in `context.agent.last_command.exit_code`.
- Both layers sit below any explicit operation and above ordinary editing.

Requires a decision on what makes a diagnostic *new* rather than long-standing, so the layer does not latch on a pre-existing warning.

### 2. Real Accept / Reject

The demo-worthy one, and the reason the terminal is still read-only today. The CLI runs `--sandbox read-only`, so there is nothing to approve; lifting that produces genuine approval requests. To attach **Accept** and **Reject** to a specific request we need:

- Observation of the real approval lifecycle — the request ID, what it wants to touch, and whether it is still pending.
- A path back to the CLI to answer that exact request.
- Isolation, so accepting a proposal never sweeps in unrelated working-tree edits the developer made by hand.

Until all three hold, no Accept key renders. A key that accepts the wrong thing is worse than no key.

### 3. Safe shipping actions

Stage a reviewed file set, commit, log, open a PR. Gated on an explicit review step and real result handling. Git access is read-only until this lands.

### 4. Debugger control

Continue, step, inspect — from the debug session's own reported state.

### 5. Physical hardware

`POST /api/key` already takes a numbered slot and a layout revision, which is the interface a controller will speak. A display transport for the key caps is the open piece. Protocol and pin layout get chosen once a device exists.

## Verification for each milestone

The point of building on observed state is that a demo cannot be scripted, so it can be tested adversarially: someone else introduces a failure during the demonstration and the layout responds to *that* failure. Each milestone is done when a bug nobody planned for produces the right six keys.

Current suite: 27 tests across the runtime, editor bridge, agent observer, layer resolution, keyboard dispatch, and voice lifecycle. `npm test`.

## Recorded decisions

- Six keys in a 2×3 grid, `U/I/O` over `J/K/L`. Letters fixed, labels dynamic.
- Stable roles — primary, secondary, inspect, agent, more, back — which specialized layers may repurpose.
- Deterministic ranking first. The agent does coding work; it does not need to choose the six keys.
- Read the agents' own transcripts rather than scraping terminals or driving the CLI.
- Keys are pressed against a layout revision, so a press that raced a context change is rejected with a 409 instead of firing something the user never saw.
- Native ES modules, no build step, no runtime dependencies. Typed adapters can come later without disturbing startup.
- Loopback only, origin-checked, token-gated, allowlisted action IDs. A local keyboard service should not be a local attack surface.
