# ProofShot visual verification workflow

Use ProofShot after a change affects a visible interface. Use it when the user asks for screenshots, a demo, a recording, or before-and-after proof.

## Check the environment

1. Run `proofshot doctor` before starting. Stop if `agent-browser` or `ffmpeg` is unavailable.
2. Check whether the intended port already has a listener. Choose another port when possible. Use `--take-port` only when you have confirmed that ProofShot may stop the existing listener.
3. Do not use `--force` as a routine retry. Use it only when `doctor` and lifecycle checks prove that saved session state is stale.

## Start the session

```bash
proofshot start --run "<dev command>" --port <port> --description "<scope>"
```

Always pass `--run` when ProofShot should own the dev server and capture its logs. Omit `--run` only when the user or another process owns the server. Report server evidence as unavailable in that case.

Use `--output <absolute-path>` when the project volume lacks space. `exec` and `stop` will follow the session pointer.

## Drive and verify the interface

Use ProofShot commands so every action enters the evidence log.

```bash
proofshot snapshot -i
proofshot exec open http://localhost:<port>/<route>
proofshot exec click @e3
proofshot exec fill @e2 "example value"
proofshot assert visible "Expected text"
proofshot screenshot state.png
```

- Use `@eN` references, CSS selectors, or `find`. Do not use Playwright selector syntax such as `text=` or `role=`.
- Add an assertion for every behavior that the proof must establish.
- Capture the state before and after important actions. Screenshots use full-page capture by default. Use `--viewport-only` only when a crop is intentional.
- Open every key screenshot with the runtime's native image viewer. Accessibility output cannot prove spacing, clipping, color, hierarchy, or responsive layout.

## Stop and evaluate the evidence

Run `proofshot stop` after successful and failed actions. ProofShot must close the browser, finalize the video, collect logs, and release any server it owns.

Treat the run as failed when an assertion or action failed, an error count is nonzero, the session log is malformed, or required console, server, browser, or video evidence is unavailable. `--allow-incomplete` permits diagnostic collection. It does not turn missing evidence into proof.

Never edit generated artifacts to improve the result.

## Record before-and-after proof

1. Create a unique temporary directory with `mktemp -d`.
2. Add the base revision as a detached worktree inside that directory.
3. Record the same actions, assertions, routes, viewport, and screenshot names against the base and current revisions. Use separate ports.
4. Inspect both screenshot sets and state the visible differences.
5. Validate the generated worktree path before removing it. Do not use a fixed temporary path or force removal without checking the target.

## Publish and report

Run `proofshot pr` only after `stop` produces complete evidence. ProofShot must reject incomplete results and partial uploads.

Report these facts separately:

- Visible observations from screenshots you inspected.
- Assertion and action results.
- Console and server errors.
- Unavailable evidence and remaining human checks.

A recording proves only the flow that ran. Tests remain a separate correctness check.
