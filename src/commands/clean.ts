import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import chalk from 'chalk';
import { loadConfig } from '../utils/config.js';
import { hasActiveSession } from '../session/state.js';

export interface CleanOptions {
  dryRun?: boolean;
  olderThan?: string;
  trash?: boolean;
}

export function parseAge(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)([mhdw])$/i);
  if (!match) throw new Error('--older-than must use a duration such as 12h, 7d, or 4w');
  const units: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}

export function validateCleanupPath(target: string, cwd = process.cwd(), home = os.homedir()): string {
  const resolved = path.resolve(target);
  const roots = new Set([path.parse(resolved).root, path.resolve(home), path.resolve(cwd)]);
  try {
    roots.add(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { /* outside a repository */ }
  if (roots.has(resolved) || [...roots].some((root) => root.startsWith(resolved + path.sep))) {
    throw new Error(`Refusing to clean dangerous directory: ${resolved}`);
  }
  if (resolved.split(path.sep).filter(Boolean).length < 3) {
    throw new Error(`Refusing to clean broad directory: ${resolved}`);
  }
  return resolved;
}

export function assertCleanupAllowed(activeSession: boolean): void {
  if (activeSession) {
    throw new Error('Refusing to clean artifacts while a ProofShot session is active. Run "proofshot stop" first.');
  }
}

export async function cleanCommand(options: CleanOptions = {}): Promise<void> {
  const outputDir = validateCleanupPath(loadConfig().output);

  if (!fs.existsSync(outputDir)) {
    console.log(chalk.dim('Nothing to clean — no artifacts directory found.'));
    return;
  }

  const cutoff = options.olderThan ? Date.now() - parseAge(options.olderThan) : null;
  const targets = cutoff === null
    ? [outputDir]
    : fs.readdirSync(outputDir, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.session'))
        .map((entry) => path.join(outputDir, entry.name))
        .filter((entryPath) => fs.statSync(entryPath).mtimeMs < cutoff);
  if (targets.length === 0) {
    console.log(chalk.dim('Nothing matched the cleanup policy.'));
    return;
  }
  if (!options.dryRun) assertCleanupAllowed(hasActiveSession(outputDir));
  for (const target of targets) console.log(`${options.dryRun ? 'Would remove' : 'Removing'} ${chalk.dim(target)}`);
  if (options.dryRun) return;
  if (options.trash) {
    const result = spawnSync('trash', targets, { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Trash cleanup failed. Install a compatible "trash" CLI or omit --trash.');
  } else {
    for (const target of targets) fs.rmSync(target, { recursive: true, force: true });
  }
  console.log(chalk.green('✓') + ` Removed ${targets.length} artifact ${targets.length === 1 ? 'path' : 'paths'}`);
}
