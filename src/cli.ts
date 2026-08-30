import { Command, InvalidArgumentError } from 'commander';
import { installCommand } from './commands/install.js';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { diffCommand } from './commands/diff.js';
import { cleanCommand } from './commands/clean.js';
import { prCommand } from './commands/pr.js';
import { execCommand } from './commands/exec.js';
import { doctorCommand } from './commands/doctor.js';
import { runCommand } from './commands/run.js';
import { PROOFSHOT_VERSION } from './version.js';

export function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError('Port must be an integer from 1 to 65535.');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError('Port must be an integer from 1 to 65535.');
  }
  return port;
}

export function createCLI(): Command {
  const program = new Command();

  program
    .name('proofshot')
    .description('Visual verification for AI coding agents')
    .version(PROOFSHOT_VERSION);

  program
    .command('install')
    .description('Install ProofShot skills at user level for all detected AI coding tools')
    .option('--only <tools>', 'Only install for these tools (comma-separated: claude,codex,cursor,gemini,windsurf,opencode)')
    .option('--skip <tools>', 'Skip these tools (comma-separated)')
    .option('--force', 'Overwrite existing skill files even if unchanged')
    .action(async (options) => {
      await installCommand(options);
    });

  program
    .command('start')
    .description('Start a verification session: browser, recording, error capture')
    .option('--description <text>', 'What is being verified (included in the proof report)')
    .option('--port <port>', 'Override detected port', parsePort)
    .option('--run <command>', 'Start this command and capture its logs')
    .option('--headed', 'Show browser window for debugging')
    .option('--output <dir>', 'Custom output directory')
    .option('--url <url>', 'Open this URL instead of the root')
    .option('--force', 'Override a stale session without running stop first')
    .option('--take-port', 'Stop the current port owner before starting --run')
    .action(async (options) => {
      await startCommand(options);
    });

  program
    .command('stop')
    .description('Stop session: stop recording, collect errors, bundle proof artifacts')
    .option('--no-close', 'Don\'t close the browser (keep it open for further use)')
    .option('--allow-incomplete', 'Return success when evidence collection is unavailable')
    .action(async (options) => {
      await stopCommand(options);
    });

  program
    .command('diff')
    .description('Compare current screenshots against a baseline')
    .requiredOption('--baseline <dir>', 'Directory with baseline screenshots')
    .requiredOption('--current <dir>', 'Directory with current screenshots')
    .option('--threshold <percent>', 'Allowed mismatch percentage', parseFloat, 0)
    .action(async (options) => {
      await diffCommand(options);
    });

  program
    .command('clean')
    .description('Remove artifact files')
    .option('--dry-run', 'Print matching paths without removing them')
    .option('--older-than <duration>', 'Only remove artifacts older than 12h, 7d, or 4w')
    .option('--trash', 'Move artifacts through the system trash CLI')
    .action(async (options) => {
      await cleanCommand(options);
    });

  program
    .command('doctor')
    .description('Inspect the local ProofShot environment and active session state')
    .option('--json', 'Print machine-readable diagnostics')
    .action(async (options) => {
      await doctorCommand(options);
    });

  program
    .command('pr')
    .description('Upload session artifacts and post a ProofShot comment on a GitHub PR')
    .argument('[pr-number]', 'PR number (auto-detects from current branch if omitted)')
    .option('--dry-run', 'Generate the comment markdown without posting')
    .option(
      '--upload-provider <provider>',
      'Artifact upload backend: repo-contents or github-web-attachments',
      'repo-contents',
    )
    .option(
      '--artifacts-branch <branch>',
      'Git branch used by the repo-contents upload provider',
      'proofshot-artifacts',
    )
    .option('--session <path>', 'Upload one exact session directory')
    .option('--sha <revision>', 'Require sessions for this revision', 'HEAD')
    .option('--all-sessions', 'Upload all matching sessions instead of the newest')
    .option('--allow-stale', 'Allow a session from another revision')
    .option('--allow-dirty', 'Allow dirty current or recorded worktrees')
    .action(async (prNumber, options) => {
      await prCommand({ prNumber, ...options });
    });

  program
    .command('run')
    .description('Execute a declarative ProofShot scenario')
    .argument('<scenario>', 'Path to a scenario JSON file')
    .action(async (scenario) => {
      await runCommand(scenario);
    });

  program
    .command('exec')
    .description('Run an agent-browser command with logging (use instead of agent-browser directly)')
    .argument('<args...>', 'agent-browser command and arguments')
    .allowUnknownOption()
    .action(async (args) => {
      await execCommand(args);
    });

  program
    .command('snapshot')
    .description('Capture an interactive browser snapshot (shorthand for "proofshot exec snapshot")')
    .argument('[args...]', 'snapshot options, such as -i')
    .allowUnknownOption()
    .action(async (args: string[] = []) => {
      await execCommand(['snapshot', ...args]);
    });

  program
    .command('screenshot')
    .description('Save a screenshot into the session folder (shorthand for "proofshot exec screenshot")')
    .argument('[args...]', 'screenshot filename, relative to the session folder')
    .allowUnknownOption()
    .action(async (args: string[] = []) => {
      await execCommand(['screenshot', ...args]);
    });

  program
    .command('assert')
    .description('Record a required browser assertion')
    .argument('<type>', 'visible, absent, url, or no-console-errors')
    .argument('[value...]', 'Expected text or URL fragment')
    .action(async (type: string, value: string[] = []) => {
      await execCommand(['assert', type, ...value]);
    });

  return program;
}
