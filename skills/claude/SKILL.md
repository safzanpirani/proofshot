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

```bash
git worktree add --detach /tmp/proof-before <BASE_SHA>
```

For projects with dependencies, link rather than reinstall:
`ln -s "$(pwd)/node_modules" /tmp/proof-before/node_modules`. Reinstalling in the
worktree is usually a slow mistake.

### 3. Record BEFORE (old code)

Run from the **repo root**, with the dev server pointed at the worktree, on its
own port. Both runs then land side by side in `./proofshot-artifacts/`.

```bash
proofshot start --run "<dev command for /tmp/proof-before>" --port 8801 --description "BEFORE <what changed>"
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
git worktree remove --force /tmp/proof-before
```

Then give the user both session folders, and name the visible difference per
screenshot pair. Do not just hand over two paths — say what changed.

---

## Single-session mode

```bash
proofshot start --run "your-dev-command" --port PORT --description "what you are verifying"
proofshot exec snapshot -i                     # See interactive elements
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
- **Read the error counts `stop` prints.** `Console errors` covers uncaught
  exceptions *and* explicit `console.error(...)`. Non-zero means you are not
  done: fix the cause and re-run before reporting success.

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
