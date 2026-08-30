# ProofShot CLI

Visual verification tool for AI coding agents. Records browser sessions, captures screenshots, collects errors, and bundles proof artifacts.

## Quick reference

```bash
pnpm build             # Build with tsup (must run after changes)
pnpm test              # Run vitest once
pnpm dev               # Watch mode build
```

## Architecture

```
src/
├── cli.ts                  # Commander.js command registration
├── commands/               # One file per CLI command (install, start, stop, exec, diff, pr, clean)
├── browser/                # agent-browser CLI wrappers (session, capture, interact, navigate)
├── server/                 # Dev server detection, startup, port waiting
├── session/state.ts        # Atomic session state, start lock, and custom-output pointer
├── session/metadata.ts     # Persistent per-session metadata (branch, commit) for PR matching
├── artifacts/              # Output generation (viewer.html, SUMMARY.md, PR format)
└── utils/                  # Config, exec helpers, port utils, error patterns, GitHub API
```

**Entry point:** `bin/proofshot.ts` → `src/cli.ts` → `src/commands/*.ts`

## Key conventions

- **ESM only** — all imports MUST use `.js` extensions: `import { foo } from '../utils/config.js'`
- **Build before test** — CLI runs from `dist/`, always run `pnpm build` after code changes
- **agent-browser** — external peer dependency (Rust CLI + Node daemon). Browser calls use `abArgs()` in `utils/exec.ts`. The wrapper passes an argv array to `execFileSync` without a command shell
- **Session state** — `start` acquires an atomic start lock and writes `.session.json` atomically. `exec` and `stop` validate the state before use. A custom output directory leaves a pointer in the configured output directory. `stop` clears state after safe resource cleanup
- **Session metadata** — `start` writes `metadata.json` inside each session folder with git branch/commit. This persists after `stop` and is used by `pr` to match sessions to branches
- **Per-session subfolders** — artifacts go in `proofshot-artifacts/YYYY-MM-DD_HH-mm-ss_slug/`

## Command lifecycle

1. `proofshot start` — claims the session, optionally spawns the dev server, opens the browser, starts recording, saves session state, and writes `metadata.json`
2. `proofshot exec <args>` — forwards argv to `agent-browser` and appends the outcome to `session-log.jsonl`
3. `proofshot stop` — collects evidence, validates and optionally trims the video, writes structured and human-readable results, cleans up owned resources, and clears safe session state
4. `proofshot pr [number]` — matches sessions to the current revision, rejects incomplete or stale proof by default, uploads complete artifact sets, and posts a PR comment

## Adding a new command

1. Create `src/commands/mycommand.ts` with `export async function mycommandCommand(options): Promise<void>`
2. Register in `src/cli.ts` with `program.command('mycommand')...`
3. Export from `src/index.ts` if it should be part of the public API

## Adding error patterns for a new language

Edit `src/utils/error-patterns.ts` — add a new entry to the `PATTERNS` array:

```typescript
{
  name: 'Swift',
  patterns: [
    /Fatal error:/,
    /Thread \d+: signal SIGABRT/,
  ],
},
```

## Session artifacts

| File | Created by | Contains |
|---|---|---|
| `metadata.json` | `start` | Git branch, commit SHA, timestamp (persists after stop) |
| `session.webm` | `start` | Video recording (Playwright screencast) |
| `session-log.jsonl` | `exec` (appended each call) | Action outcomes with start and finish times, status, URL, and evidence data |
| `server.log` | `start` (piped stdout+stderr) | All dev server output |
| `console-output.log` | `stop` | Browser console output |
| `step-*.png` | `exec screenshot` | Screenshots at key moments |
| `result.json` | `exec`, `stop` | Assertions, evidence availability, error counts, and action-log integrity |
| `manifest.json` | `stop` | Machine-readable artifact inventory |
| `SUMMARY.md` | `stop` | Markdown report with errors and screenshots |
| `viewer.html` | `stop` | Standalone HTML viewer with video + timeline |

## Versioning & releases

- **Automatic** — merging to `main` triggers semantic-release via GitHub Actions
- **Never manually edit `version` in package.json** — semantic-release handles it
- **Conventional Commits** determine the version bump:
  - `feat:` → minor (0.1.0 → 0.2.0)
  - `fix:`, `perf:`, `refactor:` → patch (0.2.0 → 0.2.1)
  - `feat!:` or `BREAKING CHANGE:` footer → major (0.2.1 → 1.0.0)
  - `docs:`, `style:`, `chore:`, `test:`, `ci:` → no release
- **Commit format:** `type(scope): description` — e.g. `feat(cli): add diff command`, `fix(viewer): correct timestamp offset`
- **Branch naming:** `AmElmo/<descriptive-name>`

## Gotchas

- `proofshot exec` sends argument arrays directly to `agent-browser`. It does not interpolate browser arguments through a shell. Logged `fill` and `type` actions redact entered values
- Video trimming seeks to the nearest preceding keyframe. A failed trim restores the validated original. The viewer applies `trimOffsetSec` to its in-memory timeline without rewriting `session-log.jsonl`
- `proofshot start --run` refuses an occupied port by default. `--take-port` grants explicit permission to stop the current owner
- `--force` only clears a session after lifecycle checks prove that its browser and owned server resources are stale
- Server log capture requires `proofshot start --run`. A session without `--run` records the server evidence status as unavailable without a managed server
- Console collection occurs at stop time. Missing console, video, server, or action-log evidence marks verification as incomplete and returns a nonzero status unless the caller passes `--allow-incomplete`
