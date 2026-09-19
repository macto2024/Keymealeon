# Keymaeleon — the 3:30 demo

## The claim

**The agent sees the code. The keyboard sees the whole workstation.**

Codex reads files, runs tests, and edits. It cannot see the browser. The demo is built on that blind spot: a bug where **the tests pass and the app is still broken**. Codex declares victory and stops. Only something watching the whole machine knows it isn't done.

That is not a contrived failure. It is the most common way agent-assisted work actually goes wrong.

## The bug

A checkout page renders `Total: $NaN`.

The unit test feeds the formatter a **number** and passes. The real API returns the price as a **string**. Codex fixes the rounding, the test goes green, and the page is still broken. The fix it cannot reach is visible only in the browser console:

```
TypeError: price.toFixed is not a function
```

One bug, one blind spot, legible in four seconds on screen.

## Beat sheet — 210 seconds

| Time | Len | On screen | The six keys | Why they changed |
|---|---|---|---|---|
| **0:00** | 20s | Chrome: `Total: $NaN`, VS Code beside it | Run Tests · Git Diff · Problems · **Ask Codex** · More · Context | Editing a connected project |
| **0:20** | 25s | Type an edit in `CheckoutTotal.tsx`, don't save | ~~Run Tests~~ · Git Diff · Problems · Ask Codex · More · Context | **U dims:** *"Save your files before running tests."* |
| **0:45** | 25s | Save, press **U** — real run, real failure | First Failure · Test Output · Rerun · **Ask Codex to investigate** · More · Back | Tests failed, exit 1 |
| **1:10** | 30s | Press **J** — Codex opens in the terminal and starts | Focus Terminal · Git Diff · Problems · Test Output · More · Context | Its session reports a turn in flight |
| **1:40** | 20s | Codex finishes. Press **I** — **tests pass** | Git Diff · Run Tests · Output · Codex · More · Context | Green, and current |
| **2:00** | 25s | **Alt-tab to Chrome. Still `$NaN`.** Hold the silence. | Console · Reload · Network · **Ask Codex with this error** · More · Back | Passing tests, broken app |
| **2:25** | 30s | Press **O** → `TypeError: price.toFixed is not a function` | **Console · Revert Codex · View Diff · Ask Codex + error · More · Back** | ← the payoff |
| **2:55** | 20s | Press **J**. Codex gets the real error, fixes it. `Total: $42.50` | Git Diff · Run Tests · Output · Codex · More · Context | Verified in both places |
| **3:15** | 15s | Land the claim | Stage · Commit · Git Log · Push · More · Back | Reviewed, green, Git available |

## The three beats that carry it

### 0:20 — the dimmed key

`U` greys out and reads *"Save your files before running tests."*

Twenty-five seconds in, before any AI is involved. A mockup never has a reason to refuse. This beat buys credibility for everything after it, which is why it goes early and why it does not get cut for time.

### 2:00 — the wall

Say almost nothing:

> *"Tests pass. Codex is done. And the bug is still there. Codex only ever saw the code — it couldn't see this."*

Then stop talking for a beat. The silence is the demo.

### 2:25 — the decision surface

This is the argument:

> *"Right now there isn't one obvious next move. There are five — look at the console, revert what Codex did, read the diff, send it back with more context, or start over. That's exactly when six keys beat a menu."*

The state is genuinely ambiguous: tests green, app broken, agent idle, tree dirty. So the keyboard stops being a shortcut pad and becomes a **choice**.

Note that `I — Revert Codex` appears here and nowhere else in the run. It exists only because the working tree is dirty *from an agent turn*. That specificity is the point.

## Talk track

**0:00** — "This is a checkout page, and the total is NaN. Six keys on the left; every one of them changes with what I'm doing."

**0:20** — "I've made an edit but haven't saved. The Run Tests key went dark, and it says why: it won't run tests against files that aren't on disk yet."

**0:45** — "Saved. Run. That's a real test process — real exit code. The keys reorganised around the failure: first failure, output, rerun, or hand it to Codex."

**1:10** — "I'll hand it over. While Codex works, the keys follow the agent, not my cursor — and it knows what I asked for, because it's reading Codex's own session log."

**1:40** — "Codex is done. It touched one file. Run the tests — green. Normally this is where the demo ends."

**2:00** — *(switch to Chrome)* "Tests pass. Codex is done. And the bug is still there. Codex only ever saw the code — it couldn't see this."

**2:25** — "Right now there isn't one obvious next move. There are five. That's exactly when six keys beat a menu. I'll look at the actual error — and now this key sends that error straight back to Codex. I don't copy anything."

**2:55** — "Now it has what it was missing. Forty-two fifty."

**3:15** — "The agent sees the code. The keyboard sees the editor, the test process, the agent's own session log, Git, and the browser. That's why it could offer the one action the agent couldn't."

## Real vs. staged

State this once, out loud, rather than let it surface in Q&A.

**Real** — the unsaved-file refusal; the test process and its exit code; Codex's working/finished lifecycle, read from its own session transcript; which files it patched; Git dirty state. Beats 0:20 through 1:40 are genuine backend behaviour today.

**Real once built** — the browser console error. The demo app reports its own errors to the backend, the same way a Sentry SDK would. Roughly thirty lines. This makes the wall real rather than scripted, and it is the highest-value small build in the project.

**Staged** — `Revert Codex` and the commit layer at 3:15.

## Production notes

- **Cut 3:15 first if over time.** The argument is complete when the browser shows `$42.50`. Ending on "and then we committed" is weaker than ending on the claim.
- **`Ask Codex with this error` is the most impressive key in the run.** The promise is that it carries the console error into the prompt and the human never copy-pastes. If only one new thing gets built for this demo, it is this.
- **Rehearse the alt-tab at 2:00.** The cut from green tests to a broken page is the whole turn; a fumbled window switch costs it.
- **Two screens.** Keys on one, work on the other, so the audience never has to choose where to look.
- **The browser display client carries the words.** The caps are 64×32 and cannot render "Codex finished and changed 2 files". The screen shows labels and the layer's reason; the keyboard shows the actions.
