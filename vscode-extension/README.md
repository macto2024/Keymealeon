# Keymaeleon VS Code bridge

Plain CommonJS extension; no npm build or external package dependency. Requires VS Code 1.85+, a trusted local file workspace, and the Python six-key companion. Remote workspaces are deliberately inactive.

```sh
./native/install-vscode.sh
# In VS Code: Developer: Reload Window
python3 companion/keymaeleon_6.py --simulate --interactive
```

The status bar displays `Keymaeleon` when connected; hover or open Output → Keymaeleon for errors. `SIX: Connect to Local Backend` and `SIX: Disconnect` control reporting. `SIX: Open Keyboard` displays the local simulator launch command.

Settings:

- `six.backendUrl`: loopback HTTP, default `http://127.0.0.1:5173`; match `--bridge-port` on the companion.
- `six.testCommand`: executable and argument array, e.g. `["python3", "-m", "unittest", "discover", "-v"]`. Runs with no shell in the active workspace folder. Empty disables Run Tests.
- `six.codexTarget`: `auto` prefers the installed `openai.chatgpt` sidebar; `cli` launches `codex` as a terminal process. Both copy context to the clipboard for manual review and submission. CLI must be on VS Code's PATH.

Every 500 ms and on editor events, the extension reports focus, active file, selection, unsaved files, diagnostics, Git branch/file state and real test results. The companion selects six pictographs. An allowlisted command is delivered once and acknowledged with success/error. Context revisions reject stale key presses; focused windows take ownership, background windows cannot. Connection expiry is three seconds.

Unsaved edits prioritize Save All. Selection exposes editing tools. Failed tests expose Ask Codex. Modified files expose Review Changes / Stage File. Diff review and staged changes expose review and commit UI actions. No automatic commit or push occurs. Staging operates on the active saved file only.

The Python backend replaces the unrelated Node/web simulator referenced by the originally copied extension. The copied macOS host scripts need that other project's files and are not part of this Linux companion workflow.

See `demo/README.md` for the repeatable Git demonstration.

While the companion is running, `curl http://127.0.0.1:5173/api/context`
shows the received editor/Git/test state, revision, connection freshness and last
action acknowledgement in its `context` field.

Live VS Code keys include short text labels below their pictograms on the
simulator and physical OLEDs. Physical labels require firmware capability
`ICON6_LABELS_1`; update the six-key sketch and restart the companion. No extension
reinstall is needed for this display-only change.
