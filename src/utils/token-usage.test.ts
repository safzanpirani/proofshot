import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { estimateTokenUsage } from './token-usage.js';

describe('estimateTokenUsage', () => {
  let originalHome: string | undefined;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    originalHome = undefined;
  });

  it('computes total tokens from usage fields when top-level totals are missing', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-token-home-'));
    const claudeSessionsDir = path.join(tmpHome, '.claude', 'sessions');
    fs.mkdirSync(claudeSessionsDir, { recursive: true });

    const now = Date.now();
    const startedAt = new Date(now).toISOString();

    fs.writeFileSync(
      path.join(claudeSessionsDir, 'session.json'),
      JSON.stringify({
        startedAt,
        usage: {
          inputTokens: 1200,
          outputTokens: 300,
        },
      }),
    );

    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-token-session-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;

    const usage = estimateTokenUsage(sessionDir, now - 1000, now + 1000);

    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(1200);
    expect(usage?.outputTokens).toBe(300);
    expect(usage?.totalTokens).toBe(1500);
    expect(usage?.source).toBe('claude-logs');
  });
});

describe('estimateTokenUsage without a real usage source', () => {
  let originalHome: string | undefined;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    originalHome = undefined;
  });

  it('returns null rather than inventing usage from the action count', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-token-empty-'));
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-token-session-'));

    // A session with plenty of actions — the old code turned this into
    // "~2,500 input tokens, ~$0.03" out of nothing.
    fs.writeFileSync(
      path.join(sessionDir, 'session-log.json'),
      JSON.stringify([{ action: 'click @e1' }, { action: 'fill @e2 hi' }, { action: 'snapshot -i' }]),
    );

    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;

    const now = Date.now();
    expect(estimateTokenUsage(sessionDir, now - 1000, now + 1000)).toBeNull();
  });
});
