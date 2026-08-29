import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { diffScreenshots } from '../browser/capture.js';

interface DiffOptions {
  baseline: string;
  current: string;
  threshold?: number;
}

export async function diffCommand(options: DiffOptions): Promise<void> {
  const currentDir = path.resolve(options.current);
  const baselineDir = path.resolve(options.baseline);

  if (!fs.existsSync(baselineDir)) {
    console.error(chalk.red('✗') + ` Baseline directory not found: ${baselineDir}`);
    process.exit(1);
  }

  if (!fs.existsSync(currentDir)) {
    console.error(
      chalk.red('✗') +
        ` Current artifacts not found: ${currentDir}\n` +
        chalk.dim('Pass an exact completed session directory with --current.'),
    );
    process.exit(1);
  }

  const baselineFiles = readManifestScreenshots(baselineDir);
  const currentFiles = readManifestScreenshots(currentDir);

  if (baselineFiles.length === 0) {
    console.error(chalk.red('✗') + ' Baseline manifest contains no screenshots');
    process.exit(1);
  }

  const diffDir = path.join(currentDir, 'diffs');
  fs.mkdirSync(diffDir, { recursive: true });

  console.log(chalk.dim('Comparing screenshots...\n'));

  let hasChanges = false;
  let exceedsThreshold = false;
  let comparisonFailed = false;
  const threshold = options.threshold ?? 0;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error('--threshold must be from 0 to 100');

  for (const file of baselineFiles) {
    const baselinePath = path.join(baselineDir, file);
    const currentPath = path.join(currentDir, file);
    const diffPath = path.join(diffDir, `diff-${file}`);

    if (!fs.existsSync(currentPath)) {
      console.log(chalk.yellow('⚠') + ` ${file}: no matching current screenshot (page removed?)`);
      hasChanges = true;
      exceedsThreshold = true;
      continue;
    }

    let mismatch: number;
    try {
      mismatch = diffScreenshots(baselinePath, currentPath, diffPath);
    } catch (error) {
      comparisonFailed = true;
      console.log(chalk.red('✗') + ` ${file}: comparison unavailable (${error instanceof Error ? error.message : error})`);
      continue;
    }

    if (mismatch === 0) {
      console.log(chalk.green('✓') + ` ${file}: identical`);
    } else {
      hasChanges = true;
      exceedsThreshold = exceedsThreshold || mismatch > threshold;
      console.log(
        chalk.red('✗') +
          ` ${file}: ${chalk.bold(`${mismatch.toFixed(2)}%`)} changed → ${chalk.dim(diffPath)}`,
      );
    }
  }

  // Check for new pages
  for (const file of currentFiles) {
    if (!baselineFiles.includes(file)) {
      console.log(chalk.cyan('+') + ` ${file}: new page (no baseline)`);
      hasChanges = true;
    }
  }

  console.log('');
  if (comparisonFailed) {
    console.log(chalk.red('Visual comparison failed.'));
  } else if (hasChanges) {
    console.log(chalk.yellow('Visual changes detected.') + ` Diff images saved to ${chalk.dim(diffDir)}`);
  } else {
    console.log(chalk.green('No visual changes detected.'));
  }
  if (comparisonFailed || exceedsThreshold) process.exitCode = 1;
}

function readManifestScreenshots(sessionDir: string): string[] {
  const manifestPath = path.join(sessionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`Session manifest not found: ${manifestPath}`);
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { screenshots?: unknown };
  if (!Array.isArray(parsed.screenshots) || parsed.screenshots.some((name) => typeof name !== 'string' || path.basename(name) !== name)) {
    throw new Error(`Invalid screenshot manifest: ${manifestPath}`);
  }
  return parsed.screenshots as string[];
}
