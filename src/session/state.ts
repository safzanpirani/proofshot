import * as fs from 'fs';
import * as path from 'path';

const SESSION_FILENAME = '.session.json';
/**
 * Written into the *default* output dir when `start --output` points the
 * session somewhere else. Without it `exec`/`stop` only look in the configured
 * directory, silently miss the session, and leave a 0-byte recording behind.
 */
const SESSION_POINTER_FILENAME = '.session-location';

export interface SessionState {
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
  recordingActive: boolean;
  viewport?: { width: number; height: number };
}

/**
 * Write session state to disk.
 */
export function saveSession(state: SessionState): void {
  const sessionPath = path.join(state.outputDir, SESSION_FILENAME);
  fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Read session state from disk.
 * Returns null if no active session.
 */
export function loadSession(outputDir: string): SessionState | null {
  const sessionPath = path.join(outputDir, SESSION_FILENAME);
  if (fs.existsSync(sessionPath)) {
    try {
      return JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    } catch {
      return null;
    }
  }
  // Session may live under a custom --output dir; follow the pointer.
  const redirected = readSessionPointer(outputDir);
  if (!redirected) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(redirected, SESSION_FILENAME), 'utf-8'));
  } catch {
    return null;
  }
}

/** Record that the active session lives in `sessionOutputDir`, not `defaultDir`. */
export function writeSessionPointer(defaultDir: string, sessionOutputDir: string): void {
  if (path.resolve(defaultDir) === path.resolve(sessionOutputDir)) return;
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.writeFileSync(path.join(defaultDir, SESSION_POINTER_FILENAME), sessionOutputDir + '\n');
}

export function readSessionPointer(defaultDir: string): string | null {
  const pointerPath = path.join(defaultDir, SESSION_POINTER_FILENAME);
  if (!fs.existsSync(pointerPath)) return null;
  const target = fs.readFileSync(pointerPath, 'utf-8').trim();
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
