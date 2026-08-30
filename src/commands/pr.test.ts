import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSessionVerificationResult } from './pr.js';

const tempDirs: string[] = [];

function createSession(result?: unknown): string {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-pr-test-'));
  tempDirs.push(sessionDir);
  if (result !== undefined) {
    fs.writeFileSync(path.join(sessionDir, 'result.json'), JSON.stringify(result));
  }
  return sessionDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('readSessionVerificationResult', () => {
  it('reports structured assertion, action, error, and evidence failures', () => {
    const sessionDir = createSession({
      schemaVersion: 2,
      assertions: [{ passed: false }],
      assertionsPassed: false,
      evidenceComplete: false,
      actions: { failedCount: 2 },
      sessionLog: { malformedLines: [4] },
      console: { status: 'captured', errorCount: 1 },
      server: { status: 'captured', errorCount: 3 },
      incompleteReasons: ['Video file was not produced'],
    });

    expect(readSessionVerificationResult(sessionDir)).toEqual({
      status: 'failed',
      errorCount: 4,
      assertionFailureCount: 1,
      failedActionCount: 2,
      reasons: [
        'Video file was not produced',
        'Session action log contains malformed JSONL at line(s) 4',
      ],
    });
  });

  it('accepts a complete version 2 result', () => {
    const sessionDir = createSession({
      schemaVersion: 2,
      assertions: [{ passed: true }],
      assertionsPassed: true,
      evidenceComplete: true,
      actions: { failedCount: 0 },
      sessionLog: { malformedLines: [] },
      console: { status: 'captured', errorCount: 0 },
      server: { status: 'captured', errorCount: 0 },
      incompleteReasons: [],
    });

    expect(readSessionVerificationResult(sessionDir).status).toBe('passed');
  });

  it('marks missing and legacy results as unknown instead of green', () => {
    const missing = readSessionVerificationResult(createSession());
    const legacy = readSessionVerificationResult(createSession({ assertions: [], passed: true }));

    expect(missing.status).toBe('unknown');
    expect(legacy.status).toBe('unknown');
    expect(legacy.reasons.join(' ')).toMatch(/Legacy result format/);
  });

  it('fails closed when a version 2 result has malformed fields', () => {
    const sessionDir = createSession({
      schemaVersion: 2,
      assertions: [],
      assertionsPassed: true,
      evidenceComplete: true,
      actions: { failedCount: 0 },
      sessionLog: { malformedLines: ['not-a-line-number'] },
      console: { errorCount: 0 },
      server: { errorCount: 0 },
      incompleteReasons: [],
    });

    const result = readSessionVerificationResult(sessionDir);
    expect(result.status).toBe('unknown');
    expect(result.reasons.join(' ')).toMatch(/missing required verification fields/);
  });
});
