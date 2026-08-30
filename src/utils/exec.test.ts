import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ab,
  abArgs,
  buildAgentBrowserArgs,
} from './exec.js';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  execFileSync: mocks.execFileSync,
}));

beforeEach(() => {
  mocks.execFileSync.mockReset();
  mocks.execFileSync.mockReturnValue('ok\n');
});

describe('argv agent-browser execution', () => {
  it('builds config and session flags as separate arguments', () => {
    expect(buildAgentBrowserArgs(['open', 'https://example.test/a b'], {
      configPath: 'C:\\ProofShot Config\\agent-browser.json',
      session: "proofshot-o'connor",
    })).toEqual([
      '--config',
      'C:\\ProofShot Config\\agent-browser.json',
      '--session',
      "proofshot-o'connor",
      'open',
      'https://example.test/a b',
    ]);
  });

  it('passes metacharacters and Windows paths without a shell', () => {
    expect(abArgs([
      'fill',
      '@e2',
      'A & B "quoted"; $(touch nope)',
      'C:\\Users\\Safzan\\proof shot.png',
    ], { session: 'proofshot test', timeoutMs: 1234 })).toBe('ok');

    expect(mocks.execFileSync).toHaveBeenCalledWith('agent-browser', [
      '--session',
      'proofshot test',
      'fill',
      '@e2',
      'A & B "quoted"; $(touch nope)',
      'C:\\Users\\Safzan\\proof shot.png',
    ], {
      encoding: 'utf-8',
      timeout: 1234,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('keeps the public string API without invoking a shell', () => {
    expect(ab('eval "window.location.href"')).toBe('ok');
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'agent-browser',
      ['eval', 'window.location.href'],
      expect.any(Object),
    );
  });
});
