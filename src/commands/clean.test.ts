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

  it('refuses destructive cleanup while a session is active', () => {
    expect(() => assertCleanupAllowed(true)).toThrow('session is active');
    expect(() => assertCleanupAllowed(false)).not.toThrow();
  });
});
