---
name: proofshot
description: Visual verification of UI features. Use after building or modifying any
  UI component, page, or visual feature. Starts a verification session with video
  recording and error capture, then you drive the browser to test, then stop to
  bundle proof artifacts for the human.
allowed-tools: Bash(proofshot:*), Bash(agent-browser:*)
---

# ProofShot — Visual Verification Workflow

ProofShot is an open-source, agent-agnostic CLI that lets you verify your own work in a real browser — video proof, screenshots, and error reports, no vendor lock-in.

## When to use

Use ProofShot after:
- Building a new UI feature or page
- Modifying existing UI components
- Fixing a visual bug
- Any change that affects what the user sees

Skip it when the change has no visual surface (backend jobs, libraries, pure CLI
work). There is nothing to record, and a reasoning-only report is just noise.

## The workflow (always follow these 3 steps)

### Step 1: Start the session

```bash
proofshot start --run "your-dev-command" --port PORT --description "what you are about to verify"
```

This opens a browser and begins recording. If the port is already in use, proofshot will kill the existing process automatically.

**Always use `--run`** to let proofshot start and capture your dev server output (server logs appear in the proof report).
Only omit `--run` if the server was explicitly started by the user or another process — without it, no server logs are captured.

`start` returns as soon as the session is live; the dev server keeps running in
the background under a detached log pump. Do not background this command or pipe
it into a waiter — it is not supposed to block.

If a previous session was not stopped cleanly, add `--force` to override it.

### Step 2: Drive the browser and test

Use proofshot exec to navigate, interact, and verify:

```bash
proofshot exec snapshot -i                                    # See interactive elements
proofshot exec open http://localhost:PORT/page                # Navigate to a page
proofshot exec click @e3                                      # Click a button
proofshot exec fill @e2 "test@example.com"                    # Fill a form field
proofshot exec screenshot step-NAME.png                       # Capture key moments
```

Take screenshots at important moments — these become the visual proof.
Verify what you expect to see by reading the snapshot output.

**Screenshot paths are relative to the session folder.** Pass a bare filename
(`step-login.png`). Do not prefix it with `./proofshot-artifacts/` — that
resolves inside the session folder and fails with "No such file or directory".

### Step 3: Stop and bundle the proof

```bash
proofshot stop
```

This stops recording, collects console + server errors, generates SUMMARY.md and
viewer.html, and shuts down the dev server it started. You do not need to kill
the server yourself.

**Read the error counts it prints.** `Console errors` covers both uncaught page
exceptions and explicit `console.error(...)` calls. A non-zero count means you
have not finished: fix the cause and re-run the workflow before reporting done.

### Step 4 (optional): Post proof to the PR

```bash
proofshot pr              # Auto-detect PR from current branch
proofshot pr 42           # Target a specific PR number
```

This uploads screenshots and video to GitHub and posts a formatted comment on the PR. By default it uses the official GitHub contents API on a `proofshot-artifacts` branch. Use `--upload-provider github-web-attachments` if you specifically want GitHub attachment URLs.

## Reporting honestly

A recording proves the happy path renders and runs. It does not prove edge cases
or regressions are absent. Say "here is the flow working", not "verified, no
bugs" — and keep tests as the actual correctness gate.

Never hand-edit files under `proofshot-artifacts/` to make a report look better.
The artifact is evidence; doctoring it makes it worthless.

## Troubleshooting

- `proofshot doctor` — checks agent-browser, ffmpeg, and the active session
- `proofshot clean` — removes artifacts and clears a stuck session
- No server logs in the report? The port was already occupied, so proofshot
  skipped spawning and never owned the server's output.

## Tips

- Always include a meaningful --description so the human knows what was tested
- Take screenshots before AND after key actions (e.g., before form submit, after redirect)
- If you find errors during verification, fix them and re-run the workflow
