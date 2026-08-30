import { execFileSync, execSync, type ChildProcess } from 'child_process';
import { spawnShellCommand } from './process.js';

export class ProofShotError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'ProofShotError';
  }
}

export interface AgentBrowserCommandOptions {
  configPath?: string;
  session?: string;
  timeoutMs?: number;
}

let defaultAgentBrowserOptions: Pick<AgentBrowserCommandOptions, 'configPath'> = {};

export function setAgentBrowserDefaults(
  options: Pick<AgentBrowserCommandOptions, 'configPath'>,
): void {
  defaultAgentBrowserOptions = { ...options };
}

function shellQuote(value: string): string {
  const escaped = value.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

export function buildAgentBrowserCommand(
  command: string,
  options: Pick<AgentBrowserCommandOptions, 'configPath' | 'session'> = {},
): string {
  const mergedOptions = {
    ...defaultAgentBrowserOptions,
    ...options,
  };
  const configFlag = mergedOptions.configPath ? ` --config ${shellQuote(mergedOptions.configPath)}` : '';
  const sessionFlag = mergedOptions.session ? ` --session ${shellQuote(mergedOptions.session)}` : '';
  return `agent-browser${configFlag}${sessionFlag} ${command}`;
}

export function buildAgentBrowserArgs(
  args: readonly string[],
  options: Pick<AgentBrowserCommandOptions, 'configPath' | 'session'> = {},
): string[] {
  const mergedOptions = {
    ...defaultAgentBrowserOptions,
    ...options,
  };
  const result: string[] = [];
  if (mergedOptions.configPath) result.push('--config', mergedOptions.configPath);
  if (mergedOptions.session) result.push('--session', mergedOptions.session);
  result.push(...args);
  return result;
}

function parseCommandArgs(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let tokenStarted = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      } else if (character === '\\' && quote === '"' && index + 1 < command.length) {
        current += command[index + 1];
        index += 1;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        args.push(current);
        current = '';
        tokenStarted = false;
      }
    } else if (character === '\\' && index + 1 < command.length) {
      current += command[index + 1];
      tokenStarted = true;
      index += 1;
    } else {
      current += character;
      tokenStarted = true;
    }
  }

  if (quote) throw new ProofShotError('Browser command contains an unterminated quote');
  if (tokenStarted) args.push(current);
  return args;
}

function formatAgentBrowserInvocation(args: readonly string[]): string {
  return ['agent-browser', ...args].map((arg) => JSON.stringify(arg)).join(' ');
}

/** Execute agent-browser without a command shell. */
export function abArgs(
  args: readonly string[],
  timeoutOrOptions: number | AgentBrowserCommandOptions = 30000,
): string {
  const options =
    typeof timeoutOrOptions === 'number'
      ? { timeoutMs: timeoutOrOptions }
      : timeoutOrOptions;
  const fullArgs = buildAgentBrowserArgs(args, options);
  try {
    return execFileSync('agent-browser', fullArgs, {
      encoding: 'utf-8',
      timeout: options.timeoutMs ?? 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error: any) {
    const stderr = error?.stderr?.toString?.() || '';
    const message = stderr || error?.message || 'Unknown error';
    throw new ProofShotError(
      `Browser command failed: ${formatAgentBrowserInvocation(fullArgs)}\n${message}`,
      error,
    );
  }
}

/**
 * Execute an agent-browser command via CLI.
 * agent-browser uses a Rust CLI + persistent Node.js daemon architecture,
 * so calling it via CLI is the intended usage pattern.
 */
export function ab(
  command: string,
  timeoutOrOptions: number | AgentBrowserCommandOptions = 30000,
): string {
  return abArgs(parseCommandArgs(command), timeoutOrOptions);
}

export function exec(command: string, timeoutMs = 30000): string {
  try {
    return execSync(command, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error: any) {
    const stderr = error?.stderr?.toString?.() || '';
    throw new ProofShotError(`Command failed: ${command}\n${stderr}`, error);
  }
}

export function spawnBackground(
  command: string,
  cwd?: string,
): ChildProcess {
  const proc = spawnShellCommand(command, {
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  proc.unref();
  return proc;
}
