import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { assertCleanupAllowed, parseAge, validateCleanupPath } from './clean.js';

describe('clean safety', () => {
  it('parses explicit retention durations', () => {
    expect(parseAge('7d')).toBe(7 * 86_400_000);
    expect(() => parseAge('7 days')).toThrow('--older-than');
  });

  it('refuses roots, home directories, repository roots, and their ancestors', () => {
    expect(() => validateCleanupPath('/', '/work/repo', '/Users/test')).toThrow('dangerous');
    expect(() => validateCleanupPath('/Users/test', '/work/repo', '/Users/test')).toThrow('dangerous');
    expect(() => validateCleanupPath('/work/repo', '/work/repo', '/Users/test')).toThrow('dangerous');
    expect(() => validateCleanupPath('/work', '/work/repo', '/Users/test')).toThrow('dangerous');
  });

  it('accepts a scoped artifacts directory', () => {
    expect(validateCleanupPath('/work/repo/proofshot-artifacts', '/work/repo', '/Users/test')).toBe('/work/repo/proofshot-artifacts');
  });

  it.each(['final', 'intermediate'])('refuses an output path with a %s symbolic-link component', (position) => {
    const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-clean-symlink-')));
    const realDir = path.join(tempDir, 'real');
    const linkedDir = path.join(tempDir, 'linked');
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    const target = position === 'final' ? linkedDir : path.join(linkedDir, 'proofshot-artifacts');

    expect(() => validateCleanupPath(target, tempDir, '/Users/test')).toThrow('symbolic link');
  });

  it('refuses destructive cleanup while a session is active', () => {
    expect(() => assertCleanupAllowed(true)).toThrow('session is active');
    expect(() => assertCleanupAllowed(false)).not.toThrow();
  });
});
