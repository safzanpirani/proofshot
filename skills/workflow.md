# ProofShot visual verification workflow

Use ProofShot after a change affects a visible interface.

1. Run `proofshot doctor`. Do not use `--force` unless doctor proves that the saved session is stale.
2. Start with `proofshot start --run "<command>" --port <port> --description "<scope>"`. An omitted `--run` makes server evidence unavailable.
3. Drive the browser through `proofshot exec`. Add required `proofshot assert` commands. Capture key screenshots with `proofshot screenshot <name>`. Screenshots use full-page capture by default. Use `--viewport-only` only when cropping is intentional.
4. Open every key screenshot with the runtime's native image inspection tool. Accessibility snapshots do not verify spacing, clipping, color, hierarchy, or responsive layout.
5. Run `proofshot stop`, including after a failed action. Treat unavailable console, server, browser, or video evidence as unavailable. Never describe missing evidence as clean.

For before-and-after work, create a unique directory with `mktemp -d`. Add the base revision as a detached worktree inside that directory. Validate the exact generated path before removing the worktree. Do not use a fixed `/tmp/proof-before` path. Do not force worktree removal unless the validated generated path requires it.

Report visible observations, assertion results, captured errors, unavailable evidence, and remaining proof boundaries as separate facts. A screenshot proves only the visible state that you inspected.
