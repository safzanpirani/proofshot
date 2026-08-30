import { execSync, spawn, type ChildProcess, type SpawnOptions } from 'child_process';

type ExecSyncLike = typeof execSync;

export function getShellExecutable(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    return env.ComSpec || 'cmd.exe';
  }

  return env.SHELL || '/bin/sh';
}

export function spawnShellCommand(
  command: string,
  options: Omit<SpawnOptions, 'shell'> = {},
): ChildProcess {
  return spawn(command, {
    ...options,
    shell: getShellExecutable(),
  });
}

export function parseWindowsNetstatOutput(output: string, port: number): number[] {
  const pids = new Set<number>();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('TCP')) continue;

    const columns = line.split(/\s+/);
    if (columns.length < 5) continue;

    const localAddress = columns[1];
    const state = columns[3];
    const pid = Number(columns[4]);
    const match = localAddress.match(/:(\d+)$/);

    if (state !== 'LISTENING' || !match || !Number.isInteger(pid)) continue;
    if (Number(match[1]) === port) {
      pids.add(pid);
    }
  }

  return [...pids];
}

export function findPidsListeningOnPort(
  port: number,
  platform = process.platform,
  execFn: ExecSyncLike = execSync,
): number[] {
  try {
    if (platform === 'win32') {
      const output = execFn('netstat -ano -p tcp', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as string;
      return parseWindowsNetstatOutput(output, port);
    }

    const output = (execFn(`lsof -nP -a -iTCP:${port} -sTCP:LISTEN -t`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as string).trim();

    return [...new Set(output
      .split(/\r?\n/)
      .map((pid) => Number(pid))
      .filter((pid) => Number.isInteger(pid) && pid > 0))];
  } catch {
    return [];
  }
}

export function killPids(
  pids: number[],
  platform = process.platform,
  execFn: ExecSyncLike = execSync,
): boolean {
  if (pids.length === 0) return false;

  try {
    if (platform === 'win32') {
      const pidArgs = pids.map((pid) => `/PID ${pid}`).join(' ');
      execFn(`taskkill /F /T ${pidArgs}`, { stdio: 'pipe' });
      return true;
    }

    execFn(`kill -9 ${pids.join(' ')}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export interface ProcessIdentity {
  pid: number;
  startTime: string;
  command: string;
}

export function getProcessIdentity(
  pid: number,
  platform = process.platform,
  execFn: ExecSyncLike = execSync,
): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'win32') {
      const output = execFn(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -First 1 CreationDate,CommandLine | ConvertTo-Json -Compress"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ) as string;
      const parsed = JSON.parse(output) as { CreationDate?: string; CommandLine?: string };
      if (!parsed.CreationDate) return null;
      return { pid, startTime: parsed.CreationDate, command: parsed.CommandLine || '' };
    }
    const output = (execFn(`ps -o lstart= -o command= -p ${pid}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as string).trim();
    if (!output) return null;
    return { pid, startTime: output.slice(0, 24).trim(), command: output.slice(24).trim() };
  } catch {
    return null;
  }
}

export function processIdentityMatches(
  actual: ProcessIdentity | null,
  expected: ProcessIdentity & { ownershipToken: string },
): boolean {
  return Boolean(
    actual &&
    actual.pid === expected.pid &&
    actual.startTime === expected.startTime &&
    actual.command.includes('log-pump') &&
    actual.command.includes(expected.ownershipToken),
  );
}

export async function terminateOwnedProcessTree(
  expected: ProcessIdentity & { ownershipToken: string },
  platform = process.platform,
  execFn: ExecSyncLike = execSync,
  killFn: (pid: number, signal: NodeJS.Signals | 0) => void = (pid, signal) => process.kill(pid, signal),
  graceMs = 5000,
): Promise<void> {
  const actual = getProcessIdentity(expected.pid, platform, execFn);
  if (!actual) {
    try { killFn(expected.pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
  }
  if (!processIdentityMatches(actual, expected)) {
    throw new Error(`Refusing to stop PID ${expected.pid}: process identity or ownership token does not match session state`);
  }
  if (platform === 'win32') {
    try { execFn(`taskkill /T /PID ${expected.pid}`, { stdio: 'pipe' }); } catch { /* verify below */ }
  } else {
    killFn(-expected.pid, 'SIGTERM');
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    try { killFn(expected.pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (platform === 'win32') {
    execFn(`taskkill /F /T /PID ${expected.pid}`, { stdio: 'pipe' });
  } else {
    killFn(-expected.pid, 'SIGKILL');
  }
}

export function terminateProcessTree(
  pid: number,
  platform = process.platform,
  execFn: ExecSyncLike = execSync,
  killFn: (pid: number, signal: NodeJS.Signals) => void = (p, sig) => process.kill(p, sig),
): void {
  if (platform === 'win32') {
    // Windows has no process groups to signal; /T walks the child tree, which
    // is the only way to take a shell-wrapped dev server down with its parent.
    execFn(`taskkill /F /T /PID ${pid}`, { stdio: 'pipe' });
    return;
  }

  // Negative PID = kill the whole process group. Requires `pid` to be a group
  // leader, which is why the log pump is spawned detached.
  killFn(-pid, 'SIGKILL');
}

export function findExecutablePath(
  command: string,
  platform = process.platform,
  execFn: ExecSyncLike = execSync,
): string | null {
  try {
    const lookupCommand = platform === 'win32' ? `where ${command}` : `command -v ${command}`;
    const output = execFn(lookupCommand, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return output.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

export function readCommandVersion(
  command: string,
  args: string[] = ['--version'],
  execFn: ExecSyncLike = execSync,
): string | null {
  try {
    const output = execFn([command, ...args].join(' '), {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return output.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}
