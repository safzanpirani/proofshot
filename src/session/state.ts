import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { writeFileAtomic, writeJsonAtomic } from '../utils/atomic.js';

const SESSION_FILENAME = '.session.json';
/**
 * Written into the *default* output dir when `start --output` points the
 * session somewhere else. Without it `exec`/`stop` only look in the configured
 * directory, silently miss the session, and leave a 0-byte recording behind.
 */
const SESSION_POINTER_FILENAME = '.session-location';
const SESSION_START_LOCK_FILENAME = '.session-start.lock';

export interface SessionStartLock {
  path: string;
  token: string;
}

export interface SessionState {
  schemaVersion: 2;
  ownershipToken: string;
  startedAt: string;
  description: string | null;
  outputDir: string;
  sessionDir: string;
  sessionName: string;
  videoPath: string;
  serverErrorLog: string;
  port: number;
  serverCommand: string | null;
  serverAlreadyRunning: boolean;
  /** PID of the detached log pump owning the dev server, if proofshot started it. */
  serverPumpPid?: number | null;
  serverProcess?: {
    pid: number;
    startTime: string;
    command: string;
    ownershipToken: string;
  } | null;
  recordingActive: boolean;
  viewport?: { width: number; height: number };
  initialViewport: { width: number; height: number };
  viewportChanges: Array<{ width: number; height: number; timestamp: string }>;
  headless: boolean;
  deviceScaleFactor: number;
  browserVersion?: string | null;
  agentBrowserVersion?: string | null;
  proofshotCommit?: string | null;
}

export class InvalidSessionStateError extends Error {
  constructor(public readonly sessionPath: string, message: string) {
    super(`Invalid ProofShot session state at ${sessionPath}: ${message}`);
    this.name = 'InvalidSessionStateError';
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Claim the default session root before checking or creating session state. */
export function acquireSessionStartLock(outputDir: string): SessionStartLock {
  fs.mkdirSync(outputDir, { recursive: true });
  const lockPath = path.join(outputDir, SESSION_START_LOCK_FILENAME);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }) + '\n');
      } finally {
        fs.closeSync(descriptor);
      }
      return { path: lockPath, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid?: unknown; token?: unknown } = {};
      try {
        owner = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { pid?: unknown; token?: unknown };
      } catch { /* malformed lock is stale */ }
      if (typeof owner.pid === 'number' && processIsAlive(owner.pid)) {
        throw new Error(`Another ProofShot start is already running with PID ${owner.pid}`);
      }
      try { fs.unlinkSync(lockPath); } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      }
    }
  }

  throw new Error('Could not acquire the ProofShot session start lock');
}

/** Release only the exact start claim acquired by this process. */
export function releaseSessionStartLock(lock: SessionStartLock): void {
  try {
    const owner = JSON.parse(fs.readFileSync(lock.path, 'utf-8')) as { token?: unknown };
    if (owner.token === lock.token) fs.unlinkSync(lock.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateSessionState(value: unknown, sessionPath = SESSION_FILENAME): SessionState {
  if (!object(value)) throw new InvalidSessionStateError(sessionPath, 'expected an object');
  const requiredStrings = ['startedAt', 'ownershipToken', 'outputDir', 'sessionDir', 'sessionName', 'videoPath', 'serverErrorLog'];
  for (const key of requiredStrings) {
    if (typeof value[key] !== 'string' || value[key] === '') {
      throw new InvalidSessionStateError(sessionPath, `${key} must be a non-empty string`);
    }
  }
  if (value.schemaVersion !== 2) throw new InvalidSessionStateError(sessionPath, 'unsupported schemaVersion');
  if (!Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) {
    throw new InvalidSessionStateError(sessionPath, 'port must be an integer from 1 to 65535');
  }
  if (typeof value.recordingActive !== 'boolean' || typeof value.serverAlreadyRunning !== 'boolean') {
    throw new InvalidSessionStateError(sessionPath, 'invalid lifecycle flags');
  }
  if (!object(value.initialViewport) || !Number.isInteger(value.initialViewport.width) || !Number.isInteger(value.initialViewport.height)) {
    throw new InvalidSessionStateError(sessionPath, 'initialViewport is invalid');
  }
  if (!Array.isArray(value.viewportChanges) || typeof value.headless !== 'boolean' || typeof value.deviceScaleFactor !== 'number') {
    throw new InvalidSessionStateError(sessionPath, 'browser environment is invalid');
  }
  const outputDir = path.resolve(value.outputDir as string);
  const sessionDir = path.resolve(value.sessionDir as string);
  if (!sessionDir.startsWith(outputDir + path.sep)) throw new InvalidSessionStateError(sessionPath, 'sessionDir must be inside outputDir');
  for (const key of ['videoPath', 'serverErrorLog'] as const) {
    const artifactPath = path.resolve(value[key] as string);
    if (!artifactPath.startsWith(sessionDir + path.sep)) throw new InvalidSessionStateError(sessionPath, `${key} must be inside sessionDir`);
  }
  if (value.serverProcess != null) {
    const processValue = value.serverProcess;
    if (!object(processValue) || !Number.isInteger(processValue.pid) || typeof processValue.startTime !== 'string' || typeof processValue.command !== 'string' || processValue.ownershipToken !== value.ownershipToken) {
      throw new InvalidSessionStateError(sessionPath, 'serverProcess identity is invalid');
    }
  }
  return value as unknown as SessionState;
}

/**
 * Write session state to disk.
 */
export function saveSession(state: SessionState): void {
  const sessionPath = path.join(state.outputDir, SESSION_FILENAME);
  writeJsonAtomic(sessionPath, state);
}

/**
 * Read session state from disk.
 * Returns null if no active session.
 */
export function loadSession(outputDir: string): SessionState | null {
  const sessionPath = path.join(outputDir, SESSION_FILENAME);
  if (fs.existsSync(sessionPath)) {
    try {
      return validateSessionState(JSON.parse(fs.readFileSync(sessionPath, 'utf-8')), sessionPath);
    } catch (error) {
      if (error instanceof InvalidSessionStateError) throw error;
      throw new InvalidSessionStateError(sessionPath, error instanceof Error ? error.message : String(error));
    }
  }
  // Session may live under a custom --output dir; follow the pointer.
  const redirected = readSessionPointer(outputDir);
  if (!redirected) return null;
  try {
    const redirectedPath = path.join(redirected, SESSION_FILENAME);
    return validateSessionState(JSON.parse(fs.readFileSync(redirectedPath, 'utf-8')), redirectedPath);
  } catch (error) {
    if (error instanceof InvalidSessionStateError) throw error;
    throw new InvalidSessionStateError(path.join(redirected, SESSION_FILENAME), error instanceof Error ? error.message : String(error));
  }
}

/** Record that the active session lives in `sessionOutputDir`, not `defaultDir`. */
export function writeSessionPointer(defaultDir: string, sessionOutputDir: string): void {
  if (path.resolve(defaultDir) === path.resolve(sessionOutputDir)) return;
  fs.mkdirSync(defaultDir, { recursive: true });
  writeFileAtomic(path.join(defaultDir, SESSION_POINTER_FILENAME), sessionOutputDir + '\n');
}

export function readSessionPointer(defaultDir: string): string | null {
  const pointerPath = path.join(defaultDir, SESSION_POINTER_FILENAME);
  if (!fs.existsSync(pointerPath)) return null;
  const target = fs.readFileSync(pointerPath, 'utf-8').trim();
  if (!path.isAbsolute(target)) return null;
  return target && fs.existsSync(path.join(target, SESSION_FILENAME)) ? target : null;
}

/**
 * Check if a session is currently active.
 */
export function hasActiveSession(outputDir: string): boolean {
  return fs.existsSync(path.join(outputDir, SESSION_FILENAME)) || readSessionPointer(outputDir) !== null;
}

/**
 * Delete the session state file (called after stop).
 */
export function clearSession(outputDir: string): void {
  const redirected = readSessionPointer(outputDir);
  for (const dir of redirected ? [outputDir, redirected] : [outputDir]) {
    const sessionPath = path.join(dir, SESSION_FILENAME);
    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
  }
  const pointerPath = path.join(outputDir, SESSION_POINTER_FILENAME);
  if (fs.existsSync(pointerPath)) fs.unlinkSync(pointerPath);
}

/**
 * Generate a deterministic agent-browser session name for a ProofShot run.
 */
export function generateAgentBrowserSessionName(seed: string): string {
  const normalized = seed
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return normalized ? `proofshot-${normalized}` : 'proofshot';
}
