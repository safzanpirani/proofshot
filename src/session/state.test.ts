import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  acquireSessionStartLock,
  generateAgentBrowserSessionName,
  releaseSessionStartLock,
  validateSessionState,
} from './state.js';

describe('generateAgentBrowserSessionName', () => {
  it('prefixes ProofShot session names consistently', () => {
    expect(generateAgentBrowserSessionName('2026-04-07_22-30-00')).toBe(
      'proofshot-2026-04-07_22-30-00',
    );
  });

  it('normalizes unsafe characters', () => {
    expect(generateAgentBrowserSessionName("April 7 review / O'Connor")).toBe(
      'proofshot-april-7-review-o-connor',
    );
  });
});

describe('session start lock', () => {
  it('allows one starter and rejects a concurrent starter', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-start-lock-'));
    const lock = acquireSessionStartLock(outputDir);
    try {
      expect(() => acquireSessionStartLock(outputDir)).toThrow('already running');
    } finally {
      releaseSessionStartLock(lock);
    }
    const reacquired = acquireSessionStartLock(outputDir);
    releaseSessionStartLock(reacquired);
    expect(fs.existsSync(reacquired.path)).toBe(false);
  });

  it('recovers a stale claim whose process no longer exists', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-stale-lock-'));
    fs.writeFileSync(
      path.join(outputDir, '.session-start.lock'),
      JSON.stringify({ pid: 2_147_483_647, token: 'stale' }),
    );
    const lock = acquireSessionStartLock(outputDir);
    releaseSessionStartLock(lock);
    expect(fs.existsSync(lock.path)).toBe(false);
  });
});

describe('validateSessionState', () => {
  it('rejects parsed JSON that lacks the current schema and ownership token', () => {
    expect(() => validateSessionState({ startedAt: new Date().toISOString() }, '/tmp/.session.json')).toThrow('ownershipToken');
  });

  it('rejects a server process whose ownership token differs from the session', () => {
    expect(() => validateSessionState({
      schemaVersion: 2,
      ownershipToken: 'session-token',
      startedAt: new Date().toISOString(),
      description: null,
      outputDir: '/tmp/out',
      sessionDir: '/tmp/out/session',
      sessionName: 'proofshot-test',
      videoPath: '/tmp/out/session/session.webm',
      serverErrorLog: '/tmp/out/session/server.log',
      port: 3000,
      serverCommand: 'npm run dev',
      serverAlreadyRunning: false,
      serverProcess: { pid: 123, startTime: 'now', command: 'log-pump', ownershipToken: 'foreign' },
      recordingActive: true,
      initialViewport: { width: 1280, height: 720 },
      viewportChanges: [],
      headless: true,
      deviceScaleFactor: 1,
    })).toThrow('serverProcess identity');
  });
});
