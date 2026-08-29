# PAPERCUTS

Small, non-blocking frictions encountered by agents while working. Review this file periodically and sand them down.

## ad3cc5 · 2026-08-29T22:30:40.964Z — codex — gpt-5.6-sol

- **Directory:** `/Users/safzan/Development/projects/agentwork/proofshot`
- **About:** `exec-command`
- **Tags:** `tooling`

While migrating this repository to pnpm, exec_command rejected an explicit validated node_modules removal because rm -f style commands are forbidden. The user authorized the exact deletion, and the command targeted one repository dependency directory.

## ee5d76 · 2026-08-29T22:37:09.477Z — codex — gpt-5.6-sol

- **Directory:** `/Users/safzan/Development/projects/agentwork/proofshot`
- **About:** `pnpm`
- **Tags:** `misleading-error`

pnpm self-update --help presents self-update as the update path, but the installed Corepack-managed pnpm rejects it with ERR_PNPM_CANT_SELF_UPDATE_IN_COREPACK. The command should direct users to the exact Corepack activation command before they attempt the update.
