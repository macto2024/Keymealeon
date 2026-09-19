# Keymeleon — backend

Six mechanical keys whose functions change with what the developer is actually doing.

This repository holds the **backend**: the service that observes real developer state, decides which six actions are most likely useful right now, and executes the one that gets pressed. It ships with the two programs that feed it context — a VS Code extension and a macOS foreground-app host. The physical keyboard and the key display are not in this repository.

The central bet is that a six-key surface is only worth having if the keys are *right*, and keys are only right if the system knows what just happened. So this backend does not guess from a script. It reads the working tree, the editor's diagnostics, the exit status of a real test process, and the coding agent's own session transcript, and it derives the layout from those facts.

> The project is named Keymeleon; the code, the LaunchAgent label, and the VS Code command namespace still use the earlier internal name `SIX` (`com.six.keyboard`, `six.connect`, `six.config.json`). Renaming those would break the installed agent and the extension's published command IDs, so they are left alone.

## The six keys

```
U — primary     I — secondary     O — inspect
J — agent       K — more          L — back / apps
```

Letters stay fixed. Labels change. `K` pages through additional actions; `L` returns to the previous useful layer.

## What the backend actually observes

| Source | File | What it yields |
|---|---|---|
| VS Code | `server/editor.js` | Active file, language, selection size, **unsaved-file count**, diagnostics with file+line, which window is focused, which SIX terminals are open |
| Coding agent | `server/agents.js` | Whether Codex or Claude is **working or finished**, the last request, the last shell command and its exit code, and **which files it patched** |
| Project + Git | `server/runtime.js` | Recursive content fingerprint (staleness), branch, dirty state, per-file status, untracked vs. tracked |
| Test process | `server/runtime.js` | A real spawned process: live output, exit code, TAP failure totals, cancellation, timeout |
| Foreground app | `native/SixHost.m` | Which macOS application has focus, by bundle ID |
| Microphone | `server/voice.js` | Local FFmpeg capture → local Whisper transcription, with an explicit review step |

The agent observer is the unusual one. Rather than scraping a terminal or driving the CLI, it tails the transcripts the agents write for themselves — `~/.codex/sessions/**/rollout-*.jsonl` and `~/.claude/projects/<slug>/*.jsonl` — and reduces them to a lifecycle. Everything it reports is something the agent stated about itself. It also counts recent sessions per project to learn which agent this developer actually uses, and offers that one on `J`.

## What the keys become

`live.js` resolves exactly one layer, and carries the reason it won. Current behavior:

| Observed situation | U | I | O | J | K | L |
|---|---|---|---|---|---|---|
| No project yet, some other app focused | VS Code | Codex / Claude | Chrome | Terminal | More | Finder |
| Editing a connected project | Run Tests | Git Diff | Output | Agent in Terminal | More | Context |
| **Agent is working** | Focus its terminal | Git Diff | Problems | Test Output | More | Context |
| **Agent finished and the tree is dirty** | **Diff the file it patched** | Run Tests | Git Diff | Problems | More | Context |
| Tests running | Output | Stop Tests | Git Diff | Agent in Terminal | More | Context |
| Tests failed | Run Tests | Git Diff | Output | Agent in Terminal | More | Context |
| Agent terminal is open | Focus terminal | Run / Stop Tests | Problems | Talk to Agent | More | Project Keys |
| Recording speech | Stop & Transcribe | Cancel | — | — | — | — |
| Transcript ready | Insert in Terminal | Review Text | Record Again | Cancel | — | — |

A key that cannot work is shown **disabled with the reason**, never hidden and never silently dead: *"Save your VS Code files before running tests."*, *"The selected project has no usable Git repository."*, *"Reload the SIX VS Code extension to enable this key."*

The post-agent review layer is the one to watch in a demo. Ask Codex for a change; while it works, `U` follows its terminal. The moment its transcript reports the turn complete and Git sees a dirty tree, `U` becomes a diff of the exact file it touched and `I` becomes Run Tests. Nobody pressed a mode button.

## Run it

Node 18+. No dependencies to install.

```sh
npm start     # backend on http://127.0.0.1:5173
npm test      # 27 tests: runtime, editor bridge, agent observer, layers, keyboard, voice
```

On macOS, to run it as a login service with foreground-app tracking, and to install the VS Code extension:

```sh
native/install-macos.sh
native/install-vscode.sh
```

Reload VS Code once after installing. `native/uninstall-macos.sh` stops the login launch.

With no project configured, the backend waits. Focus a VS Code window and the extension offers that workspace; the backend adopts it and the keys switch from app-launch to project actions.

### Configuration — `six.config.json`

| Key | Meaning |
|---|---|
| `root` | Project directory, or `null` to adopt the first focused VS Code workspace |
| `command` | Test command as an executable/argument array, e.g. `["npm","test"]`. `null` disables the test keys with a reason |
| `requireForeground` | Require a focused VS Code window before adopting a workspace |
| `codexModel` | Model passed to the Codex CLI |
| `timeoutMs` | Test-run timeout, default 60000 |

`SIX_CONFIG=/abs/path.json npm start` selects another config; `PORT=5174` changes the port. Restart after editing.

The bundled test runner expects TAP (`node --test --test-reporter=tap`). Exit zero is a pass; a nonzero exit **with** a TAP failure total is a test failure; any other nonzero exit is reported as a runner error rather than mislabelled as a failing test. Other formats need an adapter before that distinction holds.

## API

Loopback only. `Host` and `Origin` are validated, `sec-fetch-site: cross-site` is rejected, and every POST requires the per-process session token from `GET /api/context`.

| Endpoint | Purpose |
|---|---|
| `GET /api/context` | Current context snapshot + session token |
| `GET /api/events` | Server-sent events; one message per context revision |
| `GET /api/health` | Liveness + selected project |
| `POST /api/key` | Press slot 0–5 against a `layout_revision` |
| `POST /api/action` | Invoke an action by ID against a `revision` |
| `POST /api/system/context` | Foreground-app report from the native host |
| `POST /api/editor/context` | Editor heartbeat from the extension; returns queued commands |
| `POST /api/editor/ack` | Extension acknowledges a command completed or failed |
| `POST /api/surface/focus` | Display-client focus, so a browser-hosted display doesn't read as "Chrome focused" |

Presses carry the layout revision they were drawn from. If the context moved between render and press, the backend returns **409** rather than firing the action the user no longer sees. Action IDs are matched against an allowlist; the client never supplies a command.

## Deliberate limits

- **No display client in this repository.** The backend serves `/`, `/app.js`, `/style.css` from disk if present, and `live.js` so a client can render the same layer the backend resolved. With none installed, `/` returns a 404 explaining that and the API keeps working — so the macOS monitor's WebView will be blank until a display is added.
- **No physical hardware yet.** `POST /api/key` already takes a numbered slot, which is the interface a controller will use.
- **The agent terminal is read-only** and the CLI's approval requests are not yet observed, so there is no genuine Accept/Reject key. See [PLAN.md](PLAN.md), milestone 2.
- **No commit, stage, or push.** Git access is strictly read-only; nothing here stages, commits, pushes, or invokes an external diff tool.
- The native host is **macOS-only**. The backend and extension are not.
- The file watcher polls once per second, hashes file contents, skips symlinks and generated folders, and refuses projects over 10,000 files. Fine for a laptop project; a large repository needs a real watcher.
- One project and one test process at a time. Backend restarts reset run history.
- Voice transcription runs locally through FFmpeg and Whisper and requires both on `PATH`. A transcript is never sent anywhere on its own — it is inserted into the terminal **without** pressing Enter, so the developer reads it first.

## Layout

```
server/index.js     HTTP surface, origin/token checks, SSE fan-out, action routing
server/runtime.js   Context ownership, Git reads, fingerprinting, test process lifecycle
server/editor.js    VS Code session bridge: heartbeat, command queue, path confinement
server/agents.js    Codex/Claude transcript observation → agent lifecycle facts
server/voice.js     FFmpeg capture → Whisper transcription → explicit review
live.js             Layer resolution: situation → six keys, with reasons and disabled states
vscode-extension/   Editor context source and command executor
native/             macOS foreground-app host, LaunchAgent installer, build scripts
test/               27 tests over the above
```

See [PLAN.md](PLAN.md) for the full situation→key map and the staged milestones.
