# Keymeleon VS Code extension

The extension is one of the two context sources for the backend. It reports the active project file, language, selection size, unsaved-file count, and diagnostics to the local backend over loopback HTTP, and executes the small set of editor commands the backend sends back.

It does not send source text or selection text anywhere. The coding-agent CLI launched in its terminal can read project files when you ask it to — that is the CLI's own access, not this bridge's.

The extension keeps the identifier `six-workflow-bridge` and the `six.*` command namespace from the project's earlier internal name. Renaming would break installed copies and the backend's command contract.

## Install

For normal use on macOS:

```sh
native/install-vscode.sh
```

Reload VS Code once. Open any local folder — an empty one is fine — and focus its window. With the backend running, the status bar shows **SIX: connected** and the first focused workspace becomes the project.

## Test it in isolation

1. Run `npm start` in this repository and leave it running.
2. Open this repository in VS Code.
3. In Run and Debug, choose **Test Keymeleon VS Code extension** and press **F5**. You are prompted for the project folder the Extension Development Host should open — point it at any small local project with a test command. No build step is needed.

Or directly:

```sh
code --new-window --extensionDevelopmentPath="$PWD/vscode-extension" /path/to/some/project
```

Set `command` in `six.config.json` to that project's test command (e.g. `["npm","test"]`) if you want the test keys enabled.

The extension loads in the development window only.

## Checks

| Test | Action | Expected |
|---|---|---|
| Active file | Switch between two files | The backend reports the selected filename and language |
| Selection | Select several lines | The backend reports the selection's line count |
| Unsaved edits | Type without saving | Run Tests is disabled with *"Save your VS Code files before running tests."* |
| Saved edits | Save | Run Tests becomes available; previous results go stale |
| Open file | `K` twice, then `U` | VS Code opens the reported file |
| Editor diff | Second More page, `I` | VS Code opens Git HEAD versus the current document |
| Diagnostics | Introduce a syntax error | Diagnostic count appears; More → `O` opens Problems |
| Real test loop | Break an assertion, save, Run Tests | Real output and a real nonzero exit; fix and rerun to pass |
| Disconnect | **SIX: Disconnect** | The backend marks the editor disconnected within about six seconds |
| Reconnect | **SIX: Connect to Local Backend** | Context and editor actions return |

Undo any temporary error afterwards. `U/I/O/J/K/L` typed in VS Code remain ordinary typing — they are only shortcuts in a focused display client.

## Terminals it opens

| Terminal | Contents |
|---|---|
| `SIX Terminal` | Interactive shell rooted in the project |
| `SIX Tests` | The backend's actual test output; Ctrl+C requests cancellation of the backend process |
| `SIX Git` | Fixed `git --no-pager diff` / `log` commands, project-scoped |
| `SIX Codex` / `SIX Claude` | The interactive agent CLI, with the model from `six.config.json` |

Commands you type yourself in these terminals are independent and do not drive the backend's test state. Git actions never stage or commit.

The agent terminal currently starts the CLI with `--sandbox read-only`, so it proposes rather than applies. That is why there is no Accept/Reject key yet — see milestone 2 in [PLAN.md](../PLAN.md). The extension cannot confirm the CLI finished authenticating or produced a response; check the terminal for that.

## Diff behavior

`Editor Diff` compares HEAD with the current editor document, including unsaved edits. `Git Diff` runs `git --no-pager diff` in a terminal and therefore shows tracked unstaged changes only, omitting untracked files, exactly as ordinary `git diff` does. In a repository with no commits, untracked files compare against an empty baseline and show as entirely new.

## Troubleshooting

- **Backend unavailable** — start `npm start`. On another port, set `six.backendUrl` in VS Code settings to the matching loopback URL.
- **Wrong folder** — the workspace must match the root in `six.config.json`, unless `root` is `null` and the backend is adopting the first focused window.
- **No active file** — open a regular file inside the project. Virtual documents and files outside the root are excluded.
- **No diagnostics** — this depends on the language service. A syntax error is a reliable check; semantic type checking is not enabled by this extension.
- **Another window connected** — run **SIX: Disconnect** in the other window, wait six seconds, connect this one.
- **Keys stay disabled after an update** — reload the window. New keys remain disabled until the extension reports support for them.
- **Details** — VS Code's Output panel, channel **SIX**.

Trusted local file workspaces only. Remote SSH, virtual workspaces, debugger control, and global keyboard shortcuts are out of scope for this milestone.
