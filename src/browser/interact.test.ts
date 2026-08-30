import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fill, type } from './interact.js';

const mocks = vi.hoisted(() => ({ abArgs: vi.fn() }));
vi.mock('../utils/exec.js', () => ({ abArgs: mocks.abArgs }));

describe('browser interaction argv', () => {
  beforeEach(() => {
    mocks.abArgs.mockReset();
  });

  it('passes fill values as one exact argument', () => {
    fill('@e7', 'a "quote" & shell metacharacters', 'proofshot-test');
    expect(mocks.abArgs).toHaveBeenCalledWith(
      ['fill', '@e7', 'a "quote" & shell metacharacters'],
      { timeoutMs: 10000, session: 'proofshot-test' },
    );
  });

  it('passes typed text as one exact argument', () => {
    type('C:\\Users\\Safzan\\A B; $HOME', 'proofshot-test');
    expect(mocks.abArgs).toHaveBeenCalledWith(
      ['type', 'C:\\Users\\Safzan\\A B; $HOME'],
      { timeoutMs: 10000, session: 'proofshot-test' },
    );
  });
});
