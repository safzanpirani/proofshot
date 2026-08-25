---
name: proofshot
description: Visual verification of UI work, including before/after comparisons. Use
  after building or modifying any UI component, page, or visual feature, and whenever
  the user asks for a demo, proof, screen recording, or a "before and after" of a
  change. Records the browser, captures screenshots, collects console and server
  errors, and bundles proof artifacts for the human to review.
allowed-tools: Bash(proofshot:*), Bash(agent-browser:*), Bash(git:*)
---

# ProofShot — Visual Verification Workflow

Verify your own work in a real browser and hand the human video proof, screenshots, and an error report.

## Requirements

```bash
npm install -g agent-browser
npm install -g github:safzanpirani/proofshot
```

Install from that fork rather than `npm i -g proofshot`. The published package is
unmaintained since April 2026 and still has defects this workflow depends on:
`start --run` never exits (hanging the agent), `console.error(...)` is captured
but reported as zero errors, `--output` strands the session so the recording
finalises at 0 bytes, the Windows teardown leaves the dev server running, and a
Playwright-style selector fails with a bare "Element not found" that reads like a
lost page. Check the install with `proofshot doctor`.

## Which mode

- **"before and after"**, "show me what changed", "prove the fix works" → **Before/After mode** below. This is the default whenever the user's wording compares old behaviour to new.
- Anything else visual ("verify this", "record a demo", "screenshot it") → **Single-session mode**.

Skip ProofShot entirely when the change has no visual surface (backend jobs, libraries, pure CLI work).

---

## Before/After mode

Records the same flow twice: once against the pre-change code in a throwaway git
worktree, once against the working tree. Run every step without asking the user
for more input — they already asked for before/after, that is the whole brief.

### 1. Resolve the base commit

```bash
git rev-parse --short HEAD                       # uncommitted change → base is HEAD
git merge-base HEAD origin/main                  # change already committed on a branch
```

Use `HEAD` when `git status --porcelain` shows the change is uncommitted. Use the
merge-base against the default branch when the change is already committed.
If neither resolves, say so and fall back to Single-session mode — do not invent a base.

### 2. Check out the base into a worktree

Put it in a temp directory **outside** the repo, so it never shows up in status
or gets swept by a clean:

```bash
git worktree add --detach "${TMPDIR:-/tmp}/proof-before" <BASE_SHA>   # macOS / Linux
git worktree add --detach "%TEMP%\proof-before" <BASE_SHA>            # Windows
```

For projects with dependencies, link rather than reinstall — reinstalling in the
worktree is usually a slow mistake:

```bash
ln -s "$(pwd)/node_modules" "$WORKTREE/node_modules"                  # macOS / Linux
cmd /c mklink /J "%WORKTREE%\node_modules" "%CD%\node_modules"        # Windows (junction)
```

Skip the link and install properly when the project has native modules or is a
monorepo with workspace-relative paths — a linked `node_modules` is wrong there.

### 3. Record BEFORE (old code)

Run from the **repo root**, with the dev server pointed at the worktree, on its
own port. Both runs then land side by side in `./proofshot-artifacts/`.

```bash
proofshot start --run "<dev command run against $WORKTREE>" --port 8801 --description "BEFORE <what changed>"
proofshot exec open http://localhost:8801/<route>
proofshot exec screenshot state-initial.png
# ...drive the flow...
proofshot exec screenshot state-final.png
proofshot stop
```

If the flow cannot complete on the base because the feature did not exist yet,
that is a valid result. Capture what *is* there, and say plainly in your report
that the step was absent before.

### 4. Record AFTER (working tree)

Repeat step 3 against the working tree on a different port, with description
`AFTER <what changed>` — and **the same screenshot filenames and the same
actions**. Identical names are what let the human pair the shots.

### 5. Clean up and report

```bash
git worktree remove --force "$WORKTREE"
```

Always run this, even if the recording failed — a stale worktree makes the next
before/after run fail with "already exists".

Then give the user both session folders, and name the visible difference per
screenshot pair. Do not just hand over two paths — say what changed.

---

## Single-session mode

```bash
proofshot start --run "your-dev-command" --port PORT --description "what you are verifying"
proofshot exec snapshot -i                     # See interactive elements
proofshot snapshot -i                          # Equivalent shorthand
proofshot exec open http://localhost:PORT/page
proofshot exec click @e3
proofshot exec fill @e2 "test@example.com"
proofshot exec screenshot step-NAME.png
proofshot stop
```

Optionally post the result to the pull request:

```bash
proofshot pr          # auto-detect PR from branch
proofshot pr 42       # specific PR
```

---

## Rules that keep runs from failing

- **Target elements by `@eN` ref, CSS, or `find`. Never Playwright syntax.**
  `text=Today`, `role=button`, `placeholder=Email` are not accepted and fail with
  a bare "Element not found", which reads exactly like a missing page. Use
  `proofshot exec snapshot -i` and click the `@eN` it prints, a CSS selector, or
  `proofshot exec find text Today click`.
- **"Element not found" almost never means the page is gone.** Check the selector
  first; re-navigating hides the real cause and wastes the run.
- **Screenshot paths are relative to the session folder.** Pass a bare filename
  (`step-login.png`). Prefixing `./proofshot-artifacts/` resolves inside the
  session folder and fails with "No such file or directory".
- **`start` returns immediately** once the session is live; the dev server keeps
  running under a detached pump. Never background it or wrap it in a waiter.
- **`stop` shuts down the dev server it started.** Do not kill it yourself.
- **Give each concurrent-ish run its own port.** `start` kills whatever occupies
  the target port, so reusing one port across a before/after pair can take out
  the other server.
- **Always pass `--run`** so server logs are captured. Without it there are none.
- **Use `--output /path` when the project volume is low on space.** The active
  session remains discoverable by `exec` and `stop` through its session pointer.
- **Read the error counts `stop` prints.** `Console errors` covers uncaught
  exceptions *and* explicit `console.error(...)`. Non-zero means you are not
  done: fix the cause and re-run before reporting success.

## On Windows

- Run from **PowerShell or cmd**, not Git Bash. `--run` goes through `ComSpec`
  (cmd.exe), so a command written for `sh` will not parse.
- Quote paths containing spaces in `--run`, and prefer forward slashes in URLs
  even when the filesystem path uses backslashes.
- `stop` uses `taskkill /F /T` to take the dev server down, since Windows has no
  process groups. If a server somehow survives, `netstat -ano | findstr :PORT`
  then `taskkill /F /PID <pid>`.
- Use a junction (`mklink /J`), not a symlink, to share `node_modules` into a
  worktree — symlinks need Developer Mode or admin.

## Reporting honestly

A recording proves the happy path renders and runs. It does not prove edge cases
or regressions are absent. Say "here is the flow working", not "verified, no
bugs" — tests remain the correctness gate.

Never hand-edit anything under `proofshot-artifacts/` to make a report look
better. The artifact is evidence; doctoring it makes it worthless.

## Troubleshooting

- `proofshot doctor` — checks agent-browser, ffmpeg, and the active session
- `proofshot clean` — removes artifacts and clears a stuck session
- No server logs? The port was already occupied, so proofshot never owned the server.
