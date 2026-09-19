# Keymaeleon VS Code extension

The extension is the eyes and hands of the keyboard inside the editor. It reports what you are
doing to the local backend, and executes the editor actions the backend sends back.

It works entirely against the simulated keyboard — a six-key display in the browser, or the caps
drawn in a terminal. No hardware is needed to develop, run, or test any of it.

## There is no build step

This is deliberate. The extension is plain CommonJS — no TypeScript, no bundler, no `npm install`,
no compile. Two files:

```
vscode-extension/
  package.json     manifest: commands, settings, activation
  extension.cjs    the whole extension, ~183 lines
```

Edit `extension.cjs`, reload the window, done. At a hackathon, a build step is a thing that breaks
at midnight.

## Requirements

- **VS Code 1.85+** and **Node 18+**
- A **local, trusted** workspace folder. The extension refuses to run in an untrusted workspace or
  a virtual/remote one, because it executes commands and reads file paths.
- The backend running on `http://127.0.0.1:5173`

## Install

### For normal use

```sh
native/install-vscode.sh
```

Copies `package.json` and `extension.cjs` into `~/.vscode/extensions/six-local.six-workflow-bridge-0.2.0`.
Then reload VS Code once — **Ctrl+Shift+P → Developer: Reload Window**.

Re-run the script and reload again after every change to `extension.cjs`.

### For development

```sh
code --new-window --extensionDevelopmentPath="$PWD/vscode-extension" /path/to/any/project
```

Or open this repo in VS Code, press **F5**, and pick a project folder when prompted. You get a
separate Extension Development Host window with a debugger attached and breakpoints in
`extension.cjs`. The extension loads **only** in that window.

## Run it

```sh
npm start                    # the backend, from the repo root
code ~/some/git/project      # any local folder; a git repo root gets the Git keys too
```

Then pick a display — either is fine:

```
http://127.0.0.1:5173                                  six keys in the browser
python3 companion/keymaeleon_bridge.py --simulate      the caps, drawn in a terminal
```

The status bar should read **SIX: connected**, with the adopted project path as its tooltip.

Because `root` is `null` in `six.config.json`, the backend adopts whichever VS Code window you
focus, so you can switch projects just by focusing a different window.

## Confirm it is working

| Do this | Expect |
|---|---|
| Focus the window | keys become `Run Tests · Git Diff · Output · Codex in Terminal · More · Context` |
| Type without saving | **`U` dims** — *"Save your VS Code files before running tests."* |
| Ctrl+S | `U` lights up |
| Select several lines | backend reports the selection's line count |
| Introduce a syntax error | diagnostic count appears; More → `O` opens Problems |
| **SIX: Disconnect** | backend marks the editor disconnected within ~6 seconds |
| **SIX: Connect to Local Backend** | context and actions return |

The dimmed key is the one to check first. It proves the whole chain: the editor saw an unsaved
buffer, the backend refused to run tests against files that are not on disk, and the key said why
instead of failing silently when pressed.

## How it talks to the backend

A one-second heartbeat, plus a 200 ms debounced tick on editor events (active file, selection,
save, close, diagnostics, terminal close).

```
  extension                                backend
      │  GET  /api/context                    │   once, to fetch the session token
      │──────────────────────────────────────►│
      │  POST /api/editor/context             │   every second: state, and any queued commands back
      │──────────────────────────────────────►│
      │◄───────── { commands: [...] } ────────│
      │  POST /api/editor/ack                 │   after each command: done, or the error
      │──────────────────────────────────────►│
```

Commands are **acknowledged**, so the backend never reports success merely because it dispatched
something. If VS Code could not open the file, the key reports that.

### What it reports

```js
focused              active_file          language
has_selection        selection_lines      unsaved_files
agent_terminal_open  diagnostics[{ file, line, severity, message }]
agent_terminal_supported  external_actions_supported  voice_supported
```

Paths are workspace-relative and confined to the adopted root. Source text and selection contents
are never sent anywhere — only counts, names and diagnostic messages.

The `*_supported` flags exist so a key can stay **disabled with a reason** when you are running an
older extension, rather than appearing to work and doing nothing.

### What it executes

| Command | Effect |
|---|---|
| `editor_open` · `editor_diff` · `editor_problem` | open a file, diff against Git HEAD, jump to a diagnostic |
| `editor_terminal` · `editor_test_output` | `SIX Terminal`; `SIX Tests` showing real backend output |
| `editor_problems` · `editor_focus` · `editor_context` | Problems panel, editor group, the SIX output channel |
| `editor_git_diff` · `editor_git_log` | fixed Git commands in a project-scoped `SIX Git` terminal |
| `editor_agent_launch` · `editor_agent_focus` | open or reveal `SIX Codex` / `SIX Claude` |
| `editor_agent_insert` | **type text into the agent terminal without pressing Enter** |

`editor_agent_insert` is the interesting one. It is how a key can carry a failing test or an error
message into the agent's prompt while still leaving the human to read it and hit Enter.

## Settings and commands

| Setting | Default |
|---|---|
| `six.backendUrl` | `http://127.0.0.1:5173` — loopback HTTP only |

| Command palette | |
|---|---|
| `SIX: Connect to Local Backend` | reconnect after an error |
| `SIX: Disconnect` | stop reporting |
| `SIX: Open Keyboard` | open the six-key display in a browser |

## Adding a key

The extension is usually the *last* thing you touch, because most of a new key is backend work.

1. **`live.js`** — add the action id to a layer's `ids`, a label and icon in `present()`, and a
   reason in `unavailable()` for when it cannot fire.
2. **`server/runtime.js`** — add the id to the `allowed` list in `action()` and route it.
3. **`extension.cjs`** — only if it needs something new from the editor. Add a branch in
   `execute()`, and report any new state from `state()`.
4. **`tools/generate_six_icons.py`** — add the action to `ACTION_ICONS` so the physical cap has a
   pictogram. Unmapped actions log a warning and render blank rather than showing a wrong symbol.

A key must not appear enabled unless the integration behind it exists and the action will really
happen. Everything else is disabled with its reason.

## Troubleshooting

- **Stuck on "connecting"** — the backend is not running, or `six.backendUrl` points at the wrong
  port. Hover the status bar for the actual error, or open Output → **SIX**.
- **"Open this project folder in VS Code: /path"** — the backend already adopted a different
  folder. Open that one, or restart the backend to release it.
- **"Open a local project folder in VS Code"** — no file-scheme workspace folder. A loose file or
  an untitled window is not enough.
- **Keys stay disabled after an update** — reload the window. New keys stay disabled until the
  extension reports support for them, which is the intended behaviour.
- **No diagnostics** — that depends on the language service. A syntax error is a reliable check;
  semantic type checking is not enabled by this extension.
- **"Another VS Code window is connected"** — run **SIX: Disconnect** in the other window, wait six
  seconds, then connect this one.
- **Changes to `extension.cjs` do nothing** — re-run `native/install-vscode.sh` and reload, or use
  the Extension Development Host, which picks up changes on restart.

## Scope

Trusted local file workspaces only. Remote SSH, virtual workspaces, debugger control and global
keyboard shortcuts are out of scope for this milestone.
