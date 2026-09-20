# Manual VS Code + Git + Codex presentation

You drive every step in VS Code and on the keyboard. No demo launcher, timed transitions, automatic patches, or automatic commits are involved.

## Before the judges arrive

1. **Make a separate demo workspace.** In your file manager, copy this entire `demo/project` folder to a new folder outside the Keymaeleon repository, for example `~/KeymaeleonDemo`. Copying the whole folder preserves its hidden `.vscode` settings, including the test command. Open the copy with VS Code's **File → Open Folder**, trust it, and open `shipping.py`.
2. **Create the Git baseline yourself.** In Source Control, select **Initialize Repository**. Stage the sample files, enter `Baseline shipping example`, and commit. The deliberately incorrect `>` boundary is now the clean baseline. If VS Code asks for Git identity, configure your usual name and email. Keep this sample repository separate from the main Keymaeleon repository.
3. **Reload the updated bridge.** Run **Developer: Reload Window**, then **SIX: Connect to Local Backend** from the Command Palette. The extension only runs in a trusted local workspace. For Codex, sign in to its VS Code extension beforehand.
4. **Start the companion yourself** from a terminal in the Keymaeleon repository, using one of the commands below. This is the normal application process, not a demo script.

Physical keyboard:

```sh
.venv/bin/python companion/keymaeleon_6.py --port /dev/ttyACM0 --no-llm
```

Or the interactive simulator:

```sh
python3 companion/keymaeleon_6.py --simulate --interactive --no-llm
```

Run one companion at a time. Switch back to VS Code and wait for the **Keymaeleon** status indicator. The physical-keyboard log should report `supported (ICON6_1)` and then `Profile: VS Code · live context`. The simulator displays branch, test state and action feedback.

## Actions to show the judges

| Step | You do | Keys / result to point out | Suggested narration |
|---|---|---|---|
| 1. Select code | Select a few lines in `shipping.py`. | Copy · Cut · Comment / References · Format Selection · Source Control | “The keyboard knows what I am doing inside the editor.” |
| 2. Edit | Clear the selection. Add a harmless comment, such as `# Shipping demo`. | Save All becomes the first key. Press it. | “An unsaved edit changes the next useful action.” |
| 3. Reproduce | Press **Run Tests**. After the comment is saved, it is the second key in the modified-file layout. | Three real tests run; the $50 boundary fails. Then: Run Tests · Ask Codex · Test Output / Open File · Review Changes · Source Control. | “These buttons are reacting to an actual failure.” |
| 4. Ask Codex | Press **Ask Codex**, paste the copied prompt in the sidebar, read it, then send it yourself. | Codex receives the file, branch, diagnostics and real failing-test output in the prompt. | “The handoff carries the evidence. I still decide what to send.” |
| 5. Fix | Change `amount > Decimal("50")` to `amount >= Decimal("50")`, manually or with Codex. Save, clear any selection, and press **Run Tests** again. | All three tests pass. The file is modified in Git. | “The fix has to pass the same tests.” |
| 6. Review | Press **Review Changes**. | Native VS Code diff. Previous Change · Next Change · Stage File / Open File · Run Tests · Source Control. | “Now the task is review, so the keys become review tools.” |
| 7. Stage | Press **Stage File**, then **Review Staged**. | Review Staged · Unstage File · Open Commit UI / Run Tests · Source Control · Ask Codex. | “Staging changes the available decisions again.” |
| 8. Commit | Press **Open Commit UI**. Enter `Fix free shipping at the threshold` and commit using VS Code. Reopen `shipping.py`. | The clean editor layout returns. | “The final commit stays in the normal Git workflow.” |
| 9. Switch apps | Focus Firefox, terminal or Spotify, then return to VS Code. | Existing app layouts return; VS Code restores its live context. | “The same keyboard adapts across applications too.” |

For a short presentation, skip the harmless comment and start by selecting code, clearing the selection, then pressing Run Tests. If Codex takes too long, explain the one-character boundary fix and make it manually; do not present that as a live AI result.

To demonstrate the CLI alternative, set `six.codexTarget` to `cli` in VS Code settings before the demo. Ask Codex opens a VS Code terminal running the `codex` executable; paste, review and send the same copied prompt. The executable must be available on VS Code's PATH.

## If VS Code keys show Idle

The firmware and bridge are separate checks:

- **Firmware lacks ICON6_1:** upload the updated `firmware/Keymaeleon6` sketch, including its generated `Icons6.h`.
- **No VS Code context received:** run Developer: Reload Window, open/trust the local demo folder, then SIX: Connect to Local Backend. Check the VS Code Output → Keymaeleon channel if it stays disconnected.
- **Heartbeat expired:** confirm the extension is connected to the running companion. `six.backendUrl` defaults to `http://127.0.0.1:5173`; it must match the companion's `--bridge-port`.
- **Waiting for VS Code window focus:** click the VS Code window. A brief wait while switching applications is normal.

Only tests launched by the Run Tests key drive these test-result layouts. External edits to supported source files invalidate a previous pass. Disabled buttons have blank pictographs; the simulator explains the reason when clicked.

## Rehearse again

Copy `demo/project` to another new folder and repeat the manual baseline setup. This preserves your previous rehearsal and avoids resetting an unrelated repository. You can also change `>=` back to `>` in your existing demo repository and commit that deliberately broken baseline yourself.

## Developer verification

```sh
python3 -m unittest discover -s tests -v
python3 tests/smoke_vscode_gui.py
```

`tests/prepare_vscode_workspace.py` and `tests/vscode_live.cjs` are automated test fixtures, separate from the presentation. The live VS Code test modifies its disposable workspace; use it only with a fresh test fixture.
