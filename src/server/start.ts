import * as fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { Transform } from 'stream';
import { isPortOpen, waitForPort } from '../utils/port.js';
import {
  findPidsListeningOnPort,
  getProcessIdentity,
  killPids,
  spawnShellCommand,
  terminateProcessTree,
} from '../utils/process.js';

export interface ServerStartResult {
  alreadyRunning: boolean;
  port: number;
  /** PID of the detached log pump owning the dev server, or null if we didn't start one. */
  pumpPid: number | null;
  processIdentity: { pid: number; startTime: string; command: string; ownershipToken: string } | null;
}

/**
 * Kill whatever process is listening on the given port.
 * Retries up to 3 times to ensure the port is actually freed.
 * Returns true if something was killed.
 */
async function takePort(port: number): Promise<boolean> {
  let killed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const pids = findPidsListeningOnPort(port);
    if (pids.length > 0) {
      for (const pid of pids) {
        const identity = getProcessIdentity(pid);
        if (!identity) continue;
        try {
          process.kill(pid, 'SIGTERM');
          killed = true;
        } catch { /* process exited */ }
      }
    }

    // Wait for the OS to release the port
    await new Promise((r) => setTimeout(r, 1000));
    if (!(await isPortOpen(port))) return killed;
  }
  const remaining = findPidsListeningOnPort(port);
  if (remaining.length > 0) killed = killPids(remaining) || killed;
  return killed;
}

/**
 * Create a Transform stream that prepends an epoch-ms timestamp to each line.
 * Format: "1720612345678\toriginal line\n"
 */
function createTimestampTransform(): Transform {
  let buffer = '';
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        this.push(`${Date.now()}\t${line}\n`);
      }
      callback();
    },
    flush(callback) {
      if (buffer) this.push(`${Date.now()}\t${buffer}\n`);
      callback();
    },
  });
}

/**
 * Start a dev server command and wait for it to be ready.
 * Only called when the agent provides a --run command.
 * Pipes stdout/stderr to logPath for server error capture.
 */
export async function ensureDevServer(
  command: string,
  port: number,
  startupTimeout: number,
  logPath: string,
  options: { takePort?: boolean; ownershipToken: string },
): Promise<ServerStartResult> {
  if (await isPortOpen(port)) {
    const owners = findPidsListeningOnPort(port).map((pid) => getProcessIdentity(pid)).filter(Boolean);
    const ownerText = owners.map((owner) => `PID ${owner!.pid}: ${owner!.command}`).join('\n') || 'owner unavailable';
    if (!options.takePort) {
      throw new Error(`Port ${port} is already in use.\n${ownerText}\nRetry with --take-port to authorize takeover.`);
    }
    const killed = await takePort(port);
    if (killed) {
      process.stderr.write(`Port ${port} was in use — killed existing process\n`);
    }
    // Final check — if still occupied, fail fast with a clear message
    if (await isPortOpen(port)) {
      throw new Error(
        `Port ${port} is still in use after attempting to kill the process.\n` +
          `Manually stop whatever is running on port ${port} and retry.`,
      );
    }
  }

  // Run the server under a detached log pump. Piping its stdio through this
  // process would keep our event loop alive forever -- `proofshot start` never
  // exited, which hung every agent-driven session.
  // tsup emits the pump next to the CLI bundle (dist/bin/); the library bundle
  // lives in dist/src/, so check both rather than assuming one layout.
  const pumpCandidates = [
    new URL('./log-pump.js', import.meta.url),
    new URL('../bin/log-pump.js', import.meta.url),
  ].map((url) => fileURLToPath(url));
  const pumpScript = pumpCandidates.find((candidate) => fs.existsSync(candidate));
  if (!pumpScript) {
    throw new Error(
      `Could not locate log-pump.js (looked in: ${pumpCandidates.join(', ')}). ` +
        'Reinstall proofshot or run "npm run build".',
    );
  }
  const proc = spawn(process.execPath, [pumpScript, `--proofshot-owner=${options.ownershipToken}`, logPath, command], {
    cwd: process.cwd(),
    stdio: 'ignore',
    detached: true,
  });

  proc.unref();

  try {
    await waitForPort(port, startupTimeout);
  } catch (error) {
    // Clean up the spawned process if it failed to start on the expected port
    try {
      if (proc.pid) terminateProcessTree(proc.pid);
    } catch {
      // Already exited
    }
    throw new Error(
      `Failed to start dev server with "${command}" on port ${port}.\n` +
        `Make sure the command is correct and the port is available.\n` +
        `Original error: ${error instanceof Error ? error.message : error}`,
    );
  }

  // Small delay for stability
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const identity = proc.pid ? getProcessIdentity(proc.pid) : null;
  if (!identity) {
    if (proc.pid) terminateProcessTree(proc.pid);
    throw new Error('Started the dev server pump but could not verify its process identity');
  }
  return {
    alreadyRunning: false,
    port,
    pumpPid: proc.pid ?? null,
    processIdentity: { ...identity, ownershipToken: options.ownershipToken },
  };
}
